import * as compute from "@distilled.cloud/gcp/compute-v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import {
  descriptionHasAlchemyMarker,
  gcpAlchemyDescription,
  stripAlchemyMarker,
} from "../Tags.ts";
import type * as GCP from "../Providers.ts";
import { makeAwaitGlobalOperation } from "./Operations.ts";

/** One allow entry: a protocol plus optional port list. */
export type FirewallAllowed = {
  /** `tcp` | `udp` | `icmp` | `esp` | `ah` | `sctp` | protocol number. */
  IPProtocol: string;
  /** Ports / ranges (`"8000"`, `"8000-8100"`). Omit = all ports. */
  ports?: ReadonlyArray<string>;
};

/**
 * A VPC firewall rule (allow rules only — `denied` is not modelled;
 * add it when a consumer needs it).
 *
 * Firewalls have no `labels` field, so adoption gating uses the
 * alchemy marker embedded in `description` (same as `GCP.Network`).
 * Unlike Network, firewall `description` IS mutable, and the sync step
 * keeps the marker prefix in place on every reconcile.
 *
 * GCP rejects rules carrying BOTH `targetTags` and
 * `targetServiceAccounts` — prefer service accounts for GKE node
 * targeting: node tags embed a per-cluster random suffix and go stale
 * on every cluster rebuild, while the compute default SA is stable.
 *
 * @section Creating a firewall rule
 * @example GCLB health checks → GKE pods on 8000
 * ```typescript
 * yield* GCP.Firewall("LbHealthChecks", {
 *   project: host.projectId,
 *   network: vpc.selfLink,
 *   name: "k8s-app-hc",
 *   sourceRanges: ["130.211.0.0/22", "35.191.0.0/16"],
 *   allowed: [{ IPProtocol: "tcp", ports: ["8000"] }],
 *   targetServiceAccounts: [nodeSa],
 * });
 * ```
 */
export type FirewallProps = {
  /** GCP project ID hosting the rule. Immutable — replace if changed. */
  project: string;
  /**
   * Rule name. Defaults to `createPhysicalName({ id, lowercase: true,
   * maxLength: 63 })`. Immutable — replace if changed.
   */
  name?: string;
  /**
   * VPC the rule attaches to — short name or selfLink. Immutable —
   * replace if changed.
   */
  network: string;
  /** User-visible description (stored after the alchemy marker). Mutable. */
  description?: string;
  /** INGRESS (default) or EGRESS. Immutable — replace if changed. */
  direction?: "INGRESS" | "EGRESS";
  /** 0–65535, lower wins. GCP default 1000. Mutable. */
  priority?: number;
  /** Source CIDRs (INGRESS). Mutable. */
  sourceRanges?: ReadonlyArray<string>;
  /** Destination CIDRs (EGRESS). Mutable. */
  destinationRanges?: ReadonlyArray<string>;
  /** Allow entries. Required — this resource models allow rules only. Mutable. */
  allowed: ReadonlyArray<FirewallAllowed>;
  /**
   * Instance network tags the rule applies to. Mutually exclusive with
   * `targetServiceAccounts`. Mutable.
   */
  targetTags?: ReadonlyArray<string>;
  /**
   * Service accounts whose instances the rule applies to. Preferred
   * over tags for GKE nodes (stable across cluster rebuilds). Mutually
   * exclusive with `targetTags`. Mutable.
   */
  targetServiceAccounts?: ReadonlyArray<string>;
  /** Rule disabled (kept but not enforced). Mutable. */
  disabled?: boolean;
};

export type FirewallAttributes = {
  /** Rule name. */
  name: string;
  /** GCP project ID, threaded through from props for delete/read. */
  project: string;
  /** Server-defined URL. */
  selfLink: string;
  /** Server-assigned numeric id. */
  id: string;
  /** VPC selfLink the rule is attached to. */
  network: string;
  /** INGRESS / EGRESS. */
  direction: string | undefined;
  /** Effective priority. */
  priority: number | undefined;
  /** Source CIDRs. */
  sourceRanges: ReadonlyArray<string> | undefined;
  /** Allow entries. */
  allowed: ReadonlyArray<FirewallAllowed> | undefined;
  /** Target network tags. */
  targetTags: ReadonlyArray<string> | undefined;
  /** Target service accounts. */
  targetServiceAccounts: ReadonlyArray<string> | undefined;
  /** User description (alchemy marker stripped). */
  description: string | undefined;
  /** Disabled flag. */
  disabled: boolean | undefined;
};

export type Firewall = Resource<
  "GCP.Firewall",
  FirewallProps,
  FirewallAttributes,
  never,
  GCP.Providers
>;
export const Firewall = Resource<Firewall>("GCP.Firewall");

const toFirewallAttributes = (
  f: compute.Firewall,
  parent: { project: string },
): FirewallAttributes => ({
  name: f.name ?? "",
  project: parent.project,
  selfLink: f.selfLink ?? "",
  id: f.id ?? "",
  network: f.network ?? "",
  direction: f.direction,
  priority: f.priority,
  sourceRanges: f.sourceRanges,
  allowed: f.allowed as ReadonlyArray<FirewallAllowed> | undefined,
  targetTags: f.targetTags,
  targetServiceAccounts: f.targetServiceAccounts,
  description: stripAlchemyMarker(f.description),
  disabled: f.disabled,
});

/**
 * Normalize for drift comparison: GCP reorders list fields and the
 * `allowed` entries' ports — compare order-insensitively so a
 * cosmetic reordering doesn't trigger a PATCH every reconcile.
 */
const normalized = (f: {
  priority?: number | undefined;
  sourceRanges?: ReadonlyArray<string> | undefined;
  destinationRanges?: ReadonlyArray<string> | undefined;
  // `IPProtocol` is optional here because the SDK's observed Firewall
  // type marks every field optional — desired props always set it.
  allowed?: ReadonlyArray<{ IPProtocol?: string; ports?: ReadonlyArray<string> }> | undefined;
  targetTags?: ReadonlyArray<string> | undefined;
  targetServiceAccounts?: ReadonlyArray<string> | undefined;
  disabled?: boolean | undefined;
  description?: string | undefined;
}) => ({
  priority: f.priority ?? 1000,
  sourceRanges: [...(f.sourceRanges ?? [])].sort(),
  destinationRanges: [...(f.destinationRanges ?? [])].sort(),
  allowed: [...(f.allowed ?? [])]
    .map((a) => ({
      IPProtocol: (a.IPProtocol ?? "").toLowerCase(),
      ports: [...(a.ports ?? [])].sort(),
    }))
    .sort((x, y) => x.IPProtocol.localeCompare(y.IPProtocol)),
  targetTags: [...(f.targetTags ?? [])].sort(),
  targetServiceAccounts: [...(f.targetServiceAccounts ?? [])].sort(),
  disabled: f.disabled ?? false,
  description: f.description,
});

export const FirewallProvider = () =>
  Provider.effect(
    Firewall,
    Effect.gen(function* () {
      const getFirewalls = yield* compute.getFirewalls;
      const insertFirewalls = yield* compute.insertFirewalls;
      const patchFirewalls = yield* compute.patchFirewalls;
      const deleteFirewalls = yield* compute.deleteFirewalls;
      const getGlobalOperations = yield* compute.getGlobalOperations;
      const awaitOp = makeAwaitGlobalOperation(getGlobalOperations);

      const observe = (project: string, name: string) =>
        getFirewalls({ project, firewall: name }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as compute.Firewall | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as compute.Firewall | undefined),
          ),
        );

      return {
        stables: ["name", "project", "selfLink", "id", "network"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as FirewallProps, news, [
              "project",
              "name",
              "network",
              "direction",
            ])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          if (news.targetTags?.length && news.targetServiceAccounts?.length) {
            return yield* Effect.fail(
              new Error(
                "Firewall: targetTags and targetServiceAccounts are mutually exclusive (GCP rejects rules with both)",
              ),
            );
          }
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const desiredDescription = yield* gcpAlchemyDescription(
            id,
            news.description,
          );

          const mutableBody = (): compute.Firewall => ({
            description: desiredDescription,
            ...(news.priority !== undefined ? { priority: news.priority } : {}),
            ...(news.sourceRanges
              ? { sourceRanges: [...news.sourceRanges] }
              : {}),
            ...(news.destinationRanges
              ? { destinationRanges: [...news.destinationRanges] }
              : {}),
            allowed: news.allowed.map((a) => ({
              IPProtocol: a.IPProtocol,
              ...(a.ports ? { ports: [...a.ports] } : {}),
            })),
            // Always send both target fields: switching tags → service
            // accounts must CLEAR the other side, and PATCH leaves
            // omitted fields untouched.
            targetTags: [...(news.targetTags ?? [])],
            targetServiceAccounts: [...(news.targetServiceAccounts ?? [])],
            disabled: news.disabled ?? false,
          });

          // 1. Observe — collapse 403 to "missing" alongside 404.
          let observed = yield* observe(news.project, desiredName);

          // 2. Ensure — create if missing. `Conflict` covers concurrent
          //    creates and state-persistence races.
          if (!observed) {
            const op = yield* insertFirewalls({
              project: news.project,
              body: {
                name: desiredName,
                network: news.network,
                ...(news.direction ? { direction: news.direction } : {}),
                ...mutableBody(),
              },
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as compute.Operation | undefined),
              ),
            );
            if (op?.name) yield* awaitOp(news.project, op.name, session);
            observed = yield* getFirewalls({
              project: news.project,
              firewall: desiredName,
            });
          }

          // 3. Sync — everything except name/network/direction is
          //    PATCHable. Diff against OBSERVED state (cloud is
          //    authoritative), order-insensitively.
          const desired = mutableBody();
          if (!deepEqual(normalized(observed), normalized(desired))) {
            const op = yield* patchFirewalls({
              project: news.project,
              firewall: desiredName,
              body: desired,
            });
            if (op.name) yield* awaitOp(news.project, op.name, session);
          }

          const final = yield* getFirewalls({
            project: news.project,
            firewall: desiredName,
          });
          return toFirewallAttributes(final, { project: news.project });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* deleteFirewalls({
            project: output.project,
            firewall: output.name,
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
          const attrs = toFirewallAttributes(observed, { project });
          // Adoption gate via the description marker — firewalls have
          // no labels field (same situation as GCP.Network).
          return (yield* descriptionHasAlchemyMarker(id, observed.description))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
