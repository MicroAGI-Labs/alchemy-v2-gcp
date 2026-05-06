import * as cont from "@distilled.cloud/gcp/container-v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { deepEqual, isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { gcpInternalLabels, hasAlchemyLabels } from "../Tags.ts";
import type * as GCP from "../Providers.ts";
import { type NodePoolProps, toNodeConfigCreateBody } from "./NodePool.ts";
import { makeAwaitOperation, qualifyOperationName } from "./Operations.ts";

/**
 * Spec for the bootstrap node pool created inline with the cluster.
 *
 * Same shape as the create-time subset of `NodePoolProps`, minus the
 * parent-identity fields (`project`, `location`, `clusterName`), which
 * are inherited from the cluster.
 */
export type ClusterInitialNodePool = {
  /** Pool name. Required — no default. Lowercase alphanumeric+hyphens, ≤40 chars. */
  name: string;
  /** Initial node count. Required — cluster needs nonzero capacity at create. */
  initialNodeCount: number;
  /** Per-pool zones. Defaults to the cluster's zone/region. */
  nodeLocations?: ReadonlyArray<string>;
  /** Node configuration (machine type, disk, accelerators, taints, …). */
  config: NodePoolProps["config"];
  /** Cluster autoscaler config. */
  autoscaling?: NodePoolProps["autoscaling"];
  /** Auto-upgrade / auto-repair. */
  management?: NodePoolProps["management"];
  /** Surge upgrade settings. */
  upgradeSettings?: NodePoolProps["upgradeSettings"];
};

export type ClusterProps = {
  /** GCP project ID hosting the cluster. Immutable — replace if changed. */
  project: string;
  /**
   * GCP zone (e.g. `us-central1-a`) for a zonal cluster, or region
   * (e.g. `us-central1`) for a regional cluster. Immutable — replace.
   */
  location: string;
  /**
   * Cluster name. Defaults to `createPhysicalName({ id, lowercase: true,
   * maxLength: 40 })`. Lowercase alphanumeric + hyphens, ≤40 chars.
   * Immutable — replace if changed.
   */
  name?: string;
  /**
   * Additional zones for cluster nodes. Mutable via `setLocations`.
   */
  nodeLocations?: ReadonlyArray<string>;
  /**
   * VPC short name or self-link. Omit to use the project's `default`
   * VPC. Immutable — replace if changed.
   */
  network?: string;
  /** Subnet within the VPC. Immutable — replace if changed. */
  subnetwork?: string;
  /**
   * VPC-native settings. `useIpAliases: true` is GKE's default for new
   * clusters and the only path that supports private clusters.
   * Immutable — replace if changed.
   */
  ipAllocationPolicy?: {
    useIpAliases?: boolean;
    clusterIpv4CidrBlock?: string;
    servicesIpv4CidrBlock?: string;
    clusterSecondaryRangeName?: string;
    servicesSecondaryRangeName?: string;
  };
  /** GKE release channel. Mutable via `update` (`desiredReleaseChannel`). */
  releaseChannel?: { channel: "RAPID" | "REGULAR" | "STABLE" | "UNSPECIFIED" };
  /**
   * Workload Identity binds K8s SAs to GCP SAs. Format:
   * `<projectId>.svc.id.goog`. Mutable via `update`.
   */
  workloadIdentityConfig?: { workloadPool: string };
  /** Cluster addons. Mutable via dedicated `setAddons`. */
  addonsConfig?: {
    httpLoadBalancing?: { disabled?: boolean };
    horizontalPodAutoscaling?: { disabled?: boolean };
    networkPolicyConfig?: { disabled?: boolean };
    gcePersistentDiskCsiDriverConfig?: { enabled?: boolean };
    gcsFuseCsiDriverConfig?: { enabled?: boolean };
    gkeBackupAgentConfig?: { enabled?: boolean };
    dnsCacheConfig?: { enabled?: boolean };
    configConnectorConfig?: { enabled?: boolean };
  };
  /** Logging service. Mutable via `setLogging`. */
  loggingService?: string;
  /** Monitoring service. Mutable via `setMonitoring`. */
  monitoringService?: string;
  /** Maintenance window/exclusions. Mutable via `setMaintenancePolicy`. */
  maintenancePolicy?: {
    window?: {
      dailyMaintenanceWindow?: { startTime: string };
      recurringWindow?: {
        window: { startTime: string; endTime: string };
        recurrence: string;
      };
    };
  };
  /**
   * Network policy enforcement (e.g. Calico). Mutable via
   * `setNetworkPolicy`. Requires `networkPolicyConfig` addon.
   */
  networkPolicy?: {
    enabled?: boolean;
    provider?: "PROVIDER_UNSPECIFIED" | "CALICO";
  };
  /**
   * Resource labels. Alchemy internal labels (`alchemy_app`,
   * `alchemy_stage`, `alchemy_id`) are merged on top automatically and
   * are reserved. Mutable via `setResourceLabels`.
   */
  resourceLabels?: Record<string, string>;
  /**
   * Initial cluster version (`MASTER_DEFAULT` if omitted). Subsequent
   * master upgrades are not exposed in v1.
   */
  initialClusterVersion?: string;
  /**
   * Bootstrap node pool created inline with the cluster. **Required.**
   * GKE rejects cluster creation without at least one pool.
   *
   * Owned by the cluster — its `config.resourceLabels` are stamped
   * with the cluster's `alchemy_*` internal labels at create time.
   * Consumed only on the create path: after the cluster exists,
   * `Cluster.reconcile` does NOT observe, sync, or mutate this pool,
   * and changes to `initialNodePool` props on subsequent runs are a
   * silent no-op (NOT diffed, NOT a replace trigger).
   *
   * Don't declare a separate `GCP.NodePool` for the same physical
   * pool — it would key its own `alchemy_id` against a different
   * logical id and `read` would return `Unowned(...)`. If you want
   * post-create management of the bootstrap pool's size/config, do
   * it via gcloud or expand `Cluster.reconcile` to sync it; declare
   * additional pools (`compute`, `gpu`, …) as separate
   * `GCP.NodePool` resources.
   */
  initialNodePool: ClusterInitialNodePool;
};

export type ClusterAttributes = {
  /** Cluster name. */
  name: string;
  /** Server-defined URL. */
  selfLink: string;
  /** IP of the master endpoint. */
  endpoint: string;
  /** Base64-encoded master CA cert. */
  clusterCaCertificate: string;
  /** GCP project ID, threaded through from props for `delete`/`read`. */
  project: string;
  /** Zone or region, threaded through from props. */
  location: string;
  /** Current control-plane version. */
  currentMasterVersion: string | undefined;
  /** Lifecycle status. */
  status: string | undefined;
  /** Active release channel. */
  releaseChannel: { channel?: string } | undefined;
  /** Resource labels currently set, including `alchemy_*` internals. */
  resourceLabels: Record<string, string>;
};

/**
 * A GKE Standard cluster.
 *
 * Lifecycle: observe → ensure (create with the user-supplied
 * `initialNodePool` inline) → sync (labels, addons, maintenance,
 * locations, network policy, logging, monitoring, generic update) →
 * return.
 *
 * Adoption: a cluster whose `resourceLabels` lack our `alchemy_*` keys
 * is wrapped in `Unowned(attrs)` from `read`, forcing the user to
 * pass `--adopt` before takeover.
 *
 * @section Creating a cluster
 * @example Minimal Standard cluster
 * ```typescript
 * const cluster = yield* GCP.Cluster("Main", {
 *   project: project.projectId,
 *   location: "us-central1-a",
 *   releaseChannel: { channel: "REGULAR" },
 *   initialNodePool: {
 *     name: "system",
 *     initialNodeCount: 1,
 *     config: { machineType: "e2-medium" },
 *   },
 * });
 * ```
 */
export type Cluster = Resource<
  "GCP.Cluster",
  ClusterProps,
  ClusterAttributes,
  never,
  GCP.Providers
>;
export const Cluster = Resource<Cluster>("GCP.Cluster");

/**
 * Build the inline `NodePool` entry for the cluster create body.
 *
 * The cluster's alchemy internal labels (`alchemy_app`, `alchemy_stage`,
 * `alchemy_id` keyed by the cluster's logical id) are merged into the
 * pool's `config.resourceLabels`, marking the bootstrap pool as part
 * of the cluster — not a free-standing resource that needs adoption.
 * It is owned by the cluster, not by any `GCP.NodePool` resource; a
 * separate `GCP.NodePool` declared with a different logical id will
 * still see `Unowned(...)` from `read` (its own `alchemy_id` won't
 * match), which is correct: that pool belongs to the cluster.
 */
const toInitialNodePoolBody = (
  spec: ClusterInitialNodePool,
  clusterInternalLabels: Record<string, string>,
): cont.NodePool => ({
  name: spec.name,
  initialNodeCount: spec.initialNodeCount,
  ...(spec.nodeLocations ? { locations: spec.nodeLocations } : {}),
  config: toNodeConfigCreateBody(spec.config, {
    ...(spec.config.resourceLabels ?? {}),
    ...clusterInternalLabels,
  }),
  ...(spec.autoscaling ? { autoscaling: spec.autoscaling } : {}),
  ...(spec.management ? { management: spec.management } : {}),
  ...(spec.upgradeSettings ? { upgradeSettings: spec.upgradeSettings } : {}),
});

const toClusterAttributes = (
  c: cont.Cluster,
  parent: { project: string; location: string },
): ClusterAttributes => ({
  name: c.name ?? "",
  selfLink: c.selfLink ?? "",
  endpoint: c.endpoint ?? "",
  clusterCaCertificate: c.masterAuth?.clusterCaCertificate ?? "",
  project: parent.project,
  location: parent.location,
  currentMasterVersion: c.currentMasterVersion,
  status: c.status,
  releaseChannel: c.releaseChannel,
  resourceLabels: { ...(c.resourceLabels ?? {}) },
});

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      const getClusters = yield* cont.getProjectsLocationsClusters;
      const createClusters = yield* cont.createProjectsLocationsClusters;
      const updateClusters = yield* cont.updateProjectsLocationsClusters;
      const setAddons = yield* cont.setAddonsProjectsLocationsClusters;
      const setLocations = yield* cont.setLocationsProjectsLocationsClusters;
      const setMaintenance = yield* cont.setMaintenancePolicyProjectsLocationsClusters;
      const setNetworkPolicy = yield* cont.setNetworkPolicyProjectsLocationsClusters;
      const setResourceLabels = yield* cont.setResourceLabelsProjectsLocationsClusters;
      const setLogging = yield* cont.setLoggingProjectsLocationsClusters;
      const setMonitoring = yield* cont.setMonitoringProjectsLocationsClusters;
      const deleteClusters = yield* cont.deleteProjectsLocationsClusters;
      const getOperations = yield* cont.getProjectsLocationsOperations;
      const awaitOperation = makeAwaitOperation(getOperations);

      // Qualify a bare operation id using the parent path of the
      // resource it targets — every fqName in this provider has the
      // shape `projects/{p}/locations/{l}/clusters/{c}`, so the first
      // four segments give us the parent context. Avoids threading
      // project/location through every sync helper's args type.
      const qualifyOp = (fqName: string, opName: string) =>
        qualifyOperationName(
          fqName.split("/")[1],
          fqName.split("/")[3],
          opName,
        );

      const syncClusterLabels = Effect.fn(function* (args: {
        fqName: string;
        observed: cont.Cluster;
        desired: Record<string, string>;
        session: ScopedPlanStatusSession;
      }) {
        if (deepEqual(args.observed.resourceLabels ?? {}, args.desired)) return;
        // `setResourceLabels` requires `labelFingerprint` for optimistic
        // concurrency — read it fresh from the observed cluster.
        const op = yield* setResourceLabels({
          name: args.fqName,
          body: {
            resourceLabels: args.desired,
            labelFingerprint: args.observed.labelFingerprint,
          },
        });
        if (op.name) yield* awaitOperation(qualifyOp(args.fqName, op.name), args.session);
      });

      const syncClusterAddons = Effect.fn(function* (args: {
        fqName: string;
        observed: cont.Cluster;
        news: ClusterProps;
        session: ScopedPlanStatusSession;
      }) {
        if (!args.news.addonsConfig) return;
        if (deepEqual(args.observed.addonsConfig, args.news.addonsConfig)) return;
        const op = yield* setAddons({
          name: args.fqName,
          body: { addonsConfig: args.news.addonsConfig },
        });
        if (op.name) yield* awaitOperation(qualifyOp(args.fqName, op.name), args.session);
      });

      const syncClusterMaintenance = Effect.fn(function* (args: {
        fqName: string;
        observed: cont.Cluster;
        news: ClusterProps;
        session: ScopedPlanStatusSession;
      }) {
        if (!args.news.maintenancePolicy) return;
        if (deepEqual(args.observed.maintenancePolicy, args.news.maintenancePolicy)) return;
        const op = yield* setMaintenance({
          name: args.fqName,
          body: { maintenancePolicy: args.news.maintenancePolicy },
        });
        if (op.name) yield* awaitOperation(qualifyOp(args.fqName, op.name), args.session);
      });

      const syncClusterLocations = Effect.fn(function* (args: {
        fqName: string;
        observed: cont.Cluster;
        news: ClusterProps;
        session: ScopedPlanStatusSession;
      }) {
        if (!args.news.nodeLocations) return;
        if (deepEqual(args.observed.locations ?? [], args.news.nodeLocations)) return;
        const op = yield* setLocations({
          name: args.fqName,
          body: { locations: args.news.nodeLocations },
        });
        if (op.name) yield* awaitOperation(qualifyOp(args.fqName, op.name), args.session);
      });

      const syncClusterNetworkPolicy = Effect.fn(function* (args: {
        fqName: string;
        observed: cont.Cluster;
        news: ClusterProps;
        session: ScopedPlanStatusSession;
      }) {
        if (!args.news.networkPolicy) return;
        if (deepEqual(args.observed.networkPolicy, args.news.networkPolicy)) return;
        const op = yield* setNetworkPolicy({
          name: args.fqName,
          body: { networkPolicy: args.news.networkPolicy },
        });
        if (op.name) yield* awaitOperation(qualifyOp(args.fqName, op.name), args.session);
      });

      const syncClusterLogging = Effect.fn(function* (args: {
        fqName: string;
        observed: cont.Cluster;
        news: ClusterProps;
        session: ScopedPlanStatusSession;
      }) {
        if (args.news.loggingService === undefined) return;
        if (args.observed.loggingService === args.news.loggingService) return;
        const op = yield* setLogging({
          name: args.fqName,
          body: { loggingService: args.news.loggingService },
        });
        if (op.name) yield* awaitOperation(qualifyOp(args.fqName, op.name), args.session);
      });

      const syncClusterMonitoring = Effect.fn(function* (args: {
        fqName: string;
        observed: cont.Cluster;
        news: ClusterProps;
        session: ScopedPlanStatusSession;
      }) {
        if (args.news.monitoringService === undefined) return;
        if (args.observed.monitoringService === args.news.monitoringService) return;
        const op = yield* setMonitoring({
          name: args.fqName,
          body: { monitoringService: args.news.monitoringService },
        });
        if (op.name) yield* awaitOperation(qualifyOp(args.fqName, op.name), args.session);
      });

      // Catch-all generic update for fields without dedicated setters:
      // currently `releaseChannel` and `workloadIdentityConfig`. The
      // API auto-derives the field mask from which `desired*` keys are
      // populated — no `updateMask` parameter needed.
      const syncClusterUpdate = Effect.fn(function* (args: {
        fqName: string;
        observed: cont.Cluster;
        news: ClusterProps;
        session: ScopedPlanStatusSession;
      }) {
        const update: cont.ClusterUpdate = {};
        if (
          args.news.releaseChannel &&
          !deepEqual(args.observed.releaseChannel, args.news.releaseChannel)
        ) {
          update.desiredReleaseChannel = args.news.releaseChannel;
        }
        if (
          args.news.workloadIdentityConfig &&
          !deepEqual(args.observed.workloadIdentityConfig, args.news.workloadIdentityConfig)
        ) {
          update.desiredWorkloadIdentityConfig = args.news.workloadIdentityConfig;
        }
        if (Object.keys(update).length === 0) return;
        const op = yield* updateClusters({
          name: args.fqName,
          body: { update },
        });
        if (op.name) yield* awaitOperation(qualifyOp(args.fqName, op.name), args.session);
      });

      return {
        stables: [
          "name",
          "selfLink",
          "project",
          "location",
          "endpoint",
          "clusterCaCertificate",
        ],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as ClusterProps, news, [
              "project",
              "location",
              "name",
              "network",
              "subnetwork",
            ])
          ) {
            return { action: "replace" } as const;
          }
          if (!deepEqual(olds.ipAllocationPolicy, news.ipAllocationPolicy)) {
            return { action: "replace" } as const;
          }
          // `initialNodePool` is intentionally NOT part of diff — it is
          // consumed only on create. See ClusterProps JSDoc.
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const internalLabels = yield* gcpInternalLabels(id);
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, maxLength: 40 })).toLowerCase();
          const parent = `projects/${news.project}/locations/${news.location}`;
          const fqName = `${parent}/clusters/${desiredName}`;
          const desiredLabels: Record<string, string> = {
            ...(news.resourceLabels ?? {}),
            ...internalLabels,
          };

          // 1. Observe — collapse 403 to "missing" alongside 404. GCP
          //    returns 403 for invisible resources/projects.
          let observed = yield* getClusters({ name: fqName }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined as cont.Cluster | undefined)),
            Effect.catchTag("Forbidden", () => Effect.succeed(undefined as cont.Cluster | undefined)),
          );

          // 2. Ensure — create with the user-supplied bootstrap pool
          //    inline. No default-pool dance: an explicit
          //    `nodePools: [...]` entry instructs GKE to skip the
          //    implicit default. `Conflict` covers concurrent creates
          //    and state-persistence races; fall through and re-observe.
          if (!observed) {
            const initialPoolBody = toInitialNodePoolBody(
              news.initialNodePool,
              internalLabels,
            );
            // GKE create can fire faster than ApiEnable's effect
            // propagates: GCP returns 403 with "Kubernetes Engine API
            // has not been used in project ... If you enabled this
            // API recently, wait a few minutes …" even when the
            // ApiEnable LRO has reported DONE. Retry the *create call*
            // (not the LRO poll, which doesn't run until create
            // succeeds) on this specific 403 for ~5 minutes; other
            // Forbidden cases propagate normally.
            const op = yield* createClusters({
              parent,
              body: {
                cluster: {
                  name: desiredName,
                  ...(news.network ? { network: news.network } : {}),
                  ...(news.subnetwork ? { subnetwork: news.subnetwork } : {}),
                  ...(news.ipAllocationPolicy
                    ? { ipAllocationPolicy: news.ipAllocationPolicy }
                    : {}),
                  ...(news.releaseChannel ? { releaseChannel: news.releaseChannel } : {}),
                  ...(news.workloadIdentityConfig
                    ? { workloadIdentityConfig: news.workloadIdentityConfig }
                    : {}),
                  ...(news.addonsConfig ? { addonsConfig: news.addonsConfig } : {}),
                  ...(news.loggingService ? { loggingService: news.loggingService } : {}),
                  ...(news.monitoringService
                    ? { monitoringService: news.monitoringService }
                    : {}),
                  ...(news.maintenancePolicy
                    ? { maintenancePolicy: news.maintenancePolicy }
                    : {}),
                  ...(news.networkPolicy ? { networkPolicy: news.networkPolicy } : {}),
                  ...(news.initialClusterVersion
                    ? { initialClusterVersion: news.initialClusterVersion }
                    : {}),
                  ...(news.nodeLocations ? { locations: news.nodeLocations } : {}),
                  resourceLabels: desiredLabels,
                  nodePools: [initialPoolBody],
                },
              },
            }).pipe(
              Effect.retry({
                while: (e: { _tag?: string; message?: string }) =>
                  e?._tag === "Forbidden" &&
                  /enabled this API recently|has not been used/i.test(e.message ?? ""),
                schedule: Schedule.spaced(Duration.seconds(15)).pipe(
                  Schedule.both(Schedule.recurs(20)), // 20 × 15s ≈ 5 min
                  Schedule.tapOutput(() =>
                    session.note(
                      "Waiting for Container API enablement to propagate…",
                    ),
                  ),
                ),
              }),
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as cont.Operation | undefined),
              ),
            );
            if (op?.name) yield* awaitOperation(qualifyOp(fqName, op.name), session);
            observed = yield* getClusters({ name: fqName });
          }

          // 3. Sync — each aspect independently idempotent. Re-observe
          //    after the labels call so the fingerprint stays valid for
          //    subsequent setters (although they don't all use it,
          //    keeping the observed view fresh prevents subtle drift in
          //    the deepEqual short-circuits below).
          yield* syncClusterLabels({
            fqName,
            observed,
            desired: desiredLabels,
            session,
          });
          yield* syncClusterAddons({ fqName, observed, news, session });
          yield* syncClusterMaintenance({ fqName, observed, news, session });
          yield* syncClusterLocations({ fqName, observed, news, session });
          yield* syncClusterNetworkPolicy({ fqName, observed, news, session });
          yield* syncClusterLogging({ fqName, observed, news, session });
          yield* syncClusterMonitoring({ fqName, observed, news, session });
          yield* syncClusterUpdate({ fqName, observed, news, session });

          const final = yield* getClusters({ name: fqName });
          return toClusterAttributes(final, {
            project: news.project,
            location: news.location,
          });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const fqName = `projects/${output.project}/locations/${output.location}/clusters/${output.name}`;
          yield* deleteClusters({ name: fqName }).pipe(
            Effect.flatMap((op) =>
              op.name
                ? awaitOperation(qualifyOp(fqName, op.name), session)
                : Effect.succeed(op),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const project = output?.project ?? olds?.project;
          const location = output?.location ?? olds?.location;
          if (!project || !location) return undefined;
          const name =
            output?.name ??
            olds?.name ??
            (yield* createPhysicalName({ id, maxLength: 40 })).toLowerCase();
          const fqName = `projects/${project}/locations/${location}/clusters/${name}`;
          const observed = yield* getClusters({ name: fqName }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined as cont.Cluster | undefined)),
            Effect.catchTag("Forbidden", () => Effect.succeed(undefined as cont.Cluster | undefined)),
          );
          if (!observed) return undefined;
          const attrs = toClusterAttributes(observed, { project, location });
          return (yield* hasAlchemyLabels(id, observed.resourceLabels))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
