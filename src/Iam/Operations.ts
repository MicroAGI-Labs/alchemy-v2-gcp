import { ConfigError } from "@distilled.cloud/gcp";
import type * as iam from "@distilled.cloud/gcp/unstable/iam-v1";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Resolved callable signature of an `iam-v1` operations getter.
 *
 * Workload Identity pools and providers each have their own operations
 * collection (`…WorkloadIdentityPoolsOperations`,
 * `…WorkloadIdentityPoolsProvidersOperations`) rather than one shared
 * endpoint, so this is generic over the getter and each resource passes its
 * own — the same factory shape `ArtifactRegistry/Operations.ts` uses.
 */
type GetOperations = Effect.Success<
  typeof iam.getProjectsLocationsWorkloadIdentityPoolsOperations
>;

/**
 * Build the IAM long-running-operation polling helper.
 *
 * `iam-v1` operations use the standard `google.longrunning.Operation` shape —
 * doneness is `.done === true` and failure is a populated `.error` (NOT
 * Container's `.status === "DONE"`, and NOT Sqladmin's tri-state `.status`).
 * Verified against the `Operation` interface in
 * `vendor/distilled/packages/gcp/src/unstable-services/iam-v1.ts`.
 *
 * Operation names returned by pool/provider create and delete are already
 * fully qualified (`projects/{p}/locations/global/workloadIdentityPools/{id}/operations/{op}`),
 * so callers pass them straight through — no qualify dance.
 *
 * Schedule: exponential 1s → 1.5× growth, capped per-poll at 10s via
 * `Schedule.min`, then a hard count cap of 60 retries via `Schedule.max`
 * → ~10 min wall ceiling. Pool and provider CRUD normally settles in
 * seconds; the ceiling exists so a stuck operation surfaces as an error
 * rather than hanging a deploy indefinitely.
 *
 * The helper is a factory — the caller resolves the operations getter once at
 * provider construction and passes the resulting callable here, so we never
 * re-resolve services on each await.
 */
export const makeAwaitOperation = (
  getOperations: GetOperations,
  label: string,
) =>
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
            session.note(`Waiting for ${label} operation ${operationName}…`),
          ),
        ),
      }),
    );
    if (op.error) {
      return yield* new ConfigError({
        message: `${label} operation ${operationName} failed: ${
          op.error.message ?? JSON.stringify(op.error)
        }`,
      });
    }
    return op;
  });
