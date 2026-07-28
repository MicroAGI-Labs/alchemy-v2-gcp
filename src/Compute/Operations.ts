import { ConfigError } from "@distilled.cloud/gcp";
import * as compute from "@distilled.cloud/gcp/compute-v1";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Resolved callable signatures for the compute LRO getters. We hold both
 * — global resources (networks, addresses with `addressType=INTERNAL`
 * `purpose=VPC_PEERING`) emit Operations under
 * `projects/{p}/global/operations/{op}`, while regional resources
 * (subnetworks) emit Operations under
 * `projects/{p}/regions/{r}/operations/{op}`. The `Operation.name`
 * returned by the create/update/delete calls is a *bare* id (e.g.
 * `operation-1700000000000-...`); callers thread back project (and
 * region) at the await site.
 */
type GetGlobalOperations = Effect.Success<typeof compute.getGlobalOperations>;
type GetRegionOperations = Effect.Success<typeof compute.getRegionOperations>;

const formatOperationError = (op: compute.Operation): string => {
  const errors = op.error?.errors ?? [];
  if (errors.length === 0) return JSON.stringify(op.error ?? {});
  return errors
    .map((e) => `${e.code ?? "?"}${e.location ? ` @ ${e.location}` : ""}: ${e.message ?? "?"}`)
    .join("; ");
};

const isDone = (op: compute.Operation): boolean => op.status === "DONE";

const pollSchedule = (label: string, session: ScopedPlanStatusSession) =>
  Schedule.max([
    Schedule.min([
      Schedule.exponential(Duration.seconds(2), 1.5),
      Schedule.spaced(Duration.seconds(15)),
    ]),
    // 80 × ≤15s ≈ 20 min — long enough for a network create (~1 min),
    // a parallelstore-adjacent global op, or a 10-minute parallelstore
    // delete (longest LRO observed in this provider's surface).
    Schedule.recurs(80),
  ]).pipe(
    Schedule.tap(() =>
      session.note(`Waiting for Compute operation ${label}…`),
    ),
  );

/**
 * Build a poller for compute global operations
 * (`projects/{p}/global/operations/{op}`). Same exponential-then-spaced
 * schedule as the GKE poller.
 */
export const makeAwaitGlobalOperation = (getGlobalOperations: GetGlobalOperations) =>
  Effect.fn(function* (
    project: string,
    operationName: string,
    session: ScopedPlanStatusSession,
  ) {
    const label = `${project}/global/${operationName}`;
    const op = yield* getGlobalOperations({ project, operation: operationName }).pipe(
      Effect.flatMap((current) =>
        isDone(current)
          ? Effect.succeed(current)
          : Effect.fail({ _tag: "OperationPending" as const }),
      ),
      Effect.retry({
        while: (e: { _tag?: string }) => e?._tag === "OperationPending",
        schedule: pollSchedule(label, session),
      }),
    );
    if (op.error) {
      return yield* new ConfigError({
        message: `Compute global operation ${operationName} failed: ${formatOperationError(op)}`,
      });
    }
    return op;
  });

/**
 * Build a poller for compute regional operations
 * (`projects/{p}/regions/{r}/operations/{op}`).
 */
export const makeAwaitRegionOperation = (getRegionOperations: GetRegionOperations) =>
  Effect.fn(function* (
    project: string,
    region: string,
    operationName: string,
    session: ScopedPlanStatusSession,
  ) {
    const label = `${project}/${region}/${operationName}`;
    const op = yield* getRegionOperations({
      project,
      region,
      operation: operationName,
    }).pipe(
      Effect.flatMap((current) =>
        isDone(current)
          ? Effect.succeed(current)
          : Effect.fail({ _tag: "OperationPending" as const }),
      ),
      Effect.retry({
        while: (e: { _tag?: string }) => e?._tag === "OperationPending",
        schedule: pollSchedule(label, session),
      }),
    );
    if (op.error) {
      return yield* new ConfigError({
        message: `Compute region operation ${operationName} failed: ${formatOperationError(op)}`,
      });
    }
    return op;
  });
