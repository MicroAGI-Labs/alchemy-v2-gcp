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
    expect(attrs.networkConfig).toEqual({ acceleratorNetworkProfile: "auto" });
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

  test("live immutable drift is detected even when declared props are unchanged", async () => {
    const attrs = toNodePoolAttributes({ name: gb200.name, placementPolicy: gb200.placementPolicy }, gb200);
    expect(nodePoolTopologyDrift(attrs, gb200)).toEqual(["networkConfig.acceleratorNetworkProfile"]);
    await expect(Effect.runPromise(diffNodePoolTopology(gb200, gb200, attrs))).rejects.toThrow("immutable");
    expect(await Effect.runPromise(diffNodePoolTopology({}, gb200))).toBeUndefined();
  });

  test("real provider creates once, reads topology, and rejects incompatible live pools before mutations", async () => {
    let observed: cont.NodePool | undefined;
    const methods: string[] = [];
    const client = HttpClient.make((request) => Effect.sync(() => {
      methods.push(request.method);
      if (request.method === "POST") {
        expect(request.url).toEndWith("/nodePools");
        expect(request.body._tag).toBe("Uint8Array");
        if (request.body._tag !== "Uint8Array") throw new Error("Unexpected request body");
        observed = JSON.parse(new TextDecoder().decode(request.body.body)).nodePool;
        return HttpClientResponse.fromWeb(request, Response.json({}));
      }
      expect(request.method).toBe("GET");
      return HttpClientResponse.fromWeb(request, observed ? Response.json(observed) : Response.json({
        error: { code: 404, status: "NOT_FOUND", message: "Missing test pool" },
      }, { status: 404 }));
    }));
    const program = Effect.gen(function* () {
      const provider = yield* Provider.Provider<NodePool>(NodePool.Type);
      const input = { id: "gpu", news: gb200 } as Parameters<typeof provider.reconcile>[0];
      const created = yield* provider.reconcile(input);
      expect(created.networkConfig).toEqual(gb200.networkConfig);
      expect(created.placementPolicy).toEqual(gb200.placementPolicy);
      expect(methods.filter((method) => method !== "GET")).toEqual(["POST"]);
      methods.length = 0;
      yield* provider.reconcile(input);
      expect(methods.every((method) => method === "GET")).toBe(true);
      const read = yield* provider.read!({ id: "gpu", olds: gb200, output: created } as never);
      expect(read?.placementPolicy).toEqual(gb200.placementPolicy);
      expect(read?.networkConfig).toEqual(gb200.networkConfig);
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
