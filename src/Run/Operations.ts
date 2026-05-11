import { ConfigError } from "@distilled.cloud/gcp";
import * as run from "@distilled.cloud/gcp/run-v2";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Resolved callable signature of `run.getProjectsLocationsOperations`.
 *
 * `run.getProjectsLocationsOperations` is itself an
 * `Effect<callable, never, Credentials | HttpClient>`, so `Effect.Success`
 * extracts the callable type — what you get back from
 * `yield* run.getProjectsLocationsOperations`. Using a derived alias
 * keeps the helper aligned with the SDK without us hand-writing the
 * input/output/error union, which would drift if the patch set changes.
 */
type GetOperations = Effect.Success<typeof run.getProjectsLocationsOperations>;

/**
 * Build the Cloud Run long-running-operation polling helper.
 *
 * Cloud Run `Operation`s use the standard `GoogleLongrunningOperation`
 * shape — doneness is `.done === true` (NOT `.status === "DONE"` like
 * the GKE Container API). Verified at
 * `vendor/distilled/packages/gcp/src/services/run-v2.ts:2880–2900`.
 *
 * Operation names returned by run-v2 (`createProjectsLocationsServices`,
 * `patchProjectsLocationsServices`, `deleteProjectsLocationsServices`)
 * are already fully qualified
 * (`projects/{p}/locations/{l}/operations/{id}`), so callers pass them
 * straight through to `getProjectsLocationsOperations` — no `qualifyOp`
 * dance needed (unlike Container, which returns bare ids).
 *
 * Schedule: exponential 1s → 1.5× growth, capped per-poll at 10s via
 * `Schedule.either`, then a hard count cap of 60 retries via
 * `Schedule.both(Schedule.recurs(60))` → ~10 min wall ceiling. Cloud
 * Run create/patch typically completes in seconds to a couple minutes,
 * with the long pole being container image pulls.
 *
 * The helper is a factory — the caller resolves
 * `run.getProjectsLocationsOperations` once at provider construction
 * (see `Container/Operations.ts` for the same idiom) and passes the
 * resulting callable here, so we never re-resolve services on each
 * await.
 */
export const makeAwaitOperation = (getOperations: GetOperations) =>
  Effect.fn(function* (
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
          Schedule.either(Schedule.spaced(Duration.seconds(10))),
          Schedule.both(Schedule.recurs(60)),
          Schedule.tapOutput(() =>
            session.note(`Waiting for Cloud Run operation ${operationName}…`),
          ),
        ),
      }),
    );
    if (op.error) {
      return yield* new ConfigError({
        message: `Cloud Run operation ${operationName} failed: ${
          op.error.message ?? JSON.stringify(op.error)
        }`,
      });
    }
    return op;
  });
