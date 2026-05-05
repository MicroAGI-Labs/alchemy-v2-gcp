import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { GCPAuth } from "./Auth/AuthProvider.ts";
import { fromAuthProvider } from "./Auth/Credentials.ts";
import { Project, ProjectProvider } from "./CloudResourceManager/Project.ts";

export { Credentials, fromADC, fromAuthProvider } from "./Auth/Credentials.ts";
export {
  GCP_AUTH_PROVIDER_NAME,
  GCPAuth,
} from "./Auth/AuthProvider.ts";
export type {
  GCPAuthConfig,
  GCPResolvedCredentials,
} from "./Auth/AuthProvider.ts";
export * from "./CloudResourceManager/index.ts";

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
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Project])).pipe(
    Layer.provide(Layer.mergeAll(ProjectProvider())),
    Layer.provideMerge(fromAuthProvider()),
    Layer.provideMerge(GCPAuth),
    Layer.provideMerge(FetchHttpClient.layer),
  );
