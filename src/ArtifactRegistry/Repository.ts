import * as ar from "@distilled.cloud/gcp/artifactregistry-v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { deepEqual, isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { diffTags } from "alchemy/Tags";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as GCP from "../Providers.ts";
import { gcpInternalLabels, hasAlchemyLabels } from "../Tags.ts";
import { makeAwaitOperation } from "./Operations.ts";
import type { ArtifactRegistryFormat, ArtifactRegistryMode } from "./Types.ts";
import {
  reshapeBadRequest,
  validateModeConfig,
  validateRepositoryName,
} from "./Validation.ts";

/**
 * Docker remote upstream — either a Google-known public repository
 * (today: Docker Hub) or an arbitrary HTTPS Docker registry like
 * `https://nvcr.io` or `https://quay.io`. Discriminated union — the
 * server rejects bodies that supply both. Matches
 * `ar.DockerRepository`.
 *
 * @see https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories#DockerRepository
 */
export type ArtifactRegistryDockerUpstream =
  | {
      /**
       * One of Artifact Registry's built-in public-repository
       * presets. Today only `DOCKER_HUB` is meaningful for the docker
       * format. The string-tail is left open for forward compat with
       * any future presets the server adds.
       */
      publicRepository: "DOCKER_HUB" | (string & {});
      customRepository?: never;
    }
  | {
      /**
       * Arbitrary HTTPS Docker upstream — `https://nvcr.io`,
       * `https://quay.io`, a self-hosted Harbor, etc. The server
       * trims any path / pulls the manifest endpoint conventionally.
       */
      customRepository: { uri: string };
      publicRepository?: never;
    };

/**
 * A Google Artifact Registry **Repository** of `format: "DOCKER"` —
 * either a standard upload-target (`STANDARD_REPOSITORY`) for the
 * project's own container builds, or a pull-through cache
 * (`REMOTE_REPOSITORY`) pointing at Docker Hub or a custom upstream
 * like `nvcr.io`.
 *
 * **Resource model.** A repository lives at
 * `projects/{project}/locations/{location}/repositories/{name}`.
 * Format and mode are immutable; the upstream config for a remote
 * repository is also immutable on the GCP side (any change triggers a
 * replace).
 *
 * **Lifecycle.** observe → ensure (create LRO; retry on the
 * "API not yet enabled" 403 propagation race) → sync (patch
 * description, labels, dockerConfig, cleanup policies via
 * `updateMask`) → return. Mirrors `Sqladmin/Instance.ts` /
 * `Run/Service.ts`.
 *
 * **Replace triggers.** `project`, `location`, `name`, `format`,
 * `mode`, `kmsKeyName`, and any change inside `remoteRepositoryConfig`.
 *
 * **Adoption.** Label-gated via `alchemy_*` labels. A repository
 * whose `labels` lack our keys is wrapped in `Unowned(attrs)` from
 * `read`, forcing `--adopt` before takeover.
 *
 * @example Standard Docker repo for the project's own builds
 * ```typescript
 * const apps = yield* GCP.ArtifactRegistryRepository("Apps", {
 *   project: project.projectId,
 *   location: "europe-west4",
 *   format: "DOCKER",
 *   description: "App images built by CI",
 * });
 * ```
 *
 * @example Pull-through cache for Docker Hub
 * ```typescript
 * yield* GCP.ArtifactRegistryRepository("DockerHubMirror", {
 *   project: project.projectId,
 *   location: "europe-west4",
 *   format: "DOCKER",
 *   mode: "REMOTE_REPOSITORY",
 *   remoteRepositoryConfig: {
 *     description: "Pull-through cache for docker.io",
 *     dockerRepository: { publicRepository: "DOCKER_HUB" },
 *   },
 * });
 * ```
 *
 * @example Pull-through cache for nvcr.io
 * ```typescript
 * yield* GCP.ArtifactRegistryRepository("NvcrMirror", {
 *   project: project.projectId,
 *   location: "europe-west4",
 *   format: "DOCKER",
 *   mode: "REMOTE_REPOSITORY",
 *   remoteRepositoryConfig: {
 *     description: "Pull-through cache for nvcr.io",
 *     dockerRepository: { customRepository: { uri: "https://nvcr.io" } },
 *   },
 * });
 * ```
 *
 * @see https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories#Repository
 */
export type ArtifactRegistryRepositoryProps = {
  /**
   * GCP project ID hosting the repository. Immutable — replace if
   * changed.
   * @see https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories#Repository
   */
  project: string;
  /**
   * Artifact Registry location (e.g. `europe-west4`). Regional only —
   * multi-region is not supported by this resource. Immutable.
   * @see https://cloud.google.com/artifact-registry/docs/repositories/repo-locations
   */
  location: string;
  /**
   * Repository short name (the trailing path segment under
   * `…/repositories/`). Defaults to a sanitised
   * `createPhysicalName({ id, lowercase: true, maxLength: 63 })`.
   * Lowercase letters/digits/hyphens; start with a letter or digit;
   * 1–63 chars. Immutable — replace if changed.
   * @see https://cloud.google.com/artifact-registry/docs/repositories/create-repos#create
   */
  name?: string;
  /**
   * Package format. Today the provider exercises only `DOCKER`; other
   * formats are reachable via the open-tail union but un-tested.
   * Immutable — replace if changed.
   * @see https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories#Format
   */
  format: ArtifactRegistryFormat;
  /**
   * Repository mode. Defaults to `STANDARD_REPOSITORY`. Set to
   * `REMOTE_REPOSITORY` to act as a pull-through cache for an upstream
   * Docker registry; in that case `remoteRepositoryConfig` is
   * required. Immutable — replace if changed (GCP does not allow
   * flipping a repository between modes).
   * @see https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories#Mode
   */
  mode?: ArtifactRegistryMode;
  /**
   * Human-readable description. Mutable via `patch` with
   * `updateMask=description`.
   * @see https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories#Repository.FIELDS.description
   */
  description?: string;
  /**
   * Resource labels. Alchemy internal labels (`alchemy_app`,
   * `alchemy_stage`, `alchemy_id`) are merged on top automatically.
   * Mutable via `patch` with `updateMask=labels`.
   * @see https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories#Repository.FIELDS.labels
   */
  labels?: Record<string, string>;
  /**
   * Customer-managed encryption key, fully-qualified
   * (`projects/{p}/locations/{l}/keyRings/{kr}/cryptoKeys/{k}`).
   * Immutable on the GCP side — we surface that as a replace trigger.
   * Requires the AR service agent to hold
   * `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the key.
   * @see https://cloud.google.com/artifact-registry/docs/cmek
   */
  kmsKeyName?: string;
  /**
   * Docker-format repository configuration. Mutable via `patch` with
   * `updateMask=dockerConfig`.
   * @see https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories#DockerRepositoryConfig
   */
  dockerConfig?: {
    /**
     * When true, image tags inside this repository cannot be moved or
     * deleted once written. Useful for supply-chain hardening.
     */
    immutableTags?: boolean;
  };
  /**
   * Remote-repository configuration. Required (and only meaningful)
   * when `mode === "REMOTE_REPOSITORY"`. Immutable on the GCP side —
   * any change to fields under this object triggers a replace.
   * @see https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories#RemoteRepositoryConfig
   */
  remoteRepositoryConfig?: {
    /**
     * Description of the remote source (distinct from the top-level
     * `description`).
     */
    description?: string;
    /** Docker upstream — public preset or arbitrary HTTPS URI. */
    dockerRepository?: ArtifactRegistryDockerUpstream;
    /**
     * If true, AR skips the create-time HEAD request against the
     * upstream. Useful for upstreams that gate unauthenticated probes
     * (private nvcr.io paths, etc.).
     */
    disableUpstreamValidation?: boolean;
    /**
     * Credentials for authenticated upstreams — supply a Secret
     * Manager version reference for the password rather than the
     * cleartext value.
     */
    upstreamCredentials?: {
      usernamePasswordCredentials?: {
        username?: string;
        /**
         * Secret Manager secret version path:
         * `projects/{p}/secrets/{s}/versions/{v}`.
         */
        passwordSecretVersion?: string;
      };
    };
  };
  /**
   * Cleanup policies — map of policy ID → policy spec. Pass-through
   * to the API today; the policy types are accepted via the
   * distilled SDK's `CleanupPolicy` shape but not specifically
   * validated by this provider. Mutable via `patch` with
   * `updateMask=cleanupPolicies`.
   * @see https://cloud.google.com/artifact-registry/docs/repositories/cleanup-policy
   */
  cleanupPolicies?: Record<string, ar.CleanupPolicy>;
  /**
   * If true, cleanup policies are evaluated and reported but no
   * versions are actually deleted. Mutable via `patch` with
   * `updateMask=cleanupPolicyDryRun`.
   * @see https://cloud.google.com/artifact-registry/docs/repositories/cleanup-policy#test
   */
  cleanupPolicyDryRun?: boolean;
};

export type ArtifactRegistryRepositoryAttributes = {
  /** Bare repository name (no `projects/.../repositories/` prefix). */
  name: string;
  /**
   * Server-side fully-qualified name:
   * `projects/{project}/locations/{location}/repositories/{name}`.
   */
  fullyQualifiedName: string;
  /** GCP project ID. */
  project: string;
  /** Region. */
  location: string;
  /** Echoed format (e.g. `DOCKER`). */
  format: string;
  /** Echoed mode (e.g. `STANDARD_REPOSITORY`). */
  mode: string;
  /**
   * Repository endpoint (e.g. `europe-west4-docker.pkg.dev/proj/repo`)
   * — the host:path you'd `docker pull` from. Populated by the server.
   */
  registryUri: string | undefined;
  /** Total stored size in bytes, server-reported. */
  sizeBytes: string | undefined;
  /** PZS compliance flag. */
  satisfiesPzs: boolean | undefined;
  /** PZI compliance flag. */
  satisfiesPzi: boolean | undefined;
  /** Labels currently set, including alchemy internals. */
  labels: Record<string, string>;
  /** RFC3339 create timestamp. */
  createTime: string;
  /** RFC3339 last-update timestamp. */
  updateTime: string;
};

export type ArtifactRegistryRepository = Resource<
  "GCP.ArtifactRegistryRepository",
  ArtifactRegistryRepositoryProps,
  ArtifactRegistryRepositoryAttributes,
  never,
  GCP.Providers
>;
export const ArtifactRegistryRepository =
  Resource<ArtifactRegistryRepository>("GCP.ArtifactRegistryRepository");

const fqName = (project: string, location: string, name: string): string =>
  `projects/${project}/locations/${location}/repositories/${name}`;

const parent = (project: string, location: string): string =>
  `projects/${project}/locations/${location}`;

const toDockerRepositoryBody = (
  upstream: ArtifactRegistryDockerUpstream,
): ar.DockerRepository => {
  if (upstream.publicRepository !== undefined) {
    return { publicRepository: upstream.publicRepository };
  }
  if (upstream.customRepository !== undefined) {
    return { customRepository: { uri: upstream.customRepository.uri } };
  }
  // Unreachable per the discriminated union, but validation also
  // rejects an empty dockerRepository at plan time.
  return {};
};

const toRemoteRepositoryConfigBody = (
  cfg: NonNullable<ArtifactRegistryRepositoryProps["remoteRepositoryConfig"]>,
): ar.RemoteRepositoryConfig => ({
  ...(cfg.description !== undefined ? { description: cfg.description } : {}),
  ...(cfg.dockerRepository
    ? { dockerRepository: toDockerRepositoryBody(cfg.dockerRepository) }
    : {}),
  ...(cfg.disableUpstreamValidation !== undefined
    ? { disableUpstreamValidation: cfg.disableUpstreamValidation }
    : {}),
  ...(cfg.upstreamCredentials
    ? {
        upstreamCredentials: {
          ...(cfg.upstreamCredentials.usernamePasswordCredentials
            ? {
                usernamePasswordCredentials: {
                  ...(cfg.upstreamCredentials.usernamePasswordCredentials
                    .username !== undefined
                    ? {
                        username:
                          cfg.upstreamCredentials.usernamePasswordCredentials
                            .username,
                      }
                    : {}),
                  ...(cfg.upstreamCredentials.usernamePasswordCredentials
                    .passwordSecretVersion !== undefined
                    ? {
                        passwordSecretVersion:
                          cfg.upstreamCredentials.usernamePasswordCredentials
                            .passwordSecretVersion,
                      }
                    : {}),
                },
              }
            : {}),
        },
      }
    : {}),
});

const toRepositoryBody = (
  props: ArtifactRegistryRepositoryProps,
  desiredLabels: Record<string, string>,
): ar.Repository => ({
  format: props.format,
  ...(props.mode ? { mode: props.mode } : {}),
  ...(props.description !== undefined
    ? { description: props.description }
    : {}),
  labels: desiredLabels,
  ...(props.kmsKeyName ? { kmsKeyName: props.kmsKeyName } : {}),
  ...(props.dockerConfig
    ? {
        dockerConfig: {
          ...(props.dockerConfig.immutableTags !== undefined
            ? { immutableTags: props.dockerConfig.immutableTags }
            : {}),
        },
      }
    : {}),
  ...(props.remoteRepositoryConfig
    ? {
        remoteRepositoryConfig: toRemoteRepositoryConfigBody(
          props.remoteRepositoryConfig,
        ),
      }
    : {}),
  ...(props.cleanupPolicies
    ? { cleanupPolicies: props.cleanupPolicies }
    : {}),
  ...(props.cleanupPolicyDryRun !== undefined
    ? { cleanupPolicyDryRun: props.cleanupPolicyDryRun }
    : {}),
});

const toAttributes = (
  r: ar.Repository,
  parentArgs: { project: string; location: string; name: string },
): ArtifactRegistryRepositoryAttributes => ({
  name: parentArgs.name,
  fullyQualifiedName: fqName(
    parentArgs.project,
    parentArgs.location,
    parentArgs.name,
  ),
  project: parentArgs.project,
  location: parentArgs.location,
  format: r.format ?? "",
  mode: r.mode ?? "STANDARD_REPOSITORY",
  registryUri: r.registryUri,
  sizeBytes: r.sizeBytes,
  satisfiesPzs: r.satisfiesPzs,
  satisfiesPzi: r.satisfiesPzi,
  labels: { ...(r.labels ?? {}) },
  createTime: r.createTime ?? "",
  updateTime: r.updateTime ?? "",
});

export const ArtifactRegistryRepositoryProvider = () =>
  Provider.effect(
    ArtifactRegistryRepository,
    Effect.gen(function* () {
      const getRepository = yield* ar.getProjectsLocationsRepositories;
      const createRepository = yield* ar.createProjectsLocationsRepositories;
      const patchRepository = yield* ar.patchProjectsLocationsRepositories;
      const deleteRepository = yield* ar.deleteProjectsLocationsRepositories;
      const getOperations = yield* ar.getProjectsLocationsOperations;
      const awaitOperation = makeAwaitOperation(getOperations);

      const observe = (project: string, location: string, name: string) =>
        getRepository({ name: fqName(project, location, name) }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as ar.Repository | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as ar.Repository | undefined),
          ),
        );

      const syncMutable = Effect.fn(function* (args: {
        name: string;
        observed: ar.Repository;
        news: ArtifactRegistryRepositoryProps;
        desiredLabels: Record<string, string>;
        session: ScopedPlanStatusSession;
      }) {
        const fields: string[] = [];
        const body: ar.Repository = {};

        if ((args.observed.description ?? "") !== (args.news.description ?? "")) {
          fields.push("description");
          body.description = args.news.description ?? "";
        }

        const labelDiff = diffTags(
          { ...(args.observed.labels ?? {}) },
          args.desiredLabels,
        );
        if (labelDiff.removed.length > 0 || labelDiff.upsert.length > 0) {
          fields.push("labels");
          body.labels = args.desiredLabels;
        }

        const desiredDockerConfig = args.news.dockerConfig
          ? {
              ...(args.news.dockerConfig.immutableTags !== undefined
                ? { immutableTags: args.news.dockerConfig.immutableTags }
                : {}),
            }
          : undefined;
        if (!deepEqual(args.observed.dockerConfig, desiredDockerConfig)) {
          fields.push("dockerConfig");
          if (desiredDockerConfig) body.dockerConfig = desiredDockerConfig;
        }

        if (
          !deepEqual(
            args.observed.cleanupPolicies ?? {},
            args.news.cleanupPolicies ?? {},
          )
        ) {
          fields.push("cleanupPolicies");
          if (args.news.cleanupPolicies)
            body.cleanupPolicies = args.news.cleanupPolicies;
        }

        if (
          (args.observed.cleanupPolicyDryRun ?? false) !==
          (args.news.cleanupPolicyDryRun ?? false)
        ) {
          fields.push("cleanupPolicyDryRun");
          body.cleanupPolicyDryRun = args.news.cleanupPolicyDryRun ?? false;
        }

        if (fields.length === 0) return;

        // Patch returns the Repository synchronously (NOT an LRO per
        // `PatchProjectsLocationsRepositoriesResponse = Repository`).
        // No operation to await.
        yield* patchRepository({
          name: args.name,
          updateMask: fields.join(","),
          body,
        }).pipe(Effect.catchTag("BadRequest", reshapeBadRequest("patch")));
      });

      return {
        stables: [
          "name",
          "fullyQualifiedName",
          "project",
          "location",
          "format",
          "mode",
        ],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          // String-typed stables are reference-comparable.
          if (
            somePropsAreDifferent(
              olds as ArtifactRegistryRepositoryProps,
              news,
              ["project", "location", "name", "format", "mode", "kmsKeyName"],
            )
          ) {
            return { action: "replace" } as const;
          }
          // Object-typed stables must use deep equality — JSON-deserialized
          // state never `===` a freshly-built literal even when content matches.
          const oldsTyped = olds as ArtifactRegistryRepositoryProps;
          if (
            !deepEqual(
              oldsTyped.remoteRepositoryConfig,
              news.remoteRepositoryConfig,
            )
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const internalLabels = yield* gcpInternalLabels(id);
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();

          yield* validateRepositoryName(desiredName);
          yield* validateModeConfig(news);

          const desiredLabels: Record<string, string> = {
            ...(news.labels ?? {}),
            ...internalLabels,
          };
          const name = fqName(news.project, news.location, desiredName);

          // 1. Observe — collapse 403 to "missing" alongside 404.
          let observed = yield* observe(news.project, news.location, desiredName);

          // 2. Ensure — create LRO. Same API-enable race as Cloud Run /
          //    Cloud SQL: a create can fire before ApiEnable's effect
          //    propagates and the server returns 403 with "If you
          //    enabled this API recently, wait …". Retry that specific
          //    403 for ~5 min; other Forbiddens propagate.
          if (!observed) {
            const op = yield* createRepository({
              parent: parent(news.project, news.location),
              repositoryId: desiredName,
              body: toRepositoryBody(news, desiredLabels),
            }).pipe(
              Effect.retry({
                while: (e: { _tag?: string; message?: string }) =>
                  e?._tag === "Forbidden" &&
                  /enabled this API recently|has not been used/i.test(
                    e.message ?? "",
                  ),
                schedule: Schedule.max([
                  Schedule.spaced(Duration.seconds(15)),
                  Schedule.recurs(20),
                ]).pipe(
                  Schedule.tap(() =>
                    session.note(
                      "Waiting for Artifact Registry API enablement to propagate…",
                    ),
                  ),
                ),
              }),
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as ar.Operation | undefined),
              ),
              Effect.catchTag("BadRequest", reshapeBadRequest("create")),
            );
            if (op?.name) yield* awaitOperation(op.name, session);
            observed = yield* getRepository({ name });
          }

          // 3. Sync — single patch with an updateMask of changed
          //    top-level fields. `remoteRepositoryConfig` is NOT
          //    patched here: GCP refuses updates to it, so changes
          //    trigger a replace via `diff` above.
          yield* syncMutable({
            name,
            observed,
            news,
            desiredLabels,
            session,
          });

          const final = yield* getRepository({ name });
          return toAttributes(final, {
            project: news.project,
            location: news.location,
            name: desiredName,
          });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const name = fqName(output.project, output.location, output.name);
          yield* deleteRepository({ name }).pipe(
            Effect.flatMap((op) =>
              op.name ? awaitOperation(op.name, session) : Effect.succeed(op),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.catchTag("BadRequest", reshapeBadRequest("delete")),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const project = output?.project ?? olds?.project;
          const location = output?.location ?? olds?.location;
          if (!project || !location) return undefined;
          const name =
            output?.name ??
            olds?.name ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const observed = yield* observe(project, location, name);
          if (!observed) return undefined;
          const attrs = toAttributes(observed, { project, location, name });
          return (yield* hasAlchemyLabels(id, observed.labels))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
