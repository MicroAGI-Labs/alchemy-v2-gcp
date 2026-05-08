import * as Effect from "effect/Effect";
import type { Subnetwork } from "./Subnetwork.ts";

/**
 * Bind a single `(role, member)` IAM grant onto a {@link Subnetwork}.
 *
 * This is a **target-side binding** — it records the grant onto the
 * subnet's binding bag (`stack.bindings[subnet]`); the Subnetwork
 * provider's `reconcile` later merges all such bindings (across all
 * callers, including parallel ones from different cluster projects)
 * into a single `setIamPolicy` call on the subnet.
 *
 * Identity for dedup: the rendered SID is `IamMember(<subnet>, <key>)`.
 * The engine collapses binds by SID, so callers MUST supply a
 * stack-unique `key` per (subnet, role, member) triple — otherwise a
 * later bind silently overwrites an earlier one with the same key.
 *
 * The reason `key` exists: `member` is usually an `Output<string>`
 * (e.g. `Output.interpolate\`...${proj.projectNumber}...\``), and
 * `Output` expressions stringify by their AST shape, not by the
 * eventual value. Two interpolations of the same shape but different
 * literal templates render the same SID. `key` sidesteps that by
 * forcing a static, caller-supplied label into the SID.
 *
 * Use this for the "Pulumi `gcp.compute.SubnetworkIAMMember`" pattern:
 * authoritative-for-(role, member)-tuple, additive (does not displace
 * other members on the same role).
 *
 * @example Granting GKE Standard cluster networkUser on a Shared VPC subnet
 * ```typescript
 * yield* GCP.subnetworkIamMember(subnet, "ClusterA-GkeAgent", {
 *   role: "roles/compute.networkUser",
 *   member: gkeAgentMember,
 * });
 * yield* GCP.subnetworkIamMember(subnet, "ClusterA-CloudSvc", {
 *   role: "roles/compute.networkUser",
 *   member: cloudServicesMember,
 * });
 * // → one setIamPolicy on `subnet` with both members under networkUser.
 * ```
 */
export const subnetworkIamMember = (
  subnet: Subnetwork,
  key: string,
  args: { role: string; member: string },
): Effect.Effect<void> =>
  // Tagged-template `.bind` records into the target's binding bag.
  // Subnetwork's reconcile sees `bindings: ResourceBinding<…>[]` and
  // merges all entries by role into one setIamPolicy call.
  subnet.bind`IamMember(${subnet}, ${key})`({
    iamBindings: [{ role: args.role, members: [args.member] }],
  }) as unknown as Effect.Effect<void>;
