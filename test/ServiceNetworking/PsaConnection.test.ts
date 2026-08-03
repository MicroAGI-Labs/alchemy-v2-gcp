import * as sn from "@distilled.cloud/gcp/servicenetworking_v1";
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

// PSA peering provisions a peered VPC inside Google's service-producer
// project — that's the long pole, routinely 5–10 min. With project
// create + two API enables + network + reservation, 20 minutes is a
// safe ceiling.
const TIMEOUT = { timeout: 20 * 60 * 1000 };

const { test } = Test.make({ providers: GCP.providers() });

const runOrSkip =
  FOLDER_ID && BILLING_ACCOUNT ? test.provider : test.provider.skip;

runOrSkip(
  "establish PSA connection (network + reserved range + peering) + delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;

      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* GCP.Project("PsaTestProj", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID! },
            billingAccount: BILLING_ACCOUNT,
          });
          // Two APIs: compute (for the VPC + GlobalAddress) and
          // servicenetworking (for the PSA peering operation).
          const computeApi = yield* GCP.ApiEnable("ComputeApi", {
            project: project.projectId,
            service: "compute.googleapis.com",
          });
          const snApi = yield* GCP.ApiEnable("ServiceNetworkingApi", {
            project: project.projectId,
            service: "servicenetworking.googleapis.com",
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
          // Route through `snApi.project` so alchemy sequences the
          // servicenetworking enable before this resource. Network ref
          // uses project number form via the typed `networkRef` helper —
          // PSA backend resolves peerings against numeric ids.
          const psa = yield* GCP.PsaConnection("Psa", {
            network: GCP.networkRef(project.projectNumber, network.name),
            reservedPeeringRanges: [psaRange.name],
          });
          // `snApi` is referenced for sequencing only.
          void snApi;
          return { project, network, psaRange, psa };
        }),
      );

      // Cast through `string` — `toBe` is exact-equality and the
      // assertion target is a plain interpolation; the runtime value
      // matches but its declared type (the branded `NetworkRef`)
      // wouldn't accept a non-branded string. The runtime comparison
      // is what we care about.
      expect(result.psa.network as string).toBe(
        `projects/${result.project.projectNumber}/global/networks/${result.network.name}`,
      );
      expect(result.psa.serviceName).toBe(
        "services/servicenetworking.googleapis.com",
      );
      // Server-assigned peering name — canonically
      // `servicenetworking-googleapis-com` for the standard producer.
      expect(result.psa.peering.length).toBeGreaterThan(0);
      expect(result.psa.reservedPeeringRanges).toContain(result.psaRange.name);

      // Verify server-side: the peering shows up under the consumer VPC.
      const listed = yield* sn.listServicesConnections({
        parent: "services/servicenetworking.googleapis.com",
        network: result.psa.network,
      });
      const conn = (listed.connections ?? []).find(
        (c) => c.network === result.psa.network,
      );
      expect(conn).toBeDefined();
      expect(conn?.peering).toBe(result.psa.peering);
      expect(conn?.reservedPeeringRanges ?? []).toContain(result.psaRange.name);

      yield* stack.destroy();
    }),
  TIMEOUT,
);
