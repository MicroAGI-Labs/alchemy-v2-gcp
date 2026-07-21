import { ConfigError } from "@distilled.cloud/gcp";
import * as su from "@distilled.cloud/gcp/serviceusage-v1";
import { Resource } from "alchemy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as GCP from "../Providers.ts";

/**
 * Enable a Google Cloud API on a project (`serviceusage.googleapis.com`
 * `services.enable`). Required before any operation against the
 * underlying API will succeed — e.g. a fresh `GCP.Project` cannot host
 * a `GCP.Cluster` until `container.googleapis.com` is enabled.
 *
 * The resource is keyed by `(project, service)`; both are immutable —
 * changing either replaces.
 *
 * `delete` calls `services.disable`, which GCP rejects with HTTP 400
 * (`FAILED_PRECONDITION`) if the service is already disabled or has
 * dependent services in use. We treat "already disabled" as success
 * (idempotent teardown). Other 400s propagate so the user sees the
 * real reason (typically: another service depends on this one).
 */
export type ApiEnableProps = {
  /** GCP project ID hosting the API enablement. Immutable — replace. */
  project: string;
  /**
   * Fully-qualified service name, e.g. `container.googleapis.com`,
   * `compute.googleapis.com`, `iam.googleapis.com`. Immutable — replace.
   */
  service: string;
};

export type ApiEnableAttributes = {
  /** GCP project ID, threaded through from props. */
  project: string;
  /** Service name, threaded through from props. */
  service: string;
  /** Resource name in the form `projects/{project}/services/{service}`. */
  name: string;
  /** Lifecycle state — `"ENABLED"` once the LRO completes. */
  state: string;
};

/**
 * @section Enabling APIs
 *
 * **Dependency edges are explicit.** Alchemy sequences resources by the
 * Output references they consume. To make a downstream resource (e.g.
 * `GCP.Cluster`) wait for the API enable, route its `project` prop
 * through `apiEnable.project` rather than `project.projectId`:
 *
 * @example Container API for GKE
 * ```typescript
 * const project = yield* GCP.Project("Research", { ... });
 * const containerApi = yield* GCP.ApiEnable("ContainerApi", {
 *   project: project.projectId,
 *   service: "container.googleapis.com",
 * });
 * const cluster = yield* GCP.Cluster("Main", {
 *   project: containerApi.project, // ← edge through ApiEnable, not Project
 *   location: "us-central1-a",
 *   // ...
 * });
 * ```
 *
 * If the cluster instead read `project.projectId`, alchemy would
 * schedule the cluster create in parallel with the API enable and the
 * GKE call would fail with `Forbidden: <X> API has not been used in
 * project ... before or it is disabled.`
 *
 * @example Multiple APIs on a project
 * ```typescript
 * const containerApi = yield* GCP.ApiEnable("ContainerApi",
 *   { project: project.projectId, service: "container.googleapis.com" });
 * const computeApi = yield* GCP.ApiEnable("ComputeApi",
 *   { project: project.projectId, service: "compute.googleapis.com" });
 * // Then route downstream resources through the API enables that gate them:
 * const cluster = yield* GCP.Cluster("Main", { project: containerApi.project, ... });
 * ```
 */
export type ApiEnable = Resource<
  "GCP.ApiEnable",
  ApiEnableProps,
  ApiEnableAttributes,
  never,
  GCP.Providers
>;

export const ApiEnable = Resource<ApiEnable>("GCP.ApiEnable");

const fqServiceName = (project: string, service: string) =>
  `projects/${project}/services/${service}`;

export const ApiEnableProvider = () =>
  Provider.effect(
    ApiEnable,
    Effect.gen(function* () {
      const getServices = yield* su.getServices;
      const enableServices = yield* su.enableServices;
      const disableServices = yield* su.disableServices;
      const getOperations = yield* su.getOperations;

      // Service Usage `Operation` carries `.done: boolean` (matching CRM,
      // NOT Container's `.status: "DONE"`), so we can't reuse the
      // Container `makeAwaitOperation`. Mirror Project.ts's polling
      // schedule (cheap polls for fast LROs; service enable usually
      // resolves in <30s).
      const awaitOperation = Effect.fn(function* (
        operationName: string,
        session: ScopedPlanStatusSession,
      ) {
        const op = yield* getOperations({ name: operationName }).pipe(
          Effect.flatMap((current) =>
            current.done === true
              ? Effect.succeed(current)
              : Effect.fail({ _tag: "OperationPending" as const }),
          ),
          Effect.retry({
            while: (e: { _tag?: string }) => e?._tag === "OperationPending",
            schedule: Schedule.max([
              Schedule.min([
                Schedule.exponential(Duration.seconds(1), 1.5),
                Schedule.spaced(Duration.seconds(15)),
              ]),
              Schedule.recurs(60),
            ]).pipe(
              Schedule.tap(() =>
                session.note(`Waiting for ServiceUsage operation ${operationName}…`),
              ),
            ),
          }),
        );
        if (op.error) {
          return yield* new ConfigError({
            message: `ServiceUsage operation ${operationName} failed: ${
              op.error.message ?? JSON.stringify(op.error)
            }`,
          });
        }
        return op;
      });

      return {
        // No physical-name generation: identity is `(project, service)`.
        // Both are static strings on `news`/`olds`/`output`.
        stables: ["project", "service", "name"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            (olds.project !== undefined && olds.project !== news.project) ||
            (olds.service !== undefined && olds.service !== news.service)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const name = fqServiceName(news.project, news.service);

          // `getServices` returns the service entity even when disabled
          // (state="DISABLED"), so 404 here means an invalid service
          // name, not "not enabled". Treat NotFound and Forbidden as
          // "needs enable attempt" — the enable call will surface the
          // real error.
          let observed = yield* getServices({ name }).pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed(undefined as su.GoogleApiServiceusageV1Service | undefined),
            ),
            Effect.catchTag("Forbidden", () =>
              Effect.succeed(undefined as su.GoogleApiServiceusageV1Service | undefined),
            ),
          );

          if (!observed || observed.state !== "ENABLED") {
            // `Conflict` here covers concurrent enable / state-persistence
            // race; fall through and re-observe.
            const op = yield* enableServices({ name, body: {} }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as su.Operation | undefined),
              ),
            );
            if (op?.name) yield* awaitOperation(op.name, session);
            observed = yield* getServices({ name });
          }

          return {
            project: news.project,
            service: news.service,
            name: observed.name ?? name,
            state: observed.state ?? "ENABLED",
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const name = fqServiceName(output.project, output.service);
          yield* disableServices({
            name,
            body: { disableDependentServices: false },
          }).pipe(
            Effect.flatMap((op) =>
              op.name ? awaitOperation(op.name, session) : Effect.succeed(op),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
            // GCP returns HTTP 400 in two important cases on disable
            // that we treat as idempotent success:
            //
            // 1. Service already disabled. The resource is gone from
            //    the user's perspective; alchemy is removing it from
            //    state.
            //
            // 2. "Resources are found when disabling service(s) X.
            //    Before you can disable, please delete the following
            //    resources first: …" — this is GCP's eventual-
            //    consistency lag: a sibling resource (cluster, node
            //    pool) was deleted via its own API but ServiceUsage's
            //    "what's still using this service" view hasn't
            //    propagated yet. The cluster is gone; alchemy state is
            //    being torn down; if the project itself is also being
            //    destroyed (the typical case in `stack.destroy`), all
            //    API state goes with it. Failing here would leave a
            //    half-torn-down stack the user has to clean up by
            //    hand.
            //
            // Other 400s (e.g. dependent *services* still enabled, or
            // a true API-level rejection) propagate so the user sees
            // the real failure.
            Effect.catchTag("BadRequest", (e) =>
              /already.*disabled|not.*currently enabled|FAILED_PRECONDITION|Resources are found/i.test(
                e.message ?? "",
              )
                ? Effect.void
                : Effect.fail(e),
            ),
          );
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const project = output?.project ?? olds?.project;
          const service = output?.service ?? olds?.service;
          if (!project || !service) return undefined;
          const name = fqServiceName(project, service);
          const observed = yield* getServices({ name }).pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed(undefined as su.GoogleApiServiceusageV1Service | undefined),
            ),
            Effect.catchTag("Forbidden", () =>
              Effect.succeed(undefined as su.GoogleApiServiceusageV1Service | undefined),
            ),
          );
          if (!observed) return undefined;
          // A DISABLED service is functionally absent from this
          // resource's perspective — the engine treats `undefined` as
          // "needs reconcile" and the next plan will re-enable.
          if (observed.state !== "ENABLED") return undefined;
          // No `alchemy_*` ownership labels available on services
          // (no labels field), so we can't gate via `Unowned`.
          // API enablement is project-scoped state, not a labeled
          // resource — adoption is fine: any project we can read from
          // has the API enabled regardless of who turned it on.
          return {
            project,
            service,
            name: observed.name ?? name,
            state: observed.state,
          };
        }),
      };
    }),
  );
