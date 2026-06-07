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
const TIMEOUT = { timeout: 25 * 60 * 1000 };
const REGION = "europe-west4";

const { test } = Test.make({ providers: GCP.providers() });
const runOrSkip =
  FOLDER_ID && BILLING_ACCOUNT ? test.provider : test.provider.skip;

/**
 * Verifies SqlDatabase create + destroy on top of a fresh Cloud SQL
 * instance. Database creates are fast (~5–10 s once the instance
 * exists); the long pole is still the instance create.
 */
runOrSkip(
  "create + destroy a logical database on a fresh instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const projectId = `alchemy-test-${runId()}`;

      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* GCP.Project("SqlDbProj", {
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
            settings: {
              tier: "db-custom-1-3840",
              edition: "ENTERPRISE",
              dataDiskSizeGb: 10,
              ipConfiguration: { ipv4Enabled: true },
              backupConfiguration: { enabled: false },
            },
          });
          const db = yield* GCP.SqlDatabase("AppDb", {
            project: instance.project,
            instance: instance.name,
            name: "app",
          });
          return { instance, db };
        }),
      );

      expect(result.db.name).toBe("app");
      expect(result.db.instance).toBe(result.instance.name);
      expect(result.db.project).toBe(projectId);

      yield* stack.destroy();
    }),
  TIMEOUT,
);
