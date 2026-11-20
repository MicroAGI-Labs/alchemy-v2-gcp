import * as compute from "@distilled.cloud/gcp/compute_v1";
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

type Api = {
  getXpnHost: Effect.Success<typeof compute.getXpnHostProjects>;
  enableXpnResource: Effect.Success<typeof compute.enableXpnResourceProjects>;
  disableXpnResource: Effect.Success<typeof compute.disableXpnResourceProjects>;
  getGlobalOperation: Effect.Success<typeof compute.getGlobalOperations>;
};

/**
 * 400 wordings GCP uses when the service project is not (or no longer)
 * attached to the host. `disableXpnResource` answers with
 * "Invalid resource usage: 'The resource 'projects/{svc}' is not linked
 * to shared VPC host 'projects/{host}'.'" when the attachment is already
 * gone. Every other 400 (for example resources in the service project
 * still using the host's subnets) must propagate.
 */
const NOT_ATTACHED_400 =
  /not linked to shared VPC host|not.*service.*project|not.*xpn|UNSPECIFIED_XPN_PROJECT_STATUS|not.*attached/i;

/** Exported for isolated lifecycle tests; production uses the same handlers. */
export const sharedVpcServiceProjectLifecycle = (
  api: Api,
): Provider.ProviderServiceInput<SharedVpcServiceProject> => {
  const awaitOp = makeAwaitGlobalOperation(api.getGlobalOperation);

  // Observed-host name from a service project's perspective.
  // Returns the host project's `name`/`projectId` — or undefined
  // if the service project isn't attached anywhere. GCP returns
  // 404 in that case; some SDK paths return a `Project` with
  // empty fields instead, so we coalesce both. `Forbidden` is left
  // to the caller: `read` treats it as absent, `delete` as unknown.
  const observeHost = (serviceProject: string) =>
    api.getXpnHost({ project: serviceProject }).pipe(
      // Three "not attached" shapes observed:
      //   - 404 NotFound (catchTag below)
      //   - 200 with a `Project` whose name/id are empty
      //   - 200 with an undefined body (no Project payload at all)
      // Coalesce all three to `undefined`.
      Effect.map((p) => p?.name ?? p?.id ?? undefined),
      Effect.catchTag("NotFound", () =>
        Effect.succeed(undefined as string | undefined),
      ),
    );

  const attachedTo = (hostProject: string, observed: string | undefined) =>
    // Host references can come back as the bare project ID, the
    // numeric ID, or `projects/{id}` — match suffix to avoid
    // missing on format drift.
    !!observed &&
    (observed === hostProject ||
      observed.endsWith(`/${hostProject}`) ||
      observed.endsWith(`projects/${hostProject}`));

  // `ifForbidden` is what a 403 on the lookup counts as: absent for
  // `read`/`reconcile` (as before), attached for `delete`, so a missing
  // permission never skips the detach silently.
  const isAttached = (
    hostProject: string,
    serviceProject: string,
    ifForbidden = false,
  ) =>
    observeHost(serviceProject).pipe(
      Effect.map((observed) => attachedTo(hostProject, observed)),
      Effect.catchTag("Forbidden", () => Effect.succeed(ifForbidden)),
    );

  const enable = Effect.fn(function* (args: {
    hostProject: string;
    serviceProject: string;
    session: ScopedPlanStatusSession;
  }) {
    const op = yield* api
      .enableXpnResource({
        project: args.hostProject,
        body: {
          xpnResource: { type: "PROJECT", id: args.serviceProject },
        },
      })
      .pipe(
        Effect.catchTag("Conflict", () =>
          Effect.succeed(undefined as compute.Operation | undefined),
        ),
      );
    if (op?.name) yield* awaitOp(args.hostProject, op.name, args.session);
  });

  return {
    nuke: { skip: true },
    list: () => Effect.succeed([]),
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
      // Idempotent delete: if the service project is no longer attached
      // to this host (detached out of band, or by an earlier interrupted
      // destroy), there is nothing to do. Same check `read` uses, except
      // that a 403 on the lookup means "unknown", so we still attempt the
      // detach and let its own error surface instead of silently
      // dropping the attachment from state.
      const attached = yield* isAttached(
        output.hostProject,
        output.serviceProject,
        true,
      );
      if (!attached) return;
      const disabling = api
        .disableXpnResource({
          project: output.hostProject,
          body: {
            xpnResource: { type: "PROJECT", id: output.serviceProject },
          },
        })
        .pipe(
          Effect.flatMap((op) =>
            op.name
              ? awaitOp(output.hostProject, op.name, session)
              : Effect.succeed(op),
          ),
        );
      yield* disabling.pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        // `BadRequest` covers "not attached to this host" when the detach
        // races another one after the check above; other 400s (resources
        // still using shared subnets) propagate so the user sees the real
        // precondition.
        Effect.catchTag("BadRequest", (e) =>
          NOT_ATTACHED_400.test(e.message ?? "") ? Effect.void : Effect.fail(e),
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
};

export const SharedVpcServiceProjectProvider = () =>
  Provider.effect(
    SharedVpcServiceProject,
    Effect.gen(function* () {
      return sharedVpcServiceProjectLifecycle({
        getXpnHost: yield* compute.getXpnHostProjects,
        enableXpnResource: yield* compute.enableXpnResourceProjects,
        disableXpnResource: yield* compute.disableXpnResourceProjects,
        getGlobalOperation: yield* compute.getGlobalOperations,
      });
    }),
  );
