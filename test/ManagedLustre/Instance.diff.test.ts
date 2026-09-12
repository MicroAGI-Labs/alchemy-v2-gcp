import { describe, expect, test } from "bun:test";
import {
  diffManagedLustreInstanceProps,
  type ManagedLustreInstanceProps,
} from "../../src/ManagedLustre/Instance.ts";
import type { NetworkRefById } from "../../src/Compute/Network.ts";

const baseProps: ManagedLustreInstanceProps = {
  project: "test-project",
  location: "europe-west4-c",
  instanceId: "research-lustre",
  filesystem: "research",
  capacityGib: "72000",
  network: "projects/test-project/global/networks/shared-vpc" as NetworkRefById,
  perUnitStorageThroughput: "125",
  gkeSupportEnabled: true,
};

describe("ManagedLustreInstance diff", () => {
  test("grows capacity in place", () => {
    expect(
      diffManagedLustreInstanceProps(baseProps, { ...baseProps, capacityGib: "144000" }),
    ).toBeUndefined();
  });

  test("unchanged capacity is a no-op", () => {
    expect(diffManagedLustreInstanceProps(baseProps, { ...baseProps })).toBeUndefined();
  });

  test("shrinking capacity replaces", () => {
    expect(
      diffManagedLustreInstanceProps(baseProps, { ...baseProps, capacityGib: "36000" }),
    ).toEqual({ action: "replace" });
  });

  test("unparseable capacity replaces", () => {
    expect(
      diffManagedLustreInstanceProps(baseProps, { ...baseProps, capacityGib: "lots" }),
    ).toEqual({ action: "replace" });
  });

  test("still replaces when an immutable prop changes", () => {
    expect(
      diffManagedLustreInstanceProps(baseProps, {
        ...baseProps,
        capacityGib: "144000",
        perUnitStorageThroughput: "250",
      }),
    ).toEqual({ action: "replace" });
  });
});
