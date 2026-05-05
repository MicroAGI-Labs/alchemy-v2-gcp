import {
  AuthError,
  AuthProviderLayer,
  type ConfigureContext,
} from "alchemy/Auth/AuthProvider";
import {
  deleteCredentials,
  displayRedacted,
  readCredentials,
  writeCredentials,
} from "alchemy/Auth/Credentials";
import { getEnv, retryOnce } from "alchemy/Auth/Env";
import * as Clank from "alchemy/Util/Clank";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import { GoogleAuth } from "google-auth-library";

const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

export const GCP_AUTH_PROVIDER_NAME = "GCP";

/**
 * Selected method plus optional default project for a GCP profile.
 *
 * - `adc` — Application Default Credentials. Locally this resolves
 *   `gcloud auth application-default login`; in CI it picks up workload
 *   identity / metadata-server tokens. This is the default and works for
 *   the vast majority of cases.
 * - `serviceAccountKey` — points at a JSON key file on disk. The path is
 *   stored under `~/.alchemy/credentials/{profile}/gcp-service-account.json`;
 *   the JSON itself stays where the user already has it.
 */
export type GCPAuthConfig =
  | { method: "adc"; project?: string }
  | { method: "serviceAccountKey"; project?: string };

export interface GCPStoredServiceAccount {
  type: "serviceAccountKey";
  keyFilePath: string;
}

export interface GCPResolvedCredentials {
  accessToken: Redacted.Redacted<string>;
  project: string | undefined;
  source: { type: GCPAuthConfig["method"]; details?: string };
}

const options: Array<{
  value: GCPAuthConfig["method"];
  label: string;
  hint?: string;
}> = [
  {
    value: "adc",
    label: "Application Default Credentials",
    hint: "recommended — `gcloud auth application-default login` (local) or workload identity (CI)",
  },
  {
    value: "serviceAccountKey",
    label: "Service Account Key",
    hint: "path to a JSON key file (stored as a path, not the key contents)",
  },
];

/**
 * Layer that registers the GCP {@link AuthProvider} into the
 * {@link AuthProviders} registry when built. Include this in the GCP
 * `providers()` layer so `alchemy login` can discover it.
 */
export const GCPAuth = AuthProviderLayer<
  GCPAuthConfig,
  GCPResolvedCredentials
>()(GCP_AUTH_PROVIDER_NAME, {
  configure: (profileName, ctx) => configureCredentials(profileName, ctx),
  login: (profileName, config) => login(profileName, config),
  logout: (profileName, config) => logout(profileName, config),
  prettyPrint: (profileName, config) => prettyPrint(profileName, config),
  read: (profileName, config) => resolveCredentials(profileName, config),
});

const resolveCredentials = (
  profileName: string,
  config: GCPAuthConfig,
): Effect.Effect<GCPResolvedCredentials, AuthError, FileSystem.FileSystem> =>
  Match.value(config).pipe(
    Match.when({ method: "adc" }, (cfg) =>
      mintToken({ scopes: SCOPES }).pipe(
        Effect.map(({ accessToken, project }) => ({
          accessToken,
          project: cfg.project ?? project,
          source: { type: "adc" as const },
        })),
      ),
    ),
    Match.when({ method: "serviceAccountKey" }, (cfg) =>
      readCredentials<GCPStoredServiceAccount>(
        profileName,
        "gcp-service-account",
      ).pipe(
        Effect.flatMap((stored) =>
          stored == null
            ? Effect.fail(
                new AuthError({
                  message:
                    "GCP service-account credentials not found. Run: alchemy login --configure",
                }),
              )
            : mintToken({ scopes: SCOPES, keyFile: stored.keyFilePath }).pipe(
                Effect.map(({ accessToken, project }) => ({
                  accessToken,
                  project: cfg.project ?? project,
                  source: {
                    type: "serviceAccountKey" as const,
                    details: stored.keyFilePath,
                  },
                })),
              ),
        ),
      ),
    ),
    Match.exhaustive,
  );

const mintToken = (opts: { scopes: string[]; keyFile?: string }) =>
  Effect.gen(function* () {
    const auth = yield* Effect.sync(
      () =>
        new GoogleAuth({
          scopes: opts.scopes,
          ...(opts.keyFile ? { keyFile: opts.keyFile } : {}),
        }),
    );
    const accessToken = yield* Effect.tryPromise({
      try: () => auth.getAccessToken(),
      catch: (cause) =>
        new AuthError({
          message: `Failed to acquire GCP access token: ${
            (cause as { message?: string })?.message ?? String(cause)
          }. Run \`gcloud auth application-default login\` (ADC) or check the service-account key file.`,
          cause,
        }),
    });
    if (!accessToken) {
      return yield* Effect.fail(
        new AuthError({
          message:
            "GCP returned an empty access token. Run `gcloud auth application-default login`.",
        }),
      );
    }
    const project = yield* Effect.tryPromise({
      try: () => auth.getProjectId(),
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)));
    return {
      accessToken: Redacted.make(accessToken),
      project: project ?? undefined,
    };
  });

const logout = (profileName: string, config: GCPAuthConfig) =>
  Match.value(config).pipe(
    Match.when({ method: "adc" }, () => Effect.void),
    Match.when({ method: "serviceAccountKey" }, () =>
      deleteCredentials(profileName, "gcp-service-account").pipe(
        Effect.andThen(
          Clank.success("GCP: stored service-account credentials removed"),
        ),
      ),
    ),
    Match.exhaustive,
  );

const login = (profileName: string, config: GCPAuthConfig) =>
  Match.value(config)
    .pipe(
      Match.when({ method: "adc" }, () =>
        mintToken({ scopes: SCOPES }).pipe(
          Effect.tap(() => Clank.success("GCP: ADC credentials available.")),
          Effect.asVoid,
        ),
      ),
      Match.when({ method: "serviceAccountKey" }, () =>
        readCredentials<GCPStoredServiceAccount>(
          profileName,
          "gcp-service-account",
        ).pipe(
          Effect.flatMap((stored) =>
            stored == null ? loginServiceAccount(profileName) : Effect.void,
          ),
          Effect.asVoid,
        ),
      ),
      Match.exhaustive,
    )
    .pipe(
      Effect.mapError(
        (e) => new AuthError({ message: "login failed", cause: e }),
      ),
    );

const configureCredentials = (profileName: string, ctx: ConfigureContext) =>
  Effect.gen(function* () {
    if (ctx.ci) {
      return { method: "adc" as const };
    }
    return yield* configureInteractive(profileName);
  }).pipe(
    Effect.mapError(
      (e) =>
        new AuthError({
          message: "failed to configure credentials",
          cause: e,
        }),
    ),
  );

const configureInteractive = (profileName: string) =>
  Clank.select({ message: "GCP authentication method", options }).pipe(
    Effect.flatMap((method) =>
      Match.value(method).pipe(
        Match.when("adc", () =>
          Effect.gen(function* () {
            yield* mintToken({ scopes: SCOPES }).pipe(
              Effect.tap(() =>
                Clank.success("GCP: ADC credentials available."),
              ),
              Effect.catch((e) =>
                Clank.warn(
                  `GCP: could not mint ADC token (${(e as { message?: string }).message ?? String(e)}). Continuing — alchemy will retry on use.`,
                ),
              ),
            );
            const project = yield* promptProject();
            return {
              method: "adc" as const,
              ...(project ? { project } : {}),
            };
          }),
        ),
        Match.when("serviceAccountKey", () => loginServiceAccount(profileName)),
        Match.exhaustive,
      ),
    ),
  );

const loginServiceAccount = Effect.fnUntraced(function* (profileName: string) {
  const fs = yield* FileSystem.FileSystem;
  const keyFilePath = yield* Clank.text({
    message: "Path to GCP service-account JSON key",
    validate: (v) => (v.length === 0 ? "Required" : undefined),
  }).pipe(retryOnce);

  const exists = yield* fs.exists(keyFilePath).pipe(
    Effect.catch(() => Effect.succeed(false)),
  );
  if (!exists) {
    return yield* Effect.fail(
      new AuthError({
        message: `Service-account key file not found: ${keyFilePath}`,
      }),
    );
  }

  yield* writeCredentials<GCPStoredServiceAccount>(
    profileName,
    "gcp-service-account",
    { type: "serviceAccountKey", keyFilePath },
  );
  yield* Clank.success("GCP: service-account credentials saved.");

  const project = yield* promptProject();
  return {
    method: "serviceAccountKey" as const,
    ...(project ? { project } : {}),
  };
});

const promptProject = () =>
  Effect.gen(function* () {
    const explicit = yield* getEnv("GOOGLE_PROJECT_ID");
    const fallback = yield* getEnv("GOOGLE_CLOUD_PROJECT");
    const envProject = explicit ?? fallback;
    const value = yield* Clank.text({
      message: "Default GCP project (Enter to skip)",
      placeholder: envProject ?? "",
      defaultValue: envProject ?? "",
    }).pipe(retryOnce);
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  });

const prettyPrint = (profileName: string, config: GCPAuthConfig) =>
  resolveCredentials(profileName, config).pipe(
    Effect.tap((creds) => {
      const sourceStr = creds.source.details
        ? `${creds.source.type} - ${creds.source.details}`
        : creds.source.type;
      return Effect.all([
        Console.log(`  accessToken: ${displayRedacted(creds.accessToken, 6)}`),
        Console.log(`  project:     ${creds.project ?? "(none)"}`),
        Console.log(`  source:      ${sourceStr}`),
      ]);
    }),
    Effect.catch((e) =>
      Console.error(`  Failed to retrieve credentials: ${e}`),
    ),
  );
