import { ConfigError } from "@distilled.cloud/gcp";
import * as sql from "@distilled.cloud/gcp/sqladmin-v1";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Resolved callable signature of `sql.getOperations`.
 *
 * `sql.getOperations` is itself an `Effect<callable, never, Credentials |
 * HttpClient>`, so `Effect.Success` extracts the callable. Using a
 * derived alias keeps the helper aligned with the SDK without us
 * hand-writing the input/output/error union, which would drift if the
 * patch set changes.
 */
type GetOperations = Effect.Success<typeof sql.getOperations>;

/**
 * Build the Cloud SQL Admin long-running-operation polling helper.
 *
 * Sqladmin `Operation`s carry `.status: "PENDING" | "RUNNING" | "DONE"`
 * (NOT `.done: boolean` like Cloud Resource Manager / Cloud Run, and
 * NOT `.status === "DONE"` against a different enum). Verified at
 * `vendor/distilled/packages/gcp/src/services/sqladmin-v1.ts:606–612`.
 *
 * Unlike Cloud Run, Sqladmin operations are NOT fully-qualified path
 * names — the API returns a bare operation id (e.g. `e9e88dca-...`),
 * and `getOperations` takes `{ project, operation }`. Callers therefore
 * pass the bare id alongside the parent project context.
 *
 * Schedule: exponential 1s → 1.5× growth, capped via the count cap of
 * 60 retries → roughly a few minutes wall ceiling. Most Cloud SQL
 * operations (CREATE_USER, CREATE_DATABASE, UPDATE settings) finish
 * in 1–30 s; instance CREATE / patch involving a restart are the long
 * pole at 4–10 min, so callers running those should be aware that
 * recurs(60) may bottom out and surface as a retry budget exhaustion.
 *
 * @see https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/operations
 */
export const makeAwaitOperation = (getOperations: GetOperations) =>
  Effect.fn(function* (
    project: string,
    operationName: string,
    session: ScopedPlanStatusSession,
  ) {
    const op = yield* getOperations({ project, operation: operationName }).pipe(
      Effect.flatMap((current) =>
        current.status === "DONE"
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
            session.note(`Waiting for Cloud SQL operation ${operationName}…`),
          ),
        ),
      }),
    );
    if (op.error) {
      const firstErr = op.error.errors?.[0];
      return yield* new ConfigError({
        message: `Cloud SQL operation ${operationName} failed: ${
          firstErr?.message ?? JSON.stringify(op.error)
        }`,
      });
    }
    return op;
  });
