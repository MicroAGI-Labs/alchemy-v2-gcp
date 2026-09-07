import { describe, expect, test } from "bun:test";
import { clusterMaintenancePolicyUpdate } from "../../src/Container/Cluster.ts";

const desired = {
  window: {
    recurringWindow: {
      recurrence: "FREQ=MONTHLY;BYSETPOS=2;BYDAY=SA",
      window: {
        startTime: "2026-09-12T00:00:00Z",
        endTime: "2026-09-14T00:00:00Z",
      },
    },
  },
};

describe("GKE maintenance reconciliation", () => {
  test("does not rewrite a matching policy returned with a resourceVersion", () => {
    // Captured shape from a successful cluster create; rewriting this without
    // e174576b caused GKE's resourceVersion mismatch error during reconciliation.
    expect(clusterMaintenancePolicyUpdate({ ...desired, resourceVersion: "e174576b" }, desired))
      .toBeUndefined();
  });

  test("updates a changed window using the freshly observed resourceVersion", () => {
    const observed = { resourceVersion: "new-version", window: { dailyMaintenanceWindow: { startTime: "03:00", duration: "14400s" } } };
    expect(clusterMaintenancePolicyUpdate(observed, desired)).toEqual({
      ...desired,
      resourceVersion: "new-version",
    });
  });

  test("ignores server-computed daily duration without mutating the response", () => {
    const observed = { resourceVersion: "version", window: { dailyMaintenanceWindow: { startTime: "03:00", duration: "14400s" } } };
    expect(clusterMaintenancePolicyUpdate(observed, { window: { dailyMaintenanceWindow: { startTime: "03:00" } } }))
      .toBeUndefined();
    expect(observed.window.dailyMaintenanceWindow.duration).toBe("14400s");
  });

  test("can create the first policy when the API has no concurrency token", () => {
    expect(clusterMaintenancePolicyUpdate(undefined, desired)).toEqual(desired);
  });

  test("does not manage a policy unless requested, and retains the token when clearing one", () => {
    const observed = { ...desired, resourceVersion: "version" };
    expect(clusterMaintenancePolicyUpdate(observed, undefined)).toBeUndefined();
    expect(clusterMaintenancePolicyUpdate(observed, {})).toEqual({ resourceVersion: "version" });
  });
});
