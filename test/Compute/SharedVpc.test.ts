import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Test from "alchemy/Test/Bun";
import * as GCP from "@microagi/alchemy-gcp";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";

const FOLDER_ID = process.env.GCP_TEST_FOLDER_ID;
const rawBillingAccount = process.env.GCP_TEST_BILLING_ACCOUNT;
const BILLING_ACCOUNT = rawBillingAccount?.startsWith("billingAccounts/")
  ? (rawBillingAccount as `billingAccounts/${string}`)
  : undefined;

// Shared VPC attach requires `roles/compute.xpnAdmin` at the folder/org
// level on the principal running the test. That's a non-default
// permission, so this test is triple-gated: billing AND an explicit
// `GCP_TEST_SHARED_VPC=1` opt-in. The test creates two fresh projects
// under FOLDER_ID — both are cleaned up by `stack.destroy`.
const SHARED_VPC_OPT_IN = process.env.GCP_TEST_SHARED_VPC === "1";

const runId = () => Math.random().toString(36).slice(2, 8);

// Two project creates, two compute API enables, host enable LRO,
// resource attach LRO, then teardown. 30 min headroom.
const TIMEOUT = { timeout: 30 * 60 * 1000 };

const { test } = Test.make({ providers: GCP.providers() });

const runOrSkip =
  FOLDER_ID && BILLING_ACCOUNT && SHARED_VPC_OPT_IN
    ? test.provider
    : test.provider.skip;

runOrSkip(
  "enable shared-VPC host + attach service project + detach + delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const hostProjectId = `alchemy-host-${runId()}`;
      const serviceProjectId = `alchemy-svc-${runId()}`;

      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const hostProject = yield* GCP.Project("HostProj", {
            projectId: hostProjectId,
            parent: { type: "folder", id: FOLDER_ID! },
            billingAccount: BILLING_ACCOUNT,
          });
          const serviceProject = yield* GCP.Project("SvcProj", {
            projectId: serviceProjectId,
            parent: { type: "folder", id: FOLDER_ID! },
            billingAccount: BILLING_ACCOUNT,
          });
          // compute.googleapis.com must be enabled on both ends — the
          // host needs it for VPC, the service project needs it to be
          // able to consume the shared VPC.
          const hostComputeApi = yield* GCP.ApiEnable("HostComputeApi", {
            project: hostProject.projectId,
            service: "compute.googleapis.com",
          });
          const svcComputeApi = yield* GCP.ApiEnable("SvcComputeApi", {
            project: serviceProject.projectId,
            service: "compute.googleapis.com",
          });
          const host = yield* GCP.SharedVpcHost("Host", {
            project: hostComputeApi.project,
          });
          const attach = yield* GCP.SharedVpcServiceProject("Attach", {
            hostProject: host.project,
            serviceProject: svcComputeApi.project,
          });
          return { hostProject, serviceProject, host, attach };
        }),
      );

      expect(result.host.xpnProjectStatus).toBe("HOST");
      expect(result.attach.hostProject).toBe(hostProjectId);
      expect(result.attach.serviceProject).toBe(serviceProjectId);

      // Server-side: host project's xpnProjectStatus is HOST.
      const hostFetched = yield* compute.getProjects({
        project: hostProjectId,
      });
      expect(hostFetched.xpnProjectStatus).toBe("HOST");

      // Server-side: service project's "host" reference resolves to
      // the host project's name. The compute API returns this in
      // either `name` or `id`-form depending on path; match on suffix.
      const svcHost = yield* compute.getXpnHostProjects({
        project: serviceProjectId,
      });
      const hostRef = svcHost.name ?? svcHost.id ?? "";
      expect(
        hostRef === hostProjectId ||
          hostRef.endsWith(`/${hostProjectId}`) ||
          hostRef.endsWith(`projects/${hostProjectId}`),
      ).toBe(true);

      yield* stack.destroy();
    }),
  TIMEOUT,
);
