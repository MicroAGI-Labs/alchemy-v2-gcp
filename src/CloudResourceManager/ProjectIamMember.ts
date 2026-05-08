import * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

/**
 * Bind a single `(role, member)` IAM grant onto a {@link Project}.
 *
 * Target-side binding — see
 * {@link import("../Compute/SubnetworkIamMember.ts").subnetworkIamMember}
 * for the pattern, the SID-collision pitfall, and why `key` exists.
 * Project's `reconcile` merges all bindings into a single
 * `setIamPolicy` against the project, preserving foreign roles +
 * members.
 *
 * @example Granting GKE service agent host-service-agent-user on a Shared VPC host
 * ```typescript
 * yield* GCP.projectIamMember(hostProject, "ClusterA-HostSvcAgent", {
 *   role: "roles/container.hostServiceAgentUser",
 *   member: gkeAgentMember,
 * });
 * ```
 */
export const projectIamMember = (
  project: Project,
  key: string,
  args: { role: string; member: string },
): Effect.Effect<void> =>
  project.bind`IamMember(${project}, ${key})`({
    iamBindings: [{ role: args.role, members: [args.member] }],
  }) as unknown as Effect.Effect<void>;
