import { ConfigError } from "@distilled.cloud/gcp";
import * as cont from "@distilled.cloud/gcp/container-v1";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Qualify a GKE operation name. The Container API returns
 * `Operation.name` as a bare ID like `operation-1778057673333-...`,
 * but `getProjectsLocationsOperations` expects the fully-qualified
 * path `projects/{p}/locations/{l}/operations/{id}`. Already-qualified
 * names are passed through unchanged so callers can stay agnostic.
 *
 * (CRM operations don't need this because CRM returns names as
 * `operations/...` and its `getOperations` takes the bare path
 * directly.)
 */
export const qualifyOperationName = (
  project: string,
  location: string,
  name: string,
): string =>
  name.startsWith("projects/")
    ? name
    : `projects/${project}/locations/${location}/operations/${name}`;

/**
 * Resolved callable signature of `cont.getProjectsLocationsOperations`.
 *
 * `cont.getProjectsLocationsOperations` is itself an
 * `Effect<callable, never, Credentials | HttpClient>`, so `Effect.Success`
 * extracts the callable type — i.e. what you get back from
 * `yield* cont.getProjectsLocationsOperations`. Using a derived alias
 * keeps the helper aligned with the SDK without us hand-writing the
 * input/output/error union, which would drift if the patch set changes.
 */
type GetOperations = Effect.Success<typeof cont.getProjectsLocationsOperations>;

/**
 * Build the GKE long-running-operation polling helper.
 *
 * Container `Operation`s carry `.status: "PENDING" | "RUNNING" | "DONE"
 * | "ABORTING"` (NOT `.done: boolean` like Cloud Resource Manager —
 * verified at `vendor/distilled/packages/gcp/src/services/container-v1.ts:919–976`).
 * The doneness predicate compares `.status === "DONE"` accordingly.
 *
 * Schedule: exponential 2s → 1.5× growth, capped per-poll at 15s via
 * `Schedule.either`, then a hard count cap of 80 retries via
 * `Schedule.both(Schedule.recurs(80))` → ~20 min wall ceiling, well
 * above the worst observed GKE op time (cluster create runs 5–10 min).
 *
 * The helper is a factory — the caller resolves
 * `cont.getProjectsLocationsOperations` once at provider construction
 * (see `Project.ts` for the same idiom) and passes the resulting
 * callable here, so we never re-resolve services on each await.
 */
export const makeAwaitOperation = (getOperations: GetOperations) =>
  Effect.fn(function* (
    operationName: string,
    session: ScopedPlanStatusSession,
  ) {
    const op = yield* getOperations({ name: operationName }).pipe(
      Effect.flatMap((current) =>
        current.status === "DONE"
          ? Effect.succeed(current)
          : Effect.fail({ _tag: "OperationPending" as const }),
      ),
      Effect.retry({
        while: (e: { _tag?: string }) => e?._tag === "OperationPending",
        schedule: Schedule.exponential(Duration.seconds(2), 1.5).pipe(
          Schedule.either(Schedule.spaced(Duration.seconds(15))),
          Schedule.both(Schedule.recurs(80)),
          Schedule.tapOutput(() =>
            session.note(`Waiting for GKE operation ${operationName}…`),
          ),
        ),
      }),
    );
    if (op.error) {
      return yield* new ConfigError({
        message: `GKE operation ${operationName} failed: ${
          op.error.message ?? JSON.stringify(op.error)
        }`,
      });
    }
    return op;
  });
