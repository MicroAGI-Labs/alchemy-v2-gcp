import * as sql from "@distilled.cloud/gcp/sqladmin-v1";
import * as Test from "alchemy/Test/Bun";
import * as GCP from "@microagi/alchemy-gcp";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";

// Folder under microagi org (id 622919272632) where research projects
// live. Override via env to point at a different folder for local
// sandboxes.
const FOLDER_ID = process.env.GCP_TEST_FOLDER_ID;
// Billing account to attach to fresh test projects. Required because
// sqladmin.googleapis.com refuses to enable on a project without
// billing. Same constraints as the Cluster / Run test.
const rawBillingAccount = process.env.GCP_TEST_BILLING_ACCOUNT;
const BILLING_ACCOUNT = rawBillingAccount?.startsWith("billingAccounts/")
  ? (rawBillingAccount as `billingAccounts/${string}`)
  : undefined;

// GCP project IDs are globally unique forever (soft-delete holds the ID
// for ~30 days). Stamp a per-invocation suffix so reruns don't collide.
const runId = () => Math.random().toString(36).slice(2, 8);

// Cloud SQL instance create is the slow path: 4–10 min for a fresh
// Postgres 17 instance, plus the project create (~30–90 s) and API
// enable (~15–30 s) preamble. 25 min is comfortable headroom; the test
// runs a single deploy + destroy.
const TIMEOUT = { timeout: 25 * 60 * 1000 };

// Cloud SQL region — keep colocated with the existing GKE clusters.
const REGION = "europe-west4";

const { test } = Test.make({ providers: GCP.providers() });

const runOrSkip =
  FOLDER_ID && BILLING_ACCOUNT ? test.provider : test.provider.skip;

runOrSkip(
  "create + idempotent re-deploy + label patch + destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;

      const buildGraph = (instProps: {
        labels?: Record<string, string>;
        settings: GCP.SqlInstanceProps["settings"];
      }) =>
        Effect.gen(function* () {
          const project = yield* GCP.Project("SqlProj", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID! },
            billingAccount: BILLING_ACCOUNT,
          });
          const sqlApi = yield* GCP.ApiEnable("SqlApi", {
            project: project.projectId,
            service: "sqladmin.googleapis.com",
          });
          const instance = yield* GCP.SqlInstance("Primary", {
            project: sqlApi.project,
            region: REGION,
            databaseVersion: "POSTGRES_17",
            ...instProps,
          });
          return { project, instance };
        });

      const v1 = yield* stack.deploy(
        buildGraph({
          settings: {
            tier: "db-custom-1-3840",
            edition: "ENTERPRISE",
            dataDiskSizeGb: 10,
            // Public IPv4 keeps the test simple — no Shared VPC PSA
            // wiring needed. Combined with `requireSsl: false` so we
            // could (in theory) connect from CI, but we don't.
            ipConfiguration: { ipv4Enabled: true },
            backupConfiguration: { enabled: false },
          },
        }),
      );

      expect(v1.instance.name.length).toBeGreaterThan(0);
      expect(v1.instance.state).toBe("RUNNABLE");
      expect(v1.instance.databaseVersion).toBe("POSTGRES_17");
      expect(v1.instance.connectionName).toBe(
        `${projectId}:${REGION}:${v1.instance.name}`,
      );
      // Adoption labels stamped on first reconcile, surfaced through
      // settings.userLabels.
      expect(v1.instance.labels.alchemy_app).toBeDefined();
      expect(v1.instance.labels.alchemy_stage).toBe("test");
      expect(v1.instance.labels.alchemy_id).toBeDefined();
      // Public instance must have a PRIMARY IP.
      expect(v1.instance.publicIpAddress).toBeDefined();
      expect(v1.instance.settingsVersion).toBeDefined();
      const initialSettingsVersion = v1.instance.settingsVersion;

      // Idempotent re-deploy: no settings drift → no patch RPC →
      // settingsVersion unchanged.
      const v2 = yield* stack.deploy(
        buildGraph({
          settings: {
            tier: "db-custom-1-3840",
            edition: "ENTERPRISE",
            dataDiskSizeGb: 10,
            ipConfiguration: { ipv4Enabled: true },
            backupConfiguration: { enabled: false },
          },
        }),
      );
      expect(v2.instance.settingsVersion).toBe(initialSettingsVersion);

      // Patch: add user labels. settingsVersion must bump.
      const v3 = yield* stack.deploy(
        buildGraph({
          labels: { env: "test", owner: "research" },
          settings: {
            tier: "db-custom-1-3840",
            edition: "ENTERPRISE",
            dataDiskSizeGb: 10,
            ipConfiguration: { ipv4Enabled: true },
            backupConfiguration: { enabled: false },
          },
        }),
      );
      expect(v3.instance.labels.env).toBe("test");
      expect(v3.instance.labels.owner).toBe("research");
      expect(v3.instance.labels.alchemy_id).toBeDefined();
      expect(BigInt(v3.instance.settingsVersion!)).toBeGreaterThan(
        BigInt(initialSettingsVersion!),
      );

      // Cross-check via the SDK directly.
      const fetched = yield* sql.getInstances({
        project: projectId,
        instance: v1.instance.name,
      });
      expect(fetched.settings?.userLabels?.env).toBe("test");

      yield* stack.destroy();
      yield* stack.destroy();
    }),
  TIMEOUT,
);
