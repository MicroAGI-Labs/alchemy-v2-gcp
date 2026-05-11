import * as Effect from "effect/Effect";
import type { Job } from "./Job.ts";
import type { Service } from "./Service.ts";

/**
 * Bind a single `(role, member)` IAM grant onto a Cloud Run
 * {@link Service}.
 *
 * Target-side binding — see
 * {@link import("../Compute/SubnetworkIamMember.ts").subnetworkIamMember}
 * for the pattern, the SID-collision pitfall, and why `key` exists.
 * Service's `reconcile` merges all bindings into a single
 * `setIamPolicy` call against the service, preserving foreign roles
 * and members on the policy. To remove a binding, drop the call and
 * re-deploy — the provider is additive within the bindings we
 * declared, but does NOT prune.
 *
 * The most common usage:
 *
 * - **Public invoker:** `{ role: "roles/run.invoker", member: "allUsers" }`
 *   makes the service publicly reachable. Prefer this over
 *   `invokerIamDisabled: true` on the {@link Service} props — declarative
 *   IAM is auditable in `setIamPolicy` history; `invokerIamDisabled`
 *   is a flag with no audit trail.
 * - **Service-to-service:** a downstream service's runtime SA bound
 *   to `roles/run.invoker` on the upstream service.
 *
 * @example Public Cloud Run service
 * ```typescript
 * const api = yield* GCP.Service("PublicApi", { ... });
 * yield* GCP.serviceIamMember(api, "PublicInvoker", {
 *   role: "roles/run.invoker",
 *   member: "allUsers",
 * });
 * ```
 *
 * @example Service-to-service auth
 * ```typescript
 * const upstream = yield* GCP.Service("Upstream", { ... });
 * yield* GCP.serviceIamMember(upstream, "DownstreamCaller", {
 *   role: "roles/run.invoker",
 *   member: `serviceAccount:${downstreamSa.email}`,
 * });
 * ```
 */
export const serviceIamMember = (
  service: Service,
  key: string,
  args: { role: string; member: string },
): Effect.Effect<void> =>
  service.bind`IamMember(${service}, ${key})`({
    iamBindings: [{ role: args.role, members: [args.member] }],
  }) as unknown as Effect.Effect<void>;

/**
 * Bind a single `(role, member)` IAM grant onto a Cloud Run {@link Job}.
 *
 * Same target-side pattern as {@link serviceIamMember}. The most
 * common Job binding is `roles/run.invoker` on the service account
 * that triggers the job (Cloud Scheduler, Eventarc, Workflows, or a
 * developer's user identity).
 *
 * @example Letting a Cloud Scheduler SA trigger the job
 * ```typescript
 * const nightly = yield* GCP.Job("Nightly", { ... });
 * yield* GCP.jobIamMember(nightly, "SchedulerInvoker", {
 *   role: "roles/run.invoker",
 *   member: `serviceAccount:${schedulerSa.email}`,
 * });
 * ```
 */
export const jobIamMember = (
  job: Job,
  key: string,
  args: { role: string; member: string },
): Effect.Effect<void> =>
  job.bind`IamMember(${job}, ${key})`({
    iamBindings: [{ role: args.role, members: [args.member] }],
  }) as unknown as Effect.Effect<void>;
