import type * as run from "@distilled.cloud/gcp/run_v2";
import type { ResourceBinding } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Common shape of Cloud Run's `getIamPolicy` / `setIamPolicy` request
 * inputs — Service and Job declare nominally distinct request types,
 * but both reduce to `{ resource, body? }` plus the version query for
 * get. We model the operation surface generically so {@link makeSyncIam}
 * can serve both targets without duplication.
 *
 * @internal
 */
type GetIamPolicyOp = (input: {
  resource: string;
  "options.requestedPolicyVersion"?: number;
}) => Effect.Effect<run.GoogleIamV1Policy, unknown, never>;

type SetIamPolicyOp = (input: {
  resource: string;
  body?: run.GoogleIamV1SetIamPolicyRequest;
}) => Effect.Effect<run.GoogleIamV1Policy, unknown, never>;

/**
 * Single `(role, members)` entry on a Cloud Run target's IAM policy.
 * Identical shape between Service and Job — both Cloud Run resources
 * speak the same `iam.v1.Policy`, so the binding contract is shared.
 *
 * @example
 * ```typescript
 * yield* GCP.serviceIamMember(svc, "PublicInvoker", {
 *   role: "roles/run.invoker",
 *   member: "allUsers",
 * });
 * ```
 */
export type RunIamBinding = {
  /** IAM role, e.g. `"roles/run.invoker"`. */
  role: string;
  /** Principals, e.g. `["allUsers"]` or `["serviceAccount:foo@bar.iam.gserviceaccount.com"]`. */
  members: ReadonlyArray<string>;
};

/**
 * Binding contract for a Cloud Run target — services and jobs both
 * accept a list of `iamBindings` records via the alchemy `.bind`
 * mechanism. The reconciler reads `bindings` from its arguments and
 * routes them through {@link makeSyncIam}.
 */
export type RunIamBindingContract = {
  iamBindings: ReadonlyArray<RunIamBinding>;
};

/**
 * Build a reusable `syncIam` step parametrised by the resolved
 * `getIamPolicy` / `setIamPolicy` callables. Cloud Run's Service and
 * Job IAM endpoints have identical request/response shapes (both
 * `resource: "projects/{p}/locations/{l}/{kind}/{n}"`), so the same
 * helper works for both — the caller just hands in the right pair of
 * callables.
 *
 * Semantics, mirroring `Compute/Subnetwork.ts`:
 *
 * - **Union bindings per role across all `.bind` callers.** Multiple
 *   capabilities granting the same role get their members merged into
 *   a single binding.
 * - **Preserve foreign roles and members verbatim.** We never displace
 *   bindings we didn't author. The provider is additive — to remove a
 *   binding, drop the `.bind` call and re-deploy (a future revision
 *   could narrow this; for now it matches the existing idiom).
 * - **Etag round-trip.** `getIamPolicy` returns an etag; we pass it
 *   through `setIamPolicy` so a concurrent edit racing us surfaces as
 *   `Conflict`. We retry exponentially up to ~1.5 min — enough to
 *   absorb normal CI/human contention without masking real failures.
 */
export const makeSyncIam =
  (api: { getIamPolicy: GetIamPolicyOp; setIamPolicy: SetIamPolicyOp }) =>
  (args: {
    /** Fully-qualified resource name: `projects/{p}/locations/{l}/{kind}/{n}`. */
    resource: string;
    bindings: ReadonlyArray<ResourceBinding<RunIamBindingContract>>;
  }) =>
    Effect.gen(function* () {
      const desiredByRole = new Map<string, Set<string>>();
      for (const b of args.bindings) {
        for (const ib of b.data.iamBindings) {
          const set = desiredByRole.get(ib.role) ?? new Set<string>();
          for (const m of ib.members) set.add(m);
          desiredByRole.set(ib.role, set);
        }
      }
      if (desiredByRole.size === 0) return;

      const current = yield* api.getIamPolicy({
        resource: args.resource,
        "options.requestedPolicyVersion": 3,
      });

      const bindings = (current.bindings ?? []).map((b) => ({
        ...b,
        members: [...(b.members ?? [])],
      }));
      let mutated = false;
      for (const [role, members] of desiredByRole) {
        let existing = bindings.find((b) => b.role === role && !b.condition);
        if (!existing) {
          existing = { role, members: [] };
          bindings.push(existing);
        }
        const merged = new Set([...(existing.members ?? []), ...members]);
        if (merged.size !== (existing.members?.length ?? 0)) mutated = true;
        existing.members = [...merged];
      }
      if (!mutated) return;

      yield* api.setIamPolicy({
        resource: args.resource,
        body: {
          policy: {
            ...current,
            bindings,
            version: 3,
          },
        },
      });
    }).pipe(
      Effect.retry({
        schedule: Schedule.max([
          Schedule.exponential(Duration.seconds(2)),
          Schedule.recurs(8),
        ]),
      }),
    );
