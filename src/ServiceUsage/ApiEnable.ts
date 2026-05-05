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
 * @example Container API for GKE
 * ```typescript
 * const project = yield* GCP.Project("Research", { ... });
 * const containerApi = yield* GCP.ApiEnable("ContainerApi", {
 *   project: project.projectId,
 *   service: "container.googleapis.com",
 * });
 * const cluster = yield* GCP.Cluster("Main", {
 *   project: project.projectId,
 *   location: "us-central1-a",
 *   // alchemy will resolve `containerApi` before the cluster reconciles
 *   // because the cluster depends on `project.projectId` and the user
 *   // wires the API as an explicit dependency by referencing it.
 *   ...
 * });
 * ```
 *
 * @example Multiple APIs on a project
 * ```typescript
 * yield* GCP.ApiEnable("ContainerApi", { project, service: "container.googleapis.com" });
 * yield* GCP.ApiEnable("ComputeApi", { project, service: "compute.googleapis.com" });
 * yield* GCP.ApiEnable("IamApi", { project, service: "iam.googleapis.com" });
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
            schedule: Schedule.exponential(Duration.seconds(1), 1.5).pipe(
              Schedule.either(Schedule.spaced(Duration.seconds(15))),
              Schedule.both(Schedule.recurs(60)),
              Schedule.tapOutput(() =>
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
            // GCP returns HTTP 400 (`FAILED_PRECONDITION`) when the
            // service is already disabled. Treat as idempotent success.
            // Other 400s (e.g. dependent services still enabled)
            // propagate so the user sees the real failure.
            Effect.catchTag("BadRequest", (e) =>
              /already.*disabled|not.*currently enabled|FAILED_PRECONDITION/i.test(
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
