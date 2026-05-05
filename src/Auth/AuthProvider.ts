import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "alchemy/Auth/AuthProvider";
import { displayRedacted } from "alchemy/Auth/Credentials";
import { retryOnce } from "alchemy/Auth/Env";
import * as Clank from "alchemy/Util/Clank";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import { GoogleAuth } from "google-auth-library";

const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

export const GCP_AUTH_PROVIDER_NAME = "GCP";

/**
 * GCP profile config.
 *
 * There is intentionally a single method — `adc` — because
 * `google-auth-library` already discovers every credential source we
 * care about, in this priority order:
 *
 * 1. `GOOGLE_APPLICATION_CREDENTIALS` env var → JSON service-account key
 * 2. gcloud user ADC at `~/.config/gcloud/application_default_credentials.json`
 * 3. GCE/GKE metadata server (workload identity)
 *
 * To pin a specific key file at the *profile* level (rather than
 * process-wide via the env var), set `keyFile`. To override the
 * billing/quota project, set `project`. Both are passed straight
 * through to `new GoogleAuth({ ... })`.
 */
export type GCPAuthConfig = {
  method: "adc";
  /** Override the project that google-auth-library would discover. */
  project?: string;
  /** Pin a specific service-account JSON key file to this profile. */
  keyFile?: string;
};

export interface GCPResolvedCredentials {
  accessToken: Redacted.Redacted<string>;
  project: string | undefined;
}

/**
 * Mint a fresh access token (and resolve a project) by delegating to
 * `google-auth-library`. All credential discovery — env-var key files,
 * gcloud user ADC, metadata server — is the library's job; we just
 * pass through `project` / `keyFile` overrides.
 */
export const mintToken = (
  config: { project?: string; keyFile?: string } = {},
): Effect.Effect<GCPResolvedCredentials, AuthError> =>
  Effect.gen(function* () {
    const auth = yield* Effect.sync(
      () =>
        new GoogleAuth({
          scopes: SCOPES,
          ...(config.keyFile ? { keyFile: config.keyFile } : {}),
          ...(config.project ? { projectId: config.project } : {}),
        }),
    );
    const accessToken = yield* Effect.tryPromise({
      try: () => auth.getAccessToken(),
      catch: (cause) =>
        new AuthError({
          message: `Failed to acquire GCP access token: ${
            (cause as { message?: string })?.message ?? String(cause)
          }. Run \`gcloud auth application-default login\` or set GOOGLE_APPLICATION_CREDENTIALS.`,
          cause,
        }),
    });
    if (!accessToken) {
      return yield* new AuthError({
        message:
          "google-auth-library returned an empty access token. Run `gcloud auth application-default login` or set GOOGLE_APPLICATION_CREDENTIALS.",
      });
    }
    const project = yield* Effect.tryPromise({
      try: () => auth.getProjectId(),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed<string | undefined>(() => undefined));
    return {
      accessToken: Redacted.make(accessToken),
      project: project ?? undefined,
    };
  });

const configureCredentials = (
  _profileName: string,
  ctx: ConfigureContext,
): Effect.Effect<GCPAuthConfig, AuthError> =>
  Effect.gen(function* () {
    if (ctx.ci) return { method: "adc" as const };

    // Validate that google-auth-library can resolve credentials. If it
    // can't, surface a hint but don't block — the user might be about
    // to fix their environment, and `read` will fail loudly later.
    yield* mintToken().pipe(
      Effect.tap(() => Clank.success("GCP: ADC credentials available.")),
      Effect.catch((e) =>
        Clank.warn(
          `GCP: ${e.message} — continuing; alchemy will retry when credentials are needed.`,
        ).pipe(Effect.asVoid),
      ),
    );

    const project = yield* Clank.text({
      message:
        "Default GCP project (Enter to defer to google-auth-library discovery)",
      placeholder:
        process.env.GOOGLE_CLOUD_PROJECT ??
        process.env.GOOGLE_PROJECT_ID ??
        "",
      defaultValue: "",
    }).pipe(
      retryOnce,
      Effect.catch(() => Effect.succeed("")),
    );

    return {
      method: "adc" as const,
      ...(project.trim() ? { project: project.trim() } : {}),
    };
  });

const login = (_profileName: string, config: GCPAuthConfig) =>
  mintToken(config).pipe(
    Effect.tap(() => Clank.success("GCP: credentials valid.")),
    Effect.asVoid,
  );

const logout = (_profileName: string, _config: GCPAuthConfig) =>
  Clank.info(
    "GCP: credentials are managed by google-auth-library. Run `gcloud auth application-default revoke` to revoke user ADC, or unset GOOGLE_APPLICATION_CREDENTIALS to drop a service-account key.",
  );

const resolveCredentials = (
  _profileName: string,
  config: GCPAuthConfig,
): Effect.Effect<GCPResolvedCredentials, AuthError> =>
  Match.value(config).pipe(
    Match.when({ method: "adc" }, (cfg) => mintToken(cfg)),
    Match.exhaustive,
  );

const prettyPrint = (profileName: string, config: GCPAuthConfig) =>
  resolveCredentials(profileName, config).pipe(
    Effect.tap((creds) =>
      Effect.all([
        Console.log(`  accessToken: ${displayRedacted(creds.accessToken, 6)}`),
        Console.log(`  project:     ${creds.project ?? "(none)"}`),
        Console.log(
          `  source:      google-auth-library${config.keyFile ? ` (keyFile=${config.keyFile})` : config.project ? " (ADC + pinned project)" : " (ADC)"}`,
        ),
      ]),
    ),
    Effect.catch((e) =>
      Console.error(`  Failed to retrieve credentials: ${e}`),
    ),
  );

/**
 * Layer that registers the GCP {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the GCP
 * `providers()` layer so `alchemy login` can discover it.
 */
export const GCPAuth = AuthProviderLayer<
  GCPAuthConfig,
  GCPResolvedCredentials
>()(GCP_AUTH_PROVIDER_NAME, {
  configure: configureCredentials,
  login,
  logout,
  prettyPrint,
  read: resolveCredentials,
});
