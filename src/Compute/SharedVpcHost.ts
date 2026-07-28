import * as compute from "@distilled.cloud/gcp/compute-v1";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import type * as GCP from "../Providers.ts";
import { makeAwaitGlobalOperation } from "./Operations.ts";

/**
 * Mark a GCP project as a Shared VPC **host**. Service projects can
 * then attach to this host via `GCP.SharedVpcServiceProject` and use
 * its VPC for clusters, VMs, etc.
 *
 * Identity: `(project)` — there's at most one host-status flag per
 * project, so the resource is keyed by project ID alone. State is
 * binary (host or not host), so there's no ownership concept; `read`
 * returns plain attrs whenever the project's
 * `xpnProjectStatus === "HOST"`.
 *
 * The `compute.googleapis.com` API must be enabled on the project
 * before this resource succeeds — wire `project` through an
 * `ApiEnable("compute.googleapis.com")` output to make alchemy
 * sequence this resource after the API enable.
 *
 * @example
 * ```typescript
 * const computeApi = yield* GCP.ApiEnable("HostComputeApi", {
 *   project: hostProject.projectId,
 *   service: "compute.googleapis.com",
 * });
 * const host = yield* GCP.SharedVpcHost("ResearchHost", {
 *   project: computeApi.project,
 * });
 * ```
 */
export type SharedVpcHostProps = {
  /** GCP project ID to mark as a Shared VPC host. Immutable — replace. */
  project: string;
};

export type SharedVpcHostAttributes = {
  /** Project ID. */
  project: string;
  /** `"HOST"` once the enable completes. */
  xpnProjectStatus: string;
};

export type SharedVpcHost = Resource<
  "GCP.SharedVpcHost",
  SharedVpcHostProps,
  SharedVpcHostAttributes,
  never,
  GCP.Providers
>;
export const SharedVpcHost = Resource<SharedVpcHost>("GCP.SharedVpcHost");

export const SharedVpcHostProvider = () =>
  Provider.effect(
    SharedVpcHost,
    Effect.gen(function* () {
      const getProjects = yield* compute.getProjects;
      const enableXpnHostProjects = yield* compute.enableXpnHostProjects;
      const disableXpnHostProjects = yield* compute.disableXpnHostProjects;
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
        nuke: { singleton: true },
        list: () => Effect.succeed([]),
        stables: ["project"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (olds.project !== undefined && olds.project !== news.project) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const observed = yield* observe(news.project);
          if (observed?.xpnProjectStatus === "HOST") {
            return { project: news.project, xpnProjectStatus: "HOST" };
          }
          // `enableXpnHost` is idempotent on the GCP side when the
          // project is already a host (returns a no-op operation), but
          // we still tolerate `Conflict` defensively to cover the
          // narrow window where state-persistence races with another
          // reconciler.
          const op = yield* enableXpnHostProjects({
            project: news.project,
          }).pipe(
            Effect.catchTag("Conflict", () =>
              Effect.succeed(undefined as compute.Operation | undefined),
            ),
          );
          if (op?.name) yield* awaitOp(news.project, op.name, session);
          return { project: news.project, xpnProjectStatus: "HOST" };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const disabling = disableXpnHostProjects({
            project: output.project,
          }).pipe(
            Effect.flatMap((op) =>
              op.name
                ? awaitOp(output.project, op.name, session)
                : Effect.succeed(op),
            ),
          );
          yield* disabling.pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            // `BadRequest` is returned when:
            //   1. The project isn't a host (idempotent disable — fine).
            //   2. Service projects are still attached. The user has
            //      to detach them first; surface that error so they
            //      can act. Only swallow case 1.
            Effect.catchTag("BadRequest", (e) =>
              /not.*host|not.*xpn|UNSPECIFIED_XPN_PROJECT_STATUS/i.test(
                e.message ?? "",
              )
                ? Effect.void
                : Effect.fail(e),
            ),
          );
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const project = output?.project ?? olds?.project;
          if (!project) return undefined;
          const observed = yield* observe(project);
          if (!observed) return undefined;
          if (observed.xpnProjectStatus !== "HOST") return undefined;
          // No labels-based ownership: host status is project-scoped
          // state. Any host project we can see we treat as adopted —
          // mirrors `ApiEnable`'s stance.
          return { project, xpnProjectStatus: "HOST" };
        }),
      };
    }),
  );
