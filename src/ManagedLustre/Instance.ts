import { ConfigError } from "@distilled.cloud/gcp";
import * as lustre from "@distilled.cloud/gcp/lustre_v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { diffTags } from "alchemy/Tags";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { NetworkRefById } from "../Compute/Network.ts";
import { gcpInternalLabels, hasAlchemyLabels, normalizeStringMap } from "../Tags.ts";
import type * as GCP from "../Providers.ts";

/**
 * A Google Cloud Managed Lustre instance — a managed parallel POSIX
 * filesystem (DDN EXAScaler under the hood) for AI training and HPC
 * shared storage. Mounted in GKE clusters via the Managed Lustre CSI
 * driver. The Google-blessed successor to Parallelstore (deprecated,
 * EOS 2026-10-31).
 *
 * **Network preconditions.** The instance attaches to a VPC over PSA
 * (Private Services Access) consumed via `servicenetworking`. The
 * consumer VPC must already have:
 *   1. A `GCP.GlobalAddress` reservation (`purpose=VPC_PEERING`,
 *      `addressType=INTERNAL`, ≥/24 prefix length).
 *   2. A `GCP.PsaConnection` to `servicenetworking.googleapis.com`.
 * Lustre does NOT take a `reservedIpRange` field — it auto-allocates
 * from whichever PSA peering the network already has.
 *
 * **Capacity & tier.** Two tiering shapes:
 *   - **Dynamic tier** (`dynamicTierMode: "DEFAULT_CACHE"`) — pay-per-GiB
 *     elastic capacity. `perUnitStorageThroughput` MUST be unset.
 *   - **Performance tier** — `perUnitStorageThroughput` ∈ {125, 250,
 *     500, 1000} MBps/TiB; `dynamicTierMode` left unset (or "DISABLED").
 *
 * `capacityGib` floors and increments are tier-specific and **much
 * higher than the Google docs imply**. Empirical limits (probed
 * `europe-west4-a`, May 2026):
 *
 *   | Tier                                         | Min capacity        | Increment       |
 *   |----------------------------------------------|---------------------|-----------------|
 *   | `dynamicTierMode: "DEFAULT_CACHE"`           | 472000 GiB (~461T) | unknown         |
 *   | `perUnitStorageThroughput: "125"`            |  72000 GiB (~70T)  | unknown         |
 *   | `perUnitStorageThroughput: "250"`            |  36000 GiB (~35T)  | unknown         |
 *   | `perUnitStorageThroughput: "500"`            | (≤18000 ok)         | 18000 GiB       |
 *   | `perUnitStorageThroughput: "1000"`           | (≤18000 ok)         |  9000 GiB       |
 *
 * Each tier has its own quota metric
 * (`StorageFor{125,250,500,1000}MBpThroughputPerTiB` for Performance);
 * default is **zero** in `europe-west4-a` for new projects, so a
 * quota request through the GCP console is required before any
 * Performance-tier instance creates. Dynamic-tier quota was not
 * probed but is likely the same.
 *
 * See <https://cloud.google.com/managed-lustre/docs/create-instance#performance-tiers>
 * for the (incomplete) public documentation.
 *
 * Lustre operations use a CRM-style `Operation.done: boolean` (verified
 * at `lustre-v1.ts`).
 *
 * @section Creating a Managed Lustre instance
 * @example 20 TiB Performance-tier instance (125 MBps/TiB)
 * ```typescript
 * const fs = yield* GCP.ManagedLustreInstance("ModelsFs", {
 *   project: hostProject.projectId,
 *   location: "europe-west4-a",
 *   filesystem: "models",
 *   capacityGib: "20480",
 *   network: GCP.networkRefById(hostProject.projectId, vpc.name),
 *   perUnitStorageThroughput: "125",
 *   gkeSupportEnabled: true,
 * });
 * ```
 */
export type ManagedLustreInstanceProps = {
  /** GCP project ID hosting the instance. Immutable — replace if changed. */
  project: string;
  /**
   * Managed Lustre location. **Zone, not region** — Lustre is a zonal
   * product (e.g. `europe-west4-a`). Immutable — replace.
   */
  location: string;
  /**
   * Instance ID. Defaults to `createPhysicalName({ id, lowercase: true,
   * maxLength: 63 })`. Lowercase letters/numbers/hyphens, must start
   * with a letter, end with a letter or number. Immutable — replace.
   */
  instanceId?: string;
  /**
   * Lustre filesystem name — what clients use when mounting. **Eight
   * characters or less, letters and numbers only** (no hyphens). This
   * is distinct from `instanceId`; clients see the filesystem name in
   * the mount point string. Immutable — replace.
   */
  filesystem: string;
  /** User-visible description. Mutable via `patch`. */
  description?: string;
  /**
   * Capacity in **GiB** (1024-based). Sent to the API as a string per
   * Lustre's int64-encoded-as-string convention. Replace-only — Lustre
   * doesn't currently support online resize.
   */
  capacityGib: string;
  /**
   * Fully-qualified consumer VPC in **project-ID** form. Build with
   * `networkRefById(project.projectId, vpc.name)` — Lustre's
   * `instances.create` rejects the project-number form with a
   * `BadRequest` error, so this prop is intentionally typed as
   * `NetworkRefById` (a nominally branded sibling of `NetworkRef`) to
   * surface the constraint at compile time. Immutable — replace.
   */
  network: NetworkRefById;
  /**
   * Dynamic tier mode. Set to `"DEFAULT_CACHE"` to opt into the elastic
   * Dynamic tier; `"DISABLED"` (or omit) for the fixed-throughput tier.
   * If `"DEFAULT_CACHE"`, leave `perUnitStorageThroughput` unset.
   * Immutable — replace.
   */
  dynamicTierMode?: "DEFAULT_CACHE" | "DISABLED";
  /**
   * Throughput in MBps per TiB for the fixed-throughput tier. Mutually
   * exclusive with `dynamicTierMode === "DEFAULT_CACHE"`. Immutable —
   * replace.
   */
  perUnitStorageThroughput?: "125" | "250" | "500" | "1000";
  /**
   * Enable GKE-client support. Recommended `true` for instances mounted
   * by GKE pods via the Managed Lustre CSI driver. Immutable — replace.
   */
  gkeSupportEnabled?: boolean;
  /**
   * Cloud KMS key for at-rest encryption. Format
   * `projects/{p}/locations/{l}/keyRings/{r}/cryptoKeys/{k}`. Immutable
   * — replace.
   */
  kmsKey?: string;
  /**
   * Resource labels. Alchemy internal labels (`alchemy_app`,
   * `alchemy_stage`, `alchemy_id`) are merged on top automatically.
   * Mutable via `patch`.
   */
  labels?: Record<string, string>;
};

export type ManagedLustreInstanceAttributes = {
  /** Bare instance id. */
  instanceId: string;
  /** Project ID. */
  project: string;
  /** Zone. */
  location: string;
  /** Resource name `projects/{p}/locations/{l}/instances/{id}`. */
  name: string;
  /** Lustre filesystem name (mirrors props). */
  filesystem: string;
  /** Description, mirroring props. */
  description: string | undefined;
  /** Capacity in GiB. */
  capacityGib: string;
  /** Consumer VPC URL (project-ID form). */
  network: NetworkRefById;
  /** Lifecycle state — `ACTIVE` once ready. */
  state: string | undefined;
  /**
   * Mount point string clients pass to `mount -t lustre`, of the form
   * `IP_ADDRESS@tcp:/FILESYSTEM`. Output-only.
   */
  mountPoint: string | undefined;
  /** Dynamic tier mode currently configured. */
  dynamicTierMode: string | undefined;
  /** Per-TiB throughput (string, MBps/TiB). */
  perUnitStorageThroughput: string | undefined;
  /** GKE-client support flag. */
  gkeSupportEnabled: boolean | undefined;
  /** KMS key, if set. */
  kmsKey: string | undefined;
  /** Labels currently set, including internals. */
  labels: Record<string, string>;
};

export type ManagedLustreInstance = Resource<
  "GCP.ManagedLustreInstance",
  ManagedLustreInstanceProps,
  ManagedLustreInstanceAttributes,
  never,
  GCP.Providers
>;
export const ManagedLustreInstance = Resource<ManagedLustreInstance>(
  "GCP.ManagedLustreInstance",
);

const toAttributes = (
  i: lustre.Instance,
  parent: {
    project: string;
    location: string;
    instanceId: string;
    network: NetworkRefById;
  },
): ManagedLustreInstanceAttributes => ({
  instanceId: parent.instanceId,
  project: parent.project,
  location: parent.location,
  name:
    i.name ??
    `projects/${parent.project}/locations/${parent.location}/instances/${parent.instanceId}`,
  filesystem: i.filesystem ?? "",
  description: i.description,
  capacityGib: i.capacityGib ?? "",
  // Server-echoed `i.network` matches what we sent at create time, but
  // we thread `parent.network` through to preserve the
  // `NetworkRefById` brand without a cast — same pattern as project /
  // location.
  network: parent.network,
  state: i.state,
  mountPoint: i.mountPoint,
  dynamicTierMode: i.dynamicTierOptions?.mode,
  perUnitStorageThroughput: i.perUnitStorageThroughput,
  gkeSupportEnabled: i.gkeSupportEnabled,
  kmsKey: i.kmsKey,
  labels: normalizeStringMap(i.labels) ?? {},
});

export const ManagedLustreInstanceProvider = () =>
  Provider.effect(
    ManagedLustreInstance,
    Effect.gen(function* () {
      const getInstance = yield* lustre.getProjectsLocationsInstances;
      const listInstances = yield* lustre.listProjectsLocationsInstances;
      const createInstance = yield* lustre.createProjectsLocationsInstances;
      const patchInstance = yield* lustre.patchProjectsLocationsInstances;
      const deleteInstance = yield* lustre.deleteProjectsLocationsInstances;
      const getOperation = yield* lustre.getProjectsLocationsOperations;

      const awaitOperation = Effect.fn(function* (
        operationName: string,
        session: ScopedPlanStatusSession,
      ) {
        const op = yield* getOperation({ name: operationName }).pipe(
          Effect.flatMap((current) =>
            current.done === true
              ? Effect.succeed(current)
              : Effect.fail({ _tag: "OperationPending" as const }),
          ),
          Effect.retry({
            while: (e: { _tag?: string }) => e?._tag === "OperationPending",
            schedule: Schedule.max([
              Schedule.min([
                Schedule.exponential(Duration.seconds(5), 1.5),
                Schedule.spaced(Duration.seconds(30)),
              ]),
              // Lustre creates run 10–25 min for multi-TiB instances.
              // 200 × 30s ≈ 100 min wall ceiling.
              Schedule.recurs(200),
            ]).pipe(
              Schedule.tap(() =>
                session.note(`Waiting for Managed Lustre operation ${operationName}…`),
              ),
            ),
          }),
        );
        if (op.error) {
          return yield* new ConfigError({
            message: `Managed Lustre operation ${operationName} failed: ${
              op.error.message ?? JSON.stringify(op.error)
            }`,
          });
        }
        return op;
      });

      const fqName = (project: string, location: string, instanceId: string) =>
        `projects/${project}/locations/${location}/instances/${instanceId}`;

      const observe = (project: string, location: string, instanceId: string) =>
        getInstance({ name: fqName(project, location, instanceId) }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as lustre.Instance | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as lustre.Instance | undefined),
          ),
        );

      const syncMutable = Effect.fn(function* (args: {
        name: string;
        observed: lustre.Instance;
        desired: { description: string | undefined; labels: Record<string, string> };
        session: ScopedPlanStatusSession;
      }) {
        const updateMaskFields: string[] = [];
        if ((args.observed.description ?? undefined) !== args.desired.description) {
          updateMaskFields.push("description");
        }
        const observedLabels = normalizeStringMap(args.observed.labels) ?? {};
        const labelDiff = diffTags(observedLabels, args.desired.labels);
        if (labelDiff.removed.length > 0 || labelDiff.upsert.length > 0) {
          updateMaskFields.push("labels");
        }
        if (updateMaskFields.length === 0) return;

        const op = yield* patchInstance({
          name: args.name,
          updateMask: updateMaskFields.join(","),
          body: {
            description: args.desired.description,
            labels: args.desired.labels,
          },
        });
        if (op.name) yield* awaitOperation(op.name, args.session);
      });

      return {
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        stables: ["instanceId", "project", "location", "name"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as ManagedLustreInstanceProps, news, [
              "project",
              "location",
              "instanceId",
              "filesystem",
              "network",
              "capacityGib",
              "dynamicTierMode",
              "perUnitStorageThroughput",
              "gkeSupportEnabled",
              "kmsKey",
            ])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const internalLabels = yield* gcpInternalLabels(id);
          const desiredId =
            news.instanceId ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const parent = `projects/${news.project}/locations/${news.location}`;
          const name = fqName(news.project, news.location, desiredId);
          const desiredLabels: Record<string, string> = {
            ...(news.labels ?? {}),
            ...internalLabels,
          };

          let observed = yield* observe(news.project, news.location, desiredId);

          if (!observed) {
            const body: lustre.Instance = {
              filesystem: news.filesystem,
              capacityGib: news.capacityGib,
              network: news.network,
              ...(news.description ? { description: news.description } : {}),
              ...(news.dynamicTierMode
                ? { dynamicTierOptions: { mode: news.dynamicTierMode } }
                : {}),
              ...(news.perUnitStorageThroughput
                ? { perUnitStorageThroughput: news.perUnitStorageThroughput }
                : {}),
              ...(news.gkeSupportEnabled !== undefined
                ? { gkeSupportEnabled: news.gkeSupportEnabled }
                : {}),
              ...(news.kmsKey ? { kmsKey: news.kmsKey } : {}),
              labels: desiredLabels,
            };
            const op = yield* createInstance({
              parent,
              instanceId: desiredId,
              body,
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as lustre.Operation | undefined),
              ),
            );
            if (op?.name) yield* awaitOperation(op.name, session);
            observed = yield* getInstance({ name });
          }

          yield* syncMutable({
            name,
            observed,
            desired: { description: news.description, labels: desiredLabels },
            session,
          });

          const final = yield* getInstance({ name });
          return toAttributes(final, {
            project: news.project,
            location: news.location,
            instanceId: desiredId,
            network: news.network,
          });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* deleteInstance({ name: output.name }).pipe(
            Effect.flatMap((op) =>
              op.name ? awaitOperation(op.name, session) : Effect.succeed(op),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const project = output?.project ?? olds?.project;
          const location = output?.location ?? olds?.location;
          const network = output?.network ?? olds?.network;
          if (!project || !location || !network) return undefined;
          const persistedId = output?.instanceId ?? olds?.instanceId;
          let observed: lustre.Instance | undefined;
          if (persistedId) {
            observed = yield* observe(project, location, persistedId);
          } else {
            // Cold recovery (lost state): the instance id carries a
            // random per-instance suffix that lived only in state, so a
            // probe against a freshly-generated id can never hit. Scan
            // the location's instances for our alchemy labels instead.
            const page = yield* listInstances({
              parent: `projects/${project}/locations/${location}`,
            }).pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed(
                  undefined as lustre.ListInstancesResponse | undefined,
                ),
              ),
              Effect.catchTag("Forbidden", () =>
                Effect.succeed(
                  undefined as lustre.ListInstancesResponse | undefined,
                ),
              ),
            );
            for (const candidate of page?.instances ?? []) {
              if (yield* hasAlchemyLabels(id, normalizeStringMap(candidate.labels))) {
                observed = candidate;
                break;
              }
            }
          }
          if (!observed?.name) return undefined;
          // `name` is the full resource path; the instance id is its
          // last segment.
          const instanceId = observed.name.split("/").pop()!;
          const attrs = toAttributes(observed, {
            project,
            location,
            instanceId,
            network,
          });
          return (yield* hasAlchemyLabels(id, normalizeStringMap(observed.labels)))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
