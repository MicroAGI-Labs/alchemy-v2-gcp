import * as sql from "@distilled.cloud/gcp/sqladmin_v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { deepEqual, isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { diffTags } from "alchemy/Tags";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as GCP from "../Providers.ts";
import { gcpInternalLabels, hasAlchemyLabels, normalizeStringMap } from "../Tags.ts";
import { makeAwaitOperation } from "./Operations.ts";
import type {
  PostgresVersion,
  SqlActivationPolicy,
  SqlAvailabilityType,
  SqlDataDiskType,
  SqlEdition,
} from "./Types.ts";
import { reshapeBadRequest, validateInstanceName } from "./Validation.ts";

/**
 * A Cloud SQL for Postgres instance.
 *
 * **Resource model.** A Cloud SQL instance bundles the storage volume,
 * compute tier, networking (public IP / VPC private IP via PSA), and
 * managed backups. Databases (`GCP.SqlDatabase`) and users
 * (`GCP.SqlUser`) hang off it and are modelled as separate resources.
 *
 * **Lifecycle.** observe → ensure (insert; retry on the "API not yet
 * enabled" 403 propagation race) → sync (patch top-level fields, with
 * `settingsVersion` round-trip for optimistic concurrency) → return.
 *
 * **Replace triggers.** `project`, `region`, `name`, `databaseVersion`.
 * Everything else — tier, disk size, IP config, backup config — is
 * in-place via `patch`.
 *
 * **Optimistic concurrency.** Cloud SQL uses `settings.settingsVersion`
 * (NOT `etag` — etag is deprecated). Every patch reads the live
 * instance and threads the observed `settingsVersion` through the
 * body. Concurrent edits surface as `Conflict`.
 *
 * **Adoption.** Label-gated: an instance whose `settings.userLabels`
 * lack our `alchemy_*` keys is wrapped in `Unowned(attrs)` from
 * `read`, forcing `--adopt` before takeover.
 *
 * **Deletion protection.** When `settings.deletionProtectionEnabled`
 * is `true`, alchemy `destroy` will fail with a `BadRequest`. Set the
 * flag to `false` in a separate deploy (which patches the instance),
 * then re-run destroy.
 *
 * @example Minimal private-IP Postgres 17 instance on a Shared VPC
 * ```typescript
 * const db = yield* GCP.SqlInstance("Primary", {
 *   project: project.projectId,
 *   region: "europe-west4",
 *   databaseVersion: "POSTGRES_17",
 *   settings: {
 *     tier: "db-custom-2-7680",
 *     edition: "ENTERPRISE",
 *     dataDiskSizeGb: 50,
 *     ipConfiguration: {
 *       ipv4Enabled: false,
 *       privateNetwork: hostVpc.selfLink,
 *     },
 *     backupConfiguration: { enabled: true, pointInTimeRecoveryEnabled: true },
 *   },
 * });
 * ```
 *
 * @see https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances
 */
export type SqlInstanceProps = {
  /**
   * GCP project ID hosting the instance. Immutable — replace if changed.
   * @see https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances#SqlInstance
   */
  project: string;
  /**
   * Cloud SQL region (e.g. `europe-west4`). Cloud SQL is regional;
   * zonality is configured inside `settings.availabilityType`.
   * Immutable — replace if changed.
   * @see https://cloud.google.com/sql/docs/postgres/locations
   */
  region: string;
  /**
   * Instance name. Defaults to `createPhysicalName({ id, lowercase:
   * true, maxLength: 98 })`. Lowercase letters/digits/hyphens; begin
   * with a letter, no trailing hyphen; 1–98 chars. Immutable — replace.
   * @see https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances#SqlInstance
   */
  name?: string;
  /**
   * Postgres engine version. Immutable — Cloud SQL exposes major
   * version *upgrades* via a separate `upgrade` operation, not via
   * `patch`. Surfacing it as immutable here forces an explicit replace
   * (or out-of-band upgrade) for clarity.
   * @see https://cloud.google.com/sql/docs/postgres/db-versions
   */
  databaseVersion: PostgresVersion;
  /**
   * Initial Postgres `postgres` superuser password. Only set on
   * insert; ignored on subsequent patches (Cloud SQL silently drops
   * `rootPassword` on patch). Typically omitted on IAM-only stacks
   * since the `postgres` role is unused.
   * @see https://cloud.google.com/sql/docs/postgres/create-manage-users#user-root
   */
  rootPassword?: Redacted.Redacted<string>;
  /**
   * Resource labels. Alchemy internal labels (`alchemy_app`,
   * `alchemy_stage`, `alchemy_id`) are merged on top automatically.
   * Cloud SQL stores user labels under `settings.userLabels`; we
   * surface them at the top level for symmetry with other GCP
   * resources. Mutable via `patch`.
   * @see https://cloud.google.com/sql/docs/postgres/label-instance
   */
  labels?: Record<string, string>;
  /** Instance settings (tier, disk, IP, backups, …). Mostly mutable via `patch`. */
  settings: {
    /**
     * Machine tier (`db-custom-{vCPU}-{memMiB}`, `db-f1-micro`,
     * `db-perf-optimized-*`). Mutable via `patch` (causes a restart).
     * @see https://cloud.google.com/sql/docs/postgres/instance-settings
     */
    tier: string;
    /**
     * Cloud SQL edition. `ENTERPRISE_PLUS` is required for
     * Data Cache + the `db-perf-optimized-*` tiers. Mutable via
     * `patch` (some transitions require a restart).
     * @see https://cloud.google.com/sql/docs/postgres/editions-intro
     */
    edition?: SqlEdition;
    /**
     * Storage size in GB. Mutable via `patch`; can only grow, not
     * shrink (shrink requires a side-channel operation).
     * @see https://cloud.google.com/sql/docs/postgres/instance-settings#storage-capacity-2ndgen
     */
    dataDiskSizeGb?: number;
    /**
     * Disk type. `PD_SSD` is the default; `PD_HDD` is legacy.
     * Immutable in practice — Cloud SQL rejects type changes on patch.
     * @see https://cloud.google.com/sql/docs/postgres/instance-settings#storage-type-2ndgen
     */
    dataDiskType?: SqlDataDiskType;
    /** Auto-grow the data disk when nearing full. Mutable via `patch`. */
    diskAutoresize?: boolean;
    /** Cap on auto-grown size, in GB. Mutable via `patch`. */
    diskAutoresizeLimit?: number;
    /** Networking — public IP, private IP via PSA, or both. Mutable via `patch`. */
    ipConfiguration?: {
      /**
       * VPC selfLink (`https://www.googleapis.com/compute/v1/projects/{p}/global/networks/{n}`)
       * to attach the private IP to. The VPC must already have a PSA
       * peering with `servicenetworking.googleapis.com`. Immutable
       * after first set (Cloud SQL refuses to change the private network).
       * @see https://cloud.google.com/sql/docs/postgres/private-ip
       */
      privateNetwork?: string;
      /** Enable a public IPv4 endpoint. Mutable via `patch`. */
      ipv4Enabled?: boolean;
      /**
       * Allow Google-managed services (BigQuery, Vertex AI, etc.) to
       * reach the private IP over Google's backbone. Mutable via `patch`.
       */
      enablePrivatePathForGoogleCloudServices?: boolean;
      /** Require SSL/TLS on all connections. Mutable via `patch`. */
      requireSsl?: boolean;
    };
    /** Backup window + retention settings. Mutable via `patch`. */
    backupConfiguration?: {
      /** Enable automated daily backups. Mutable via `patch`. */
      enabled?: boolean;
      /** Enable PITR (write-ahead log archiving). Mutable via `patch`. */
      pointInTimeRecoveryEnabled?: boolean;
      /** Backup start time in UTC, `HH:MM` 24-hour. Mutable via `patch`. */
      startTime?: string;
      /** WAL retention window (1–7 days). Mutable via `patch`. */
      transactionLogRetentionDays?: number;
    };
    /**
     * Postgres flags (e.g. `shared_buffers`, `max_connections`).
     * Mutable via `patch`; some flags trigger a restart.
     * @see https://cloud.google.com/sql/docs/postgres/flags
     */
    databaseFlags?: ReadonlyArray<{ name: string; value: string }>;
    /**
     * Block alchemy from deleting the instance via the API. Disable
     * before running destroy.
     * @see https://cloud.google.com/sql/docs/postgres/deletion-protection
     */
    deletionProtectionEnabled?: boolean;
    /** Park (`NEVER`) or run (`ALWAYS`) the instance. Mutable via `patch`. */
    activationPolicy?: SqlActivationPolicy;
    /**
     * `ZONAL` = single zone; `REGIONAL` = HA standby in a second zone.
     * Mutable via `patch` (transitions to/from `REGIONAL` take ~10 min).
     * @see https://cloud.google.com/sql/docs/postgres/high-availability
     */
    availabilityType?: SqlAvailabilityType;
  };
};

export type SqlInstanceIpAddress = {
  /** Address class — `PRIMARY` (public), `PRIVATE`, or `OUTGOING`. */
  type: string | undefined;
  /** The IP itself. */
  ipAddress: string | undefined;
};

export type SqlInstanceAttributes = {
  /** Bare instance name (no `projects/.../instances/` prefix). */
  name: string;
  /** Server-defined URL for the instance. */
  selfLink: string;
  /** GCP project ID. */
  project: string;
  /** Region. */
  region: string;
  /**
   * `project:region:name` — the canonical identifier the Cloud SQL
   * Auth Proxy and the IAM authn token exchange both consume.
   */
  connectionName: string;
  /** Echoed Postgres version (e.g. `POSTGRES_17`). */
  databaseVersion: string;
  /** Lifecycle state — `RUNNABLE` once ready. */
  state: string;
  /** All IPs Cloud SQL has assigned. */
  ipAddresses: ReadonlyArray<SqlInstanceIpAddress>;
  /** Convenience: first `PRIVATE` IP, if any. */
  privateIpAddress: string | undefined;
  /** Convenience: first `PRIMARY` (public) IP, if any. */
  publicIpAddress: string | undefined;
  /** Server CA cert; useful for pinning TLS roots from a client. */
  serverCaCert:
    | {
        cert: string | undefined;
        commonName: string | undefined;
        expirationTime: string | undefined;
        sha1Fingerprint: string | undefined;
      }
    | undefined;
  /** Monotonic optimistic-concurrency token — round-tripped on patch. */
  settingsVersion: string | undefined;
  /** Labels currently set, including alchemy internals. */
  labels: Record<string, string>;
};

export type SqlInstance = Resource<
  "GCP.SqlInstance",
  SqlInstanceProps,
  SqlInstanceAttributes,
  never,
  GCP.Providers
>;
export const SqlInstance = Resource<SqlInstance>("GCP.SqlInstance");

const toAddress = (m: sql.IpMapping): SqlInstanceIpAddress => ({
  type: m.type,
  ipAddress: m.ipAddress,
});

const toAttributes = (
  i: sql.DatabaseInstance,
  parent: { project: string; region: string; name: string },
): SqlInstanceAttributes => {
  const ipAddresses = (i.ipAddresses ?? []).map(toAddress);
  return {
    name: parent.name,
    selfLink: i.selfLink ?? "",
    project: parent.project,
    region: parent.region,
    connectionName:
      i.connectionName ?? `${parent.project}:${parent.region}:${parent.name}`,
    databaseVersion: i.databaseVersion ?? "",
    state: i.state ?? "",
    ipAddresses,
    privateIpAddress: ipAddresses.find((a) => a.type === "PRIVATE")?.ipAddress,
    publicIpAddress: ipAddresses.find((a) => a.type === "PRIMARY")?.ipAddress,
    serverCaCert: i.serverCaCert
      ? {
          cert: i.serverCaCert.cert,
          commonName: i.serverCaCert.commonName,
          expirationTime: i.serverCaCert.expirationTime,
          sha1Fingerprint: i.serverCaCert.sha1Fingerprint,
        }
      : undefined,
    settingsVersion: i.settings?.settingsVersion,
    labels: normalizeStringMap(i.settings?.userLabels) ?? {},
  };
};

/**
 * Build the `Settings` body sent to the API.
 *
 * Only sets fields the user has populated, so distinct from a settings
 * stanza diff: server-injected defaults aren't overwritten by an
 * `undefined` from us.
 */
const toSettingsBody = (
  s: SqlInstanceProps["settings"],
  userLabels: Record<string, string>,
  settingsVersion?: string,
): sql.Settings => ({
  tier: s.tier,
  userLabels,
  ...(s.edition ? { edition: s.edition } : {}),
  ...(s.dataDiskSizeGb !== undefined
    ? { dataDiskSizeGb: String(s.dataDiskSizeGb) }
    : {}),
  ...(s.dataDiskType ? { dataDiskType: s.dataDiskType } : {}),
  ...(s.diskAutoresize !== undefined
    ? { storageAutoResize: s.diskAutoresize }
    : {}),
  ...(s.diskAutoresizeLimit !== undefined
    ? { storageAutoResizeLimit: String(s.diskAutoresizeLimit) }
    : {}),
  ...(s.ipConfiguration
    ? {
        ipConfiguration: {
          ...(s.ipConfiguration.ipv4Enabled !== undefined
            ? { ipv4Enabled: s.ipConfiguration.ipv4Enabled }
            : {}),
          ...(s.ipConfiguration.privateNetwork
            ? { privateNetwork: s.ipConfiguration.privateNetwork }
            : {}),
          ...(s.ipConfiguration.enablePrivatePathForGoogleCloudServices !==
          undefined
            ? {
                enablePrivatePathForGoogleCloudServices:
                  s.ipConfiguration.enablePrivatePathForGoogleCloudServices,
              }
            : {}),
          ...(s.ipConfiguration.requireSsl !== undefined
            ? { requireSsl: s.ipConfiguration.requireSsl }
            : {}),
        },
      }
    : {}),
  ...(s.backupConfiguration ? { backupConfiguration: s.backupConfiguration } : {}),
  ...(s.databaseFlags ? { databaseFlags: [...s.databaseFlags] } : {}),
  ...(s.deletionProtectionEnabled !== undefined
    ? { deletionProtectionEnabled: s.deletionProtectionEnabled }
    : {}),
  ...(s.activationPolicy ? { activationPolicy: s.activationPolicy } : {}),
  ...(s.availabilityType ? { availabilityType: s.availabilityType } : {}),
  ...(settingsVersion !== undefined ? { settingsVersion } : {}),
});

export const SqlInstanceProvider = () =>
  Provider.effect(
    SqlInstance,
    Effect.gen(function* () {
      const getInstances = yield* sql.getInstances;
      const listInstances = yield* sql.listInstances;
      const insertInstances = yield* sql.insertInstances;
      const patchInstances = yield* sql.patchInstances;
      const deleteInstances = yield* sql.deleteInstances;
      const getOperations = yield* sql.getOperations;
      const awaitOperation = makeAwaitOperation(getOperations);

      const observe = (project: string, name: string) =>
        getInstances({ project, instance: name }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as sql.DatabaseInstance | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as sql.DatabaseInstance | undefined),
          ),
        );

      const syncMutable = Effect.fn(function* (args: {
        project: string;
        name: string;
        observed: sql.DatabaseInstance;
        news: SqlInstanceProps;
        desiredLabels: Record<string, string>;
        session: ScopedPlanStatusSession;
      }) {
        const obsSettings = args.observed.settings ?? {};
        const desiredSettingsForCompare = toSettingsBody(
          args.news.settings,
          args.desiredLabels,
        );

        // Per-field diff — settingsVersion is added below only if we
        // actually need to patch, so it's not part of the no-op check.
        let needPatch = false;
        const reasons: string[] = [];
        const compare = (key: string, a: unknown, b: unknown) => {
          if (!deepEqual(a, b)) {
            needPatch = true;
            reasons.push(key);
          }
        };
        compare("tier", obsSettings.tier, desiredSettingsForCompare.tier);
        compare(
          "edition",
          obsSettings.edition,
          desiredSettingsForCompare.edition,
        );
        compare(
          "dataDiskSizeGb",
          obsSettings.dataDiskSizeGb,
          desiredSettingsForCompare.dataDiskSizeGb,
        );
        compare(
          "dataDiskType",
          obsSettings.dataDiskType,
          desiredSettingsForCompare.dataDiskType,
        );
        compare(
          "storageAutoResize",
          obsSettings.storageAutoResize,
          desiredSettingsForCompare.storageAutoResize,
        );
        compare(
          "storageAutoResizeLimit",
          obsSettings.storageAutoResizeLimit,
          desiredSettingsForCompare.storageAutoResizeLimit,
        );
        compare(
          "ipConfiguration",
          obsSettings.ipConfiguration,
          desiredSettingsForCompare.ipConfiguration,
        );
        compare(
          "backupConfiguration",
          obsSettings.backupConfiguration,
          desiredSettingsForCompare.backupConfiguration,
        );
        compare(
          "databaseFlags",
          obsSettings.databaseFlags ?? [],
          desiredSettingsForCompare.databaseFlags ?? [],
        );
        compare(
          "deletionProtectionEnabled",
          obsSettings.deletionProtectionEnabled,
          desiredSettingsForCompare.deletionProtectionEnabled,
        );
        compare(
          "activationPolicy",
          obsSettings.activationPolicy,
          desiredSettingsForCompare.activationPolicy,
        );
        compare(
          "availabilityType",
          obsSettings.availabilityType,
          desiredSettingsForCompare.availabilityType,
        );

        const labelDiff = diffTags(
          normalizeStringMap(obsSettings.userLabels) ?? {},
          args.desiredLabels,
        );
        if (labelDiff.removed.length > 0 || labelDiff.upsert.length > 0) {
          needPatch = true;
          reasons.push("userLabels");
        }

        if (!needPatch) return;

        // Thread the observed settingsVersion through the patch body
        // — Cloud SQL uses it as the optimistic-concurrency token
        // (etag is deprecated on this resource).
        const body: sql.DatabaseInstance = {
          settings: toSettingsBody(
            args.news.settings,
            args.desiredLabels,
            obsSettings.settingsVersion,
          ),
        };
        const op = yield* patchInstances({
          project: args.project,
          instance: args.name,
          body,
        }).pipe(
          Effect.catchTag("BadRequest", reshapeBadRequest("Instance", "patch")),
        );
        if (op.name) yield* awaitOperation(args.project, op.name, args.session);
      });

      return {
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        stables: ["name", "selfLink", "project", "region", "connectionName"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as SqlInstanceProps, news, [
              "project",
              "region",
              "name",
              "databaseVersion",
            ])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const internalLabels = yield* gcpInternalLabels(id);
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, maxLength: 98 })).toLowerCase();
          yield* validateInstanceName(desiredName);

          const desiredLabels: Record<string, string> = {
            ...(news.labels ?? {}),
            ...internalLabels,
          };

          // 1. Observe — collapse 403 to "missing" alongside 404.
          let observed = yield* observe(news.project, desiredName);

          // 2. Ensure — insert. Like Cloud Run / GKE, sqladmin can 403
          //    with "Cloud SQL Admin API has not been used in project
          //    ... If you enabled this API recently, wait …" for ~1–2
          //    minutes after ApiEnable lands. Retry the insert on that
          //    specific 403; other Forbidden cases propagate.
          if (!observed) {
            const op = yield* insertInstances({
              project: news.project,
              body: {
                name: desiredName,
                region: news.region,
                databaseVersion: news.databaseVersion,
                ...(news.rootPassword
                  ? { rootPassword: Redacted.value(news.rootPassword) }
                  : {}),
                settings: toSettingsBody(news.settings, desiredLabels),
              },
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
                      "Waiting for Cloud SQL Admin API enablement to propagate…",
                    ),
                  ),
                ),
              }),
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as sql.Operation | undefined),
              ),
              Effect.catchTag(
                "BadRequest",
                reshapeBadRequest("Instance", "insert"),
              ),
            );
            if (op?.name) yield* awaitOperation(news.project, op.name, session);
            observed = yield* getInstances({
              project: news.project,
              instance: desiredName,
            });
          }

          // 3. Sync — single patch with the full settings body when any
          //    field drifts. settingsVersion threaded through for OCC.
          yield* syncMutable({
            project: news.project,
            name: desiredName,
            observed,
            news,
            desiredLabels,
            session,
          });

          const final = yield* getInstances({
            project: news.project,
            instance: desiredName,
          });
          return toAttributes(final, {
            project: news.project,
            region: news.region,
            name: desiredName,
          });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* deleteInstances({
            project: output.project,
            instance: output.name,
          }).pipe(
            Effect.flatMap((op) =>
              op.name
                ? awaitOperation(output.project, op.name, session)
                : Effect.succeed(op),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.catchTag(
              "BadRequest",
              reshapeBadRequest("Instance", "delete"),
            ),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const project = output?.project ?? olds?.project;
          const region = output?.region ?? olds?.region;
          if (!project || !region) return undefined;
          const name = output?.name ?? olds?.name;
          let observed: sql.DatabaseInstance | undefined;
          if (name) {
            observed = yield* observe(project, name);
          } else {
            // Cold recovery (lost state): the physical name carries a
            // random per-instance suffix that lived only in state, so a
            // probe against a freshly-generated name can never hit. Scan
            // the project's instances for our alchemy labels instead.
            const page = yield* listInstances({
              project,
              maxResults: 500,
            }).pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed(undefined as sql.InstancesListResponse | undefined),
              ),
              Effect.catchTag("Forbidden", () =>
                Effect.succeed(undefined as sql.InstancesListResponse | undefined),
              ),
            );
            for (const candidate of page?.items ?? []) {
              if (
                yield* hasAlchemyLabels(
                  id,
                  normalizeStringMap(candidate.settings?.userLabels),
                )
              ) {
                observed = candidate;
                break;
              }
            }
          }
          if (!observed?.name) return undefined;
          const attrs = toAttributes(observed, {
            project,
            region,
            name: observed.name,
          });
          return (yield* hasAlchemyLabels(
            id,
            normalizeStringMap(observed.settings?.userLabels),
          ))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
