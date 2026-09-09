import { describe, expect, test } from "bun:test";
import {
  NodePool, NodePoolProvider, diffNodePoolTopology, nodePoolSizeNeedsSync,
  nodePoolTopologyDrift, toNodePoolAttributes, toNodePoolCreateBody,
  type NodePoolProps,
} from "../../src/Container/NodePool.ts";
import * as cont from "@distilled.cloud/gcp/container_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Provider from "alchemy/Provider";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

describe("NodePool size ownership", () => {
  test("syncs a fixed-size pool when observed size drifts", () => {
    expect(nodePoolSizeNeedsSync(2, { initialNodeCount: 3 })).toBe(true);
  });

  test("does not sync an externally managed pool", () => {
    expect(
      nodePoolSizeNeedsSync(2, {
        initialNodeCount: 3,
        externallyManagedSize: true,
      }),
    ).toBe(false);
  });

  test("does not sync an autoscaled pool", () => {
    expect(
      nodePoolSizeNeedsSync(2, {
        initialNodeCount: 3,
        autoscaling: { enabled: true },
      }),
    ).toBe(false);
  });

  test("does not sync when no steady-state size is declared", () => {
    expect(nodePoolSizeNeedsSync(2, {})).toBe(false);
  });
});

const gb200: NodePoolProps = {
  project: "cluster-project", location: "us-east1", clusterName: "research",
  name: "gb200-rack-a", initialNodeCount: 18, nodeLocations: ["us-east1-d"],
  placementPolicy: { type: "COMPACT", policyName: "gb200-nvl72" },
  networkConfig: { acceleratorNetworkProfile: "auto" },
  config: {
    machineType: "a4x-highgpu-4g", imageType: "COS_CONTAINERD", diskType: "hyperdisk-balanced",
    accelerators: [{ type: "nvidia-gb200", count: 4 }],
    labels: { "cloud.google.com/gke-networking-dra-driver": "true" },
    reservationAffinity: {
      consumeReservationType: "SPECIFIC_RESERVATION", key: "compute.googleapis.com/reservation-name",
      values: ["projects/reservation-project/reservations/gb200/reservationBlocks/block-a"],
    },
  },
  upgradeSettings: { maxSurge: 0, maxUnavailable: 1 },
};

describe("NodePool accelerator topology", () => {
  test("maps topology and automated networking onto pool-level API fields", () => {
    const body = toNodePoolCreateBody(gb200, gb200.name!, { alchemy_id: "gpu" });
    expect(body.placementPolicy).toEqual(gb200.placementPolicy);
    expect(body.networkConfig).toEqual({ acceleratorNetworkProfile: "auto" });
    expect(body.config).not.toHaveProperty("networkConfig");
    expect(body.config).not.toHaveProperty("placementPolicy");
    expect(body.config?.accelerators?.[0]?.acceleratorCount).toBe("4");
    expect(body.config?.reservationAffinity?.values).toEqual([...gb200.config.reservationAffinity!.values!]);
    expect(body.locations).toEqual(["us-east1-d"]);
    expect(body.initialNodeCount).toBe(18);
    expect(body.upgradeSettings).toEqual({ maxSurge: 0, maxUnavailable: 1 });
  });

  test("ordinary pools omit optional topology fields and retain create sizing defaults", () => {
    const ordinary = { ...gb200, placementPolicy: undefined, networkConfig: undefined, initialNodeCount: undefined };
    const body = toNodePoolCreateBody(ordinary, "ordinary", {});
    expect(body).not.toHaveProperty("placementPolicy");
    expect(body).not.toHaveProperty("networkConfig");
    expect(body.initialNodeCount).toBe(1);
    expect(toNodePoolCreateBody({ ...ordinary, autoscaling: { enabled: true, minNodeCount: 3 } }, "ordinary", {}).initialNodeCount).toBe(3);
  });

  test("read attributes track declared topology while ignoring GKE-generated NICs", async () => {
    const observed = {
      ...toNodePoolCreateBody(gb200, gb200.name!, {}),
      networkConfig: {
        acceleratorNetworkProfile: "auto",
        additionalNodeNetworkConfigs: [{ network: "generated-rdma", subnetwork: "generated-rail-0" }],
      },
    };
    const attrs = toNodePoolAttributes(observed, gb200);
    expect(attrs.networkConfig).toMatchObject({ acceleratorNetworkProfile: "auto" });
    expect(attrs.placementPolicy).toEqual(gb200.placementPolicy);
    expect(nodePoolTopologyDrift(observed, gb200)).toEqual([]);
    expect(await Effect.runPromise(diffNodePoolTopology(gb200, gb200, attrs))).toBeUndefined();
    expect(nodePoolTopologyDrift(observed, { ...gb200, placementPolicy: undefined, networkConfig: undefined })).toEqual([]);
  });

  test.each([
    { ...gb200, placementPolicy: { type: "COMPACT" as const, policyName: "other-policy" } },
    { ...gb200, networkConfig: undefined },
  ])("blocks immutable changes reusing a fixed physical name", async (news) => {
    await expect(Effect.runPromise(diffNodePoolTopology(gb200, news))).rejects.toThrow("Choose a new pool name");
    expect(await Effect.runPromise(diffNodePoolTopology(gb200, { ...news, name: "new-rack" }))).toEqual({ action: "replace" });
    expect(await Effect.runPromise(diffNodePoolTopology(
      { ...gb200, name: undefined }, { ...news, name: undefined },
    ))).toEqual({ action: "replace" });
  });

  test("explicit NIC mapping preserves rail order and blocks reorder/removal at a fixed name", async () => {
    const networks = Array.from({ length: 5 }, (_, i) => ({
      network: `projects/host/global/networks/${i === 0 ? "gvnic" : "rdma"}`,
      subnetwork: `projects/host/regions/us-east1/subnetworks/rail-${i}`,
    }));
    const explicit = { ...gb200, networkConfig: { additionalNodeNetworkConfigs: networks } };
    const body = toNodePoolCreateBody(explicit, explicit.name!, {});
    expect(body.networkConfig).toEqual({ additionalNodeNetworkConfigs: networks });
    const observed = { ...body, networkConfig: { additionalNodeNetworkConfigs: networks.map((nic) => ({
      network: `https://www.googleapis.com/compute/v1/${nic.network}`,
      subnetwork: `https://www.googleapis.com/compute/v1/${nic.subnetwork}`,
    })) } };
    const attrs = toNodePoolAttributes(observed, explicit);
    expect(attrs.networkConfig?.additionalNodeNetworkConfigs).toHaveLength(5);
    expect(nodePoolTopologyDrift(observed, explicit)).toEqual([]);
    expect(await Effect.runPromise(diffNodePoolTopology(explicit, explicit, attrs))).toBeUndefined();
    const reordered = { ...explicit, networkConfig: { additionalNodeNetworkConfigs: [...networks].reverse() } };
    expect(nodePoolTopologyDrift(observed, reordered)).toEqual(["networkConfig.additionalNodeNetworkConfigs"]);
    await expect(Effect.runPromise(diffNodePoolTopology(explicit, reordered))).rejects.toThrow("Choose a new pool name");
    await expect(Effect.runPromise(diffNodePoolTopology(explicit, { ...explicit, networkConfig: undefined }))).rejects.toThrow("Choose a new pool name");
    expect(await Effect.runPromise(diffNodePoolTopology(explicit, { ...reordered, name: "new" }))).toEqual({ action: "replace" });
  });

  test("failed auto-network attempts recover matching explicit live pools without replacement", async () => {
    const desired = { ...gb200, networkConfig: { additionalNodeNetworkConfigs: [{
      network: "projects/host/global/networks/rdma", subnetwork: "projects/host/regions/us-east1/subnetworks/rail-0",
    }] } };
    const observed = toNodePoolAttributes({ name: desired.name, placementPolicy: desired.placementPolicy, networkConfig: {
      subnetwork: "projects/host/regions/us-east1/subnetworks/primary",
      additionalNodeNetworkConfigs: [{ network: "rdma", subnetwork: "rail-0" }],
    } }, desired);
    expect(await Effect.runPromise(diffNodePoolTopology(gb200, desired, observed))).toEqual({ action: "update" });
    for (const output of [
      undefined,
      { ...observed, name: "unrelated-pool" },
      { ...observed, project: "other-project" },
      { ...observed, location: "us-west1" },
      { ...observed, clusterName: "other-cluster" },
      { ...observed, placementPolicy: { policyName: "other-policy" } },
      { ...observed, networkConfig: { ...observed.networkConfig, additionalNodeNetworkConfigs: [{ network: "rdma", subnetwork: "wrong-rail" }] } },
    ]) await expect(Effect.runPromise(diffNodePoolTopology(gb200, desired, output))).rejects.toThrow("Choose a new pool name");
    // Omitting fields is not evidence that the live immutable setting vanished.
    await expect(Effect.runPromise(diffNodePoolTopology(desired, { ...desired, networkConfig: undefined }, observed))).rejects.toThrow("Choose a new pool name");
    await expect(Effect.runPromise(diffNodePoolTopology(desired, { ...desired, placementPolicy: undefined }, observed))).rejects.toThrow("Choose a new pool name");
  });

  test("bare observed NIC names use primary subnet host/region without conflating qualified references", async () => {
    const desired = { ...gb200, networkConfig: { additionalNodeNetworkConfigs: [{
      network: "projects/host/global/networks/rdma", subnetwork: "projects/host/regions/us-east1/subnetworks/rail-0",
    }] } };
    const observed = { placementPolicy: gb200.placementPolicy, networkConfig: {
      subnetwork: "projects/host/regions/us-east1/subnetworks/primary",
      additionalNodeNetworkConfigs: [{ network: "rdma", subnetwork: "rail-0" }],
    } };
    expect(nodePoolTopologyDrift(observed, desired)).toEqual([]);
    const attrs = toNodePoolAttributes(observed, desired);
    expect(attrs.networkConfig?.subnetwork).toBe(observed.networkConfig.subnetwork);
    expect(await Effect.runPromise(diffNodePoolTopology(desired, desired, attrs))).toBeUndefined();
    for (const nic of [
      { network: "projects/other/global/networks/rdma", subnetwork: "projects/host/regions/us-east1/subnetworks/rail-0" },
      { network: "projects/host/global/networks/rdma", subnetwork: "projects/host/regions/us-west1/subnetworks/rail-0" },
    ]) {
      const changed = { ...desired, networkConfig: { additionalNodeNetworkConfigs: [nic] } };
      expect(nodePoolTopologyDrift(observed, changed)).toEqual(["networkConfig.additionalNodeNetworkConfigs"]);
      await expect(Effect.runPromise(diffNodePoolTopology(desired, changed, attrs))).rejects.toThrow("Choose a new pool name");
    }
    expect(nodePoolTopologyDrift({ ...observed, networkConfig: { ...observed.networkConfig, subnetwork: undefined } }, desired)).toEqual(["networkConfig.additionalNodeNetworkConfigs"]);
    expect(nodePoolTopologyDrift({ ...observed, networkConfig: { ...observed.networkConfig, subnetwork: "projects/other/regions/us-east1/subnetworks/primary" } }, desired)).toEqual(["networkConfig.additionalNodeNetworkConfigs"]);
  });

  test("named policy identity tolerates sparse type responses while unnamed placement remains strict", async () => {
    const sparse = { ...gb200, placementPolicy: { policyName: "gb200-nvl72" } };
    expect(nodePoolTopologyDrift(sparse, gb200)).toEqual([]);
    expect(await Effect.runPromise(diffNodePoolTopology(gb200, sparse))).toBeUndefined();
    expect(nodePoolTopologyDrift({ ...sparse, placementPolicy: { policyName: "other" } }, gb200)).toEqual(["placementPolicy"]);
    const unnamed = { ...gb200, placementPolicy: { type: "COMPACT" as const } };
    expect(nodePoolTopologyDrift({ ...unnamed, placementPolicy: {} }, unnamed)).toEqual(["placementPolicy"]);
    await expect(Effect.runPromise(diffNodePoolTopology(unnamed, { ...unnamed, placementPolicy: undefined }))).rejects.toThrow("Choose a new pool name");
  });

  test("live immutable drift is detected even when declared props are unchanged", async () => {
    const attrs = toNodePoolAttributes({ name: gb200.name, placementPolicy: gb200.placementPolicy }, gb200);
    expect(nodePoolTopologyDrift(attrs, gb200)).toEqual(["networkConfig.acceleratorNetworkProfile"]);
    await expect(Effect.runPromise(diffNodePoolTopology(gb200, gb200, attrs))).rejects.toThrow("immutable");
    expect(await Effect.runPromise(diffNodePoolTopology({}, gb200))).toBeUndefined();
  });

  test.each([
    gb200,
    { ...gb200, networkConfig: { additionalNodeNetworkConfigs: Array.from({ length: 5 }, (_, i) => ({ network: `projects/host/global/networks/${i ? "rdma" : "gvnic"}`, subnetwork: `projects/host/regions/us-east1/subnetworks/rail-${i}` })) } },
  ])("real provider creates once, reads topology, and rejects incompatible live pools before mutations", async (desired) => {
    let observed: cont.NodePool | undefined;
    const methods: string[] = [];
    const client = HttpClient.make((request) => Effect.sync(() => {
      methods.push(request.method);
      if (request.method === "POST") {
        expect(request.url).toEndWith("/nodePools");
        expect(request.body._tag).toBe("Uint8Array");
        if (request.body._tag !== "Uint8Array") throw new Error("Unexpected request body");
        observed = JSON.parse(new TextDecoder().decode(request.body.body)).nodePool;
        // Exercise a sparse named-policy response through the actual reconciler.
        delete observed!.placementPolicy!.type;
        if (observed!.networkConfig?.additionalNodeNetworkConfigs) {
          expect(observed!.networkConfig.additionalNodeNetworkConfigs).toEqual([...(desired.networkConfig?.additionalNodeNetworkConfigs ?? [])]);
          observed!.networkConfig.subnetwork = "projects/host/regions/us-east1/subnetworks/primary";
          observed!.networkConfig.additionalNodeNetworkConfigs = observed!.networkConfig.additionalNodeNetworkConfigs.map((nic) => ({
            network: nic.network!.split("/").at(-1), subnetwork: nic.subnetwork!.split("/").at(-1),
          }));
        }
        return HttpClientResponse.fromWeb(request, Response.json({}));
      }
      expect(request.method).toBe("GET");
      return HttpClientResponse.fromWeb(request, observed ? Response.json(observed) : Response.json({
        error: { code: 404, status: "NOT_FOUND", message: "Missing test pool" },
      }, { status: 404 }));
    }));
    const program = Effect.gen(function* () {
      const provider = yield* Provider.Provider<NodePool>(NodePool.Type);
      const input = { id: "gpu", news: desired } as Parameters<typeof provider.reconcile>[0];
      const invalid = { ...desired, networkConfig: { acceleratorNetworkProfile: "auto" as const, additionalNodeNetworkConfigs: [{ network: "net", subnetwork: "sub" }] } };
      expect(String(yield* provider.reconcile({ ...input, news: invalid }).pipe(Effect.flip))).toContain("mutually exclusive");
      expect(methods).toEqual([]);
      const created = yield* provider.reconcile(input);
      expect(created.networkConfig).toEqual(observed!.networkConfig);
      expect(nodePoolTopologyDrift(created, desired)).toEqual([]);
      if (desired.networkConfig?.additionalNodeNetworkConfigs) {
        // Plan recovery supplies stale failed-auto props plus fresh read output.
        expect(yield* provider.diff!({ id: "gpu", olds: gb200, news: desired, output: created } as never)).toEqual({ action: "update" });
        // Recovery must not bypass independent immutable node-config checks.
        expect(yield* provider.diff!({ id: "gpu", olds: gb200, news: {
          ...desired, config: { ...desired.config, serviceAccount: "different-service-account" },
        }, output: created } as never)).toEqual({ action: "replace" });
      }
      const interruptedOld = { ...gb200, config: { ...gb200.config, reservationAffinity: {
        ...gb200.config.reservationAffinity!, values: [null],
      } } } as unknown as NodePoolProps;
      expect(created.config?.reservationAffinity?.values).toEqual([...(desired.config.reservationAffinity?.values ?? [])]);
      // Exact persisted failure: null was serialized for an unresolved reservation Output.
      expect(yield* provider.diff!({ id: "gpu", olds: interruptedOld, news: desired, output: created } as never)).toEqual({ action: "update" });
      for (const output of [
        { ...created, config: undefined },
        { ...created, config: { reservationAffinity: { ...created.config!.reservationAffinity!, values: ["projects/other/reservations/wrong"] } } },
      ]) expect(String(yield* provider.diff!({ id: "gpu", olds: interruptedOld, news: desired, output } as never).pipe(Effect.flip))).toContain("matching live reservation evidence");
      expect(String(yield* provider.diff!({ id: "gpu", olds: interruptedOld, news: {
        ...desired, config: { ...desired.config, reservationAffinity: { ...desired.config.reservationAffinity!, values: ["projects/other/reservations/wrong"] } },
      }, output: created } as never).pipe(Effect.flip))).toContain("matching live reservation evidence");
      expect(yield* provider.diff!({ id: "gpu", olds: interruptedOld, news: {
        ...desired, config: { ...desired.config, serviceAccount: "different-service-account" },
      }, output: created } as never)).toEqual({ action: "replace" });
      expect(created.placementPolicy).toEqual({ policyName: "gb200-nvl72" });
      expect(methods.filter((method) => method !== "GET")).toEqual(["POST"]);
      methods.length = 0;
      yield* provider.reconcile(input);
      expect(methods.every((method) => method === "GET")).toBe(true);
      const read = yield* provider.read!({ id: "gpu", olds: gb200, output: created } as never);
      expect(read?.placementPolicy).toEqual({ policyName: "gb200-nvl72" });
      expect(read?.networkConfig).toEqual(observed!.networkConfig);
      expect(yield* provider.diff!({ id: "gpu", olds: desired, news: desired, output: created } as never)).toBeUndefined();
      const originalConfig = observed!.config;
      observed!.config = { ...originalConfig, reservationAffinity: { ...originalConfig!.reservationAffinity!, values: ["projects/other/reservations/wrong"] } };
      methods.length = 0;
      expect(String(yield* provider.reconcile(input).pipe(Effect.flip))).toContain("matching live reservation evidence");
      expect(methods).toEqual(["GET"]);
      observed!.config = originalConfig;
      observed = { ...observed, networkConfig: undefined };
      methods.length = 0;
      const failure = yield* provider.reconcile(input).pipe(Effect.flip);
      expect(String(failure)).toContain("incompatible immutable");
      expect(methods).toEqual(["GET"]);
    }).pipe(
      Effect.provide(NodePoolProvider()),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(Credentials, Effect.succeed({ accessToken: Redacted.make("unit-test-only") })),
      Effect.provideService(Stage, "test"),
      Effect.provideService(Stack, { name: "nodepool-test", stage: "test" } as Stack["Service"]),
    );
    await Effect.runPromise(program as Effect.Effect<void>);
  });
});
