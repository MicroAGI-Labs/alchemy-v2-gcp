import * as compute from "@distilled.cloud/gcp/compute-v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { deepEqual, isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { gcpInternalLabels, hasAlchemyLabels } from "../Tags.ts";
import type * as GCP from "../Providers.ts";
import { makeAwaitGlobalOperation } from "./Operations.ts";

/**
 * A global compute Address. The intended use here is **Private Services
 * Access (PSA)** — reserving an internal IP range that
 * `servicenetworking.services.connections.create` consumes to peer
 * Google's service-producer VPC into the host VPC. That requires the
 * specific shape `addressType=INTERNAL`, `purpose=VPC_PEERING`,
 * `network=<vpc selfLink>`, plus an explicit `prefixLength`.
 *
 * Other purposes (`PRIVATE_SERVICE_CONNECT`, `GCE_ENDPOINT`, regional
 * external addresses) are not modelled in this resource — add them in
 * separate resources if/when needed.
 *
 * Adoption uses the labels field (Address carries `labels` +
 * `labelFingerprint`).
 *
 * @section Reserving a PSA range
 * @example /20 reserved for `servicenetworking.googleapis.com`
 * ```typescript
 * const psaRange = yield* GCP.GlobalAddress("PsaRange", {
 *   project: hostProject.projectId,
 *   network: vpc.selfLink,
 *   purpose: "VPC_PEERING",
 *   addressType: "INTERNAL",
 *   prefixLength: 20,
 * });
 * ```
 */
export type GlobalAddressProps = {
  /** GCP project ID hosting the address. Immutable — replace if changed. */
  project: string;
  /**
   * Address name. Defaults to `createPhysicalName({ id, lowercase: true,
   * maxLength: 63 })`. Immutable — replace if changed.
   */
  name?: string;
  /** Description (free-form). */
  description?: string;
  /**
   * Internal vs external. Defaults to `INTERNAL` (the only value that
   * makes sense for a PSA reservation). Immutable — replace.
   */
  addressType?: "INTERNAL" | "EXTERNAL";
  /**
   * Address purpose. For PSA use `VPC_PEERING`. Immutable — replace.
   */
  purpose?:
    | "VPC_PEERING"
    | "GCE_ENDPOINT"
    | "PRIVATE_SERVICE_CONNECT"
    | "DNS_RESOLVER";
  /**
   * URL of the VPC the address belongs to (PSA requires this).
   * Immutable — replace.
   */
  network?: string;
  /**
   * Prefix length for a range allocation (PSA always allocates a
   * range, not a single address). Required for `purpose=VPC_PEERING`.
   * Immutable — replace.
   */
  prefixLength?: number;
  /**
   * Explicit address (or first address of the range) to reserve. If
   * omitted, GCP picks one inside the VPC's available space.
   * Immutable — replace.
   */
  address?: string;
  /**
   * Resource labels. Alchemy internal labels (`alchemy_app`,
   * `alchemy_stage`, `alchemy_id`) are merged on top automatically and
   * are reserved. Mutable via `setLabels`.
   */
  labels?: Record<string, string>;
};

export type GlobalAddressAttributes = {
  /** Address name. */
  name: string;
  /** GCP project ID, threaded through from props for delete/read. */
  project: string;
  /** Server-defined URL. */
  selfLink: string;
  /** Server-assigned numeric id. */
  id: string;
  /** The reserved IP (or first IP of the range). */
  address: string;
  /** Prefix length, when reserving a range. */
  prefixLength: number | undefined;
  /** Address type. */
  addressType: string | undefined;
  /** Purpose. */
  purpose: string | undefined;
  /** VPC URL. */
  network: string | undefined;
  /** Status: `RESERVING`, `RESERVED`, `IN_USE`. */
  status: string | undefined;
  /** Labels currently set, including the alchemy internals. */
  labels: Record<string, string>;
};

export type GlobalAddress = Resource<
  "GCP.GlobalAddress",
  GlobalAddressProps,
  GlobalAddressAttributes,
  never,
  GCP.Providers
>;
export const GlobalAddress = Resource<GlobalAddress>("GCP.GlobalAddress");

const toGlobalAddressAttributes = (
  a: compute.Address,
  parent: { project: string },
): GlobalAddressAttributes => ({
  name: a.name ?? "",
  project: parent.project,
  selfLink: a.selfLink ?? "",
  id: a.id ?? "",
  address: a.address ?? "",
  prefixLength: a.prefixLength,
  addressType: a.addressType,
  purpose: a.purpose,
  network: a.network,
  status: a.status,
  labels: { ...(a.labels ?? {}) },
});

export const GlobalAddressProvider = () =>
  Provider.effect(
    GlobalAddress,
    Effect.gen(function* () {
      const getGlobalAddresses = yield* compute.getGlobalAddresses;
      const insertGlobalAddresses = yield* compute.insertGlobalAddresses;
      const deleteGlobalAddresses = yield* compute.deleteGlobalAddresses;
      const setLabelsGlobalAddresses = yield* compute.setLabelsGlobalAddresses;
      const getGlobalOperations = yield* compute.getGlobalOperations;
      const awaitOp = makeAwaitGlobalOperation(getGlobalOperations);

      const observe = (project: string, name: string) =>
        getGlobalAddresses({ project, address: name }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as compute.Address | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as compute.Address | undefined),
          ),
        );

      const syncLabels = Effect.fn(function* (args: {
        project: string;
        observed: compute.Address;
        desired: Record<string, string>;
        session: ScopedPlanStatusSession;
      }) {
        if (deepEqual(args.observed.labels ?? {}, args.desired)) return;
        const op = yield* setLabelsGlobalAddresses({
          project: args.project,
          resource: args.observed.name ?? "",
          body: {
            labels: args.desired,
            labelFingerprint: args.observed.labelFingerprint,
          },
        });
        if (op.name) yield* awaitOp(args.project, op.name, args.session);
      });

      return {
        stables: ["name", "project", "selfLink", "id", "address"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as GlobalAddressProps, news, [
              "project",
              "name",
              "addressType",
              "purpose",
              "network",
              "prefixLength",
              "address",
            ])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const internalLabels = yield* gcpInternalLabels(id);
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const desiredLabels: Record<string, string> = {
            ...(news.labels ?? {}),
            ...internalLabels,
          };

          let observed = yield* observe(news.project, desiredName);

          if (!observed) {
            const body: compute.Address = {
              name: desiredName,
              ...(news.description ? { description: news.description } : {}),
              addressType: news.addressType ?? "INTERNAL",
              ...(news.purpose ? { purpose: news.purpose } : {}),
              ...(news.network ? { network: news.network } : {}),
              ...(news.prefixLength !== undefined
                ? { prefixLength: news.prefixLength }
                : {}),
              ...(news.address ? { address: news.address } : {}),
              labels: desiredLabels,
            };
            const op = yield* insertGlobalAddresses({
              project: news.project,
              body,
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as compute.Operation | undefined),
              ),
            );
            if (op?.name) yield* awaitOp(news.project, op.name, session);
            observed = yield* getGlobalAddresses({
              project: news.project,
              address: desiredName,
            });
          }

          yield* syncLabels({
            project: news.project,
            observed,
            desired: desiredLabels,
            session,
          });

          const final = yield* getGlobalAddresses({
            project: news.project,
            address: desiredName,
          });
          return toGlobalAddressAttributes(final, { project: news.project });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* deleteGlobalAddresses({
            project: output.project,
            address: output.name,
          }).pipe(
            Effect.flatMap((op) =>
              op.name
                ? awaitOp(output.project, op.name, session)
                : Effect.succeed(op),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
            // 400 with "is being used by ..." comes back when a PSA
            // connection still references the range. The user has to
            // delete the connection first; surface the error rather
            // than silently swallowing.
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const project = output?.project ?? olds?.project;
          if (!project) return undefined;
          const name =
            output?.name ??
            olds?.name ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const observed = yield* observe(project, name);
          if (!observed) return undefined;
          const attrs = toGlobalAddressAttributes(observed, { project });
          return (yield* hasAlchemyLabels(id, observed.labels))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
