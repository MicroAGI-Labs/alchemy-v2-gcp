import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type * as compute from "@distilled.cloud/gcp/compute_v1";
import {
  sharedVpcServiceProjectLifecycle,
  type SharedVpcServiceProjectAttributes,
} from "../../src/Compute/SharedVpcServiceProject.ts";

type Api = Parameters<typeof sharedVpcServiceProjectLifecycle>[0];

const host = "micro-research-shared";
const service = "atlas-core-508317";
const attrs: SharedVpcServiceProjectAttributes = { hostProject: host, serviceProject: service };
const base = { id: "Attach", fqn: "Attach", instanceId: "test", bindings: [], session: { note: () => Effect.void } as never };

// GCP's wording for a detach of a project that is not attached to the host
// (2026-11-20 research-infra deploy).
const NOT_LINKED = `Invalid resource usage: 'The resource 'projects/${service}' is not linked to shared VPC host 'projects/${host}'.'.`;

type Failure = { _tag: string; message?: string };

const fixture = (opts: {
  observed?: string | Failure;
  disableFails?: Failure;
}) => {
  const lookups: compute.GetXpnHostProjectsRequest[] = [];
  const disables: compute.DisableXpnResourceProjectsRequest[] = [];
  let operationReads = 0;
  const provider = sharedVpcServiceProjectLifecycle({
    getXpnHost: (((request: compute.GetXpnHostProjectsRequest) =>
      Effect.suspend(() => {
        lookups.push(request);
        const o = opts.observed;
        if (o === undefined) return Effect.fail({ _tag: "NotFound" });
        if (typeof o === "string") return Effect.succeed({ name: o });
        return Effect.fail(o);
      })) as unknown) as Api["getXpnHost"],
    enableXpnResource: ((() =>
      Effect.die("enableXpnResource must not be called")) as unknown) as Api["enableXpnResource"],
    disableXpnResource: (((request: compute.DisableXpnResourceProjectsRequest) =>
      Effect.suspend(() => {
        disables.push(request);
        return opts.disableFails
          ? Effect.fail(opts.disableFails)
          : Effect.succeed({ name: "detach-op", status: "PENDING" });
      })) as unknown) as Api["disableXpnResource"],
    getGlobalOperation: ((() =>
      Effect.sync(() => {
        operationReads++;
        return { status: "DONE" };
      })) as unknown) as Api["getGlobalOperation"],
  });
  const remove = () =>
    Effect.runPromise(provider.delete({ ...base, olds: attrs, output: attrs }) as Effect.Effect<void>);
  return { provider, remove, lookups, disables, operationReads: () => operationReads };
};

describe("SharedVpcServiceProject delete", () => {
  test("already detached: returns without calling disableXpnResource", async () => {
    const f = fixture({ observed: undefined });
    await f.remove();
    expect(f.lookups).toEqual([{ project: service }]);
    expect(f.disables).toHaveLength(0);
  });

  test("attached to a different host: nothing to detach from this host", async () => {
    const f = fixture({ observed: "projects/some-other-host" });
    await f.remove();
    expect(f.disables).toHaveLength(0);
  });

  test("attached: detaches from the host and waits for the operation", async () => {
    const f = fixture({ observed: `projects/${host}` });
    await f.remove();
    expect(f.disables).toEqual([
      { project: host, body: { xpnResource: { type: "PROJECT", id: service } } },
    ]);
    expect(f.operationReads()).toBe(1);
  });

  test("a 'not linked to shared VPC host' 400 from a racing detach is swallowed", async () => {
    const f = fixture({ observed: host, disableFails: { _tag: "BadRequest", message: NOT_LINKED } });
    await f.remove();
    expect(f.disables).toHaveLength(1);
  });

  test("any other 400 propagates (e.g. resources still using shared subnets)", async () => {
    const f = fixture({
      observed: host,
      disableFails: {
        _tag: "BadRequest",
        message: `The resource 'projects/${service}' has resources using shared VPC subnetworks of host 'projects/${host}'.`,
      },
    });
    await expect(f.remove()).rejects.toMatchObject({ _tag: "BadRequest" });
    expect(f.disables).toHaveLength(1);
  });

  test("a 403 on the lookup still attempts the detach, so permission errors surface", async () => {
    const f = fixture({
      observed: { _tag: "Forbidden", message: "denied" },
      disableFails: { _tag: "Forbidden", message: "denied" },
    });
    await expect(f.remove()).rejects.toMatchObject({ _tag: "Forbidden" });
    expect(f.disables).toHaveLength(1);
  });
});

describe("SharedVpcServiceProject read", () => {
  test("detached, other host or 403 read as absent; attached reads back", async () => {
    const read = (observed?: string | Failure) =>
      Effect.runPromise(fixture({ observed }).provider.read!({ ...base, olds: attrs, output: attrs }) as Effect.Effect<unknown>);
    expect(await read(undefined)).toBeUndefined();
    expect(await read("projects/some-other-host")).toBeUndefined();
    expect(await read({ _tag: "Forbidden" })).toBeUndefined();
    expect(await read(`projects/${host}`)).toEqual(attrs);
  });
});
