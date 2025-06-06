import { Construct, IConstruct } from 'constructs';
import { AwsAuthMapping } from './aws-auth-mapping';
import { Cluster, AuthenticationMode } from './cluster';
import { KubernetesManifest } from './k8s-manifest';
import * as iam from '../../aws-iam';
import { Lazy, Stack, ValidationError } from '../../core';

/**
 * Configuration props for the AwsAuth construct.
 */
export interface AwsAuthProps {
  /**
   * The EKS cluster to apply this configuration to.
   *
   * [disable-awslint:ref-via-interface]
   */
  readonly cluster: Cluster;
}

/**
 * Manages mapping between IAM users and roles to Kubernetes RBAC configuration.
 *
 * @see https://docs.aws.amazon.com/en_us/eks/latest/userguide/add-user-role.html
 */
export class AwsAuth extends Construct {
  private readonly stack: Stack;
  private readonly roleMappings = new Array<{ role: iam.IRole; mapping: AwsAuthMapping }>();
  private readonly userMappings = new Array<{ user: iam.IUser; mapping: AwsAuthMapping }>();
  private readonly accounts = new Array<string>();

  constructor(scope: Construct, id: string, props: AwsAuthProps) {
    super(scope, id);

    /**
     * Throw if the cluster does not support ConfigMap.
     * AuthenticationMode.API => support API only
     * AuthenticationMode.API_AND_CONFIG_MAP => support both API and ConfigMap
     * AuthenticationMode.CONFIG_MAP => support ConfigMap only
     * AuthenticationMode undefined => support ConfigMap only
     *
     * As AwsAuth is designed to handle the ConfigMap by creating the KubernetesManifest.
     * We should throw when ConfigMap is not supported and that is only when authenticationMode is
     * AuthenticationMode.API.
     */
    const supportConfigMap = props.cluster.authenticationMode !== AuthenticationMode.API ? true : false;

    if (!supportConfigMap) {
      throw new ValidationError('ConfigMap not supported in the AuthenticationMode', this);
    }

    this.stack = Stack.of(this);

    new KubernetesManifest(this, 'manifest', {
      cluster: props.cluster,
      overwrite: true, // this config map is auto-created by the cluster
      manifest: [
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: {
            name: 'aws-auth',
            namespace: 'kube-system',
          },
          data: {
            mapRoles: this.synthesizeMapRoles(),
            mapUsers: this.synthesizeMapUsers(),
            mapAccounts: this.synthesizeMapAccounts(),
          },
        },
      ],
    });
  }

  /**
   * Adds the specified IAM role to the `system:masters` RBAC group, which means
   * that anyone that can assume it will be able to administer this Kubernetes system.
   *
   * @param role The IAM role to add
   * @param username Optional user (defaults to the role ARN)
   */
  public addMastersRole(role: iam.IRole, username?: string) {
    this.addRoleMapping(role, {
      username,
      groups: ['system:masters'],
    });
  }

  /**
   * Adds a mapping between an IAM role to a Kubernetes user and groups.
   *
   * @param role The IAM role to map
   * @param mapping Mapping to k8s user name and groups
   */
  public addRoleMapping(role: iam.IRole, mapping: AwsAuthMapping) {
    this.assertSameStack(role);
    this.roleMappings.push({ role, mapping });
  }

  /**
   * Adds a mapping between an IAM user to a Kubernetes user and groups.
   *
   * @param user The IAM user to map
   * @param mapping Mapping to k8s user name and groups
   */
  public addUserMapping(user: iam.IUser, mapping: AwsAuthMapping) {
    this.assertSameStack(user);
    this.userMappings.push({ user, mapping });
  }

  /**
   * Additional AWS account to add to the aws-auth configmap.
   * @param accountId account number
   */
  public addAccount(accountId: string) {
    this.accounts.push(accountId);
  }

  private assertSameStack(construct: IConstruct) {
    const thisStack = Stack.of(this);

    if (Stack.of(construct) !== thisStack) {
      // aws-auth is always part of the cluster stack, and since resources commonly take
      // a dependency on the cluster, allowing those resources to be in a different stack,
      // will create a circular dependency. granted, it won't always be the case,
      // but we opted for the more cautious and restrictive approach for now.
      throw new ValidationError(`${construct.node.path} should be defined in the scope of the ${thisStack.stackName} stack to prevent circular dependencies`, this);
    }
  }

  private synthesizeMapRoles() {
    return Lazy.any({
      produce: () => this.stack.toJsonString(this.roleMappings.map(m => ({
        rolearn: m.role.roleArn,
        username: m.mapping.username ?? m.role.roleArn,
        groups: m.mapping.groups,
      }))),
    });
  }

  private synthesizeMapUsers() {
    return Lazy.any({
      produce: () => this.stack.toJsonString(this.userMappings.map(m => ({
        userarn: m.user.userArn,
        username: m.mapping.username ?? m.user.userArn,
        groups: m.mapping.groups,
      }))),
    });
  }

  private synthesizeMapAccounts() {
    return Lazy.any({
      produce: () => this.stack.toJsonString(this.accounts),
    });
  }
}
