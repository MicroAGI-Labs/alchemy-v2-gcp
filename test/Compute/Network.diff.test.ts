import { describe, expect, test } from "bun:test";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Provider from "alchemy/Provider";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Network, NetworkProvider, diffNetworkConfiguration, normalizeNetworkProfile, toNetworkAttributes, type NetworkProps } from "../../src/Compute/Network.ts";

const profile = "projects/consumer/global/networkProfiles/us-east1-d-vpc-roce";
const desired: NetworkProps = { project: "consumer", name: "rdma", mtu: 8896, networkProfile: profile };
const base = { id: "rdma", fqn: "rdma", instanceId: "test", bindings: [], session: { note: () => Effect.void } as never };

describe("Network immutable profile", () => {
  test("normalizes full/partial URLs without conflating profile projects", () => {
    for (const url of [profile, `https://www.googleapis.com/compute/v1/${profile}`, `https://compute.googleapis.com/compute/beta/${profile}`]) expect(normalizeNetworkProfile(url)).toBe(profile);
    expect(normalizeNetworkProfile(profile.replace("consumer", "different"))).not.toBe(profile);
    expect(normalizeNetworkProfile(undefined)).toBeUndefined();
    expect(normalizeNetworkProfile("")).toBeUndefined();
  });

  test("blocks fixed-name add/change/remove and permits a distinct physical destination", async () => {
    for (const news of [
      { ...desired, networkProfile: undefined }, { ...desired, networkProfile: `${profile}-new` },
      { ...desired, mtu: 1500 }, { ...desired, autoCreateSubnetworks: true },
    ]) {
      await expect(Effect.runPromise(diffNetworkConfiguration(desired, news))).rejects.toThrow("choose a new network name");
      expect(await Effect.runPromise(diffNetworkConfiguration(desired, { ...news, name: "rdma-new" }))).toEqual({ action: "replace" });
      expect(await Effect.runPromise(diffNetworkConfiguration(desired, { ...news, project: "other-project" }))).toEqual({ action: "replace" });
    }
    await expect(Effect.runPromise(diffNetworkConfiguration({ ...desired, networkProfile: undefined }, desired))).rejects.toThrow("choose a new network name");
    expect(await Effect.runPromise(diffNetworkConfiguration({ ...desired, name: undefined }, { ...desired, name: undefined, networkProfile: `${profile}-new` }))).toEqual({ action: "replace" });
  });

  test("handles sparse recovered props, blank output identity, defaults, and observed drift", async () => {
    const output = toNetworkAttributes({ mtu: 8896, networkProfile: `https://www.googleapis.com/compute/v1/${profile}` }, { project: desired.project, name: desired.name! });
    expect(output.name).toBe("rdma");
    expect(output.selfLink).toBe("https://www.googleapis.com/compute/v1/projects/consumer/global/networks/rdma");
    expect(await Effect.runPromise(diffNetworkConfiguration(undefined, desired, output))).toBeUndefined();
    expect(await Effect.runPromise(diffNetworkConfiguration(desired, desired, { ...output, name: "", project: "" }))).toBeUndefined();
    await expect(Effect.runPromise(diffNetworkConfiguration(undefined, { ...desired, networkProfile: undefined }, output))).rejects.toThrow("choose a new network name");
    await expect(Effect.runPromise(diffNetworkConfiguration(desired, desired, { ...output, networkProfile: `${profile}-remote` }))).rejects.toThrow("choose a new network name");
    expect(await Effect.runPromise(diffNetworkConfiguration({ project: "p", name: "vpc" }, { project: "p", name: "vpc", mtu: 1460, autoCreateSubnetworks: false }))).toBeUndefined();
    expect(await Effect.runPromise(diffNetworkConfiguration(undefined, desired))).toBeUndefined();
    // A profile can select a non-default MTU; omission does not manage that field.
    expect(await Effect.runPromise(diffNetworkConfiguration({ ...desired, mtu: undefined }, { ...desired, mtu: undefined }, output))).toBeUndefined();
  });

  test("HTTP lifecycle installs the profile, accepts canonical observations, and fails before wrong-profile mutation", async () => {
    let live: compute.Network | undefined;
    const requests: { method: string; url: string }[] = [];
    const client = HttpClient.make((request) => Effect.sync(() => {
      requests.push({ method: request.method, url: request.url });
      if (request.url.includes("/global/operations/")) return HttpClientResponse.fromWeb(request, Response.json({ status: "DONE" }));
      if (request.method === "POST") {
        if (request.body._tag !== "Uint8Array") throw new Error("Unexpected request body");
        live = JSON.parse(new TextDecoder().decode(request.body.body));
        expect(live?.networkProfile).toBe(profile);
        expect(live?.autoCreateSubnetworks).toBe(false);
        live!.networkProfile = `https://www.googleapis.com/compute/v1/${profile}`;
        // Compute sparse observations must not lose the known resource name.
        delete live!.name;
        return HttpClientResponse.fromWeb(request, Response.json({ name: "create", status: "PENDING" }));
      }
      if (request.method === "DELETE") return HttpClientResponse.fromWeb(request, Response.json({ status: "DONE" }));
      expect(request.method).toBe("GET");
      return HttpClientResponse.fromWeb(request, live ? Response.json(live) : Response.json({ error: { code: 404, status: "NOT_FOUND", message: "Missing network" } }, { status: 404 }));
    }));
    const program = Effect.gen(function* () {
      const provider = yield* Provider.Provider<Network>(Network.Type);
      const input: Parameters<typeof provider.reconcile>[0] = { ...base, news: desired, olds: undefined, output: undefined };
      const created = yield* provider.reconcile(input);
      expect(created.name).toBe("rdma");
      expect(created.networkProfile).toBe(`https://www.googleapis.com/compute/v1/${profile}`);
      expect(yield* provider.diff!({ ...input, olds: desired, output: created, oldBindings: [], newBindings: [] })).toBeUndefined();
      expect(yield* provider.reconcile({ ...input, olds: desired, output: created })).toEqual(created);
      const before = requests.length;
      expect(String(yield* provider.reconcile({ ...input, olds: desired, output: created, news: { ...desired, networkProfile: undefined } }).pipe(Effect.flip))).toContain("choose a new network name");
      expect(requests).toHaveLength(before);
      live!.networkProfile = `${profile}-other`;
      expect(String(yield* provider.reconcile(input).pipe(Effect.flip))).toContain("choose a new network name");
      expect(requests.filter((r) => r.method !== "GET").map((r) => r.method)).toEqual(["POST"]);
      live!.networkProfile = profile;
      const sparse = { ...created, name: "", project: "" };
      expect(yield* provider.read!({ ...base, olds: desired, output: sparse } as never)).toMatchObject({ project: "consumer", name: "rdma" });
      yield* provider.delete({ ...base, olds: desired, output: sparse } as never);
      expect(requests.at(-1)).toEqual({ method: "DELETE", url: "https://compute.googleapis.com/compute/v1/projects/consumer/global/networks/rdma" });
      const after = requests.length;
      yield* provider.delete({ ...base, olds: undefined, output: { ...created, name: "" } } as never);
      yield* provider.delete({ ...base, olds: undefined, output: undefined } as never);
      expect(requests).toHaveLength(after);
    }).pipe(
      Effect.provide(NetworkProvider()), Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(Credentials, Effect.succeed({ accessToken: Redacted.make("unit-test-only") })),
      Effect.provideService(Stage, "test"), Effect.provideService(Stack, { name: "network-test", stage: "test" } as Stack["Service"]),
    );
    await Effect.runPromise(program as Effect.Effect<void>);
  });
});
