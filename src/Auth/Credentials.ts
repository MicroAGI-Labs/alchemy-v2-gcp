import { ConfigError, Credentials } from "@distilled.cloud/gcp";
import { getAuthProvider } from "alchemy/Auth/AuthProvider";
import { ALCHEMY_PROFILE, loadOrConfigure } from "alchemy/Auth/Profile";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  GCP_AUTH_PROVIDER_NAME,
  type GCPAuthConfig,
  type GCPResolvedCredentials,
  mintToken,
} from "./AuthProvider.ts";

export { Credentials } from "@distilled.cloud/gcp";

const toConfigError = (e: { message?: string } | unknown) =>
  new ConfigError({
    message: `Failed to resolve GCP credentials: ${
      (e as { message?: string })?.message ?? String(e)
    }`,
  });

/**
 * Single-profile ADC bridge. Bypasses the `AuthProvider` registry —
 * useful for tests and one-off scripts where multi-profile resolution
 * isn't needed. All credential discovery is delegated to
 * `google-auth-library`; the optional `project` argument overrides
 * the project the library would discover.
 *
 * Prefer {@link fromAuthProvider} when the stack runs through
 * `alchemy login` / `ALCHEMY_PROFILE`.
 */
export const fromADC = (project?: string) =>
  Layer.effect(
    Credentials,
    mintToken({ project }).pipe(Effect.mapError(toConfigError)),
  );

/**
 * Build a `Credentials` Layer that resolves GCP credentials via the
 * Alchemy AuthProvider registry, using the active profile (from
 * `ALCHEMY_PROFILE`, default `"default"`).
 *
 * Routes through `loadOrConfigure` so a missing profile triggers the
 * provider's `configure` step (interactive locally, `{ method: "adc" }`
 * in CI) before reading credentials. Both methods of the provider
 * ultimately call `mintToken`, which is just a thin wrapper over
 * `google-auth-library`.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const auth = yield* getAuthProvider<
        GCPAuthConfig,
        GCPResolvedCredentials
      >(GCP_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const ctx = yield* Effect.context<never>();

      return yield* loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((cfg) => auth.read(profileName, cfg as GCPAuthConfig)),
        Effect.map(({ accessToken, project }) => ({ accessToken, project })),
        Effect.mapError(toConfigError),
        Effect.provide(ctx),
      );
    }),
  );
