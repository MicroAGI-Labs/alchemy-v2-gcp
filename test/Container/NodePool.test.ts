import * as cont from "@distilled.cloud/gcp/container-v1";
import * as Test from "alchemy/Test/Bun";
import * as GCP from "@microagi/alchemy-gcp";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";

const FOLDER_ID = process.env.GCP_TEST_FOLDER_ID;
// Must be `billingAccounts/{id}` to match Project.billingAccount's
// template literal type; bare ids skip these tests.
const rawBillingAccount = process.env.GCP_TEST_BILLING_ACCOUNT;
const BILLING_ACCOUNT = rawBillingAccount?.startsWith("billingAccounts/")
  ? (rawBillingAccount as `billingAccounts/${string}`)
  : undefined;

const runId = () => Math.random().toString(36).slice(2, 8);

// Cluster create + node pool create + a setSize LRO comfortably fits in
// 30 minutes; the cluster is the long pole.
const TIMEOUT = { timeout: 30 * 60 * 1000 };

const { test } = Test.make({ providers: GCP.providers() });

const runOrSkip =
  FOLDER_ID && BILLING_ACCOUNT ? test.provider : test.provider.skip;

runOrSkip(
  "create + resize + delete a node pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;

      const buildGraph = (
        initialNodeCount: number,
        externallyManagedSize = false,
      ) =>
        Effect.gen(function* () {
          const project = yield* GCP.Project("PoolTestProj", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID! },
            billingAccount: BILLING_ACCOUNT,
          });
          // Routing the cluster's `project` through `containerApi.project`
          // gives alchemy the dependency edge it needs to sequence
          // API enablement before the cluster create.
          const containerApi = yield* GCP.ApiEnable("ContainerApi", {
            project: project.projectId,
            service: "container.googleapis.com",
          });
          const cluster = yield* GCP.Cluster("PoolTestCluster", {
            project: containerApi.project,
            location: "us-central1-a",
            // Bootstrap pool is owned by the cluster. Distinct name from
            // the GCP.NodePool below so the two don't collide.
            initialNodePool: {
              name: "bootstrap",
              initialNodeCount: 1,
              config: { machineType: "e2-medium" },
            },
          });
          const pool = yield* GCP.NodePool("system", {
            project: project.projectId,
            location: cluster.location,
            clusterName: cluster.name,
            initialNodeCount,
            externallyManagedSize,
            config: { machineType: "e2-standard-2" },
          });
          return { project, cluster, pool };
        });

      const created = yield* stack.deploy(buildGraph(1));
      expect(created.pool.name).toBeDefined();
      expect(created.pool.clusterName).toBe(created.cluster.name);
      expect(created.pool.location).toBe("us-central1-a");
      expect(created.pool.status).toBe("RUNNING");

      // Pool gets stamped with its own alchemy labels (keyed against
      // the pool's logical id "system", distinct from the cluster's id).
      const fetched = yield* cont.getProjectsLocationsClustersNodePools({
        name: `projects/${projectId}/locations/us-central1-a/clusters/${created.cluster.name}/nodePools/${created.pool.name}`,
      });
      expect(fetched.config?.resourceLabels?.alchemy_id).toBeDefined();
      expect(fetched.initialNodeCount).toBe(1);

      // Resize path — re-deploy full graph with size 2. Exercises
      // `setSize` sync without replacing the pool.
      const resized = yield* stack.deploy(buildGraph(2));
      expect(resized.pool.name).toBe(created.pool.name);

      const refetched = yield* cont.getProjectsLocationsClustersNodePools({
        name: `projects/${projectId}/locations/us-central1-a/clusters/${resized.cluster.name}/nodePools/${resized.pool.name}`,
      });
      expect(refetched.initialNodeCount).toBe(2);

      // Switching to external size ownership leaves the observed size at 2
      // even though the bootstrap count is back to 1. Alchemy continues to
      // reconcile every other pool property, but must not call setSize.
      const externallyManaged = yield* stack.deploy(buildGraph(1, true));
      const externallyManagedFetched =
        yield* cont.getProjectsLocationsClustersNodePools({
          name: `projects/${projectId}/locations/us-central1-a/clusters/${externallyManaged.cluster.name}/nodePools/${externallyManaged.pool.name}`,
        });
      expect(externallyManagedFetched.initialNodeCount).toBe(2);

      yield* stack.destroy();
    }),
  TIMEOUT,
);
