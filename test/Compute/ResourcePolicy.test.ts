import { describe, expect, test } from "bun:test";
import { resourcePolicyMatches, ResourcePolicy, ResourcePolicyProvider, type ResourcePolicyProps } from "../../src/Compute/ResourcePolicy.ts";
import type * as compute from "@distilled.cloud/gcp/compute_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Provider from "alchemy/Provider";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
const desired: ResourcePolicyProps = { project: "consumer", region: "us-east1", name: "gb200-placement", workloadPolicy: { type: "HIGH_THROUGHPUT", acceleratorTopology: "1x72" } };
describe("GB200 workload policy comparison", () => {
  test("accepts API-defaulted topology mode and ownership description", () => {
    expect(resourcePolicyMatches({ workloadPolicy: { ...desired.workloadPolicy, acceleratorTopologyMode: "AUTO_CONNECT" }, description: "[alchemy:app=research,stage=prod,id=gb200]" }, desired)).toBe(true);
  });
  test("detects immutable workload topology, intent, and description drift", () => {
    expect(resourcePolicyMatches({ workloadPolicy: { ...desired.workloadPolicy, acceleratorTopology: "2x72" } }, desired)).toBe(false);
    expect(resourcePolicyMatches({ workloadPolicy: { ...desired.workloadPolicy, type: "HIGH_AVAILABILITY" } }, desired)).toBe(false);
    expect(resourcePolicyMatches({ workloadPolicy: desired.workloadPolicy, description: "changed" }, desired)).toBe(false);
  });

  test("real HTTP-backed provider creates, observes, detects drift, and prevents same-name replacement", async () => {
    let live: compute.ResourcePolicy | undefined;
    const mutations: string[] = [];
    let operationReads = 0;
    let failDeletion = false;
    const client = HttpClient.make((request) => Effect.sync(() => {
      if (request.url.includes("/operations/")) {
        operationReads++;
        return HttpClientResponse.fromWeb(request, Response.json({ status: "DONE", ...(failDeletion ? { error: { errors: [{ code: "RESOURCE_IN_USE", message: "still used by node pool" }] } } : {}) }));
      }
      if (request.method === "POST") {
        mutations.push("POST");
        expect(request.url).toEndWith("/projects/consumer/regions/us-east1/resourcePolicies");
        if (request.body._tag !== "Uint8Array") throw new Error("Unexpected request body");
        live = JSON.parse(new TextDecoder().decode(request.body.body));
        expect(live?.workloadPolicy).toEqual({ type: "HIGH_THROUGHPUT", acceleratorTopology: "1x72" });
        expect(live?.description).toBe("[alchemy:app=policy-test,stage=test,id=policy]");
        return HttpClientResponse.fromWeb(request, Response.json({ name: "create-op", status: "PENDING" }));
      }
      if (request.method === "DELETE") {
        mutations.push("DELETE");
        return HttpClientResponse.fromWeb(request, Response.json({ name: "delete-op", status: "PENDING" }));
      }
      expect(request.method).toBe("GET");
      return HttpClientResponse.fromWeb(request, live ? Response.json(live) : Response.json({ error: { code: 404, status: "NOT_FOUND", message: "Missing policy" } }, { status: 404 }));
    }));
    const program = Effect.gen(function* () {
      const provider = yield* Provider.Provider<ResourcePolicy>(ResourcePolicy.Type);
      const input: Parameters<typeof provider.reconcile>[0] = { id: "policy", fqn: "policy", instanceId: "test", news: desired, olds: undefined, output: undefined, bindings: [], session: { note: () => Effect.void } as never };
      const created = yield* provider.reconcile(input);
      expect(operationReads).toBe(1);
      expect(created.workloadPolicy).toEqual(desired.workloadPolicy);
      yield* provider.reconcile({ ...input, olds: desired, output: created });
      const read = yield* provider.read!({ id: "policy", olds: desired, output: created } as never);
      expect(read).toEqual(created);
      const diffInput = { id: "policy", news: desired, olds: desired, output: created } as Parameters<NonNullable<typeof provider.diff>>[0];
      expect(yield* provider.diff!(diffInput)).toBeUndefined();
      expect(mutations).toEqual(["POST"]);
      live!.workloadPolicy = { ...desired.workloadPolicy, acceleratorTopology: "2x72" };
      expect(String(yield* provider.diff!(diffInput).pipe(Effect.flip))).toContain("choose a new resource policy name");
      expect(String(yield* provider.reconcile(input).pipe(Effect.flip))).toContain("choose a new resource policy name");
      // Even if the live policy already equals desired, old props must not cause
      // same-name replacement followed by GC deleting that same physical policy.
      live!.workloadPolicy = desired.workloadPolicy;
      const changedDescription = { ...desired, description: "new description" };
      live!.description = "[alchemy:app=policy-test,stage=test,id=policy] new description";
      expect(String(yield* provider.diff!({ ...diffInput, news: changedDescription }).pipe(Effect.flip))).toContain("choose a new resource policy name");
      expect(String(yield* provider.reconcile({ ...input, news: changedDescription, olds: desired, output: created }).pipe(Effect.flip))).toContain("choose a new resource policy name");
      expect(yield* provider.diff!({ ...diffInput, news: { ...changedDescription, name: "new-policy" } })).toEqual({ action: "replace" });
      expect(mutations).toEqual(["POST"]);
      failDeletion = true;
      expect(String(yield* provider.delete({ ...input, olds: desired, output: created } as never).pipe(Effect.flip))).toContain("still used by node pool");
      expect(operationReads).toBe(2);
    }).pipe(
      Effect.provide(ResourcePolicyProvider()),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(Credentials, Effect.succeed({ accessToken: Redacted.make("unit-test-only") })),
      Effect.provideService(Stage, "test"),
      Effect.provideService(Stack, { name: "policy-test", stage: "test" } as Stack["Service"]),
    );
    await Effect.runPromise(program as Effect.Effect<void>);
  });
});
