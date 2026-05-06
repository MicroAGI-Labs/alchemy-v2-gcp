import * as compute from "@distilled.cloud/gcp/compute-v1";
import * as Test from "alchemy/Test/Bun";
import * as GCP from "@microagi/alchemy-gcp";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";

const FOLDER_ID = process.env.GCP_TEST_FOLDER_ID;
const rawBillingAccount = process.env.GCP_TEST_BILLING_ACCOUNT;
const BILLING_ACCOUNT = rawBillingAccount?.startsWith("billingAccounts/")
  ? (rawBillingAccount as `billingAccounts/${string}`)
  : undefined;

const runId = () => Math.random().toString(36).slice(2, 8);

const TIMEOUT = { timeout: 10 * 60 * 1000 };

const { test } = Test.make({ providers: GCP.providers() });

const runOrSkip =
  FOLDER_ID && BILLING_ACCOUNT ? test.provider : test.provider.skip;

runOrSkip(
  "reserve PSA range as a global address + delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;

      // PSA reservation is the canonical use case: addressType=INTERNAL,
      // purpose=VPC_PEERING, prefixLength on a network ref. The reserve
      // itself doesn't peer — that's what GCP.PsaConnection does.
      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* GCP.Project("AddrTestProj", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID! },
            billingAccount: BILLING_ACCOUNT,
          });
          const computeApi = yield* GCP.ApiEnable("ComputeApi", {
            project: project.projectId,
            service: "compute.googleapis.com",
          });
          const network = yield* GCP.Network("Vpc", {
            project: computeApi.project,
          });
          const psaRange = yield* GCP.GlobalAddress("PsaRange", {
            project: computeApi.project,
            network: network.selfLink,
            addressType: "INTERNAL",
            purpose: "VPC_PEERING",
            prefixLength: 20,
          });
          return { project, network, psaRange };
        }),
      );

      expect(result.psaRange.name).toBeDefined();
      expect(result.psaRange.purpose).toBe("VPC_PEERING");
      expect(result.psaRange.addressType).toBe("INTERNAL");
      expect(result.psaRange.prefixLength).toBe(20);
      // Server allocates an address inside the VPC's available space.
      expect(result.psaRange.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      // Status before any consumer connects is RESERVED.
      expect(result.psaRange.status).toBe("RESERVED");
      // Internal labels round-trip — adoption gate checks these.
      expect(result.psaRange.labels.alchemy_app).toBeDefined();
      expect(result.psaRange.labels.alchemy_id).toBeDefined();

      const fetched = yield* compute.getGlobalAddresses({
        project: projectId,
        address: result.psaRange.name,
      });
      expect(fetched.purpose).toBe("VPC_PEERING");
      expect(fetched.prefixLength).toBe(20);

      yield* stack.destroy();
    }),
  TIMEOUT,
);
