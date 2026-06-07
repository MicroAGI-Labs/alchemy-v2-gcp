import * as Test from "alchemy/Test/Bun";
import * as GCP from "@microagi/alchemy-gcp";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

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
 * Exercises both auth modes — BUILT_IN (with a Redacted password) and
 * CLOUD_IAM_SERVICE_ACCOUNT (no password). We don't actually log in;
 * we just verify the user resources land server-side and clean up.
 */
runOrSkip(
  "create BUILT_IN + IAM SA users on a fresh instance and destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const projectId = `alchemy-test-${runId()}`;

      const builtInPassword = Redacted.make(
        `pw-${Math.random().toString(36).slice(2, 18)}`,
      );

      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* GCP.Project("SqlUserProj", {
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
              // IAM database authn requires this flag.
              databaseFlags: [
                { name: "cloudsql.iam_authentication", value: "on" },
              ],
              ipConfiguration: { ipv4Enabled: true },
              backupConfiguration: { enabled: false },
            },
          });
          const builtIn = yield* GCP.SqlUser("BuiltIn", {
            project: instance.project,
            instance: instance.name,
            name: "migrator",
            password: builtInPassword,
          });
          // The default Compute SA always exists in a fresh project as
          // `{projectNumber}-compute@developer.gserviceaccount.com`.
          // Cloud SQL expects the role name = SA email minus
          // `.gserviceaccount.com`. Using an explicit project SA
          // avoids creating a second one just for the test.
          const projectNumber = project.projectNumber;
          const saEmail = `${projectNumber}-compute@developer.gserviceaccount`;
          const iamUser = yield* GCP.SqlUser("IamSa", {
            project: instance.project,
            instance: instance.name,
            name: saEmail,
            type: "CLOUD_IAM_SERVICE_ACCOUNT",
          });
          return { instance, builtIn, iamUser };
        }),
      );

      expect(result.builtIn.name).toBe("migrator");
      expect(result.builtIn.type).toBe("BUILT_IN");
      expect(result.iamUser.type).toBe("CLOUD_IAM_SERVICE_ACCOUNT");

      yield* stack.destroy();
    }),
  TIMEOUT,
);
