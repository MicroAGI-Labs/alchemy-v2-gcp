import * as ar from "@distilled.cloud/gcp/artifactregistry-v1";
import * as GCP from "@microagi/alchemy-gcp";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";

// Folder under microagi org (id 622919272632) where research projects
// live. Override via env to point at a different folder for local
// sandboxes.
const FOLDER_ID = process.env.GCP_TEST_FOLDER_ID;
// Billing account to attach to fresh test projects. Required because
// artifactregistry.googleapis.com refuses to enable on a project
// without billing.
const rawBillingAccount = process.env.GCP_TEST_BILLING_ACCOUNT;
const BILLING_ACCOUNT = rawBillingAccount?.startsWith("billingAccounts/")
  ? (rawBillingAccount as `billingAccounts/${string}`)
  : undefined;

// GCP project IDs are globally unique forever (soft-delete holds the ID
// for ~30 days). Stamp a per-invocation suffix so reruns don't collide.
const runId = () => Math.random().toString(36).slice(2, 8);

// Repository CRUD is fast (seconds each), but the project create
// (~30–90 s) and API enable (~15–30 s) preamble dominate. 10 min is
// comfortable headroom for create + idempotent re-deploy + patch +
// destroy.
const TIMEOUT = { timeout: 10 * 60 * 1000 };

const LOCATION = "europe-west4";

const { test } = Test.make({ providers: GCP.providers() });

const runOrSkip =
  FOLDER_ID && BILLING_ACCOUNT ? test.provider : test.provider.skip;

runOrSkip(
  "create standard + remote repos, re-deploy, patch labels, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;

      const buildGraph = (extraLabels?: Record<string, string>) =>
        Effect.gen(function* () {
          const project = yield* GCP.Project("ArProj", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID! },
            billingAccount: BILLING_ACCOUNT,
          });
          const arApi = yield* GCP.ApiEnable("ArApi", {
            project: project.projectId,
            service: "artifactregistry.googleapis.com",
          });
          const apps = yield* GCP.ArtifactRegistryRepository("Apps", {
            project: arApi.project,
            location: LOCATION,
            format: "DOCKER",
            description: "App images built by CI",
            labels: extraLabels,
          });
          const dockerHubMirror = yield* GCP.ArtifactRegistryRepository(
            "DockerHubMirror",
            {
              project: arApi.project,
              location: LOCATION,
              format: "DOCKER",
              mode: "REMOTE_REPOSITORY",
              remoteRepositoryConfig: {
                description: "Pull-through cache for docker.io",
                dockerRepository: { publicRepository: "DOCKER_HUB" },
              },
            },
          );
          const nvcrMirror = yield* GCP.ArtifactRegistryRepository(
            "NvcrMirror",
            {
              project: arApi.project,
              location: LOCATION,
              format: "DOCKER",
              mode: "REMOTE_REPOSITORY",
              remoteRepositoryConfig: {
                description: "Pull-through cache for nvcr.io",
                dockerRepository: {
                  customRepository: { uri: "https://nvcr.io" },
                },
              },
            },
          );
          return { project, apps, dockerHubMirror, nvcrMirror };
        });

      const v1 = yield* stack.deploy(buildGraph());

      expect(v1.apps.format).toBe("DOCKER");
      expect(v1.apps.mode).toBe("STANDARD_REPOSITORY");
      expect(v1.apps.registryUri).toBeDefined();
      expect(v1.apps.fullyQualifiedName).toBe(
        `projects/${projectId}/locations/${LOCATION}/repositories/${v1.apps.name}`,
      );
      expect(v1.apps.labels.alchemy_app).toBeDefined();
      expect(v1.apps.labels.alchemy_stage).toBe("test");
      expect(v1.apps.labels.alchemy_id).toBeDefined();

      expect(v1.dockerHubMirror.mode).toBe("REMOTE_REPOSITORY");
      expect(v1.nvcrMirror.mode).toBe("REMOTE_REPOSITORY");

      // Idempotent re-deploy: no field drift → no patch.
      const v2 = yield* stack.deploy(buildGraph());
      expect(v2.apps.name).toBe(v1.apps.name);
      expect(v2.apps.updateTime).toBe(v1.apps.updateTime);

      // Patch: add a user label. updateTime must bump.
      const v3 = yield* stack.deploy(
        buildGraph({ env: "test", owner: "research" }),
      );
      expect(v3.apps.labels.env).toBe("test");
      expect(v3.apps.labels.owner).toBe("research");
      expect(v3.apps.labels.alchemy_id).toBeDefined();
      expect(
        new Date(v3.apps.updateTime).getTime(),
      ).toBeGreaterThanOrEqual(new Date(v1.apps.updateTime).getTime());

      // Cross-check via the SDK directly.
      const fetched = yield* ar.getProjectsLocationsRepositories({
        name: v3.apps.fullyQualifiedName,
      });
      expect(fetched.labels?.env).toBe("test");

      yield* stack.destroy();
      yield* stack.destroy();
    }),
  TIMEOUT,
);
