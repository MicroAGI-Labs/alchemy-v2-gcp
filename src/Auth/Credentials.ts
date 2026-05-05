import { Credentials } from "@distilled.cloud/gcp";
import { ConfigError } from "@distilled.cloud/gcp";
import { getAuthProvider } from "alchemy/Auth/AuthProvider";
import { ALCHEMY_PROFILE, loadOrConfigure } from "alchemy/Auth/Profile";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { GoogleAuth } from "google-auth-library";
import {
  GCP_AUTH_PROVIDER_NAME,
  type GCPAuthConfig,
  type GCPResolvedCredentials,
} from "./AuthProvider.ts";

export { Credentials } from "@distilled.cloud/gcp";

const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

/**
 * Resolves a GCP `Credentials` Layer from Application Default Credentials.
 *
 * Locally this picks up `gcloud auth application-default login`; in CI it
 * picks up workload identity / metadata-server tokens. The `Credentials`
 * tag we provide is the one re-exported from `@distilled.cloud/gcp` so the
 * SDK's own operations see this Layer.
 *
 * Prefer {@link fromAuthProvider} when the stack is wired through the
 * Alchemy AuthProvider registry (multi-profile, `alchemy login`). Use this
 * directly when you want a single-profile ADC bridge with no profile
 * resolution.
 *
 * @param project Optional quota/billing project id. Falls back to
 * `GOOGLE_PROJECT_ID` / `GOOGLE_CLOUD_PROJECT` and finally to the project
 * inferred by `google-auth-library`.
 */
export const fromADC = (project?: string) =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const auth = yield* Effect.sync(() => new GoogleAuth({ scopes: SCOPES }));

      const accessToken = yield* Effect.tryPromise({
        try: () => auth.getAccessToken(),
        catch: (cause) =>
          new ConfigError({
            message: `Failed to acquire ADC access token: ${
              (cause as { message?: string })?.message ?? String(cause)
            }. Run \`gcloud auth application-default login\` locally.`,
          }),
      });

      if (!accessToken) {
        return yield* new ConfigError({
          message:
            "Application Default Credentials returned an empty access token. Run `gcloud auth application-default login`.",
        });
      }

      const resolvedProject =
        project ??
        process.env.GOOGLE_PROJECT_ID ??
        process.env.GOOGLE_CLOUD_PROJECT ??
        (yield* Effect.tryPromise({
          try: () => auth.getProjectId(),
          catch: () => "no-project" as const,
        }).pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined))));

      return {
        accessToken: Redacted.make(accessToken),
        project: resolvedProject ?? undefined,
      };
    }),
  );

/**
 * Build a `Credentials` layer that resolves GCP credentials via the Alchemy
 * AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 *
 * Routes through `loadOrConfigure` so a missing profile triggers the
 * provider's `configure` step (interactive locally, `{ method: "adc" }` in
 * CI) before reading credentials. The provider's `read` mints a fresh token
 * via `google-auth-library` for both ADC and service-account-key methods.
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
        Effect.flatMap((config) =>
          auth.read(profileName, config as GCPAuthConfig),
        ),
        Effect.map((creds) => ({
          accessToken: creds.accessToken,
          project: creds.project,
        })),
        Effect.mapError(
          (e) =>
            new ConfigError({
              message: `Failed to resolve GCP credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.provide(ctx),
      );
    }),
  );
