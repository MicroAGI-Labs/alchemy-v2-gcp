import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type * as compute from "@distilled.cloud/gcp/compute_v1";
import { reservationShareProjectLifecycle, type ReservationShareProjectAttributes } from "../../src/Compute/ReservationShareProject.ts";

const props = { project: "owner", zone: "us-east1-d", reservation: "cud-gb200", consumerProjectNumber: "123456789", consumerProjectId: "consumer-project" };
const base = { id: "Share", fqn: "Share", instanceId: "test", bindings: [], session: {} as never };
const output = (createdMembership: boolean): ReservationShareProjectAttributes => ({ ...props, createdMembership, reservationSelfLink: "reservation-link" });
const fixture = (preexisting = false) => {
  let live: compute.Reservation | undefined = {
    name: props.reservation, specificReservation: { count: "36" },
    shareSettings: { shareType: "SPECIFIC_PROJECTS", projectMap: {
      "987654321": { projectId: "987654321" }, ...(preexisting ? { [props.consumerProjectNumber]: { projectId: props.consumerProjectNumber } } : {}),
    } },
  };
  const updates: compute.UpdateReservationsRequest[] = [];
  const reads: compute.GetReservationsRequest[] = [];
  let operationReads = 0;
  let operationError = false;
  let forbidden = false;
  const provider = reservationShareProjectLifecycle({
    get: (((request: compute.GetReservationsRequest) => Effect.suspend(() => {
      reads.push(request);
      return forbidden ? Effect.fail({ _tag: "Forbidden", message: "denied" }) : live ? Effect.succeed(structuredClone(live)) : Effect.fail({ _tag: "NotFound" });
    })) as unknown) as Parameters<typeof reservationShareProjectLifecycle>[0]["get"],
    update: (((request: compute.UpdateReservationsRequest) => Effect.sync(() => {
      updates.push(request);
      const number = props.consumerProjectNumber;
      if (request.body?.shareSettings?.projectMap?.[number]) live!.shareSettings!.projectMap![number] = { projectId: number };
      else delete live!.shareSettings!.projectMap![number];
      return { name: "update-op", status: "PENDING" };
    })) as unknown) as Parameters<typeof reservationShareProjectLifecycle>[0]["update"],
    getOperation: ((() => Effect.sync(() => {
      operationReads++;
      return { status: "DONE", ...(operationError ? { error: { errors: [{ message: "operation failed" }] } } : {}) };
    })) as unknown) as Parameters<typeof reservationShareProjectLifecycle>[0]["getOperation"],
  });
  return { provider, updates, reads, live: () => live, disappear: () => { live = undefined; }, deny: () => { forbidden = true; }, failOperation: () => { operationError = true; }, operationReads: () => operationReads };
};
const reconcile = (f: ReturnType<typeof fixture>, previous?: ReservationShareProjectAttributes) => Effect.runPromise(f.provider.reconcile({ ...base, news: props, olds: previous ? props : undefined, output: previous }));
const remove = (f: ReturnType<typeof fixture>, previous: ReservationShareProjectAttributes) => Effect.runPromise(f.provider.delete({ ...base, olds: props, output: previous }));

describe("existing reservation consumer grant", () => {
  test("adds exactly one project with a field-level PATCH, waits, preserves CUD capacity and other consumers", async () => {
    const f = fixture();
    const result = await reconcile(f);
    expect(result.createdMembership).toBe(true);
    expect(f.updates).toEqual([{ project: "owner", zone: "us-east1-d", reservation: "cud-gb200", paths: ["shareSettings.projectMap.123456789"], body: { name: "cud-gb200", shareSettings: { projectMap: { "123456789": { projectId: "123456789" } } } } }]);
    expect(f.operationReads()).toBe(1);
    expect(f.live()?.specificReservation?.count).toBe("36");
    expect(f.live()?.shareSettings?.projectMap?.["987654321"]).toEqual({ projectId: "987654321" });
    await reconcile(f, result);
    expect(f.updates).toHaveLength(1);
    await remove(f, result);
    expect(f.updates[1]?.body).toEqual({ name: "cud-gb200" });
    expect(f.updates[1]?.paths).toEqual(["shareSettings.projectMap.123456789"]);
    expect(f.live()?.shareSettings?.projectMap?.["987654321"]).toBeDefined();
    expect(f.live()?.specificReservation?.count).toBe("36");
  });
  test("adopts preexisting membership without claiming or removing it", async () => {
    const f = fixture(true);
    const adopted = await Effect.runPromise(f.provider.read!({ ...base, olds: props, output: undefined }));
    expect(adopted).toMatchObject({ createdMembership: false });
    const result = await reconcile(f, adopted as ReservationShareProjectAttributes);
    await remove(f, result);
    expect(f.updates).toHaveLength(0);
  });
  test("recognizes textual, numeric, and mixed project-map response representations without claiming existing grants", async () => {
    for (const [key, projectId] of [[props.consumerProjectId, props.consumerProjectId], [props.consumerProjectNumber, props.consumerProjectId], [props.consumerProjectId, props.consumerProjectNumber]]) {
      const f = fixture();
      f.live()!.shareSettings!.projectMap![key!] = { projectId };
      const adopted = await Effect.runPromise(f.provider.read!({ ...base, olds: props, output: undefined }));
      expect(adopted).toMatchObject({ createdMembership: false });
      const result = await reconcile(f, adopted as ReservationShareProjectAttributes);
      await remove(f, result);
      expect(f.updates).toHaveLength(0);
    }
  });
  test("read preserves known ownership, state-loss recovery conservatively retains membership", async () => {
    const f = fixture(true);
    expect(await Effect.runPromise(f.provider.read!({ ...base, olds: props, output: output(true) }))).toMatchObject({ createdMembership: true });
    expect(await reconcile(f)).toMatchObject({ createdMembership: false });
  });
  test("detects live membership drift and restores only its consumer", async () => {
    const f = fixture();
    expect(await Effect.runPromise(f.provider.diff!({ ...base, news: props, olds: props, output: output(true), oldBindings: [], newBindings: [] }))).toEqual({ action: "update" });
    expect(await reconcile(f, output(true))).toMatchObject({ createdMembership: true });
    expect(await Effect.runPromise(f.provider.diff!({ ...base, news: props, olds: props, output: output(true), oldBindings: [], newBindings: [] }))).toBeUndefined();
  });
  test("requires replacement when the owner or consumer identity changes", async () => {
    const f = fixture();
    expect(await Effect.runPromise(f.provider.diff!({ ...base, news: { ...props, consumerProjectNumber: "222" }, olds: props, output: output(true), oldBindings: [], newBindings: [] }))).toEqual({ action: "replace" });
    expect(await Effect.runPromise(f.provider.diff!({ ...base, news: { ...props, consumerProjectId: "other-consumer" }, olds: props, output: output(true), oldBindings: [], newBindings: [] }))).toEqual({ action: "replace" });
  });
  test("surviving attributes detect every identity change without old props or API calls", async () => {
    const f = fixture(true);
    for (const key of ["project", "zone", "reservation", "consumerProjectNumber", "consumerProjectId"] as const) {
      const news = { ...props, [key]: key === "consumerProjectNumber" ? "222" : "different" };
      expect(await Effect.runPromise(f.provider.diff!({ ...base, news, olds: undefined as never, output: output(true), oldBindings: [], newBindings: [] }))).toEqual({ action: "replace" });
    }
    expect(f.reads).toEqual([]);
    expect(f.updates).toEqual([]);
  });
  test("blank attributes fall back to old identity for diff, read, and owned-grant deletion", async () => {
    const f = fixture(true);
    const sparse = { ...output(true), project: "", zone: "", reservation: "", consumerProjectNumber: "", consumerProjectId: "" };
    expect(await Effect.runPromise(f.provider.diff!({ ...base, news: { ...props, consumerProjectNumber: "222" }, olds: props, output: sparse, oldBindings: [], newBindings: [] }))).toEqual({ action: "replace" });
    expect(await Effect.runPromise(f.provider.read!({ ...base, olds: props, output: sparse }))).toMatchObject({ ...props, createdMembership: true });
    await remove(f, sparse);
    expect(f.reads).toEqual(Array(2).fill({ project: "owner", zone: "us-east1-d", reservation: "cud-gb200" }));
    expect(f.updates).toEqual([{ project: "owner", zone: "us-east1-d", reservation: "cud-gb200", paths: ["shareSettings.projectMap.123456789"], body: { name: "cud-gb200" } }]);
  });
  test("populated attributes win over stale props and incomplete identity never reaches the API", async () => {
    const f = fixture(true);
    const stale = { ...props, project: "wrong-project", consumerProjectNumber: "999" };
    expect(await Effect.runPromise(f.provider.diff!({ ...base, news: props, olds: stale, output: output(true), oldBindings: [], newBindings: [] }))).toBeUndefined();
    await Effect.runPromise(f.provider.delete({ ...base, olds: stale, output: output(true) }));
    expect(f.updates[0]).toMatchObject({ project: "owner", paths: ["shareSettings.projectMap.123456789"] });
    const before = f.reads.length;
    for (const incomplete of [undefined, { ...output(true), reservation: "" }]) {
      expect(await Effect.runPromise(f.provider.read!({ ...base, olds: undefined as never, output: incomplete }))).toBeUndefined();
      await Effect.runPromise(f.provider.delete({ ...base, olds: undefined as never, output: incomplete as never }));
    }
    expect(f.reads).toHaveLength(before);
    expect(f.updates).toHaveLength(1);
  });
  test("cannot convert a local reservation, recreate a missing reservation, or accept nonnumeric removal keys", async () => {
    const f = fixture();
    f.live()!.shareSettings!.shareType = "LOCAL";
    await expect(reconcile(f)).rejects.toThrow("SPECIFIC_PROJECTS");
    f.disappear();
    await expect(reconcile(f)).rejects.toThrow("was not found");
    await remove(f, output(true));
    await expect(Effect.runPromise(f.provider.reconcile({ ...base, news: { ...props, consumerProjectNumber: "project-id" }, olds: undefined, output: undefined }))).rejects.toThrow("numeric project number");
    expect(f.updates).toHaveLength(0);
  });
  test("does not hide authorization failures or failed async operations", async () => {
    const denied = fixture(); denied.deny();
    await expect(reconcile(denied)).rejects.toBeDefined();
    expect(denied.updates).toHaveLength(0);
    const failed = fixture(); failed.failOperation();
    await expect(reconcile(failed)).rejects.toThrow("operation failed");
  });
});
