import { describe, expect, test } from "bun:test";
import {
  diffClusterProps,
  type ClusterProps,
} from "../../src/Container/Cluster.ts";

const baseProps: ClusterProps = {
  project: "test-project",
  location: "us-central1",
  name: "test-cluster",
  ipAllocationPolicy: {
    useIpAliases: true,
    clusterSecondaryRangeName: "pods",
    servicesSecondaryRangeName: "services",
    networkTierConfig: { networkTier: "NETWORK_TIER_PREMIUM" },
  },
  initialNodePool: {
    name: "system",
    initialNodeCount: 1,
    config: { machineType: "e2-medium" },
  },
};

describe("Cluster diff", () => {
  test("does not replace when only the network tier changes", () => {
    const news: ClusterProps = {
      ...baseProps,
      ipAllocationPolicy: {
        ...baseProps.ipAllocationPolicy,
        networkTierConfig: { networkTier: "NETWORK_TIER_STANDARD" },
      },
    };

    expect(diffClusterProps(baseProps, news)).toBeUndefined();
  });

  test("still replaces when another IP allocation field changes", () => {
    const news: ClusterProps = {
      ...baseProps,
      ipAllocationPolicy: {
        ...baseProps.ipAllocationPolicy,
        clusterSecondaryRangeName: "different-pods",
      },
    };

    expect(diffClusterProps(baseProps, news)).toEqual({ action: "replace" });
  });
});
