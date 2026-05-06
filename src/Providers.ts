import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { GCPAuth } from "./Auth/AuthProvider.ts";
import { fromAuthProvider } from "./Auth/Credentials.ts";
import { Project, ProjectProvider } from "./CloudResourceManager/Project.ts";
import { GlobalAddress, GlobalAddressProvider } from "./Compute/GlobalAddress.ts";
import { Network, NetworkProvider } from "./Compute/Network.ts";
import { SharedVpcHost, SharedVpcHostProvider } from "./Compute/SharedVpcHost.ts";
import {
  SharedVpcServiceProject,
  SharedVpcServiceProjectProvider,
} from "./Compute/SharedVpcServiceProject.ts";
import { Subnetwork, SubnetworkProvider } from "./Compute/Subnetwork.ts";
import { Cluster, ClusterProvider } from "./Container/Cluster.ts";
import { NodePool, NodePoolProvider } from "./Container/NodePool.ts";
import {
  ParallelstoreInstance,
  ParallelstoreInstanceProvider,
} from "./Parallelstore/Instance.ts";
import {
  PsaConnection,
  PsaConnectionProvider,
} from "./ServiceNetworking/PsaConnection.ts";
import { ApiEnable, ApiEnableProvider } from "./ServiceUsage/ApiEnable.ts";

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
      Subnetwork,
      GlobalAddress,
      SharedVpcHost,
      SharedVpcServiceProject,
      PsaConnection,
      ParallelstoreInstance,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectProvider(),
        ClusterProvider(),
        NodePoolProvider(),
        ApiEnableProvider(),
        NetworkProvider(),
        SubnetworkProvider(),
        GlobalAddressProvider(),
        SharedVpcHostProvider(),
        SharedVpcServiceProjectProvider(),
        PsaConnectionProvider(),
        ParallelstoreInstanceProvider(),
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
