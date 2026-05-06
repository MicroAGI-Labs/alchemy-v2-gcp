import * as compute from "@distilled.cloud/gcp/compute-v1";
import * as Test from "alchemy/Test/Bun";
import * as GCP from "alchemy-v2-gcp";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";

const FOLDER_ID = process.env.GCP_TEST_FOLDER_ID ?? "<redacted-folder-id>";
const rawBillingAccount = process.env.GCP_TEST_BILLING_ACCOUNT;
const BILLING_ACCOUNT = rawBillingAccount?.startsWith("billingAccounts/")
  ? (rawBillingAccount as `billingAccounts/${string}`)
  : undefined;

const runId = () => Math.random().toString(36).slice(2, 8);

const TIMEOUT = { timeout: 15 * 60 * 1000 };
const REGION = "us-central1";

const { test } = Test.make({ providers: GCP.providers() });

const runOrSkip = BILLING_ACCOUNT ? test.provider : test.provider.skip;

runOrSkip(
  "create subnetwork + toggle privateIpGoogleAccess + delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;

      const buildGraph = (privateIpGoogleAccess: boolean) =>
        Effect.gen(function* () {
          const project = yield* GCP.Project("SubnetTestProj", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID },
            billingAccount: BILLING_ACCOUNT,
          });
          const computeApi = yield* GCP.ApiEnable("ComputeApi", {
            project: project.projectId,
            service: "compute.googleapis.com",
          });
          const network = yield* GCP.Network("Vpc", {
            project: computeApi.project,
          });
          // Subnet shape mirrors what a GKE VPC-native cluster expects:
          // primary range plus named secondary ranges for pods + services.
          const subnetwork = yield* GCP.Subnetwork("Subnet", {
            project: computeApi.project,
            region: REGION,
            network: network.selfLink,
            ipCidrRange: "10.0.0.0/20",
            secondaryIpRanges: [
              { rangeName: "pods", ipCidrRange: "10.4.0.0/14" },
              { rangeName: "services", ipCidrRange: "10.8.0.0/20" },
            ],
            privateIpGoogleAccess,
          });
          return { project, network, subnetwork };
        });

      const created = yield* stack.deploy(buildGraph(false));
      expect(created.subnetwork.name).toBeDefined();
      expect(created.subnetwork.region).toBe(REGION);
      expect(created.subnetwork.ipCidrRange).toBe("10.0.0.0/20");
      expect(created.subnetwork.privateIpGoogleAccess).toBe(false);
      // Both secondary ranges land. The provider sorts before diffing
      // so order independence is preserved.
      const ranges = [...created.subnetwork.secondaryIpRanges].sort((a, b) =>
        a.rangeName.localeCompare(b.rangeName),
      );
      expect(ranges).toEqual([
        { rangeName: "pods", ipCidrRange: "10.4.0.0/14" },
        { rangeName: "services", ipCidrRange: "10.8.0.0/20" },
      ]);

      const fetched = yield* compute.getSubnetworks({
        project: projectId,
        region: REGION,
        subnetwork: created.subnetwork.name,
      });
      expect(fetched.privateIpGoogleAccess).toBe(false);
      expect(fetched.description ?? "").toContain("[alchemy:");

      // Toggle privateIpGoogleAccess via patch (no replace).
      const updated = yield* stack.deploy(buildGraph(true));
      expect(updated.subnetwork.name).toBe(created.subnetwork.name);
      expect(updated.subnetwork.privateIpGoogleAccess).toBe(true);

      const refetched = yield* compute.getSubnetworks({
        project: projectId,
        region: REGION,
        subnetwork: updated.subnetwork.name,
      });
      expect(refetched.privateIpGoogleAccess).toBe(true);

      yield* stack.destroy();
    }),
  TIMEOUT,
);
