import { ConfigError } from "@distilled.cloud/gcp";
import * as sn from "@distilled.cloud/gcp/servicenetworking_v1";
import { Resource } from "alchemy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { NetworkRef } from "../Compute/Network.ts";
import type * as GCP from "../Providers.ts";

/**
 * A **Private Services Access (PSA)** connection that peers a Google
 * service-producer VPC into the consumer VPC, drawing from one or more
 * pre-allocated `GCP.GlobalAddress` ranges.
 *
 * Identity: `(network, service)`. There can only be one PSA connection
 * per `(VPC, service)` pair, so the resource is keyed by both. The
 * peering name (used in delete/patch URLs) is server-assigned —
 * canonically `servicenetworking-googleapis-com` for the standard
 * Service Networking peering — and is read off the live connection
 * rather than reconstructed.
 *
 * Service Networking operations use a CRM-style `Operation.done:
 * boolean`, not the compute `.status: "DONE"` shape, so this resource
 * uses its own polling helper rather than the Compute one.
 *
 * @section Setting up PSA for Parallelstore
 * @example
 * ```typescript
 * // Reserve the range first.
 * const psaRange = yield* GCP.GlobalAddress("PsaRange", {
 *   project: hostProject.projectId,
 *   network: vpc.selfLink,
 *   purpose: "VPC_PEERING",
 *   addressType: "INTERNAL",
 *   prefixLength: 20,
 * });
 *
 * // Then peer. `networkRef` enforces the project-number form at the
 * // type level — `Project.projectNumber` is typed as `${number}` so
 * // this composes without manual casts.
 * yield* GCP.PsaConnection("Psa", {
 *   network: GCP.networkRef(hostProject.projectNumber, vpc.name),
 *   reservedPeeringRanges: [psaRange.name],
 * });
 * ```
 *
 * The `network` field is typed as `NetworkRef` —
 * `projects/{projectNumber}/global/networks/{name}` — because the
 * service producer's backend resolves peerings against the numeric
 * project id, not the project id string. Use `networkRef` to build
 * the value; passing a project ID will fail to typecheck.
 */
export type PsaConnectionProps = {
  /**
   * Fully-qualified consumer VPC in project-number form. Build with
   * `networkRef(project.projectNumber, vpc.name)` from `Compute/Network.ts`
   * — that helper composes the right shape and the type system rejects
   * passing a project ID. Immutable — replace.
   */
  network: NetworkRef;
  /**
   * Service Networking service. Defaults to `servicenetworking.googleapis.com`
   * (the only producer that PSA-aware GCP services like Parallelstore,
   * Cloud SQL, Memorystore peer through).
   */
  service?: string;
  /**
   * Names of `GCP.GlobalAddress` ranges (with `purpose=VPC_PEERING`) to
   * cede to the service producer. Mutable via `patchServicesConnections`.
   * Removing a range previously assigned requires `force=true` server-
   * side; this provider always passes `force=true` on patch to honour
   * the user's declared shape.
   */
  reservedPeeringRanges: ReadonlyArray<string>;
};

export type PsaConnectionAttributes = {
  /** Consumer VPC URL, threaded through from props. */
  network: NetworkRef;
  /** `services/<service>` resource name, threaded through from props. */
  serviceName: string;
  /** Server-assigned peering name (e.g. `servicenetworking-googleapis-com`). */
  peering: string;
  /** Reserved peering ranges currently in use. */
  reservedPeeringRanges: ReadonlyArray<string>;
};

export type PsaConnection = Resource<
  "GCP.PsaConnection",
  PsaConnectionProps,
  PsaConnectionAttributes,
  never,
  GCP.Providers
>;
export const PsaConnection = Resource<PsaConnection>("GCP.PsaConnection");

const DEFAULT_SERVICE = "servicenetworking.googleapis.com";

const serviceParent = (service: string) =>
  service.startsWith("services/") ? service : `services/${service}`;

export const PsaConnectionProvider = () =>
  Provider.effect(
    PsaConnection,
    Effect.gen(function* () {
      const listConnections = yield* sn.listServicesConnections;
      const createConnection = yield* sn.createServicesConnections;
      const patchConnection = yield* sn.patchServicesConnections;
      const deleteConnection = yield* sn.deleteConnectionServicesConnections;
      const getOperations = yield* sn.getOperations;

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
                Schedule.exponential(Duration.seconds(2), 1.5),
                Schedule.spaced(Duration.seconds(15)),
              ]),
              // PSA peering creates can take 5–10 min while the
              // service producer provisions its side. 80 × 15s ≈ 20 min.
              Schedule.recurs(80),
            ]).pipe(
              Schedule.tap(() =>
                session.note(`Waiting for ServiceNetworking operation ${operationName}…`),
              ),
            ),
          }),
        );
        if (op.error) {
          return yield* new ConfigError({
            message: `ServiceNetworking operation ${operationName} failed: ${
              op.error.message ?? JSON.stringify(op.error)
            }`,
          });
        }
        return op;
      });

      // List connections in the consumer VPC and return the matching
      // one (there can be at most one connection per `(network, service)`
      // pair). 404/403 collapse to "not present".
      const observe = (parent: string, network: string) =>
        listConnections({ parent, network }).pipe(
          Effect.map((res) =>
            (res.connections ?? []).find((c) => c.network === network),
          ),
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as sn.Connection | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as sn.Connection | undefined),
          ),
        );

      return {
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        stables: ["network", "serviceName", "peering"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldsService = olds.service ?? DEFAULT_SERVICE;
          const newsService = news.service ?? DEFAULT_SERVICE;
          if (
            (olds.network !== undefined && olds.network !== news.network) ||
            (olds.service !== undefined && oldsService !== newsService)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const service = news.service ?? DEFAULT_SERVICE;
          const parent = serviceParent(service);
          const desired = [...news.reservedPeeringRanges].sort();

          let observed = yield* observe(parent, news.network);

          if (!observed) {
            const op = yield* createConnection({
              parent,
              body: {
                network: news.network,
                reservedPeeringRanges: desired,
              },
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as sn.Operation | undefined),
              ),
            );
            if (op?.name) yield* awaitOperation(op.name, session);
            observed = yield* observe(parent, news.network);
          }

          if (!observed) {
            return yield* new ConfigError({
              message: `PSA connection on ${news.network} did not appear after create.`,
            });
          }

          // Sync reserved ranges. `force=true` is required when removing
          // a previously-assigned range; we pass it unconditionally to
          // keep the patch idempotent regardless of which direction the
          // diff went.
          const observedRanges = [...(observed.reservedPeeringRanges ?? [])].sort();
          if (!deepEqual(observedRanges, desired) && observed.peering) {
            const op = yield* patchConnection({
              name: `${parent}/connections/${observed.peering}`,
              force: true,
              updateMask: "reservedPeeringRanges",
              body: {
                network: news.network,
                reservedPeeringRanges: desired,
              },
            });
            if (op.name) yield* awaitOperation(op.name, session);
            observed = yield* observe(parent, news.network);
          }

          return {
            network: news.network,
            serviceName: parent,
            peering: observed?.peering ?? "",
            reservedPeeringRanges: observed?.reservedPeeringRanges ?? desired,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          if (!output.peering) return; // Never fully created.
          yield* deleteConnection({
            name: `${output.serviceName}/connections/${output.peering}`,
            body: { consumerNetwork: output.network },
          }).pipe(
            Effect.flatMap((op) =>
              op.name ? awaitOperation(op.name, session) : Effect.succeed(op),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
            // `BadRequest` may surface when the PSA range is still in
            // use by a managed service (Parallelstore, Cloud SQL, …)
            // — that's a real precondition the user must resolve, so
            // propagate it.
          );
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const network = output?.network ?? olds?.network;
          const service = olds?.service ?? DEFAULT_SERVICE;
          const parent = output?.serviceName ?? serviceParent(service);
          if (!network) return undefined;
          const observed = yield* observe(parent, network);
          if (!observed) return undefined;
          // No ownership concept: PSA connections are unique per
          // `(network, service)`, and the operation can only be
          // performed by the consumer-VPC project owner. Adoption is
          // permissive — same stance as `ApiEnable`.
          return {
            network,
            serviceName: parent,
            peering: observed.peering ?? "",
            reservedPeeringRanges: observed.reservedPeeringRanges ?? [],
          };
        }),
      };
    }),
  );
