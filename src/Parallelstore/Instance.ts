import { ConfigError } from "@distilled.cloud/gcp";
import * as ps from "@distilled.cloud/gcp/parallelstore-v1";
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
import type { NetworkRef } from "../Compute/Network.ts";
import { gcpInternalLabels, hasAlchemyLabels } from "../Tags.ts";
import type * as GCP from "../Providers.ts";

/**
 * A Parallelstore instance — a high-throughput, POSIX-style filesystem
 * Google sells for AI training/inference shared storage. Backed by DAOS
 * under the hood; mounted in clusters via the Parallelstore CSI driver.
 *
 * **Network preconditions.** The instance attaches to a VPC over PSA
 * (Private Services Access). The consumer VPC must already have:
 *   1. A `GCP.GlobalAddress` reservation (`purpose=VPC_PEERING`,
 *      `addressType=INTERNAL`, ≥/24 prefix length).
 *   2. A `GCP.PsaConnection` to `servicenetworking.googleapis.com`
 *      consuming that range.
 * See the Shared VPC + Parallelstore wiring in the apps/cluster stack.
 *
 * **Capacity.** `capacityGib` must be a multiple of 12000 GiB and
 * between 12000 (12 TiB) and 100800 (98.4 TiB). Smaller deployments
 * may use 100 GiB increments depending on the SKU; the API surfaces
 * the floor at create time.
 *
 * Parallelstore operations use a CRM-style `Operation.done: boolean`
 * (verified at `parallelstore-v1.ts`).
 *
 * @section Creating a Parallelstore instance
 * @example 20 TiB scratch instance
 * ```typescript
 * const fs = yield* GCP.ParallelstoreInstance("ModelsFs", {
 *   project: hostProject.projectId,
 *   location: "us-central1-a",
 *   capacityGib: "20480",
 *   network: GCP.networkRef(hostProject.projectNumber, vpc.name),
 *   reservedIpRange: psaRange.name,
 *   deploymentType: "SCRATCH",
 *   fileStripeLevel: "FILE_STRIPE_LEVEL_BALANCED",
 *   directoryStripeLevel: "DIRECTORY_STRIPE_LEVEL_BALANCED",
 * });
 * ```
 */
export type ParallelstoreInstanceProps = {
  /** GCP project ID hosting the instance. Immutable — replace if changed. */
  project: string;
  /**
   * Parallelstore location. **Zone, not region** — Parallelstore is a
   * zonal product. Common: `us-central1-a`. Immutable — replace.
   */
  location: string;
  /**
   * Instance ID. Defaults to `createPhysicalName({ id, lowercase: true,
   * maxLength: 63 })`. Lowercase letters/numbers/hyphens, must start
   * with a letter, end with a letter or number. Immutable — replace.
   */
  instanceId?: string;
  /** User-visible description. Mutable via `patch`. */
  description?: string;
  /**
   * Capacity in **GiB** (1024-based). Sent to the API as a string per
   * Parallelstore's int64-encoded-as-string convention. Replace-only —
   * Parallelstore doesn't currently support online resize.
   */
  capacityGib: string;
  /**
   * Fully-qualified consumer VPC in project-number form. Build with
   * `networkRef(project.projectNumber, vpc.name)` — the `NetworkRef`
   * template literal type rejects project-ID-form strings at compile
   * time. Immutable — replace.
   */
  network: NetworkRef;
  /**
   * Name (or self-link) of a `GCP.GlobalAddress` PSA reservation in
   * the same VPC. Immutable — replace.
   */
  reservedIpRange?: string;
  /** `SCRATCH` (default) or `PERSISTENT`. Immutable — replace. */
  deploymentType?: "SCRATCH" | "PERSISTENT";
  /** File stripe level. Replace-only. */
  fileStripeLevel?:
    | "FILE_STRIPE_LEVEL_MIN"
    | "FILE_STRIPE_LEVEL_BALANCED"
    | "FILE_STRIPE_LEVEL_MAX";
  /** Directory stripe level. Replace-only. */
  directoryStripeLevel?:
    | "DIRECTORY_STRIPE_LEVEL_MIN"
    | "DIRECTORY_STRIPE_LEVEL_BALANCED"
    | "DIRECTORY_STRIPE_LEVEL_MAX";
  /**
   * Resource labels. Alchemy internal labels (`alchemy_app`,
   * `alchemy_stage`, `alchemy_id`) are merged on top automatically.
   * Mutable via `patch`.
   */
  labels?: Record<string, string>;
};

export type ParallelstoreInstanceAttributes = {
  /** Bare instance id. */
  instanceId: string;
  /** Project ID. */
  project: string;
  /** Zone. */
  location: string;
  /** Resource name `projects/{p}/locations/{l}/instances/{id}`. */
  name: string;
  /** Description, mirroring props. */
  description: string | undefined;
  /** Capacity in GiB. */
  capacityGib: string;
  /** Consumer VPC URL (project-number form). */
  network: NetworkRef;
  /** Reserved IP range used (server-resolved). */
  reservedIpRange: string | undefined;
  /** Effective reserved range (post-allocation). */
  effectiveReservedIpRange: string | undefined;
  /** Lifecycle state — `ACTIVE` once ready. */
  state: string | undefined;
  /** Active deployment type. */
  deploymentType: string | undefined;
  /** DNS access points VMs mount via. */
  accessPoints: ReadonlyArray<string>;
  /** Labels currently set, including internals. */
  labels: Record<string, string>;
};

export type ParallelstoreInstance = Resource<
  "GCP.ParallelstoreInstance",
  ParallelstoreInstanceProps,
  ParallelstoreInstanceAttributes,
  never,
  GCP.Providers
>;
export const ParallelstoreInstance = Resource<ParallelstoreInstance>(
  "GCP.ParallelstoreInstance",
);

const toAttributes = (
  i: ps.Instance,
  parent: {
    project: string;
    location: string;
    instanceId: string;
    network: NetworkRef;
  },
): ParallelstoreInstanceAttributes => ({
  instanceId: parent.instanceId,
  project: parent.project,
  location: parent.location,
  name: i.name ?? `projects/${parent.project}/locations/${parent.location}/instances/${parent.instanceId}`,
  description: i.description,
  capacityGib: i.capacityGib ?? "",
  // The server-echoed `i.network` matches what we sent up at create
  // time, but we thread `parent.network` through to preserve the
  // `NetworkRef` type without a cast — same pattern as project /
  // location, both of which would otherwise lose their typing through
  // the SDK's `string | undefined` fields.
  network: parent.network,
  reservedIpRange: i.reservedIpRange,
  effectiveReservedIpRange: i.effectiveReservedIpRange,
  state: i.state,
  deploymentType: i.deploymentType,
  accessPoints: i.accessPoints ?? [],
  labels: { ...(i.labels ?? {}) },
});

export const ParallelstoreInstanceProvider = () =>
  Provider.effect(
    ParallelstoreInstance,
    Effect.gen(function* () {
      const getInstance = yield* ps.getProjectsLocationsInstances;
      const createInstance = yield* ps.createProjectsLocationsInstances;
      const patchInstance = yield* ps.patchProjectsLocationsInstances;
      const deleteInstance = yield* ps.deleteProjectsLocationsInstances;
      const getOperation = yield* ps.getProjectsLocationsOperations;

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
            schedule: Schedule.exponential(Duration.seconds(5), 1.5).pipe(
              Schedule.either(Schedule.spaced(Duration.seconds(30))),
              // Parallelstore creates routinely run 10–25 min for
              // multi-TiB instances. 200 × 30s ≈ 100 min wall ceiling.
              Schedule.both(Schedule.recurs(200)),
              Schedule.tapOutput(() =>
                session.note(`Waiting for Parallelstore operation ${operationName}…`),
              ),
            ),
          }),
        );
        if (op.error) {
          return yield* new ConfigError({
            message: `Parallelstore operation ${operationName} failed: ${
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
            Effect.succeed(undefined as ps.Instance | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as ps.Instance | undefined),
          ),
        );

      const syncMutable = Effect.fn(function* (args: {
        name: string;
        observed: ps.Instance;
        desired: { description: string | undefined; labels: Record<string, string> };
        session: ScopedPlanStatusSession;
      }) {
        const updateMaskFields: string[] = [];
        if ((args.observed.description ?? undefined) !== args.desired.description) {
          updateMaskFields.push("description");
        }
        const observedLabels = { ...(args.observed.labels ?? {}) };
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
        stables: ["instanceId", "project", "location", "name"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as ParallelstoreInstanceProps, news, [
              "project",
              "location",
              "instanceId",
              "network",
              "reservedIpRange",
              "deploymentType",
              "fileStripeLevel",
              "directoryStripeLevel",
              "capacityGib",
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
            const body: ps.Instance = {
              capacityGib: news.capacityGib,
              network: news.network,
              ...(news.description ? { description: news.description } : {}),
              ...(news.reservedIpRange ? { reservedIpRange: news.reservedIpRange } : {}),
              ...(news.deploymentType ? { deploymentType: news.deploymentType } : {}),
              ...(news.fileStripeLevel ? { fileStripeLevel: news.fileStripeLevel } : {}),
              ...(news.directoryStripeLevel
                ? { directoryStripeLevel: news.directoryStripeLevel }
                : {}),
              labels: desiredLabels,
            };
            const op = yield* createInstance({
              parent,
              instanceId: desiredId,
              body,
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as ps.Operation | undefined),
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
          // `network` only narrows to NetworkRef when it comes from
          // post-create `output`. `olds` is the snapshot of *props*
          // including a NetworkRef, so both feed into the same typed
          // pipeline.
          const network = output?.network ?? olds?.network;
          if (!project || !location || !network) return undefined;
          const instanceId =
            output?.instanceId ??
            olds?.instanceId ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const observed = yield* observe(project, location, instanceId);
          if (!observed) return undefined;
          const attrs = toAttributes(observed, {
            project,
            location,
            instanceId,
            network,
          });
          return (yield* hasAlchemyLabels(id, observed.labels))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
