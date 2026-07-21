import { ConfigError } from "@distilled.cloud/gcp";
import * as ar from "@distilled.cloud/gcp/artifactregistry-v1";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Resolved callable signature of `ar.getProjectsLocationsOperations`.
 *
 * `ar.getProjectsLocationsOperations` is itself an
 * `Effect<callable, never, Credentials | HttpClient>`, so
 * `Effect.Success` extracts the callable type. Using a derived alias
 * keeps the helper aligned with the SDK without us hand-writing the
 * input/output/error union, which would drift if the patch set changes.
 */
type GetOperations = Effect.Success<typeof ar.getProjectsLocationsOperations>;

/**
 * Build the Artifact Registry long-running-operation polling helper.
 *
 * Artifact Registry `Operation`s use the standard
 * `GoogleLongrunningOperation` shape — doneness is `.done === true`
 * (NOT `.status === "DONE"` like the GKE Container API and NOT
 * Sqladmin's tri-state `.status`). Verified at
 * `vendor/distilled/packages/gcp/src/services/artifactregistry-v1.ts:308–328`.
 *
 * Operation names returned by `artifactregistry-v1`
 * (`createProjectsLocationsRepositories`,
 * `patchProjectsLocationsRepositories`,
 * `deleteProjectsLocationsRepositories`) are already fully qualified
 * (`projects/{p}/locations/{l}/operations/{id}`), so callers pass them
 * straight through to `getProjectsLocationsOperations` — no qualify
 * dance needed (unlike Container, which returns bare ids).
 *
 * Schedule: exponential 1s → 1.5× growth, capped per-poll at 10s via
 * `Schedule.min`, then a hard count cap of 60 retries via `Schedule.max`
 * → ~10 min wall
 * ceiling. Repository CRUD is fast (seconds); the only long-running
 * case is a delete on a repository with many cached images, where AR
 * has to GC the underlying blobs.
 *
 * The helper is a factory — the caller resolves
 * `ar.getProjectsLocationsOperations` once at provider construction
 * and passes the resulting callable here, so we never re-resolve
 * services on each await.
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
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential(Duration.seconds(1), 1.5),
            Schedule.spaced(Duration.seconds(10)),
          ]),
          Schedule.recurs(60),
        ]).pipe(
          Schedule.tap(() =>
            session.note(
              `Waiting for Artifact Registry operation ${operationName}…`,
            ),
          ),
        ),
      }),
    );
    if (op.error) {
      return yield* new ConfigError({
        message: `Artifact Registry operation ${operationName} failed: ${
          op.error.message ?? JSON.stringify(op.error)
        }`,
      });
    }
    return op;
  });
