import * as cont from "@distilled.cloud/gcp/container-v1";
import * as Test from "alchemy/Test/Bun";
import * as GCP from "@microagi/alchemy-gcp";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";

// Folder under microagi org (id 622919272632) where research projects live.
// Override via env to point at a different folder for local sandboxes.
const FOLDER_ID = process.env.GCP_TEST_FOLDER_ID ?? "<redacted-folder-id>";
// Billing account to attach to fresh test projects. Required because
// container.googleapis.com refuses to enable on a project without
// billing. No default — must be set explicitly to avoid charging an
// arbitrary account; tests that need it are skipped otherwise.
//
// Must be the fully-qualified `billingAccounts/{id}` form — the
// `Project.billingAccount` prop is typed `\`billingAccounts/${string}\``
// and unprefixed values would be a runtime 400 from cloudbilling.
const rawBillingAccount = process.env.GCP_TEST_BILLING_ACCOUNT;
const BILLING_ACCOUNT = rawBillingAccount?.startsWith("billingAccounts/")
  ? (rawBillingAccount as `billingAccounts/${string}`)
  : undefined;

// GCP project IDs are globally unique forever (soft-deletion holds the ID
// for ~30 days after delete). Stamp a per-invocation suffix so reruns of
// the same test don't collide on a recently-deleted ID.
const runId = () => Math.random().toString(36).slice(2, 8);

// GKE cluster create LRO is the long pole — typically 5–10 minutes.
// Layered on top of project create (~30–90s) and a label-update LRO
// (~30–60s), 30 minutes is comfortable headroom.
const TIMEOUT = { timeout: 30 * 60 * 1000 };

const { test } = Test.make({ providers: GCP.providers() });

const runOrSkip = BILLING_ACCOUNT ? test.provider : test.provider.skip;

runOrSkip(
  "create + update labels + delete a cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;

      // The full graph (Project + Cluster) is rebuilt on each deploy
      // because `stack.deploy` takes the desired graph for that
      // deployment — anything declared previously but missing here
      // would be destroyed by the engine's diff.
      const buildGraph = (resourceLabels: Record<string, string>) =>
        Effect.gen(function* () {
          // Attach billing inline on the project. Without it, the
          // ApiEnable below would fail with "Billing account ... is
          // not found. Billing must be enabled for activation of
          // service(s) 'container.googleapis.com'".
          const project = yield* GCP.Project("ClusterTestProj", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID },
            billingAccount: BILLING_ACCOUNT,
          });
          // Container API must be enabled before any GKE call works on
          // a freshly-created project. Route the cluster's `project`
          // through `containerApi.project` (rather than directly
          // through `project.projectId`) so alchemy sees the
          // dependency edge and sequences API enable before cluster
          // create.
          const containerApi = yield* GCP.ApiEnable("ContainerApi", {
            project: project.projectId,
            service: "container.googleapis.com",
          });
          const cluster = yield* GCP.Cluster("Test", {
            project: containerApi.project,
            location: "us-central1-a",
            releaseChannel: { channel: "REGULAR" },
            resourceLabels,
            initialNodePool: {
              name: "system",
              initialNodeCount: 1,
              config: { machineType: "e2-medium" },
            },
          });
          return { project, cluster };
        });

      const created = yield* stack.deploy(buildGraph({ env: "test" }));
      expect(created.cluster.name).toBeDefined();
      expect(created.cluster.endpoint).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(created.cluster.clusterCaCertificate.length).toBeGreaterThan(0);
      // Cluster carries our internal labels; bootstrap pool is owned by
      // the cluster (labels stamped via `toInitialNodePoolBody`).
      expect(created.cluster.resourceLabels.alchemy_app).toBeDefined();
      expect(created.cluster.resourceLabels.alchemy_stage).toBe("test");
      expect(created.cluster.resourceLabels.alchemy_id).toBeDefined();
      expect(created.cluster.resourceLabels.env).toBe("test");

      // Verify server-side state matches.
      const fetched = yield* cont.getProjectsLocationsClusters({
        name: `projects/${projectId}/locations/us-central1-a/clusters/${created.cluster.name}`,
      });
      expect(fetched.status).toBe("RUNNING");
      expect(fetched.resourceLabels?.env).toBe("test");

      // Update path — full graph re-declared, only labels change.
      // Should NOT trigger replace (cluster name is stable).
      const updated = yield* stack.deploy(
        buildGraph({ env: "test", owner: "research" }),
      );
      expect(updated.cluster.name).toBe(created.cluster.name);
      expect(updated.cluster.resourceLabels.owner).toBe("research");

      const refetched = yield* cont.getProjectsLocationsClusters({
        name: `projects/${projectId}/locations/us-central1-a/clusters/${updated.cluster.name}`,
      });
      expect(refetched.resourceLabels?.owner).toBe("research");

      yield* stack.destroy();
    }),
  TIMEOUT,
);
