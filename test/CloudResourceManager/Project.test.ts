import * as crm from "@distilled.cloud/gcp/cloudresourcemanager-v3";
import * as Test from "alchemy/Test/Bun";
import * as GCP from "alchemy-v2-gcp";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";

// Folder under microagi org (id 622919272632) where research projects live.
// Override via env to point at a different folder for local sandboxes.
const FOLDER_ID = process.env.GCP_TEST_FOLDER_ID ?? "<redacted-folder-id>";

// GCP project IDs are globally unique forever (soft-deletion holds the ID
// for ~30 days after delete). Stamp a per-invocation suffix so reruns of
// the same test don't collide on a recently-deleted ID.
const runId = () => Math.random().toString(36).slice(2, 8);

// Project create + LRO polling routinely takes 30-90s; pad generously.
const TIMEOUT = { timeout: 600_000 };

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "create and delete project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;

      const project = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Project("Smoke", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID },
            displayName: "alchemy smoke",
          });
        }),
      );

      expect(project.projectId).toBe(projectId);
      expect(project.state).toBe("ACTIVE");
      expect(project.parent).toBe(`folders/${FOLDER_ID}`);
      // Internal labels must be applied so `read` recognises ownership.
      expect(project.labels.alchemy_app).toBeDefined();
      expect(project.labels.alchemy_stage).toBe("test");
      expect(project.labels.alchemy_id).toBeDefined();

      const fetched = yield* crm.getProjects({
        name: `projects/${projectId}`,
      });
      expect(fetched.projectId).toBe(projectId);
      expect(fetched.state).toBe("ACTIVE");
      expect(fetched.labels?.alchemy_id).toBe(project.labels.alchemy_id);

      yield* stack.destroy();
    }),
  TIMEOUT,
);

test.provider(
  "create, update displayName, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const projectId = `alchemy-test-${runId()}`;

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Project("Update", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID },
            displayName: "initial",
          });
        }),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Project("Update", {
            projectId,
            parent: { type: "folder", id: FOLDER_ID },
            displayName: "updated",
          });
        }),
      );

      expect(updated.projectId).toBe(projectId);
      expect(updated.displayName).toBe("updated");

      // Verify the patch landed server-side, not just in attributes.
      const fetched = yield* crm.getProjects({
        name: `projects/${projectId}`,
      });
      expect(fetched.displayName).toBe("updated");

      yield* stack.destroy();
    }),
  TIMEOUT,
);
