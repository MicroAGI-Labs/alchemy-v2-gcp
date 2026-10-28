import { describe, expect, test } from "bun:test";
import {
  managedLustreMaintenancePolicyUpdate,
  type ManagedLustreMaintenancePolicy,
} from "../../src/ManagedLustre/Instance.ts";

const saturdayMidnight: ManagedLustreMaintenancePolicy = {
  weeklyMaintenanceWindows: [{ dayOfWeek: "SATURDAY", startTime: { hours: 0, minutes: 0 } }],
};

describe("Managed Lustre maintenance reconciliation", () => {
  test("does not rewrite a matching policy the API returned with zero fields dropped", () => {
    // Captured from research-lustre after setting SATURDAY 00:00: the API
    // omits zero-valued TimeOfDay fields.
    const observed = { weeklyMaintenanceWindows: [{ dayOfWeek: "SATURDAY", startTime: {} }] };
    expect(managedLustreMaintenancePolicyUpdate(observed, saturdayMidnight)).toBeUndefined();
  });

  test("sets the first policy on an instance that has none", () => {
    expect(managedLustreMaintenancePolicyUpdate(undefined, saturdayMidnight)).toEqual(
      saturdayMidnight,
    );
  });

  test("updates a changed window", () => {
    const observed = {
      weeklyMaintenanceWindows: [{ dayOfWeek: "TUESDAY", startTime: { hours: 3 } }],
    };
    expect(managedLustreMaintenancePolicyUpdate(observed, saturdayMidnight)).toEqual(
      saturdayMidnight,
    );
  });

  test("adding an exclusion is a change", () => {
    const desired: ManagedLustreMaintenancePolicy = {
      ...saturdayMidnight,
      maintenanceExclusionWindow: [
        { startDate: { year: 2026, month: 12, day: 20 }, endDate: { year: 2027, month: 1, day: 2 } },
      ],
    };
    const observed = { weeklyMaintenanceWindows: [{ dayOfWeek: "SATURDAY", startTime: {} }] };
    expect(managedLustreMaintenancePolicyUpdate(observed, desired)).toEqual(desired);
    // ...and once applied, the API's zero-dropped echo is a no-op.
    const applied = {
      ...observed,
      maintenanceExclusionWindow: [
        { startDate: { year: 2026, month: 12, day: 20 }, endDate: { year: 2027, month: 1, day: 2 }, time: {} },
      ],
    };
    expect(managedLustreMaintenancePolicyUpdate(applied, desired)).toBeUndefined();
  });

  test("does not manage a policy unless requested, and {} clears one", () => {
    const observed = { weeklyMaintenanceWindows: [{ dayOfWeek: "SATURDAY", startTime: {} }] };
    expect(managedLustreMaintenancePolicyUpdate(observed, undefined)).toBeUndefined();
    expect(managedLustreMaintenancePolicyUpdate(observed, {})).toEqual({});
    expect(managedLustreMaintenancePolicyUpdate(undefined, {})).toBeUndefined();
  });
});
