import { ConfigError } from "@distilled.cloud/gcp";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { isResolved } from "alchemy/Diff";
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

// Distinct nominal brands keep `NetworkRef` and `NetworkRefById`
// mutually unassignable even though their underlying template-literal
// shapes overlap. The brand symbols are `declare`-only — never present
// at runtime — and only the constructor functions below mint values
// carrying them, so a caller cannot bypass the type by hand-crafting a
// raw string and asserting it.
declare const _networkRefByNumberBrand: unique symbol;
declare const _networkRefByIdBrand: unique symbol;

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
 * the call site. The nominal brand prevents a `NetworkRefById` from
 * being passed where this is expected and vice versa — see
 * {@link NetworkRefById}.
 */
export type NetworkRef = `projects/${number}/global/networks/${string}` & {
  readonly [_networkRefByNumberBrand]: true;
};

/**
 * Fully-qualified VPC reference in **project-ID** form:
 * `projects/{projectId}/global/networks/{name}`.
 *
 * Required by Managed Lustre's `instances.create` (and any future GCP
 * API that explicitly rejects the project-number form). Build with
 * {@link networkRefById}.
 *
 * Note: project-ID form is in some places interchangeable with
 * project-number form (the SDK accepts either for compute / GKE), but
 * Managed Lustre's API validates the path segment shape and refuses
 * numeric ids — without this distinct branded type, a stack would
 * compile fine and only fail at deploy time with `BadRequest: Valid
 * format: projects/{project_id}/global/networks/{network_id}`.
 */
export type NetworkRefById = `projects/${string}/global/networks/${string}` & {
  readonly [_networkRefByIdBrand]: true;
};

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
      ([num, name]) => `projects/${num}/global/networks/${name}`,
    ),
  ) as unknown as Output.Output<NetworkRef>;

/**
 * Build a project-ID-form `NetworkRefById`. Use for APIs that require
 * the project-ID path segment — Managed Lustre is the current example.
 *
 * Pass `Project.projectId` (an `Output<string>`) plus `Network.name`.
 * Plain literal arguments work too: `networkRefById("research-shared",
 * "main")`. The branded return type prevents the value from being
 * confused with a project-number-form {@link NetworkRef} at any call
 * site downstream — even though their string shapes happen to coincide
 * for numeric ids.
 */
export const networkRefById = (
  projectId: string | Output.Output<string>,
  networkName: string | Output.Output<string>,
): Output.Output<NetworkRefById> =>
  Output.all(
    Output.asOutput(projectId),
    Output.asOutput(networkName),
  ).pipe(
    Output.map(([id, name]) => `projects/${id}/global/networks/${name}`),
  ) as unknown as Output.Output<NetworkRefById>;

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
  /** Full or partial Compute network-profile URL. Create-only; changing a
   * fixed-name network requires choosing a new name, never in-place replacement.
   * Example: projects/{project}/global/networkProfiles/{profile}.
   */
  networkProfile?: string;
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
  /** Active immutable network profile, as returned by Compute. */
  networkProfile: string | undefined;
};

export type Network = Resource<
  "GCP.Network",
  NetworkProps,
  NetworkAttributes,
  never,
  GCP.Providers
>;
export const Network = Resource<Network>("GCP.Network");

export const toNetworkAttributes = (
  n: compute.Network,
  parent: { project: string; name: string },
): NetworkAttributes => ({
  name: n.name || parent.name,
  project: parent.project,
  selfLink: n.selfLink || `https://www.googleapis.com/compute/v1/projects/${parent.project}/global/networks/${parent.name}`,
  id: n.id ?? "",
  description: stripAlchemyMarker(n.description),
  autoCreateSubnetworks: n.autoCreateSubnetworks ?? false,
  routingMode: n.routingConfig?.routingMode,
  mtu: n.mtu,
  networkProfile: n.networkProfile,
});

/** Compute accepts both full and partial URLs. Keep project identity intact. */
export const normalizeNetworkProfile = (profile: string | undefined) =>
  profile?.trim().replace(/^https:\/\/(?:www\.googleapis\.com|compute\.googleapis\.com)\/compute\/(?:v1|beta|alpha)\//, "").replace(/^\//, "") || undefined;

const priorIdentity = (olds?: Partial<NetworkProps>, output?: Partial<NetworkAttributes>) => ({
  project: output?.project || olds?.project,
  name: output?.name || olds?.name,
});
const immutableError = (name: string) => new ConfigError({
  message: `Network ${name} has incompatible immutable networkProfile, MTU or subnet mode; choose a new network name before changing these fields`,
});
const immutableChanged = (prior: Partial<NetworkProps>, news: NetworkProps) =>
  (prior.autoCreateSubnetworks ?? false) !== (news.autoCreateSubnetworks ?? false) ||
  (prior.mtu ?? 1460) !== (news.mtu ?? 1460) ||
  normalizeNetworkProfile(prior.networkProfile) !== normalizeNetworkProfile(news.networkProfile);

/** Protect fixed names from replacement GC deleting the same physical VPC. */
export const diffNetworkConfiguration = Effect.fn(function* (
  olds: Partial<NetworkProps> | undefined,
  news: NetworkProps,
  output?: Partial<NetworkAttributes>,
) {
  const identity = priorIdentity(olds, output);
  if ((identity.project && identity.project !== news.project) ||
      (news.name !== undefined && identity.name && identity.name !== news.name) ||
      (news.name === undefined && olds?.name !== undefined)) return { action: "replace" } as const;
  if (!olds && !output) return undefined;
  // Old props protect against same-name replacements even if refreshed output
  // already reflects a remote change. Output provides recovery/drift evidence.
  const changed = (olds !== undefined && immutableChanged(olds, news)) ||
    (output !== undefined && (
      (output.autoCreateSubnetworks !== undefined && output.autoCreateSubnetworks !== (news.autoCreateSubnetworks ?? false)) ||
      (news.mtu !== undefined && output.mtu !== undefined && output.mtu !== news.mtu) ||
      (Object.hasOwn(output, "networkProfile") && normalizeNetworkProfile(output.networkProfile) !== normalizeNetworkProfile(news.networkProfile))
    ));
  if (!changed) return undefined;
  if (news.name !== undefined && identity.name === news.name && identity.project === news.project) return yield* immutableError(news.name);
  return { action: "replace" } as const;
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
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        stables: ["name", "project", "selfLink", "id"],
        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news)) return undefined;
          return yield* diffNetworkConfiguration(olds, news, output);
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          yield* diffNetworkConfiguration(olds, news, output);
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
              ...(news.networkProfile ? { networkProfile: news.networkProfile } : {}),
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

          // Even create/adoption/conflict recovery must not claim a different
          // immutable profile was installed on an already existing VPC.
          if (normalizeNetworkProfile(observed.networkProfile) !== normalizeNetworkProfile(news.networkProfile)) {
            return yield* immutableError(desiredName);
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
          return toNetworkAttributes(final, { project: news.project, name: desiredName });
        }),
        delete: Effect.fn(function* ({ output, olds, session }) {
          const identity = priorIdentity(olds, output);
          if (!identity.project || !identity.name) return;
          const project = identity.project;
          const name = identity.name;
          const deletion = deleteNetworks({
            project,
            network: name,
          }).pipe(
            Effect.flatMap((op) =>
              op.name
                ? awaitOp(project, op.name, session)
                : Effect.succeed(op),
            ),
          );
          yield* deletion.pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const project = output?.project || olds?.project;
          if (!project) return undefined;
          const name =
            output?.name ||
            olds?.name ||
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const observed = yield* observe(project, name);
          if (!observed) return undefined;
          const attrs = toNetworkAttributes(observed, { project, name });
          // Adoption gate via the description marker — networks have no
          // labels field (verified against compute-v1 SDK Network type).
          return (yield* descriptionHasAlchemyMarker(id, observed.description))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
