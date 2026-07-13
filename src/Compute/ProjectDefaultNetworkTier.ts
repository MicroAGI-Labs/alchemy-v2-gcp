import * as compute from "@distilled.cloud/gcp/compute-v1";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import type * as GCP from "../Providers.ts";
import { makeAwaitGlobalOperation } from "./Operations.ts";

export type ProjectDefaultNetworkTierProps = {
  /** GCP project whose default network tier is managed. Immutable. */
  project: string;
  /** Default tier applied to newly created Compute resources. */
  networkTier: "PREMIUM" | "STANDARD";
};

export type ProjectDefaultNetworkTierAttributes = {
  project: string;
  networkTier: "PREMIUM" | "STANDARD";
};

export type ProjectDefaultNetworkTier = Resource<
  "GCP.ProjectDefaultNetworkTier",
  ProjectDefaultNetworkTierProps,
  ProjectDefaultNetworkTierAttributes,
  never,
  GCP.Providers
>;
export const ProjectDefaultNetworkTier = Resource<ProjectDefaultNetworkTier>(
  "GCP.ProjectDefaultNetworkTier",
);

/** Manage the Compute Engine project-wide default network service tier. */
export const ProjectDefaultNetworkTierProvider = () =>
  Provider.effect(
    ProjectDefaultNetworkTier,
    Effect.gen(function* () {
      const getProjects = yield* compute.getProjects;
      const setDefaultNetworkTier = yield* compute.setDefaultNetworkTierProjects;
      const getGlobalOperations = yield* compute.getGlobalOperations;
      const awaitOp = makeAwaitGlobalOperation(getGlobalOperations);

      const observe = (project: string) =>
        getProjects({ project }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as compute.Project | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as compute.Project | undefined),
          ),
        );

      return {
        stables: ["project"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (olds.project !== undefined && olds.project !== news.project) {
            return { action: "replace" } as const;
          }

          // This project-scoped setting can drift independently of Alchemy's
          // persisted props (for example through the Cloud Console or gcloud).
          // Existing resources do not pass through `read`, so consult the live
          // project here and force reconcile whenever reality differs.
          const observed = yield* observe(news.project);
          if (observed?.defaultNetworkTier !== news.networkTier) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const observed = yield* observe(news.project);
          if (observed?.defaultNetworkTier !== news.networkTier) {
            const op = yield* setDefaultNetworkTier({
              project: news.project,
              body: { networkTier: news.networkTier },
            });
            if (op.name) yield* awaitOp(news.project, op.name, session);
          }
          return { project: news.project, networkTier: news.networkTier };
        }),
        // Project defaults are shared project-level policy. Removing this
        // declaration must not silently revert the project's selected tier.
        delete: Effect.fn(function* () {
          return yield* Effect.void;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const project = output?.project ?? olds?.project;
          if (!project) return undefined;
          const observed = yield* observe(project);
          if (!observed?.defaultNetworkTier) return undefined;
          if (
            observed.defaultNetworkTier !== "PREMIUM" &&
            observed.defaultNetworkTier !== "STANDARD"
          ) {
            return undefined;
          }
          return { project, networkTier: observed.defaultNetworkTier };
        }),
      };
    }),
  );
