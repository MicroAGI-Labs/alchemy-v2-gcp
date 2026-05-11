import * as run from "@distilled.cloud/gcp/run-v2";
import * as Test from "alchemy/Test/Bun";
import * as GCP from "@microagi/alchemy-gcp";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";

// Folder under microagi org (id 622919272632) where research projects live.
// Override via env to point at a different folder for local sandboxes.
const FOLDER_ID = process.env.GCP_TEST_FOLDER_ID;
// Billing account to attach to fresh test projects. Required because
// run.googleapis.com refuses to enable on a project without billing.
// Same constraints as the Cluster test.
const rawBillingAccount = process.env.GCP_TEST_BILLING_ACCOUNT;
const BILLING_ACCOUNT = rawBillingAccount?.startsWith("billingAccounts/")
  ? (rawBillingAccount as `billingAccounts/${string}`)
  : undefined;

// GCP project IDs are globally unique forever (soft-delete holds the ID
// for ~30 days). Stamp a per-invocation suffix so reruns don't collide.
const runId = () => Math.random().toString(36).slice(2, 8);

// Cloud Run Service create is fast (typically 20–40 s including the
// hello-world image pull), but the long poles are: project create
// (30–90 s), API enable (15–30 s), and three sequential deploys to
// exercise create → no-op → patch paths. 20 minutes is ample headroom.
const TIMEOUT = { timeout: 20 * 60 * 1000 };

// Cloud Run is regional. europe-west4 is the same region as the
// existing GKE clusters in this repo — keeps everything in one zone
// for latency and consistency.
const REGION = "europe-west4";

const { test } = Test.make({ providers: GCP.providers() });

const runOrSkip =
  FOLDER_ID && BILLING_ACCOUNT ? test.provider : test.provider.skip;

runOrSkip(
  "create, idempotent re-deploy, patch (top-level + template), destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;

      // The full graph (Project + ApiEnable + Service) is rebuilt on
      // each deploy — `stack.deploy` takes the desired graph for that
      // deployment, so anything declared previously but missing would
      // be destroyed by the engine's diff. Parametrise the per-deploy
      // delta as Service props so we can drive create / no-op / patch
      // from a single builder.
      const buildGraph = (svcProps: {
        labels?: Record<string, string>;
        ingress?: GCP.ServiceProps["ingress"];
        invokerIamDisabled?: boolean;
        template: GCP.ServiceProps["template"];
      }) =>
        Effect.gen(function* () {
          const project = yield* GCP.Project("RunSvcProj", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID! },
            billingAccount: BILLING_ACCOUNT,
          });
          // Route the Service's `project` through `runApi.project`
          // (rather than directly through `project.projectId`) so
          // alchemy sees the dependency edge and sequences API enable
          // before Service create. Without this, create races the API
          // enable and lands on the "If you enabled this API recently"
          // retry path — works, but slower.
          const runApi = yield* GCP.ApiEnable("RunApi", {
            project: project.projectId,
            service: "run.googleapis.com",
          });
          const svc = yield* GCP.Service("HelloApi", {
            project: runApi.project,
            location: REGION,
            ...svcProps,
          });
          return { project, svc };
        });

      // -----------------------------------------------------------
      // Deploy 1: create. Single container, default ingress.
      // `invokerIamDisabled: true` makes the Service publicly
      // reachable without a separate IAM binding — keeps the test
      // self-contained until we ship RunIamMember.
      // -----------------------------------------------------------
      const v1 = yield* stack.deploy(
        buildGraph({
          invokerIamDisabled: true,
          template: {
            containers: [{ image: "gcr.io/cloudrun/hello" }],
          },
        }),
      );

      expect(v1.svc.name.length).toBeGreaterThan(0);
      expect(v1.svc.uid.length).toBeGreaterThan(0);
      expect(v1.svc.uri).toMatch(/^https:\/\/.*\.run\.app$/);
      // The Service reached steady state — terminalCondition pops to
      // SUCCEEDED once the latest revision is Ready.
      expect(v1.svc.terminalCondition?.state).toBe("CONDITION_SUCCEEDED");
      expect(v1.svc.latestReadyRevision).toBeDefined();
      expect(v1.svc.latestReadyRevision).toBe(v1.svc.latestCreatedRevision);
      // Adoption labels stamped on first reconcile.
      expect(v1.svc.labels.alchemy_app).toBeDefined();
      expect(v1.svc.labels.alchemy_stage).toBe("test");
      expect(v1.svc.labels.alchemy_id).toBeDefined();
      // Public hello container must answer the default ingress URI.
      const helloRes = yield* Effect.tryPromise(() => fetch(v1.svc.uri));
      expect(helloRes.status).toBe(200);

      const initialGeneration = v1.svc.generation;
      const initialRevision = v1.svc.latestReadyRevision;
      const initialResourceName = v1.svc.resourceName;
      const initialUid = v1.svc.uid;
      expect(initialGeneration).toBeDefined();

      // -----------------------------------------------------------
      // Deploy 2: identical inputs. The sync step's deepEqual checks
      // should short-circuit every field and skip the patch RPC, so
      // generation MUST be unchanged. This is the most likely place
      // for the template diff logic to misbehave (server-injected
      // defaults make observed != news), so it's the load-bearing
      // assertion.
      // -----------------------------------------------------------
      const v2 = yield* stack.deploy(
        buildGraph({
          invokerIamDisabled: true,
          template: {
            containers: [{ image: "gcr.io/cloudrun/hello" }],
          },
        }),
      );
      expect(v2.svc.uid).toBe(initialUid);
      expect(v2.svc.resourceName).toBe(initialResourceName);
      expect(v2.svc.generation).toBe(initialGeneration);
      expect(v2.svc.latestReadyRevision).toBe(initialRevision);

      // -----------------------------------------------------------
      // Deploy 3: patch top-level fields (labels, ingress) AND
      // template (new env var → new revision). Verifies updateMask
      // construction and that Cloud Run spawns a new revision when
      // the template changes substantively.
      // -----------------------------------------------------------
      const v3 = yield* stack.deploy(
        buildGraph({
          labels: { env: "test", owner: "research" },
          ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
          invokerIamDisabled: true,
          template: {
            containers: [
              {
                image: "gcr.io/cloudrun/hello",
                env: [{ name: "TARGET", value: "patched" }],
              },
            ],
          },
        }),
      );
      expect(v3.svc.uid).toBe(initialUid);
      expect(v3.svc.labels.env).toBe("test");
      expect(v3.svc.labels.owner).toBe("research");
      // Internals still present.
      expect(v3.svc.labels.alchemy_id).toBeDefined();
      expect(BigInt(v3.svc.generation!)).toBeGreaterThan(BigInt(initialGeneration!));
      expect(v3.svc.latestReadyRevision).toBeDefined();
      expect(v3.svc.latestReadyRevision).not.toBe(initialRevision);

      // Verify server-side that ingress + labels actually landed (not
      // just echoed back from the patch RPC into attrs).
      const fetched = yield* run.getProjectsLocationsServices({
        name: initialResourceName,
      });
      expect(fetched.ingress).toBe("INGRESS_TRAFFIC_INTERNAL_ONLY");
      expect(fetched.labels?.env).toBe("test");
      expect(fetched.labels?.owner).toBe("research");

      // -----------------------------------------------------------
      // Deploy 4: same patched inputs as v3. Generation MUST again be
      // stable — proves the patch path is idempotent across re-runs.
      // -----------------------------------------------------------
      const v4 = yield* stack.deploy(
        buildGraph({
          labels: { env: "test", owner: "research" },
          ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
          invokerIamDisabled: true,
          template: {
            containers: [
              {
                image: "gcr.io/cloudrun/hello",
                env: [{ name: "TARGET", value: "patched" }],
              },
            ],
          },
        }),
      );
      expect(v4.svc.generation).toBe(v3.svc.generation);

      // -----------------------------------------------------------
      // Destroy and then destroy again — second destroy must be a
      // clean no-op (NotFound is success in delete).
      // -----------------------------------------------------------
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  TIMEOUT,
);
