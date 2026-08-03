import * as run from "@distilled.cloud/gcp/run_v2";
import * as Test from "alchemy/Test/Bun";
import * as GCP from "@microagi/alchemy-gcp";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";

// Same env-gate as the Service test. Job lifecycle costs are similar
// (project + API enable dominate; Job create itself is fast — usually
// 5-15 s with no container pull on the control plane).
const FOLDER_ID = process.env.GCP_TEST_FOLDER_ID;
const rawBillingAccount = process.env.GCP_TEST_BILLING_ACCOUNT;
const BILLING_ACCOUNT = rawBillingAccount?.startsWith("billingAccounts/")
  ? (rawBillingAccount as `billingAccounts/${string}`)
  : undefined;

const runId = () => Math.random().toString(36).slice(2, 8);
const TIMEOUT = { timeout: 20 * 60 * 1000 };
const REGION = "europe-west4";

const { test } = Test.make({ providers: GCP.providers() });
const runOrSkip =
  FOLDER_ID && BILLING_ACCOUNT ? test.provider : test.provider.skip;

runOrSkip(
  "Job: create, idempotent re-deploy, patch (labels + template), destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;

      const buildGraph = (jobProps: {
        labels?: Record<string, string>;
        template: GCP.JobProps["template"];
      }) =>
        Effect.gen(function* () {
          const project = yield* GCP.Project("RunJobProj", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID! },
            billingAccount: BILLING_ACCOUNT,
          });
          const runApi = yield* GCP.ApiEnable("RunApi", {
            project: project.projectId,
            service: "run.googleapis.com",
          });
          const job = yield* GCP.Job("BatchJob", {
            project: runApi.project,
            location: REGION,
            ...jobProps,
          });
          return { project, job };
        });

      // -----------------------------------------------------------
      // Deploy 1: create. Single-task job, `gcr.io/cloudrun/hello`
      // works fine as a batch image — it exits 0 after a brief HTTP
      // greeting loop, which is the simplest valid Job container.
      // -----------------------------------------------------------
      const v1 = yield* stack.deploy(
        buildGraph({
          template: {
            taskCount: 1,
            template: {
              maxRetries: 0,
              containers: [{ image: "gcr.io/cloudrun/hello" }],
            },
          },
        }),
      );

      expect(v1.job.name.length).toBeGreaterThan(0);
      expect(v1.job.uid.length).toBeGreaterThan(0);
      // Job's terminalCondition becomes Ready=true after reconcile,
      // and Cloud Run reports this via `CONDITION_SUCCEEDED` on the
      // terminal `Ready` condition.
      expect(v1.job.terminalCondition?.state).toBe("CONDITION_SUCCEEDED");
      // Adoption labels stamped on create.
      expect(v1.job.labels.alchemy_app).toBeDefined();
      expect(v1.job.labels.alchemy_stage).toBe("test");
      expect(v1.job.labels.alchemy_id).toBeDefined();

      const initialUid = v1.job.uid;
      const initialGeneration = v1.job.generation;
      const initialResourceName = v1.job.resourceName;
      expect(initialGeneration).toBeDefined();

      // -----------------------------------------------------------
      // Deploy 2: identical inputs → generation must stay flat. Job's
      // patch has no updateMask, so the load-bearing idempotency
      // check is the `jobMutated` deepEqual on the template.
      // -----------------------------------------------------------
      const v2 = yield* stack.deploy(
        buildGraph({
          template: {
            taskCount: 1,
            template: {
              maxRetries: 0,
              containers: [{ image: "gcr.io/cloudrun/hello" }],
            },
          },
        }),
      );
      expect(v2.job.uid).toBe(initialUid);
      expect(v2.job.generation).toBe(initialGeneration);

      // -----------------------------------------------------------
      // Deploy 3: patch labels + add env var. Should bump generation
      // and stamp the new label values.
      // -----------------------------------------------------------
      const v3 = yield* stack.deploy(
        buildGraph({
          labels: { tier: "batch", owner: "research" },
          template: {
            taskCount: 1,
            template: {
              maxRetries: 0,
              containers: [
                {
                  image: "gcr.io/cloudrun/hello",
                  env: [{ name: "JOB_VARIANT", value: "patched" }],
                },
              ],
            },
          },
        }),
      );
      expect(v3.job.uid).toBe(initialUid);
      expect(v3.job.labels.tier).toBe("batch");
      expect(v3.job.labels.owner).toBe("research");
      expect(v3.job.labels.alchemy_id).toBeDefined();
      expect(BigInt(v3.job.generation!)).toBeGreaterThan(
        BigInt(initialGeneration!),
      );

      // Server-side verification — confirm the patch actually landed.
      const fetched = yield* run.getProjectsLocationsJobs({
        name: initialResourceName,
      });
      expect(fetched.labels?.tier).toBe("batch");
      expect(fetched.template?.template?.containers?.[0]?.env?.[0]?.name).toBe(
        "JOB_VARIANT",
      );

      // -----------------------------------------------------------
      // Deploy 4: same patched inputs → generation stable. This is
      // the load-bearing repro for "deepEqual on the template after a
      // patch holds up against server-injected defaults".
      // -----------------------------------------------------------
      const v4 = yield* stack.deploy(
        buildGraph({
          labels: { tier: "batch", owner: "research" },
          template: {
            taskCount: 1,
            template: {
              maxRetries: 0,
              containers: [
                {
                  image: "gcr.io/cloudrun/hello",
                  env: [{ name: "JOB_VARIANT", value: "patched" }],
                },
              ],
            },
          },
        }),
      );
      expect(v4.job.generation).toBe(v3.job.generation);

      yield* stack.destroy();
      // Second destroy must be a clean no-op (NotFound is success).
      yield* stack.destroy();
    }),
  TIMEOUT,
);
