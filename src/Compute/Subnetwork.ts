import * as compute from "@distilled.cloud/gcp/compute-v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { deepEqual, isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { ResourceBinding } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  descriptionHasAlchemyMarker,
  gcpAlchemyDescription,
  stripAlchemyMarker,
} from "../Tags.ts";
import type * as GCP from "../Providers.ts";
import { makeAwaitRegionOperation } from "./Operations.ts";

export type SubnetworkSecondaryRange = {
  /** Name used by alias-IP ranges on VMs in this subnet. */
  rangeName: string;
  /** Secondary CIDR. Must be unique and non-overlapping. */
  ipCidrRange: string;
};

/**
 * A regional VPC subnet. Carries a primary CIDR plus zero or more
 * named secondary ranges (used by GKE VPC-native pods/services).
 *
 * Like Networks, Subnetworks have no `labels` field, so adoption uses
 * the alchemy marker embedded in `description`. Description is set on
 * create and treated as immutable.
 *
 * @section Creating a subnet
 * @example GKE-ready subnet with pods + services secondary ranges
 * ```typescript
 * const sub = yield* GCP.Subnetwork("ResearchSubnet", {
 *   project: hostProject.projectId,
 *   region: "us-central1",
 *   network: vpc.selfLink,
 *   ipCidrRange: "10.0.0.0/20",
 *   secondaryIpRanges: [
 *     { rangeName: "pods", ipCidrRange: "10.4.0.0/14" },
 *     { rangeName: "services", ipCidrRange: "10.8.0.0/20" },
 *   ],
 *   privateIpGoogleAccess: true,
 * });
 * ```
 */
export type SubnetworkProps = {
  /** GCP project ID hosting the subnet. Immutable — replace if changed. */
  project: string;
  /**
   * GCP region. Subnets are regional — a different region requires
   * replace.
   */
  region: string;
  /**
   * Subnet name. Defaults to `createPhysicalName({ id, lowercase: true,
   * maxLength: 63 })`. Immutable — replace if changed.
   */
  name?: string;
  /**
   * URL or short name of the parent VPC. Pass `network.selfLink` from a
   * `GCP.Network` to make alchemy sequence the subnet after the VPC.
   * Immutable — replace.
   */
  network: string;
  /** User-visible description. Stored after the alchemy marker. Immutable. */
  description?: string;
  /**
   * Primary CIDR for the subnet. Mutable via `expandIpCidrRange` *only*
   * to a strictly-larger range; we surface that as a sync (treats
   * shrinks as "no-op"). For changes that aren't an expansion, this is
   * effectively replace-only.
   */
  ipCidrRange: string;
  /**
   * Secondary CIDR ranges used by alias IPs (e.g. GKE pods/services
   * ranges). Mutable via `patchSubnetworks`.
   */
  secondaryIpRanges?: ReadonlyArray<SubnetworkSecondaryRange>;
  /**
   * Whether VMs in this subnet can reach Google services without an
   * external IP. Defaults to `false`. Mutable via `patchSubnetworks`.
   */
  privateIpGoogleAccess?: boolean;
  /**
   * Stack type for the subnet. Defaults to `IPV4_ONLY`.
   */
  stackType?: "IPV4_ONLY" | "IPV4_IPV6" | "IPV6_ONLY";
};

export type SubnetworkAttributes = {
  /** Subnet name. */
  name: string;
  /** GCP project ID, threaded through from props for delete/read. */
  project: string;
  /** GCP region, threaded through from props for delete/read. */
  region: string;
  /** Server-defined URL. */
  selfLink: string;
  /** Server-assigned numeric id. */
  id: string;
  /** URL of the parent VPC. */
  network: string;
  /** User-visible description (with the alchemy marker stripped). */
  description: string | undefined;
  /** Primary CIDR. */
  ipCidrRange: string;
  /** Secondary ranges currently set. */
  secondaryIpRanges: ReadonlyArray<SubnetworkSecondaryRange>;
  /** Private Google Access setting. */
  privateIpGoogleAccess: boolean;
  /** Stack type. */
  stackType: string | undefined;
  /** Lifecycle state. */
  state: string | undefined;
  /** Default IPv4 gateway in the primary range. */
  gatewayAddress: string | undefined;
};

/**
 * Single (role, members) entry on a Subnetwork's IAM policy. Targets
 * declare this contract so capabilities can `.bind` IAM grants onto
 * the subnet — the provider's `reconcile` merges all bound entries
 * by role into a single `setIamPolicy` call.
 */
export type SubnetworkIamBinding = {
  /** IAM role, e.g. `"roles/compute.networkUser"`. */
  role: string;
  /** Principals, e.g. `["serviceAccount:foo@bar.iam.gserviceaccount.com"]`. */
  members: ReadonlyArray<string>;
};

export type SubnetworkBindingContract = {
  iamBindings: ReadonlyArray<SubnetworkIamBinding>;
};

export type Subnetwork = Resource<
  "GCP.Subnetwork",
  SubnetworkProps,
  SubnetworkAttributes,
  SubnetworkBindingContract,
  GCP.Providers
>;
export const Subnetwork = Resource<Subnetwork>("GCP.Subnetwork");

const toSubnetworkAttributes = (
  s: compute.Subnetwork,
  parent: { project: string; region: string },
): SubnetworkAttributes => ({
  name: s.name ?? "",
  project: parent.project,
  region: parent.region,
  selfLink: s.selfLink ?? "",
  id: s.id ?? "",
  network: s.network ?? "",
  description: stripAlchemyMarker(s.description),
  ipCidrRange: s.ipCidrRange ?? "",
  secondaryIpRanges: (s.secondaryIpRanges ?? []).map((r) => ({
    rangeName: r.rangeName ?? "",
    ipCidrRange: r.ipCidrRange ?? "",
  })),
  privateIpGoogleAccess: s.privateIpGoogleAccess ?? false,
  stackType: s.stackType,
  state: s.state,
  gatewayAddress: s.gatewayAddress,
});

const sortedSecondaryRanges = (
  rs: ReadonlyArray<SubnetworkSecondaryRange> | undefined,
): ReadonlyArray<SubnetworkSecondaryRange> =>
  [...(rs ?? [])].sort((a, b) => a.rangeName.localeCompare(b.rangeName));

export const SubnetworkProvider = () =>
  Provider.effect(
    Subnetwork,
    Effect.gen(function* () {
      const getSubnetworks = yield* compute.getSubnetworks;
      const insertSubnetworks = yield* compute.insertSubnetworks;
      const patchSubnetworks = yield* compute.patchSubnetworks;
      const deleteSubnetworks = yield* compute.deleteSubnetworks;
      const expandIpCidrRange = yield* compute.expandIpCidrRangeSubnetworks;
      const getRegionOperations = yield* compute.getRegionOperations;
      const getIamPolicy = yield* compute.getIamPolicySubnetworks;
      const setIamPolicy = yield* compute.setIamPolicySubnetworks;
      const awaitOp = makeAwaitRegionOperation(getRegionOperations);

      // Apply merged IAM bindings as a single setIamPolicy. Bindings
      // are unioned per role (multiple `.bind` callers sharing a role
      // get their members combined). Foreign bindings on the policy
      // (non-alchemy roles, or members we don't manage in this role)
      // are preserved verbatim. Etag round-trip handles concurrent
      // edits; Conflict triggers a re-read + retry.
      const syncIam = (args: {
        project: string;
        region: string;
        name: string;
        bindings: ReadonlyArray<ResourceBinding<SubnetworkBindingContract>>;
      }) =>
        Effect.gen(function* () {
          // Union all incoming binds by role.
          const desiredByRole = new Map<string, Set<string>>();
          for (const b of args.bindings) {
            for (const ib of b.data.iamBindings) {
              const set = desiredByRole.get(ib.role) ?? new Set<string>();
              for (const m of ib.members) set.add(m);
              desiredByRole.set(ib.role, set);
            }
          }
          if (desiredByRole.size === 0) return;

          const current = yield* getIamPolicy({
            project: args.project,
            region: args.region,
            resource: args.name,
            optionsRequestedPolicyVersion: 3,
          });

          // Take the current policy verbatim, then for each role we
          // manage, union desired members into the existing binding (or
          // create one). This preserves foreign roles and any extra
          // members on the same role that we don't know about.
          const bindings = (current.bindings ?? []).map((b) => ({
            ...b,
            members: [...(b.members ?? [])],
          }));
          let mutated = false;
          for (const [role, members] of desiredByRole) {
            let existing = bindings.find(
              (b) => b.role === role && !b.condition,
            );
            if (!existing) {
              existing = { role, members: [] };
              bindings.push(existing);
            }
            const merged = new Set([...(existing.members ?? []), ...members]);
            if (merged.size !== (existing.members?.length ?? 0)) mutated = true;
            existing.members = [...merged];
          }
          if (!mutated) return;

          yield* setIamPolicy({
            project: args.project,
            region: args.region,
            resource: args.name,
            body: { policy: { ...current, bindings, version: 3 } },
          });
        }).pipe(
          // setIamPolicy returns Conflict on etag race. Re-read + retry.
          // With multiple subnets/projects in a stack each receiving
          // multiple bindings in parallel, races are common. Cap at
          // ~1.5 min total to surface real failures.
          Effect.retry({
            schedule: Schedule.max([
              Schedule.exponential(Duration.seconds(2)),
              Schedule.recurs(8),
            ]),
          }),
        );

      const observe = (project: string, region: string, name: string) =>
        getSubnetworks({ project, region, subnetwork: name }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as compute.Subnetwork | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as compute.Subnetwork | undefined),
          ),
        );

      // patchSubnetworks requires an up-to-date `fingerprint` for
      // optimistic concurrency control. Re-read just before patching to
      // minimize the chance of `412 conditionNotMet`.
      const patchAspects = Effect.fn(function* (args: {
        project: string;
        region: string;
        name: string;
        observed: compute.Subnetwork;
        news: SubnetworkProps;
        session: ScopedPlanStatusSession;
      }) {
        const body: compute.Subnetwork = {};
        const obsRanges = sortedSecondaryRanges(
          (args.observed.secondaryIpRanges ?? []).map((r) => ({
            rangeName: r.rangeName ?? "",
            ipCidrRange: r.ipCidrRange ?? "",
          })),
        );
        const desiredRanges = sortedSecondaryRanges(args.news.secondaryIpRanges);
        if (!deepEqual(obsRanges, desiredRanges)) {
          body.secondaryIpRanges = desiredRanges as ReadonlyArray<compute.SubnetworkSecondaryRange>;
        }
        if (
          args.news.privateIpGoogleAccess !== undefined &&
          (args.observed.privateIpGoogleAccess ?? false) !==
            args.news.privateIpGoogleAccess
        ) {
          body.privateIpGoogleAccess = args.news.privateIpGoogleAccess;
        }
        if (
          args.news.stackType !== undefined &&
          args.observed.stackType !== args.news.stackType
        ) {
          body.stackType = args.news.stackType;
        }
        if (Object.keys(body).length === 0) return;

        body.fingerprint = args.observed.fingerprint;
        const op = yield* patchSubnetworks({
          project: args.project,
          region: args.region,
          subnetwork: args.name,
          body,
        });
        if (op.name) yield* awaitOp(args.project, args.region, op.name, args.session);
      });

      // Primary CIDR can only be *expanded*. We treat shrinks as no-ops
      // (the diff path doesn't trigger replace on ipCidrRange to keep
      // adoption flexible — if the user passes a smaller range, the
      // observed range stays).
      const expandPrimary = Effect.fn(function* (args: {
        project: string;
        region: string;
        name: string;
        observed: compute.Subnetwork;
        desired: string;
        session: ScopedPlanStatusSession;
      }) {
        if (!args.observed.ipCidrRange) return;
        if (args.observed.ipCidrRange === args.desired) return;
        // Cheap guard: only attempt expand if the desired range is
        // syntactically different. The API will reject shrinks/jumps;
        // surface that error to the user.
        const op = yield* expandIpCidrRange({
          project: args.project,
          region: args.region,
          subnetwork: args.name,
          body: { ipCidrRange: args.desired },
        });
        if (op.name) yield* awaitOp(args.project, args.region, op.name, args.session);
      });

      return {
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        stables: ["name", "project", "region", "selfLink", "id"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as SubnetworkProps, news, [
              "project",
              "region",
              "name",
              "network",
            ])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, session, bindings }) {
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const desiredDescription = yield* gcpAlchemyDescription(
            id,
            news.description,
          );

          let observed = yield* observe(news.project, news.region, desiredName);

          if (!observed) {
            const body: compute.Subnetwork = {
              name: desiredName,
              description: desiredDescription,
              network: news.network,
              ipCidrRange: news.ipCidrRange,
              ...(news.privateIpGoogleAccess !== undefined
                ? { privateIpGoogleAccess: news.privateIpGoogleAccess }
                : {}),
              ...(news.stackType ? { stackType: news.stackType } : {}),
              ...(news.secondaryIpRanges
                ? {
                    secondaryIpRanges: news.secondaryIpRanges.map((r) => ({
                      rangeName: r.rangeName,
                      ipCidrRange: r.ipCidrRange,
                    })),
                  }
                : {}),
            };
            const op = yield* insertSubnetworks({
              project: news.project,
              region: news.region,
              body,
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as compute.Operation | undefined),
              ),
            );
            if (op?.name) yield* awaitOp(news.project, news.region, op.name, session);
            observed = yield* getSubnetworks({
              project: news.project,
              region: news.region,
              subnetwork: desiredName,
            });
          }

          // Sync mutables: secondary ranges, privateIpGoogleAccess,
          // stackType (via patch), then primary range (via expand).
          yield* patchAspects({
            project: news.project,
            region: news.region,
            name: desiredName,
            observed,
            news,
            session,
          });
          yield* expandPrimary({
            project: news.project,
            region: news.region,
            name: desiredName,
            observed,
            desired: news.ipCidrRange,
            session,
          });

          // Apply IAM bindings AFTER the subnet exists. Single
          // setIamPolicy call covers all bindings for this subnet.
          yield* syncIam({
            project: news.project,
            region: news.region,
            name: desiredName,
            bindings,
          });

          const final = yield* getSubnetworks({
            project: news.project,
            region: news.region,
            subnetwork: desiredName,
          });
          return toSubnetworkAttributes(final, {
            project: news.project,
            region: news.region,
          });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const deletion = deleteSubnetworks({
            project: output.project,
            region: output.region,
            subnetwork: output.name,
          }).pipe(
            Effect.flatMap((op) =>
              op.name
                ? awaitOp(output.project, output.region, op.name, session)
                : Effect.succeed(op),
            ),
          );
          yield* deletion.pipe(
            Effect.catchTag("NotFound", () => Effect.void),
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
          const attrs = toSubnetworkAttributes(observed, { project, region });
          return (yield* descriptionHasAlchemyMarker(id, observed.description))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
