import * as compute from "@distilled.cloud/gcp/compute-v1";
import * as Test from "alchemy/Test/Bun";
import * as GCP from "alchemy-v2-gcp";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";

// Folder under microagi org (id 622919272632) where research projects live.
const FOLDER_ID = process.env.GCP_TEST_FOLDER_ID ?? "<redacted-folder-id>";
// `compute.googleapis.com` enable requires billing on the project, so
// like Cluster.test.ts these tests skip unless a billing account is
// supplied in the fully-qualified `billingAccounts/{id}` form.
const rawBillingAccount = process.env.GCP_TEST_BILLING_ACCOUNT;
const BILLING_ACCOUNT = rawBillingAccount?.startsWith("billingAccounts/")
  ? (rawBillingAccount as `billingAccounts/${string}`)
  : undefined;

const runId = () => Math.random().toString(36).slice(2, 8);

// Project create (~30–60s) + compute API enable (~30s) + network create
// (~30s) + routingConfig patch LRO (~15s). 10 minutes is comfortable.
const TIMEOUT = { timeout: 10 * 60 * 1000 };

const { test } = Test.make({ providers: GCP.providers() });

const runOrSkip = BILLING_ACCOUNT ? test.provider : test.provider.skip;

runOrSkip(
  "create network + update routingMode + delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;

      // Project graph is rebuilt each deploy because `stack.deploy`
      // takes the *desired* graph — anything declared previously but
      // missing in a later deploy would be destroyed by the diff.
      const buildGraph = (routingMode: "REGIONAL" | "GLOBAL") =>
        Effect.gen(function* () {
          const project = yield* GCP.Project("NetTestProj", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID },
            billingAccount: BILLING_ACCOUNT,
          });
          const computeApi = yield* GCP.ApiEnable("ComputeApi", {
            project: project.projectId,
            service: "compute.googleapis.com",
          });
          // Route `project` through `computeApi.project` so alchemy
          // sequences API enablement before network create — same
          // dependency-edge trick as Cluster.test.ts uses for GKE.
          const network = yield* GCP.Network("Vpc", {
            project: computeApi.project,
            routingMode,
          });
          return { project, network };
        });

      const created = yield* stack.deploy(buildGraph("REGIONAL"));
      expect(created.network.name).toBeDefined();
      expect(created.network.autoCreateSubnetworks).toBe(false);
      expect(created.network.routingMode).toBe("REGIONAL");
      // The alchemy ownership marker is stamped into the description
      // (networks have no labels field). `stripAlchemyMarker` runs at
      // attribute time, so the user-visible description is undefined
      // when we only wrote the marker.
      expect(created.network.description).toBeUndefined();

      // Verify server-side state matches.
      const fetchedRegional = yield* compute.getNetworks({
        project: projectId,
        network: created.network.name,
      });
      expect(fetchedRegional.routingConfig?.routingMode).toBe("REGIONAL");
      // Marker round-trips on the wire as the raw description.
      expect(fetchedRegional.description ?? "").toContain("[alchemy:");

      // Update path — same network, mutate the only mutable field.
      const updated = yield* stack.deploy(buildGraph("GLOBAL"));
      expect(updated.network.name).toBe(created.network.name);
      expect(updated.network.routingMode).toBe("GLOBAL");

      const fetchedGlobal = yield* compute.getNetworks({
        project: projectId,
        network: updated.network.name,
      });
      expect(fetchedGlobal.routingConfig?.routingMode).toBe("GLOBAL");

      yield* stack.destroy();
    }),
  TIMEOUT,
);
