import { describe, expect, test } from "bun:test";
import { nodePoolSizeNeedsSync } from "../../src/Container/NodePool.ts";

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
