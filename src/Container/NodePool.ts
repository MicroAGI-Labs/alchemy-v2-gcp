import * as cont from "@distilled.cloud/gcp/container-v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { deepEqual, isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { gcpInternalLabels, hasAlchemyLabels } from "../Tags.ts";
import type * as GCP from "../Providers.ts";
import { makeAwaitOperation, qualifyOperationName } from "./Operations.ts";

export type NodePoolProps = {
  /** GCP project ID. Immutable — replace if changed. */
  project: string;
  /**
   * Cluster zone (e.g. `us-central1-a`) for a zonal cluster, or region
   * (e.g. `us-central1`) for a regional cluster. Immutable — replace.
   */
  location: string;
  /**
   * Parent cluster name. Immutable — node pools cannot be reparented; a
   * change here triggers a replace.
   */
  clusterName: string;
  /**
   * Pool name. Defaults to `createPhysicalName({ id, lowercase: true,
   * maxLength: 40 })`. Lowercase alphanumeric + hyphens, ≤40 chars.
   * Immutable — replace if changed.
   */
  name?: string;
  /**
   * Initial size at create time. GKE Standard rejects pool creation
   * without a positive node count, so when omitted we default to
   * `autoscaling.minNodeCount ?? 1` on the create path.
   *
   * Subsequent size changes go via `setSize` when `autoscaling` is
   * disabled, or are GKE-managed when `autoscaling.enabled` is true
   * (the size sync is skipped to avoid fighting the autoscaler).
   */
  initialNodeCount?: number;
  /**
   * Per-pool zones. Override the cluster default. Mutable via
   * `update` — sent in a standalone update body to avoid the SDK's
   * "do not combine with other fields" warning.
   */
  nodeLocations?: ReadonlyArray<string>;
  /** Node configuration (machine, disk, accelerators, taints, labels, …). */
  config: {
    /** GCE machine type, e.g. `n2-standard-4`. Mutable via `update`. */
    machineType: string;
    /** Boot disk size GB. Mutable via `update`. */
    diskSizeGb?: number;
    /** Boot disk type, e.g. `pd-balanced`. Mutable via `update`. */
    diskType?: string;
    /**
     * Image, e.g. `COS_CONTAINERD`, `UBUNTU_CONTAINERD`. Omit to let
     * GCP apply the GKE default for the cluster's release channel.
     * Mutable via `update`.
     */
    imageType?: string;
    /** GPUs / TPUs. Mutable via `update`. */
    accelerators?: ReadonlyArray<{
      type: string;
      count: number;
      gpuPartitionSize?: string;
      gpuDriverInstallationConfig?: { gpuDriverVersion?: string };
    }>;
    /**
     * GCE service account. Omit to let GCP fall back to the project's
     * default compute SA. **Replace-only** — not in `UpdateNodePoolRequest`.
     */
    serviceAccount?: string;
    /**
     * GCP API scopes. Omit to let GCP apply its default. **Replace-only**.
     */
    oauthScopes?: ReadonlyArray<string>;
    /** Kubernetes node taints. Mutable via `update`. */
    taints?: ReadonlyArray<{
      key: string;
      value: string;
      effect: "NO_SCHEDULE" | "PREFER_NO_SCHEDULE" | "NO_EXECUTE";
    }>;
    /** Kubernetes node labels (NOT GCP labels). Mutable via `update`. */
    labels?: Record<string, string>;
    /**
     * GCE resource labels. Alchemy internal labels are merged on top
     * automatically. Mutable via `update`.
     */
    resourceLabels?: Record<string, string>;
    /** Custom GCE metadata. **Replace-only**. */
    metadata?: Record<string, string>;
    /** Custom GCE tags (firewall). Mutable via `update`. */
    tags?: ReadonlyArray<string>;
    /** Min CPU platform. **Replace-only**. */
    minCpuPlatform?: string;
    /** Boot disk CMEK. **Replace-only**. */
    bootDiskKmsKey?: string;
    /** GKE Sandbox (gVisor). **Replace-only**. */
    sandboxConfig?: { type: "GVISOR" };
    /** Spot or PVM. **Replace-only**. */
    preemptible?: boolean;
    /** Spot VM. **Replace-only**. */
    spot?: boolean;
    /** Reservation affinity. **Replace-only**. */
    reservationAffinity?: {
      consumeReservationType: string;
      key?: string;
      values?: ReadonlyArray<string>;
    };
    /** Shielded VM. **Replace-only**. */
    shieldedInstanceConfig?: {
      enableSecureBoot?: boolean;
      enableIntegrityMonitoring?: boolean;
    };
    /**
     * Local SSDs via the legacy SCSI-era count field. Prefer
     * `localNvmeSsdBlockConfig` / `ephemeralStorageLocalSsdConfig` for
     * NVMe-only machine families (Gen3+, Titanium SSD). Mutually
     * exclusive with both. **Replace-only**.
     */
    localSsdCount?: number;
    /**
     * Raw-block local NVMe SSDs — exposed to workloads as unformatted
     * block devices (local PVs / your own RAID). For machine types with
     * a fixed disk count (e.g. g4-standard-48 → 4), `localSsdCount`
     * must equal that count or be 0/unset for the machine default.
     * **Replace-only**.
     */
    localNvmeSsdBlockConfig?: { localSsdCount?: number };
    /**
     * Local NVMe SSDs backing node ephemeral storage (emptyDir, image
     * layers, logs) — GKE RAID0s the disks. Same fixed-count rule as
     * `localNvmeSsdBlockConfig`. `dataCacheCount` carves disks out for
     * GKE Data Cache. **Replace-only**.
     */
    ephemeralStorageLocalSsdConfig?: {
      localSsdCount?: number;
      dataCacheCount?: number;
    };
    /** Workload Identity metadata. Mutable via `update`. */
    workloadMetadataConfig?: { mode: "GKE_METADATA" | "GCE_METADATA" };
    /** GVNIC. Mutable via `update`. */
    gvnic?: { enabled: boolean };
    /** Confidential VM. Mutable via `update`. */
    confidentialNodes?: { enabled: boolean };
  };
  /** Cluster autoscaler. Mutable via `setAutoscaling`. */
  autoscaling?: {
    enabled: boolean;
    minNodeCount?: number;
    maxNodeCount?: number;
    locationPolicy?: "BALANCED" | "ANY";
  };
  /** Auto-upgrade / auto-repair. Mutable via `setManagement`. */
  management?: { autoUpgrade?: boolean; autoRepair?: boolean };
  /** Surge upgrade settings. Mutable via `update`. */
  upgradeSettings?: {
    maxSurge?: number;
    maxUnavailable?: number;
    strategy?: "SURGE" | "BLUE_GREEN";
  };
};

export type NodePoolAttributes = {
  /** Pool name (matches the GKE resource). */
  name: string;
  /** Server-defined URL for the pool. */
  selfLink: string;
  /** GCP project ID, threaded through from props for `delete`/`read`. */
  project: string;
  /** Cluster zone or region, threaded through from props. */
  location: string;
  /** Parent cluster name. */
  clusterName: string;
  /** Current Kubernetes version of nodes in this pool. */
  version: string | undefined;
  /** Lifecycle status. */
  status: string | undefined;
  /** Managed instance group URLs backing the pool. */
  instanceGroupUrls: ReadonlyArray<string>;
};

/**
 * A node pool inside a GKE Standard cluster.
 *
 * Lifecycle is observe → ensure (create) → sync (size, autoscaling,
 * management, generic update) → return.
 *
 * Adoption: a pool whose `config.resourceLabels` lack our `alchemy_*`
 * keys is wrapped in `Unowned(attrs)`. Useful for adopting the inline
 * bootstrap pool created by `GCP.Cluster.initialNodePool` (which
 * intentionally carries no alchemy labels).
 *
 * @section Creating a node pool
 * @example CPU pool
 * ```typescript
 * const compute = yield* GCP.NodePool("compute", {
 *   project: project.projectId,
 *   location: cluster.location,
 *   clusterName: cluster.name,
 *   initialNodeCount: 1,
 *   config: { machineType: "n2-standard-16" },
 * });
 * ```
 *
 * @example GPU pool with autoscaling
 * ```typescript
 * const rtx6000 = yield* GCP.NodePool("rtx6000", {
 *   project: project.projectId,
 *   location: cluster.location,
 *   clusterName: cluster.name,
 *   config: {
 *     machineType: "g2-standard-12",
 *     accelerators: [{ type: "nvidia-l40s", count: 1 }],
 *   },
 *   autoscaling: { enabled: true, minNodeCount: 0, maxNodeCount: 4 },
 * });
 * ```
 */
export type NodePool = Resource<
  "GCP.NodePool",
  NodePoolProps,
  NodePoolAttributes,
  never,
  GCP.Providers
>;
export const NodePool = Resource<NodePool>("GCP.NodePool");

/**
 * Translate a public `accelerators` spec into the SDK's
 * `AcceleratorConfig`. Same shape on both create and update paths.
 */
const toAcceleratorConfig = (
  accelerators: NodePoolProps["config"]["accelerators"] | undefined,
): ReadonlyArray<cont.AcceleratorConfig> | undefined =>
  accelerators?.map((a) => ({
    acceleratorType: a.type,
    acceleratorCount: String(a.count),
    ...(a.gpuPartitionSize ? { gpuPartitionSize: a.gpuPartitionSize } : {}),
    ...(a.gpuDriverInstallationConfig
      ? { gpuDriverInstallationConfig: a.gpuDriverInstallationConfig }
      : {}),
  }));

/**
 * Build the `NodeConfig` sub-object for a create body. Numbers stay as
 * numbers; collections stay unwrapped (this is what GKE expects on
 * create — see SDK NodeConfig at container-v1.ts:1583).
 *
 * Internal alchemy labels are merged into `resourceLabels` here so the
 * pool is recognizable to `read`'s adoption gate. Exported for reuse by
 * `Cluster.toInitialNodePoolBody`.
 */
export const toNodeConfigCreateBody = (
  config: NodePoolProps["config"],
  desiredResourceLabels: Record<string, string>,
): cont.NodeConfig => {
  const accelerators = toAcceleratorConfig(config.accelerators);
  return {
    machineType: config.machineType,
    ...(config.diskSizeGb !== undefined ? { diskSizeGb: config.diskSizeGb } : {}),
    ...(config.diskType ? { diskType: config.diskType } : {}),
    ...(config.imageType ? { imageType: config.imageType } : {}),
    ...(accelerators ? { accelerators } : {}),
    ...(config.serviceAccount ? { serviceAccount: config.serviceAccount } : {}),
    ...(config.oauthScopes ? { oauthScopes: config.oauthScopes } : {}),
    ...(config.taints ? { taints: config.taints } : {}),
    ...(config.labels ? { labels: config.labels } : {}),
    resourceLabels: desiredResourceLabels,
    ...(config.metadata ? { metadata: config.metadata } : {}),
    ...(config.tags ? { tags: config.tags } : {}),
    ...(config.minCpuPlatform ? { minCpuPlatform: config.minCpuPlatform } : {}),
    ...(config.bootDiskKmsKey ? { bootDiskKmsKey: config.bootDiskKmsKey } : {}),
    ...(config.sandboxConfig ? { sandboxConfig: config.sandboxConfig } : {}),
    ...(config.preemptible !== undefined ? { preemptible: config.preemptible } : {}),
    ...(config.spot !== undefined ? { spot: config.spot } : {}),
    ...(config.reservationAffinity
      ? { reservationAffinity: config.reservationAffinity }
      : {}),
    ...(config.shieldedInstanceConfig
      ? { shieldedInstanceConfig: config.shieldedInstanceConfig }
      : {}),
    ...(config.localSsdCount !== undefined
      ? { localSsdCount: config.localSsdCount }
      : {}),
    ...(config.localNvmeSsdBlockConfig
      ? { localNvmeSsdBlockConfig: config.localNvmeSsdBlockConfig }
      : {}),
    ...(config.ephemeralStorageLocalSsdConfig
      ? { ephemeralStorageLocalSsdConfig: config.ephemeralStorageLocalSsdConfig }
      : {}),
    ...(config.workloadMetadataConfig
      ? { workloadMetadataConfig: config.workloadMetadataConfig }
      : {}),
    ...(config.gvnic ? { gvnic: config.gvnic } : {}),
    ...(config.confidentialNodes ? { confidentialNodes: config.confidentialNodes } : {}),
  };
};

/**
 * Build a non-location `UpdateNodePoolRequest` body, populating only
 * fields whose desired value differs from observed. Wrapping (NetworkTags
 * / NodeLabels / NodeTaints / ResourceLabels) and number→string for
 * `diskSizeGb` are applied at this boundary (SDK shapes diverge between
 * create and update — see container-v1.ts:4289).
 *
 * Returns `undefined` if no field requires updating.
 */
const toNodePoolUpdateBody = (
  observed: cont.NodePool,
  news: NodePoolProps,
  desiredResourceLabels: Record<string, string>,
): cont.UpdateNodePoolRequest | undefined => {
  const body: cont.UpdateNodePoolRequest = {};
  const oc = observed.config ?? {};
  const nc = news.config;

  if (nc.machineType !== undefined && nc.machineType !== oc.machineType) {
    body.machineType = nc.machineType;
  }
  if (nc.imageType !== undefined && nc.imageType !== oc.imageType) {
    body.imageType = nc.imageType;
  }
  if (nc.diskType !== undefined && nc.diskType !== oc.diskType) {
    body.diskType = nc.diskType;
  }
  if (
    nc.diskSizeGb !== undefined &&
    String(nc.diskSizeGb) !== String(oc.diskSizeGb ?? "")
  ) {
    body.diskSizeGb = String(nc.diskSizeGb);
  }

  const desiredAccelerators = toAcceleratorConfig(nc.accelerators);
  if (
    desiredAccelerators &&
    !deepEqual(oc.accelerators ?? [], desiredAccelerators)
  ) {
    body.accelerators = desiredAccelerators;
  }

  if (nc.tags && !deepEqual(oc.tags ?? [], nc.tags)) {
    body.tags = { tags: nc.tags };
  }
  if (nc.labels && !deepEqual(oc.labels ?? {}, nc.labels)) {
    body.labels = { labels: nc.labels };
  }
  if (nc.taints && !deepEqual(oc.taints ?? [], nc.taints)) {
    body.taints = { taints: nc.taints };
  }
  // GKE injects its own `goog-*` resource labels (accelerator type,
  // provisioning model, …) after create. Treat them as server-managed:
  // fold the observed ones into the desired set before diffing, or
  // every reconcile issues a labels update — which on a large pool is
  // a long rolling cluster operation that wedges all other mutations
  // on the cluster ("incompatible operation").
  const observedResourceLabels = oc.resourceLabels ?? {};
  const desiredWithServerManaged = {
    ...Object.fromEntries(
      Object.entries(observedResourceLabels).filter(([k]) =>
        k.startsWith("goog-"),
      ),
    ),
    ...desiredResourceLabels,
  };
  if (!deepEqual(observedResourceLabels, desiredWithServerManaged)) {
    body.resourceLabels = { labels: desiredWithServerManaged };
  }

  if (nc.gvnic && !deepEqual(oc.gvnic, nc.gvnic)) {
    body.gvnic = nc.gvnic;
  }
  if (nc.confidentialNodes && !deepEqual(oc.confidentialNodes, nc.confidentialNodes)) {
    body.confidentialNodes = nc.confidentialNodes;
  }
  if (
    nc.workloadMetadataConfig &&
    !deepEqual(oc.workloadMetadataConfig, nc.workloadMetadataConfig)
  ) {
    body.workloadMetadataConfig = nc.workloadMetadataConfig;
  }
  if (
    news.upgradeSettings &&
    !deepEqual(observed.upgradeSettings, news.upgradeSettings)
  ) {
    body.upgradeSettings = news.upgradeSettings;
  }

  return Object.keys(body).length === 0 ? undefined : body;
};

const toNodePoolAttributes = (
  pool: cont.NodePool,
  parent: { project: string; location: string; clusterName: string },
): NodePoolAttributes => ({
  name: pool.name ?? "",
  selfLink: pool.selfLink ?? "",
  project: parent.project,
  location: parent.location,
  clusterName: parent.clusterName,
  version: pool.version,
  status: pool.status,
  instanceGroupUrls: pool.instanceGroupUrls ?? [],
});

export const NodePoolProvider = () =>
  Provider.effect(
    NodePool,
    Effect.gen(function* () {
      const getNodePools = yield* cont.getProjectsLocationsClustersNodePools;
      const listNodePools = yield* cont.listProjectsLocationsClustersNodePools;
      const createNodePools = yield* cont.createProjectsLocationsClustersNodePools;
      const updateNodePools = yield* cont.updateProjectsLocationsClustersNodePools;
      const setSize = yield* cont.setSizeProjectsLocationsClustersNodePools;
      const setAutoscaling = yield* cont.setAutoscalingProjectsLocationsClustersNodePools;
      const setManagement = yield* cont.setManagementProjectsLocationsClustersNodePools;
      const deleteNodePools = yield* cont.deleteProjectsLocationsClustersNodePools;
      const getOperations = yield* cont.getProjectsLocationsOperations;
      const awaitOperation = makeAwaitOperation(getOperations);

      // Qualify a bare GKE operation id using the parent path of the
      // resource it targets. NodePool fqNames have the shape
      // `projects/{p}/locations/{l}/clusters/{c}/nodePools/{n}`; the
      // first four segments give us the parent context for the
      // operation, identical to Cluster's helper.
      const qualifyOp = (fqName: string, opName: string) =>
        qualifyOperationName(
          fqName.split("/")[1],
          fqName.split("/")[3],
          opName,
        );

      const syncNodePoolSize = Effect.fn(function* (args: {
        fqName: string;
        observed: cont.NodePool;
        news: NodePoolProps;
        session: ScopedPlanStatusSession;
      }) {
        // Skip when the autoscaler is enabled; fighting it creates churn.
        if (args.news.autoscaling?.enabled) return;
        if (args.news.initialNodeCount === undefined) return;
        const observedCount = args.observed.initialNodeCount;
        if (observedCount === args.news.initialNodeCount) return;
        const op = yield* setSize({
          name: args.fqName,
          body: { nodeCount: args.news.initialNodeCount },
        });
        if (op.name) yield* awaitOperation(qualifyOp(args.fqName, op.name), args.session);
      });

      const syncNodePoolAutoscaling = Effect.fn(function* (args: {
        fqName: string;
        observed: cont.NodePool;
        news: NodePoolProps;
        session: ScopedPlanStatusSession;
      }) {
        if (!args.news.autoscaling) return;
        if (deepEqual(args.observed.autoscaling, args.news.autoscaling)) return;
        const op = yield* setAutoscaling({
          name: args.fqName,
          body: { autoscaling: args.news.autoscaling },
        });
        if (op.name) yield* awaitOperation(qualifyOp(args.fqName, op.name), args.session);
      });

      const syncNodePoolManagement = Effect.fn(function* (args: {
        fqName: string;
        observed: cont.NodePool;
        news: NodePoolProps;
        session: ScopedPlanStatusSession;
      }) {
        if (!args.news.management) return;
        if (deepEqual(args.observed.management, args.news.management)) return;
        const op = yield* setManagement({
          name: args.fqName,
          body: { management: args.news.management },
        });
        if (op.name) yield* awaitOperation(qualifyOp(args.fqName, op.name), args.session);
      });

      const syncNodePoolUpdate = Effect.fn(function* (args: {
        fqName: string;
        observed: cont.NodePool;
        news: NodePoolProps;
        desiredResourceLabels: Record<string, string>;
        session: ScopedPlanStatusSession;
      }) {
        // 1. Locations — sent as a standalone update body. The SDK
        //    explicitly warns not to combine `locations` with other
        //    fields; if you do, the other fields only apply to newly-
        //    created nodes.
        if (
          args.news.nodeLocations &&
          !deepEqual(args.observed.locations ?? [], args.news.nodeLocations)
        ) {
          const op = yield* updateNodePools({
            name: args.fqName,
            body: { locations: args.news.nodeLocations },
          });
          if (op.name) yield* awaitOperation(qualifyOp(args.fqName, op.name), args.session);
        }

        // 2. Re-observe so the non-location update diffs against fresh
        //    state (the location update may have rewritten labels/taints
        //    on new nodes already).
        const fresh = yield* getNodePools({ name: args.fqName });
        const body = toNodePoolUpdateBody(fresh, args.news, args.desiredResourceLabels);
        if (!body) return;

        const op = yield* updateNodePools({ name: args.fqName, body });
        if (op.name) yield* awaitOperation(qualifyOp(args.fqName, op.name), args.session);
      });

      return {
        stables: ["name", "selfLink", "project", "location", "clusterName"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as NodePoolProps, news, [
              "project",
              "location",
              "clusterName",
              "name",
            ])
          ) {
            return { action: "replace" } as const;
          }
          const oc = olds.config ?? ({} as NodePoolProps["config"]);
          const nc = news.config;
          if (
            somePropsAreDifferent(oc, nc, [
              "serviceAccount",
              "minCpuPlatform",
              "bootDiskKmsKey",
              "preemptible",
              "spot",
              "localSsdCount",
            ])
          ) {
            return { action: "replace" } as const;
          }
          if (
            !deepEqual(oc.oauthScopes, nc.oauthScopes) ||
            !deepEqual(oc.metadata, nc.metadata) ||
            !deepEqual(oc.sandboxConfig, nc.sandboxConfig) ||
            !deepEqual(oc.reservationAffinity, nc.reservationAffinity) ||
            !deepEqual(oc.shieldedInstanceConfig, nc.shieldedInstanceConfig) ||
            !deepEqual(oc.localNvmeSsdBlockConfig, nc.localNvmeSsdBlockConfig) ||
            !deepEqual(
              oc.ephemeralStorageLocalSsdConfig,
              nc.ephemeralStorageLocalSsdConfig,
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
            (yield* createPhysicalName({ id, maxLength: 40 })).toLowerCase();
          const clusterPath = `projects/${news.project}/locations/${news.location}/clusters/${news.clusterName}`;
          const fqName = `${clusterPath}/nodePools/${desiredName}`;
          const desiredResourceLabels: Record<string, string> = {
            ...(news.config.resourceLabels ?? {}),
            ...internalLabels,
          };

          // 1. Observe — collapse 403 to "missing" alongside 404, mirroring
          //    Project.observeProject's stance that GCP returns 403 for
          //    invisible resources.
          let observed = yield* getNodePools({ name: fqName }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined as cont.NodePool | undefined)),
            Effect.catchTag("Forbidden", () => Effect.succeed(undefined as cont.NodePool | undefined)),
          );

          // 2. Ensure — create if missing. `Conflict` covers concurrent
          //    creates and state-persistence races; fall through and
          //    re-observe.
          if (!observed) {
            const config = toNodeConfigCreateBody(news.config, desiredResourceLabels);
            // GKE Standard rejects creates without a positive node
            // count. If the user didn't specify, fall back to the
            // autoscaler floor (or 1 if there's no autoscaler config).
            const createNodeCount =
              news.initialNodeCount ?? news.autoscaling?.minNodeCount ?? 1;
            const op = yield* createNodePools({
              parent: clusterPath,
              body: {
                nodePool: {
                  name: desiredName,
                  initialNodeCount: createNodeCount,
                  ...(news.nodeLocations ? { locations: news.nodeLocations } : {}),
                  config,
                  ...(news.autoscaling ? { autoscaling: news.autoscaling } : {}),
                  ...(news.management ? { management: news.management } : {}),
                  ...(news.upgradeSettings ? { upgradeSettings: news.upgradeSettings } : {}),
                },
              },
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as cont.Operation | undefined),
              ),
            );
            if (op?.name) yield* awaitOperation(qualifyOp(fqName, op.name), session);
            observed = yield* getNodePools({ name: fqName });
          }

          // 3. Sync — sequential, each aspect independently idempotent.
          yield* syncNodePoolSize({ fqName, observed, news, session });
          yield* syncNodePoolAutoscaling({ fqName, observed, news, session });
          yield* syncNodePoolManagement({ fqName, observed, news, session });
          yield* syncNodePoolUpdate({
            fqName,
            observed,
            news,
            desiredResourceLabels,
            session,
          });

          const final = yield* getNodePools({ name: fqName });
          return toNodePoolAttributes(final, {
            project: news.project,
            location: news.location,
            clusterName: news.clusterName,
          });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const fqName = `projects/${output.project}/locations/${output.location}/clusters/${output.clusterName}/nodePools/${output.name}`;
          yield* deleteNodePools({ name: fqName }).pipe(
            Effect.flatMap((op) =>
              op.name
                ? awaitOperation(qualifyOp(fqName, op.name), session)
                : Effect.succeed(op),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          // ProviderService.read receives `{ id, instanceId, olds, output }`
          // — no `news`. Identity must come from output (post-create
          // cache) or olds (last-persisted props).
          const project = output?.project ?? olds?.project;
          const location = output?.location ?? olds?.location;
          const clusterName = output?.clusterName ?? olds?.clusterName;
          if (!project || !location || !clusterName) return undefined;
          const name = output?.name ?? olds?.name;
          let observed: cont.NodePool | undefined;
          if (name) {
            const fqName = `projects/${project}/locations/${location}/clusters/${clusterName}/nodePools/${name}`;
            observed = yield* getNodePools({ name: fqName }).pipe(
              Effect.catchTag("NotFound", () => Effect.succeed(undefined as cont.NodePool | undefined)),
              Effect.catchTag("Forbidden", () => Effect.succeed(undefined as cont.NodePool | undefined)),
            );
          } else {
            // Cold recovery (lost state): the pool name truncates the
            // logical id and appends a random per-instance suffix that
            // lived only in state, so a probe against a freshly-generated
            // name can never hit. Scan the cluster's pools for our
            // alchemy labels (stamped into config.resourceLabels).
            const page = yield* listNodePools({
              parent: `projects/${project}/locations/${location}/clusters/${clusterName}`,
            }).pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed(undefined as cont.ListNodePoolsResponse | undefined),
              ),
              Effect.catchTag("Forbidden", () =>
                Effect.succeed(undefined as cont.ListNodePoolsResponse | undefined),
              ),
            );
            for (const candidate of page?.nodePools ?? []) {
              if (
                yield* hasAlchemyLabels(id, candidate.config?.resourceLabels)
              ) {
                observed = candidate;
                break;
              }
            }
          }
          if (!observed) return undefined;
          const attrs = toNodePoolAttributes(observed, {
            project,
            location,
            clusterName,
          });
          return (yield* hasAlchemyLabels(id, observed.config?.resourceLabels))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
