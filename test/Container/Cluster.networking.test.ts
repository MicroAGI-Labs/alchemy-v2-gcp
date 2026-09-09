import { describe, expect, test } from "bun:test";
import { Cluster, ClusterProvider, diffClusterProps, type ClusterProps } from "../../src/Container/Cluster.ts";
import type * as cont from "@distilled.cloud/gcp/container_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Provider from "alchemy/Provider";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const initial: ClusterProps = {
  project: "consumer", location: "us-east1", name: "existing-cluster",
  networkConfig: { datapathProvider: "ADVANCED_DATAPATH" },
  initialNodePool: { name: "cpu", initialNodeCount: 1, config: { machineType: "e2-medium" } },
};

describe("Cluster multi-networking", () => {
  test("updates in place, awaits the operation, observes state, and repairs drift", async () => {
    let live: cont.Cluster | undefined;
    const mutations: { method: string; body: unknown }[] = [];
    let operationReads = 0;
    const client = HttpClient.make((request) => Effect.sync(() => {
      if (request.url.includes("/operations/")) {
        operationReads++;
        return HttpClientResponse.fromWeb(request, Response.json({ name: "enable-op", status: "DONE" }));
      }
      if (request.method !== "GET") {
        if (request.body._tag !== "Uint8Array") throw new Error("Unexpected request body");
        const body = JSON.parse(new TextDecoder().decode(request.body.body));
        mutations.push({ method: request.method, body });
        if (request.method === "POST") {
          expect(request.url).toEndWith("/projects/consumer/locations/us-east1/clusters");
          live = body.cluster;
          return HttpClientResponse.fromWeb(request, Response.json({}));
        }
        expect(request.method).toBe("PUT");
        expect(request.url).toEndWith("/projects/consumer/locations/us-east1/clusters/existing-cluster");
        live!.networkConfig = { ...live!.networkConfig, enableMultiNetworking: body.update.desiredEnableMultiNetworking };
        return HttpClientResponse.fromWeb(request, Response.json({ name: "enable-op", status: "RUNNING" }));
      }
      return HttpClientResponse.fromWeb(request, live ? Response.json(live) : Response.json({ error: { code: 404, status: "NOT_FOUND", message: "Missing cluster" } }, { status: 404 }));
    }));
    const program = Effect.gen(function* () {
      const provider = yield* Provider.Provider<Cluster>(Cluster.Type);
      const input: Parameters<typeof provider.reconcile>[0] = { id: "cluster", fqn: "cluster", instanceId: "test", news: initial, olds: undefined, output: undefined, bindings: [], session: { note: () => Effect.void } as never };
      const created = yield* provider.reconcile(input);
      expect(created.networkConfig?.enableMultiNetworking).toBe(false);
      const enabled: ClusterProps = { ...initial, networkConfig: { ...initial.networkConfig, enableMultiNetworking: true } };
      expect(diffClusterProps(initial, enabled)).toBeUndefined();
      const diff = { id: "cluster", olds: initial, news: enabled, output: created } as Parameters<NonNullable<typeof provider.diff>>[0];
      expect(yield* provider.diff!(diff)).toEqual({ action: "update" });
      const result = yield* provider.reconcile({ ...input, news: enabled, olds: initial, output: created });
      expect(result.networkConfig?.enableMultiNetworking).toBe(true);
      expect(operationReads).toBe(1);
      expect(mutations.slice(1)).toEqual([{ method: "PUT", body: { update: { desiredEnableMultiNetworking: true } } }]);
      expect(yield* provider.read!({ id: "cluster", olds: undefined, output: result } as never)).toMatchObject({ networkConfig: { enableMultiNetworking: true } });
      expect(yield* provider.diff!({ ...diff, olds: enabled, output: result })).toBeUndefined();
      yield* provider.reconcile({ ...input, news: enabled, olds: enabled, output: result });
      expect(mutations).toHaveLength(2);
      live!.networkConfig!.enableMultiNetworking = false;
      const drifted = yield* provider.read!({ id: "cluster", olds: enabled, output: result } as never);
      expect(yield* provider.diff!({ ...diff, olds: enabled, output: drifted as typeof result })).toEqual({ action: "update" });
      yield* provider.reconcile({ ...input, news: enabled, olds: enabled, output: result });
      expect(mutations).toHaveLength(3);
      expect(operationReads).toBe(2);
      // Omission relinquishes management without disabling the live setting.
      yield* provider.reconcile({ ...input, olds: enabled, output: result });
      expect(mutations).toHaveLength(3);
      expect(live!.networkConfig!.enableMultiNetworking).toBe(true);
    }).pipe(
      Effect.provide(ClusterProvider()),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(Credentials, Effect.succeed({ accessToken: Redacted.make("unit-test-only") })),
      Effect.provideService(Stage, "test"),
      Effect.provideService(Stack, { name: "cluster-test", stage: "test" } as Stack["Service"]),
    );
    await Effect.runPromise(program as Effect.Effect<void>);
  });
});
