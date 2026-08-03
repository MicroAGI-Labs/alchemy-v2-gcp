import * as compute from "@distilled.cloud/gcp/compute_v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { deepEqual, isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { gcpInternalLabels, hasAlchemyLabels, normalizeStringMap } from "../Tags.ts";
import type * as GCP from "../Providers.ts";
import { makeAwaitRegionOperation } from "./Operations.ts";

/**
 * A regional compute Address. The intended use here is a **Private
 * Service Connect consumer endpoint IP** — a single internal address
 * reserved in a subnet (`addressType=INTERNAL`, `purpose=GCE_ENDPOINT`)
 * that a `ForwardingRule` then binds to a producer service attachment
 * (e.g. a Cloud SQL instance in another VPC).
 *
 * For global PSA *ranges* (`purpose=VPC_PEERING`) use
 * {@link GlobalAddress} — that is a different API surface
 * (`globalAddresses` vs regional `addresses`).
 *
 * Adoption uses the labels field (Address carries `labels` +
 * `labelFingerprint`).
 *
 * @section Reserving a PSC endpoint IP
 * @example Internal address inside a subnet for a PSC forwarding rule
 * ```typescript
 * const endpointIp = yield* GCP.Address("DbPscAddress", {
 *   project: hostProject.projectId,
 *   region: "europe-west1",
 *   subnetwork: pscSubnet.selfLink,
 *   address: "10.0.16.5",
 * });
 * ```
 */
export type AddressProps = {
  /** GCP project ID hosting the address. Immutable — replace if changed. */
  project: string;
  /** GCP region. Addresses are regional — a different region requires replace. */
  region: string;
  /**
   * Address name. Defaults to `createPhysicalName({ id, lowercase: true,
   * maxLength: 63 })`. Immutable — replace if changed.
   */
  name?: string;
  /** Description (free-form). Set on create; immutable. */
  description?: string;
  /**
   * Internal vs external. Defaults to `INTERNAL` (the only value that
   * makes sense for a PSC endpoint IP). Immutable — replace.
   */
  addressType?: "INTERNAL" | "EXTERNAL";
  /**
   * Address purpose. For a PSC endpoint IP use `GCE_ENDPOINT` (the
   * default GCP assigns to plain internal addresses). Immutable — replace.
   */
  purpose?: "GCE_ENDPOINT" | "SHARED_LOADBALANCER_VIP" | "DNS_RESOLVER";
  /**
   * URL of the subnetwork the address is allocated from. Pass
   * `subnet.selfLink` from a `GCP.Subnetwork` to make alchemy sequence
   * the address after the subnet. Required for INTERNAL addresses.
   * Immutable — replace.
   */
  subnetwork: string;
  /**
   * Explicit IP to reserve inside the subnet's range. If omitted, GCP
   * picks one. Immutable — replace.
   */
  address?: string;
  /**
   * Resource labels. Alchemy internal labels (`alchemy_app`,
   * `alchemy_stage`, `alchemy_id`) are merged on top automatically and
   * are reserved. Mutable via `setLabels`.
   */
  labels?: Record<string, string>;
};

export type AddressAttributes = {
  /** Address name. */
  name: string;
  /** GCP project ID, threaded through from props for delete/read. */
  project: string;
  /** GCP region, threaded through from props for delete/read. */
  region: string;
  /** Server-defined URL. */
  selfLink: string;
  /** Server-assigned numeric id. */
  id: string;
  /** The reserved IP. */
  address: string;
  /** Address type. */
  addressType: string | undefined;
  /** Purpose. */
  purpose: string | undefined;
  /** Subnetwork URL. */
  subnetwork: string | undefined;
  /** Status: `RESERVING`, `RESERVED`, `IN_USE`. */
  status: string | undefined;
  /** Labels currently set, including the alchemy internals. */
  labels: Record<string, string>;
};

export type Address = Resource<
  "GCP.Address",
  AddressProps,
  AddressAttributes,
  never,
  GCP.Providers
>;
export const Address = Resource<Address>("GCP.Address");

const toAddressAttributes = (
  a: compute.Address,
  parent: { project: string; region: string },
): AddressAttributes => ({
  name: a.name ?? "",
  project: parent.project,
  region: parent.region,
  selfLink: a.selfLink ?? "",
  id: a.id ?? "",
  address: a.address ?? "",
  addressType: a.addressType,
  purpose: a.purpose,
  subnetwork: a.subnetwork,
  status: a.status,
  labels: normalizeStringMap(a.labels) ?? {},
});

export const AddressProvider = () =>
  Provider.effect(
    Address,
    Effect.gen(function* () {
      const getAddresses = yield* compute.getAddresses;
      const insertAddresses = yield* compute.insertAddresses;
      const deleteAddresses = yield* compute.deleteAddresses;
      const setLabelsAddresses = yield* compute.setLabelsAddresses;
      const getRegionOperations = yield* compute.getRegionOperations;
      const awaitOp = makeAwaitRegionOperation(getRegionOperations);

      const observe = (project: string, region: string, name: string) =>
        getAddresses({ project, region, address: name }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as compute.Address | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as compute.Address | undefined),
          ),
        );

      const syncLabels = Effect.fn(function* (args: {
        project: string;
        region: string;
        observed: compute.Address;
        desired: Record<string, string>;
        session: ScopedPlanStatusSession;
      }) {
        if (deepEqual(args.observed.labels ?? {}, args.desired)) return;
        const op = yield* setLabelsAddresses({
          project: args.project,
          region: args.region,
          resource: args.observed.name ?? "",
          body: {
            labels: args.desired,
            labelFingerprint: args.observed.labelFingerprint,
          },
        });
        if (op.name) {
          yield* awaitOp(args.project, args.region, op.name, args.session);
        }
      });

      return {
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        stables: ["name", "project", "region", "selfLink", "id", "address"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as AddressProps, news, [
              "project",
              "region",
              "name",
              "addressType",
              "purpose",
              "subnetwork",
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

          let observed = yield* observe(news.project, news.region, desiredName);

          if (!observed) {
            const body: compute.Address = {
              name: desiredName,
              ...(news.description ? { description: news.description } : {}),
              addressType: news.addressType ?? "INTERNAL",
              ...(news.purpose ? { purpose: news.purpose } : {}),
              subnetwork: news.subnetwork,
              ...(news.address ? { address: news.address } : {}),
              labels: desiredLabels,
            };
            const op = yield* insertAddresses({
              project: news.project,
              region: news.region,
              body,
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as compute.Operation | undefined),
              ),
            );
            if (op?.name) {
              yield* awaitOp(news.project, news.region, op.name, session);
            }
            observed = yield* getAddresses({
              project: news.project,
              region: news.region,
              address: desiredName,
            });
          }

          yield* syncLabels({
            project: news.project,
            region: news.region,
            observed,
            desired: desiredLabels,
            session,
          });

          const final = yield* getAddresses({
            project: news.project,
            region: news.region,
            address: desiredName,
          });
          return toAddressAttributes(final, {
            project: news.project,
            region: news.region,
          });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const deletion = deleteAddresses({
            project: output.project,
            region: output.region,
            address: output.name,
          }).pipe(
            Effect.flatMap((op) =>
              op.name
                ? awaitOp(output.project, output.region, op.name, session)
                : Effect.succeed(op),
            ),
          );
          yield* deletion.pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            // 400 "is being used by ..." comes back while a forwarding
            // rule still references the address. The rule must be
            // deleted first (alchemy's dep order handles this when the
            // rule consumes `address.selfLink`); surface the error
            // rather than silently swallowing.
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const project = output?.project ?? olds?.project;
          const region = output?.region ?? olds?.region;
          if (!project || !region) return undefined;
          const name =
            output?.name ??
            olds?.name ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const observed = yield* observe(project, region, name);
          if (!observed) return undefined;
          const attrs = toAddressAttributes(observed, { project, region });
          return (yield* hasAlchemyLabels(id, normalizeStringMap(observed.labels)))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
