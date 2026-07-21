import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import {
  ArtifactRegistryRepository,
  ArtifactRegistryRepositoryProvider,
} from "./ArtifactRegistry/Repository.ts";
import {
  ArtifactRegistryRepositoryIamMember,
  ArtifactRegistryRepositoryIamMemberProvider,
} from "./ArtifactRegistry/RepositoryIamMember.ts";
import { GCPAuth } from "./Auth/AuthProvider.ts";
import { fromAuthProvider } from "./Auth/Credentials.ts";
import { Project, ProjectProvider } from "./CloudResourceManager/Project.ts";
import { Address, AddressProvider } from "./Compute/Address.ts";
import { Firewall, FirewallProvider } from "./Compute/Firewall.ts";
import {
  ForwardingRule,
  ForwardingRuleProvider,
} from "./Compute/ForwardingRule.ts";
import { GlobalAddress, GlobalAddressProvider } from "./Compute/GlobalAddress.ts";
import { Network, NetworkProvider } from "./Compute/Network.ts";
import {
  ProjectDefaultNetworkTier,
  ProjectDefaultNetworkTierProvider,
} from "./Compute/ProjectDefaultNetworkTier.ts";
import { SharedVpcHost, SharedVpcHostProvider } from "./Compute/SharedVpcHost.ts";
import {
  SharedVpcServiceProject,
  SharedVpcServiceProjectProvider,
} from "./Compute/SharedVpcServiceProject.ts";
import { Subnetwork, SubnetworkProvider } from "./Compute/Subnetwork.ts";
import { Cluster, ClusterProvider } from "./Container/Cluster.ts";
import { NodePool, NodePoolProvider } from "./Container/NodePool.ts";
import {
  ServiceAccount,
  ServiceAccountProvider,
} from "./Iam/ServiceAccount.ts";
import {
  ServiceAccountKey,
  ServiceAccountKeyProvider,
} from "./Iam/ServiceAccountKey.ts";
import {
  HelmRelease,
  HelmReleaseProvider,
} from "./Kubernetes/Helm.ts";
import {
  KubernetesManifest,
  KubernetesManifestProvider,
} from "./Kubernetes/KubernetesManifest.ts";
import {
  KubernetesSecret,
  KubernetesSecretProvider,
} from "./Kubernetes/Secret.ts";
import {
  ManagedLustreInstance,
  ManagedLustreInstanceProvider,
} from "./ManagedLustre/Instance.ts";
import { Job, JobProvider } from "./Run/Job.ts";
import { Service, ServiceProvider } from "./Run/Service.ts";
import {
  PsaConnection,
  PsaConnectionProvider,
} from "./ServiceNetworking/PsaConnection.ts";
import {
  StorageBucket,
  StorageBucketProvider,
} from "./Storage/Bucket.ts";
import {
  StorageBucketIamMember,
  StorageBucketIamMemberProvider,
} from "./Storage/StorageBucketIamMember.ts";
import { ApiEnable, ApiEnableProvider } from "./ServiceUsage/ApiEnable.ts";
import { SqlDatabase, SqlDatabaseProvider } from "./Sqladmin/Database.ts";
import { SqlInstance, SqlInstanceProvider } from "./Sqladmin/Instance.ts";
import { SqlUser, SqlUserProvider } from "./Sqladmin/User.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("GCP") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Bundle the GCP resource providers, AuthProvider-backed credentials, and an
 * HTTP client into a single Layer suitable for `Alchemy.Stack({ providers })`.
 *
 * Credentials resolve through the Alchemy AuthProvider registry — the active
 * profile (from `ALCHEMY_PROFILE`, default `"default"`) configures `project`
 * and optional `keyFile` overrides; everything else (ADC discovery, env-var
 * key files, metadata server) is delegated to `google-auth-library`. To
 * bypass the registry, import {@link fromADC} directly.
 *
 * `FetchHttpClient.layer` is provided once at the Stack level (see
 * `vendor/alchemy/packages/alchemy/src/Stack.ts`); we intentionally do NOT
 * re-provide it here, mirroring `AWS/Providers.ts` and
 * `Cloudflare/Providers.ts`.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Project,
      Cluster,
      NodePool,
      ApiEnable,
      Network,
      ProjectDefaultNetworkTier,
      Subnetwork,
      Firewall,
      Address,
      ForwardingRule,
      GlobalAddress,
      SharedVpcHost,
      SharedVpcServiceProject,
      PsaConnection,
      ManagedLustreInstance,
      StorageBucket,
      StorageBucketIamMember,
      Service,
      Job,
      SqlInstance,
      SqlDatabase,
      SqlUser,
      ArtifactRegistryRepository,
      ArtifactRegistryRepositoryIamMember,
      ServiceAccount,
      ServiceAccountKey,
      KubernetesSecret,
      KubernetesManifest,
      HelmRelease,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectProvider(),
        ClusterProvider(),
        NodePoolProvider(),
        ApiEnableProvider(),
        NetworkProvider(),
        ProjectDefaultNetworkTierProvider(),
        SubnetworkProvider(),
        FirewallProvider(),
        AddressProvider(),
        ForwardingRuleProvider(),
        GlobalAddressProvider(),
        SharedVpcHostProvider(),
        SharedVpcServiceProjectProvider(),
        PsaConnectionProvider(),
        ManagedLustreInstanceProvider(),
        StorageBucketProvider(),
        StorageBucketIamMemberProvider(),
        ServiceProvider(),
        JobProvider(),
        SqlInstanceProvider(),
        SqlDatabaseProvider(),
        SqlUserProvider(),
        ArtifactRegistryRepositoryProvider(),
        ArtifactRegistryRepositoryIamMemberProvider(),
        ServiceAccountProvider(),
        ServiceAccountKeyProvider(),
        KubernetesSecretProvider(),
        KubernetesManifestProvider(),
        HelmReleaseProvider(),
      ),
    ),
    Layer.provideMerge(fromAuthProvider()),
    Layer.provideMerge(GCPAuth),
    // Auth/config failures (missing ADC, malformed profile) become
    // unrecoverable defects rather than typed errors — mirrors
    // `AWS/Providers.ts` and `Cloudflare/Providers.ts`. Resource lifecycle
    // handlers still surface their own typed errors normally.
    Layer.orDie,
  );
