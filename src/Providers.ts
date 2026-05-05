import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { GCPAuth } from "./Auth/AuthProvider.ts";
import { fromAuthProvider } from "./Auth/Credentials.ts";
import { Project, ProjectProvider } from "./CloudResourceManager/Project.ts";

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
  Layer.effect(Providers, Provider.collection([Project])).pipe(
    Layer.provide(Layer.mergeAll(ProjectProvider())),
    Layer.provideMerge(fromAuthProvider()),
    Layer.provideMerge(GCPAuth),
  );
