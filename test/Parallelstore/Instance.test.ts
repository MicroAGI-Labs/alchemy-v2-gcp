import * as Test from "alchemy/Test/Bun";
import * as GCP from "@microagi/alchemy-gcp";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";

const FOLDER_ID = process.env.GCP_TEST_FOLDER_ID;
const rawBillingAccount = process.env.GCP_TEST_BILLING_ACCOUNT;
const BILLING_ACCOUNT = rawBillingAccount?.startsWith("billingAccounts/")
  ? (rawBillingAccount as `billingAccounts/${string}`)
  : undefined;

// Parallelstore instances cost real money even at the floor (12 TiB
// for ~$5/hour as of 2026), so this test is double-gated: needs a
// billing account AND an explicit `GCP_TEST_PARALLELSTORE=1` opt-in.
const PARALLELSTORE_OPT_IN = process.env.GCP_TEST_PARALLELSTORE === "1";

const runId = () => Math.random().toString(36).slice(2, 8);

// Parallelstore creates routinely run 15–25 min for a 12 TiB instance,
// and deletes are similar. Project + APIs + network + reservation +
// PSA peering + instance create + delete fits in 90 min.
const TIMEOUT = { timeout: 90 * 60 * 1000 };
const ZONE = "us-central1-a";

const { test } = Test.make({ providers: GCP.providers() });

const runOrSkip =
  FOLDER_ID && BILLING_ACCOUNT && PARALLELSTORE_OPT_IN
    ? test.provider
    : test.provider.skip;

runOrSkip(
  "create Parallelstore instance over PSA + delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;

      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* GCP.Project("PsTestProj", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID! },
            billingAccount: BILLING_ACCOUNT,
          });
          const computeApi = yield* GCP.ApiEnable("ComputeApi", {
            project: project.projectId,
            service: "compute.googleapis.com",
          });
          const snApi = yield* GCP.ApiEnable("ServiceNetworkingApi", {
            project: project.projectId,
            service: "servicenetworking.googleapis.com",
          });
          const psApi = yield* GCP.ApiEnable("ParallelstoreApi", {
            project: project.projectId,
            service: "parallelstore.googleapis.com",
          });
          const network = yield* GCP.Network("Vpc", {
            project: computeApi.project,
          });
          const psaRange = yield* GCP.GlobalAddress("PsaRange", {
            project: computeApi.project,
            network: network.selfLink,
            addressType: "INTERNAL",
            purpose: "VPC_PEERING",
            // /16 — Parallelstore reservations want at least /20; /16
            // gives enough room for the future-proofed shared FS use case.
            prefixLength: 16,
          });
          const psa = yield* GCP.PsaConnection("Psa", {
            network: GCP.networkRef(project.projectNumber, network.name),
            reservedPeeringRanges: [psaRange.name],
          });
          // Route through `psApi.project` for the parallelstore API
          // sequencing edge; PSA must come first so the network is
          // peer-ready before the instance create.
          const fs = yield* GCP.ParallelstoreInstance("Fs", {
            project: psApi.project,
            location: ZONE,
            // 12000 GiB is the documented floor; bump to 20480 (20 TiB)
            // to match the shared-services architecture target.
            capacityGib: "12000",
            network: GCP.networkRef(project.projectNumber, network.name),
            reservedIpRange: psaRange.name,
            deploymentType: "SCRATCH",
          });
          // Reference for sequencing only — alchemy keeps PSA upstream
          // of the instance via the `network`+`reservedIpRange` edge
          // already, but binding this explicitly makes the dependency
          // visible.
          void psa;
          void snApi;
          return { project, network, psaRange, psa, fs };
        }),
      );

      expect(result.fs.instanceId).toBeDefined();
      expect(result.fs.location).toBe(ZONE);
      expect(result.fs.capacityGib).toBe("12000");
      expect(result.fs.state).toBe("ACTIVE");
      expect(result.fs.deploymentType).toBe("SCRATCH");
      // Access points are the DNS targets a CSI driver mounts.
      expect(result.fs.accessPoints.length).toBeGreaterThan(0);
      // Internal labels stamped — adoption gate works.
      expect(result.fs.labels.alchemy_id).toBeDefined();

      yield* stack.destroy();
    }),
  TIMEOUT,
);
