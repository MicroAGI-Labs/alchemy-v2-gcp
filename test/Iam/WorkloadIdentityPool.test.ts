import * as GCP from "@microagi/alchemy-gcp";
import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";

// Folder under microagi org (id 622919272632) where research projects live.
const FOLDER_ID = process.env.GCP_TEST_FOLDER_ID;
// Workload Identity pools need no billing of their own, but the enclosing
// project does in order to enable iam.googleapis.com.
const rawBillingAccount = process.env.GCP_TEST_BILLING_ACCOUNT;
const BILLING_ACCOUNT = rawBillingAccount?.startsWith("billingAccounts/")
  ? (rawBillingAccount as `billingAccounts/${string}`)
  : undefined;

const runId = () => Math.random().toString(36).slice(2, 8);

// Pool/provider CRUD is fast (LROs settle in seconds), but the project
// create (~30–90 s) and API enable (~15–30 s) preamble dominate.
const TIMEOUT = { timeout: 10 * 60 * 1000 };

// A real, stable OIDC issuer is required: GCP validates the discovery
// document at create time, so a made-up URL fails the API call rather than
// the assertion. Google's own issuer is public, always reachable, and
// carries no relationship to this project.
const ISSUER_URI = "https://accounts.google.com";

const { test } = Test.make({ providers: GCP.providers() });

const runOrSkip =
  FOLDER_ID && BILLING_ACCOUNT ? test.provider : test.provider.skip;

runOrSkip(
  "create pool + OIDC provider, re-deploy, patch, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;
      // 4-32 chars of [a-z0-9-]; the `gcp-` prefix is reserved by Google.
      const poolId = `wif-test-${runId()}`;
      const providerId = `oidc-test-${runId()}`;

      const buildGraph = (displayName: string, condition?: string) =>
        Effect.gen(function* () {
          const project = yield* GCP.Project("WifProj", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID! },
            billingAccount: BILLING_ACCOUNT,
          });
          const iamApi = yield* GCP.ApiEnable("IamApi", {
            project: project.projectId,
            service: "iam.googleapis.com",
          });
          const pool = yield* GCP.WorkloadIdentityPool("Pool", {
            // The project NUMBER, not the id: principalSet:// members built
            // from an id are accepted and then never match.
            project: Output.map(
              Output.all(project.projectNumber, iamApi.project),
              ([projectNumber]) => projectNumber,
            ) as unknown as string,
            poolId,
            displayName,
            description: "Workload Identity lifecycle test",
          });
          const provider = yield* GCP.WorkloadIdentityPoolProvider("Provider", {
            project: pool.project,
            poolId: pool.poolId,
            providerId,
            oidc: {
              issuerUri: ISSUER_URI,
              allowedAudiences: ["sts.googleapis.com"],
            },
            attributeMapping: { "google.subject": "assertion.sub" },
            ...(condition ? { attributeCondition: condition } : {}),
            displayName,
          });
          return { pool, provider };
        });

      const created = yield* stack.deploy(buildGraph("WIF test"));

      expect(created.pool.poolId).toBe(poolId);
      expect(created.pool.state).toBe("ACTIVE");
      expect(created.pool.name).toContain(
        `/locations/global/workloadIdentityPools/${poolId}`,
      );
      // Description round-trips with the ownership marker stripped.
      expect(created.pool.description).toBe("Workload Identity lifecycle test");

      expect(created.provider.providerId).toBe(providerId);
      expect(created.provider.issuerUri).toBe(ISSUER_URI);
      expect(created.provider.attributeMapping).toEqual({
        "google.subject": "assertion.sub",
      });
      // The audience string is what a credential configuration needs; assert
      // the exact shape because the leading `//` and absent scheme are easy
      // to get wrong by hand.
      expect(created.provider.audience).toBe(
        `//iam.googleapis.com/${created.provider.name}`,
      );

      // Re-deploying an unchanged graph must not churn: both resources
      // observe, find themselves current, and skip the patch LRO.
      const redeployed = yield* stack.deploy(buildGraph("WIF test"));
      expect(redeployed.pool.name).toBe(created.pool.name);
      expect(redeployed.provider.name).toBe(created.provider.name);

      // Patch mutable fields on both.
      const patched = yield* stack.deploy(
        buildGraph(
          "WIF test v2",
          "assertion.sub == 'system:serviceaccount:admin:test'",
        ),
      );
      expect(patched.pool.displayName).toBe("WIF test v2");
      expect(patched.provider.displayName).toBe("WIF test v2");
      expect(patched.provider.attributeCondition).toBe(
        "assertion.sub == 'system:serviceaccount:admin:test'",
      );
      // Identity is preserved across the patch — a replace here would mean
      // the diff wrongly treats a mutable field as immutable.
      expect(patched.pool.name).toBe(created.pool.name);
      expect(patched.provider.name).toBe(created.provider.name);

      yield* stack.destroy();
    }),
  TIMEOUT,
);
