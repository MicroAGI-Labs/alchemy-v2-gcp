import * as compute from "@distilled.cloud/gcp/compute-v1";
import { Resource } from "alchemy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import type * as GCP from "../Providers.ts";
import { makeAwaitGlobalOperation } from "./Operations.ts";

/**
 * Attach a service project to a Shared VPC **host**. Once attached,
 * resources in the service project (clusters, VMs) can use VPCs and
 * subnets owned by the host project.
 *
 * Identity: `(hostProject, serviceProject)`. Both are immutable —
 * changing either replaces. Read uses
 * `compute.projects.getXpnHost({ project: serviceProject })`, which
 * returns the host the service project is attached to (or 4xx if
 * unattached). When the returned host name matches `hostProject`, the
 * attachment is present.
 *
 * The host project must already be enabled (`GCP.SharedVpcHost`), and
 * the IAM principal running the deploy needs `compute.xpnAdmin` at the
 * organisation or folder level — that role is what authorises both
 * sides of the attach (the host, owned by infra; the service project,
 * owned by the team consuming the VPC).
 *
 * @example
 * ```typescript
 * const host = yield* GCP.SharedVpcHost("ResearchHost", { project: hostProject.projectId });
 * yield* GCP.SharedVpcServiceProject("AttachGkeProj", {
 *   hostProject: host.project,
 *   serviceProject: gkeProject.projectId,
 * });
 * ```
 */
export type SharedVpcServiceProjectProps = {
  /** Shared VPC host project ID. Immutable — replace. */
  hostProject: string;
  /** Service project ID to attach. Immutable — replace. */
  serviceProject: string;
};

export type SharedVpcServiceProjectAttributes = {
  /** Host project ID. */
  hostProject: string;
  /** Service project ID. */
  serviceProject: string;
};

export type SharedVpcServiceProject = Resource<
  "GCP.SharedVpcServiceProject",
  SharedVpcServiceProjectProps,
  SharedVpcServiceProjectAttributes,
  never,
  GCP.Providers
>;
export const SharedVpcServiceProject = Resource<SharedVpcServiceProject>(
  "GCP.SharedVpcServiceProject",
);

export const SharedVpcServiceProjectProvider = () =>
  Provider.effect(
    SharedVpcServiceProject,
    Effect.gen(function* () {
      const getXpnHostProjects = yield* compute.getXpnHostProjects;
      const enableXpnResource = yield* compute.enableXpnResourceProjects;
      const disableXpnResource = yield* compute.disableXpnResourceProjects;
      const getGlobalOperations = yield* compute.getGlobalOperations;
      const awaitOp = makeAwaitGlobalOperation(getGlobalOperations);

      // Observed-host name from a service project's perspective.
      // Returns the host project's `name`/`projectId` — or undefined
      // if the service project isn't attached anywhere. GCP returns
      // 404 in that case; some SDK paths return a `Project` with
      // empty fields instead, so we coalesce both.
      const observeHost = (serviceProject: string) =>
        getXpnHostProjects({ project: serviceProject }).pipe(
          // Three "not attached" shapes observed:
          //   - 404 NotFound (catchTag below)
          //   - 200 with a `Project` whose name/id are empty
          //   - 200 with an undefined body (no Project payload at all)
          // Coalesce all three to `undefined`.
          Effect.map((p) => p?.name ?? p?.id ?? undefined),
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as string | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as string | undefined),
          ),
        );

      const isAttached = Effect.fn(function* (
        hostProject: string,
        serviceProject: string,
      ) {
        const observed = yield* observeHost(serviceProject);
        if (!observed) return false;
        // Host references can come back as the bare project ID, the
        // numeric ID, or `projects/{id}` — match suffix to avoid
        // missing on format drift.
        return (
          observed === hostProject ||
          observed.endsWith(`/${hostProject}`) ||
          observed.endsWith(`projects/${hostProject}`)
        );
      });

      const enable = Effect.fn(function* (args: {
        hostProject: string;
        serviceProject: string;
        session: ScopedPlanStatusSession;
      }) {
        const op = yield* enableXpnResource({
          project: args.hostProject,
          body: {
            xpnResource: { type: "PROJECT", id: args.serviceProject },
          },
        }).pipe(
          Effect.catchTag("Conflict", () =>
            Effect.succeed(undefined as compute.Operation | undefined),
          ),
        );
        if (op?.name) yield* awaitOp(args.hostProject, op.name, args.session);
      });

      return {
        stables: ["hostProject", "serviceProject"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            (olds.hostProject !== undefined &&
              olds.hostProject !== news.hostProject) ||
            (olds.serviceProject !== undefined &&
              olds.serviceProject !== news.serviceProject)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const attached = yield* isAttached(news.hostProject, news.serviceProject);
          if (!attached) {
            yield* enable({
              hostProject: news.hostProject,
              serviceProject: news.serviceProject,
              session,
            });
          }
          return {
            hostProject: news.hostProject,
            serviceProject: news.serviceProject,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* disableXpnResource({
            project: output.hostProject,
            body: {
              xpnResource: { type: "PROJECT", id: output.serviceProject },
            },
          }).pipe(
            Effect.flatMap((op) =>
              op.name
                ? awaitOp(output.hostProject, op.name, session)
                : Effect.succeed(op),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
            // `BadRequest` covers "not attached to this host" (idempotent
            // detach); other 400s (resources still using shared subnets)
            // propagate so the user sees the real precondition.
            Effect.catchTag("BadRequest", (e) =>
              /not.*service.*project|not.*xpn|UNSPECIFIED_XPN_PROJECT_STATUS|not.*attached/i.test(
                e.message ?? "",
              )
                ? Effect.void
                : Effect.fail(e),
            ),
          );
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const hostProject = output?.hostProject ?? olds?.hostProject;
          const serviceProject = output?.serviceProject ?? olds?.serviceProject;
          if (!hostProject || !serviceProject) return undefined;
          const attached = yield* isAttached(hostProject, serviceProject);
          if (!attached) return undefined;
          return { hostProject, serviceProject };
        }),
      };
    }),
  );
