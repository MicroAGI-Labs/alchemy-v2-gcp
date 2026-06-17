import * as Effect from "effect/Effect";
import type { ServiceAccount } from "./ServiceAccount.ts";

/**
 * Bind a single `(role, member)` IAM grant onto a {@link ServiceAccount}.
 *
 * This is a **target-side binding** — it records the grant onto the
 * GSA's binding bag (`stack.bindings[gsa]`); the ServiceAccount
 * provider's `reconcile` later merges all such bindings (across all
 * callers, including parallel ones from different stack stages) into
 * a single `setIamPolicy` call on the GSA. Same pattern as
 * `projectIamMember` / `subnetworkIamMember`.
 *
 * Identity for dedup: the rendered SID is `IamMember(<gsa>, <key>)`.
 * The engine collapses binds by SID, so callers MUST supply a
 * stack-unique `key` per (gsa, role, member) triple — otherwise a
 * later bind silently overwrites an earlier one with the same key.
 *
 * The reason `key` exists: `member` is usually an `Output<string>`
 * (e.g. `Output.interpolate\`...${cluster.projectId}...\``), and
 * `Output` expressions stringify by their AST shape, not by the
 * eventual value. Two interpolations of the same shape but different
 * literal templates render the same SID. `key` sidesteps that by
 * forcing a static, caller-supplied label into the SID.
 *
 * Use this for the "Pulumi `gcp.serviceAccount.IAMMember`" pattern:
 * authoritative-for-(role, member)-tuple, additive (does not displace
 * other members on the same role).
 *
 * @example Workload Identity binding for one cluster
 * ```typescript
 * yield* GCP.serviceAccountIamMember(gsa, "ClusterA-WorkloadIdentity", {
 *   role: "roles/iam.workloadIdentityUser",
 *   member: `serviceAccount:${clusterA.projectId}.svc.id.goog[researchers/build]`,
 * });
 * ```
 *
 * @example Same GSA, second cluster (separate key → distinct SID)
 * ```typescript
 * yield* GCP.serviceAccountIamMember(gsa, "ClusterB-WorkloadIdentity", {
 *   role: "roles/iam.workloadIdentityUser",
 *   member: `serviceAccount:${clusterB.projectId}.svc.id.goog[researchers/build]`,
 * });
 * ```
 */
export const serviceAccountIamMember = (
  gsa: ServiceAccount,
  key: string,
  args: { role: string; member: string },
): Effect.Effect<void> =>
  // Tagged-template `.bind` records into the target's binding bag.
  // ServiceAccount's reconcile sees `bindings: ResourceBinding<…>[]`
  // and merges all entries by role into one setIamPolicy call.
  gsa.bind`IamMember(${gsa}, ${key})`({
    iamBindings: [{ role: args.role, members: [args.member] }],
  }) as unknown as Effect.Effect<void>;
