import * as compute from "@distilled.cloud/gcp/compute-v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import {
  descriptionHasAlchemyMarker,
  gcpAlchemyDescription,
  stripAlchemyMarker,
} from "../Tags.ts";
import type * as GCP from "../Providers.ts";
import { makeAwaitGlobalOperation } from "./Operations.ts";

/**
 * Fully-qualified VPC reference in **project-number** form:
 * `projects/{projectNumber}/global/networks/{name}`.
 *
 * Several GCP service-producer APIs (servicenetworking PSA,
 * Parallelstore) require this exact shape — the *project number*, not
 * project ID — because they resolve peerings against numeric ids that
 * are stable across project renames. Compose with `networkRef`:
 *
 * ```typescript
 * const ref = networkRef(project.projectNumber, vpc.name);
 * // typed as Output<NetworkRef>, accepted by GCP.PsaConnection /
 * // GCP.ParallelstoreInstance via the Resource constructor's
 * // InputProps widening.
 * ```
 *
 * `Project.projectNumber` is typed as `` `${number}` `` precisely so
 * this template literal type composes without a runtime coercion at
 * the call site.
 */
export type NetworkRef = `projects/${number}/global/networks/${string}`;

/**
 * Build a project-number-form `NetworkRef`. Lifted through `Output`
 * so it composes with `Project.projectNumber` (an `Output<\`${number}\`>`)
 * and `Network.name` (an `Output<string>`) coming from other resource
 * constructors. The `` `${number}` `` argument type prevents
 * accidentally passing `Project.projectId` here — TS rejects strings
 * that don't match the numeric shape.
 *
 * Plain literal arguments still work: `networkRef("415104041262", "main")`
 * is wrapped via `Output.asOutput` and resolves immediately at apply
 * time.
 */
export const networkRef = (
  projectNumber: `${number}` | Output.Output<`${number}`>,
  networkName: string | Output.Output<string>,
): Output.Output<NetworkRef> =>
  Output.all(
    Output.asOutput(projectNumber),
    Output.asOutput(networkName),
  ).pipe(
    Output.map(
      ([num, name]) =>
        `projects/${num}/global/networks/${name}` as NetworkRef,
    ),
  );

/**
 * A VPC Network in custom-mode (`autoCreateSubnetworks=false`). Auto-mode
 * networks are intentionally not exposed — every cluster/parallelstore
 * deployment in this provider expects explicit subnets in known regions.
 *
 * Compute Networks have no `labels` field, so adoption gating uses an
 * alchemy marker embedded in the `description` field instead (see
 * `gcpAlchemyDescription`). Network `description` is set at create time
 * and is treated as immutable — the marker survives for the resource's
 * lifetime.
 *
 * @section Creating a VPC
 * @example Custom-mode VPC for a Shared VPC host
 * ```typescript
 * const vpc = yield* GCP.Network("ResearchVpc", {
 *   project: hostProject.projectId,
 *   routingMode: "GLOBAL",
 * });
 * ```
 */
export type NetworkProps = {
  /** GCP project ID hosting the network. Immutable — replace if changed. */
  project: string;
  /**
   * Network name. Defaults to `createPhysicalName({ id, lowercase: true,
   * maxLength: 63 })`. Must match `[a-z]([-a-z0-9]*[a-z0-9])?`.
   * Immutable — replace if changed.
   */
  name?: string;
  /**
   * User-visible description. Stored in the resource's `description`
   * field after the alchemy ownership marker prefix. Treated as
   * immutable by GCP after create — changes here do NOT replace.
   */
  description?: string;
  /**
   * `auto` mode: GCP allocates one subnet per region with predetermined
   * CIDRs. `custom` mode (default): you create subnetworks explicitly
   * via `GCP.Subnetwork`. Immutable — switching modes requires replace.
   */
  autoCreateSubnetworks?: boolean;
  /**
   * Network-wide routing config. Cloud Routers in REGIONAL mode advertise
   * only same-region subnets; GLOBAL mode advertises across regions.
   * Mutable via `patchNetworks` (the only field GCP allows mutating
   * post-create on a VPC).
   */
  routingMode?: "REGIONAL" | "GLOBAL";
  /**
   * MTU in bytes. Range 1300-8896. Defaults to 1460. Common values:
   * 1500 (internet default), 8896 (jumbo frames). Immutable — replace.
   */
  mtu?: number;
};

export type NetworkAttributes = {
  /** Network name. */
  name: string;
  /** GCP project ID, threaded through from props for delete/read. */
  project: string;
  /** Server-defined URL for the resource. */
  selfLink: string;
  /** Server-assigned numeric id. */
  id: string;
  /** User-visible description (with the alchemy marker stripped off). */
  description: string | undefined;
  /** Custom (false) vs auto (true) subnet mode. */
  autoCreateSubnetworks: boolean;
  /** Active routing mode. */
  routingMode: string | undefined;
  /** Active MTU in bytes. */
  mtu: number | undefined;
};

export type Network = Resource<
  "GCP.Network",
  NetworkProps,
  NetworkAttributes,
  never,
  GCP.Providers
>;
export const Network = Resource<Network>("GCP.Network");

const toNetworkAttributes = (
  n: compute.Network,
  parent: { project: string },
): NetworkAttributes => ({
  name: n.name ?? "",
  project: parent.project,
  selfLink: n.selfLink ?? "",
  id: n.id ?? "",
  description: stripAlchemyMarker(n.description),
  autoCreateSubnetworks: n.autoCreateSubnetworks ?? false,
  routingMode: n.routingConfig?.routingMode,
  mtu: n.mtu,
});

export const NetworkProvider = () =>
  Provider.effect(
    Network,
    Effect.gen(function* () {
      const getNetworks = yield* compute.getNetworks;
      const insertNetworks = yield* compute.insertNetworks;
      const patchNetworks = yield* compute.patchNetworks;
      const deleteNetworks = yield* compute.deleteNetworks;
      const getGlobalOperations = yield* compute.getGlobalOperations;
      const awaitOp = makeAwaitGlobalOperation(getGlobalOperations);

      const observe = (project: string, name: string) =>
        getNetworks({ project, network: name }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as compute.Network | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as compute.Network | undefined),
          ),
        );

      const syncRoutingMode = Effect.fn(function* (args: {
        project: string;
        name: string;
        observed: compute.Network;
        desired: NetworkProps["routingMode"];
        session: ScopedPlanStatusSession;
      }) {
        if (!args.desired) return;
        if (args.observed.routingConfig?.routingMode === args.desired) return;
        const op = yield* patchNetworks({
          project: args.project,
          network: args.name,
          body: { routingConfig: { routingMode: args.desired } },
        });
        if (op.name) yield* awaitOp(args.project, op.name, args.session);
      });

      return {
        stables: ["name", "project", "selfLink", "id"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as NetworkProps, news, [
              "project",
              "name",
              "autoCreateSubnetworks",
              "mtu",
            ])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const desiredDescription = yield* gcpAlchemyDescription(
            id,
            news.description,
          );

          // 1. Observe — collapse 403 to "missing" alongside 404.
          let observed = yield* observe(news.project, desiredName);

          // 2. Ensure — create if missing. `autoCreateSubnetworks`
          //    defaults to *true* on the GCP side (auto-mode VPC), but
          //    we default to false because every consumer in this
          //    provider creates explicit subnets. `Conflict` covers
          //    concurrent creates and state-persistence races.
          if (!observed) {
            const body: compute.Network = {
              name: desiredName,
              description: desiredDescription,
              autoCreateSubnetworks: news.autoCreateSubnetworks ?? false,
              ...(news.mtu !== undefined ? { mtu: news.mtu } : {}),
              ...(news.routingMode
                ? { routingConfig: { routingMode: news.routingMode } }
                : {}),
            };
            const op = yield* insertNetworks({
              project: news.project,
              body,
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as compute.Operation | undefined),
              ),
            );
            if (op?.name) yield* awaitOp(news.project, op.name, session);
            observed = yield* getNetworks({
              project: news.project,
              network: desiredName,
            });
          }

          // 3. Sync — only routing config can be mutated post-create.
          //    Description, MTU, autoCreateSubnetworks are all locked.
          yield* syncRoutingMode({
            project: news.project,
            name: desiredName,
            observed,
            desired: news.routingMode,
            session,
          });

          const final = yield* getNetworks({
            project: news.project,
            network: desiredName,
          });
          return toNetworkAttributes(final, { project: news.project });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* deleteNetworks({
            project: output.project,
            network: output.name,
          }).pipe(
            Effect.flatMap((op) =>
              op.name
                ? awaitOp(output.project, op.name, session)
                : Effect.succeed(op),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
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
          const attrs = toNetworkAttributes(observed, { project });
          // Adoption gate via the description marker — networks have no
          // labels field (verified against compute-v1 SDK Network type).
          return (yield* descriptionHasAlchemyMarker(id, observed.description))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
