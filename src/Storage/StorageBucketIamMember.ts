import { ConfigError } from "@distilled.cloud/gcp";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as GCP from "../Providers.ts";

/**
 * A single `(role, member)` IAM binding entry on an **existing** GCS
 * bucket that this stack does not manage. Contrast with
 * {@link storageBucketIamMember}, the target-side binding helper: that
 * one requires a stack-owned {@link StorageBucket} and is additive-only
 * (bindings written into the bucket's binding bag are merged on
 * reconcile but never pruned). This standalone resource takes the raw
 * bucket name, adds the member on reconcile, and — the part the helper
 * cannot do — **removes it again on delete**, so grants revoke when the
 * declaring resource leaves the stack.
 *
 * Identity is the `(bucket, role, member, condition.expression)` tuple;
 * all are immutable — changing any replaces (the old grant is revoked,
 * the new one granted).
 *
 * With a `condition`, the member lands in the binding whose condition
 * **expression** matches (CEL, compared byte-for-byte) — the binding is
 * created with the given title/description if absent. Title and
 * description are create-time metadata only: an existing binding with
 * the same expression but a different title is adopted as-is, never
 * retitled (that lets hand-applied conditional grants converge into the
 * stack without a duplicate binding). Conditional bindings require the
 * bucket to have uniform bucket-level access (GCS rejects conditions
 * otherwise) and policy version 3 — the read-modify-write here always
 * requests/writes version 3.
 *
 * The read-modify-write on the shared bucket policy is member-scoped:
 * exactly one member is added/removed, every foreign role and member is
 * preserved verbatim, and the whole cycle retries with backoff so
 * concurrent writers on the same bucket compose safely (GCS rejects a
 * stale-etag set with `Conflict`/`PreconditionFailed`).
 *
 * There is nothing GCP-side to carry alchemy ownership labels on an IAM
 * binding, so `read` has no `Unowned` adoption gate — presence of the
 * exact member under the exact role IS the resource.
 *
 * @section Granting on an unmanaged bucket
 * @example Read access for a collaborator group's namespace identity
 * ```typescript
 * yield* GCP.StorageBucketIamMember("SrlPackagingRead", {
 *   bucket: "srl_200hr_packaging",
 *   role: "roles/storage.objectViewer",
 *   member:
 *     "principal://iam.googleapis.com/projects/864268824536/locations/global/workloadIdentityPools/micro-research-cluster-a.svc.id.goog/subject/ns/collab-srl/sa/default",
 * });
 * ```
 *
 * @section Prefix-scoped read on a customer bucket
 * @example Conditional grant limited to one object prefix (+ bucket-level list)
 * ```typescript
 * yield* GCP.StorageBucketIamMember("QaDatasetRead", {
 *   bucket: "golden-zone-prod-770927",
 *   role: "roles/storage.objectViewer",
 *   member: "principal://iam.googleapis.com/…/subject/ns/collab-jeffrey-coworking/sa/default",
 *   condition: {
 *     title: "collab-jeffrey-coworking",
 *     expression:
 *       'resource.name.startsWith("projects/_/buckets/golden-zone-prod-770927/objects/qa/") || resource.name == "projects/_/buckets/golden-zone-prod-770927"',
 *   },
 * });
 * ```
 */
export type StorageBucketIamMemberCondition = {
  /**
   * Binding title — create-time metadata only. NOT identity: a live
   * binding with the same expression but another title is adopted, not
   * retitled/replaced.
   */
  title: string;
  /** Optional human note on the binding. Create-time metadata only. */
  description?: string;
  /**
   * CEL condition expression. Part of the resource identity — compared
   * byte-for-byte against live bindings' expressions, so keep the
   * rendering deterministic. Immutable — replace.
   */
  expression: string;
};

export type StorageBucketIamMemberProps = {
  /**
   * Name of the (pre-existing) GCS bucket to grant on. The bucket is
   * NOT created, adopted, or deleted by this resource. Immutable —
   * replace.
   */
  bucket: string;
  /** IAM role, e.g. `roles/storage.objectViewer`. Immutable — replace. */
  role: string;
  /**
   * IAM member string (`serviceAccount:…`, `principal://…`,
   * `group:…`, …). Immutable — replace.
   */
  member: string;
  /**
   * Optional IAM Condition scoping the grant (e.g. to an object
   * prefix). Absent → the member joins the role's UNCONDITIONAL
   * binding. The condition **expression** is identity (immutable —
   * replace); title/description are create-time metadata. Requires
   * uniform bucket-level access on the bucket.
   */
  condition?: StorageBucketIamMemberCondition;
};

export type StorageBucketIamMemberAttributes = {
  /** Bucket name, threaded through from props. */
  bucket: string;
  /** IAM role, threaded through from props. */
  role: string;
  /** IAM member, threaded through from props. */
  member: string;
  /** IAM Condition, threaded through from props (absent = unconditional). */
  condition?: StorageBucketIamMemberCondition;
};

export type StorageBucketIamMember = Resource<
  "GCP.StorageBucketIamMember",
  StorageBucketIamMemberProps,
  StorageBucketIamMemberAttributes,
  never,
  GCP.Providers
>;

export const StorageBucketIamMember = Resource<StorageBucketIamMember>(
  "GCP.StorageBucketIamMember",
);

export const StorageBucketIamMemberProvider = () =>
  Provider.effect(
    StorageBucketIamMember,
    Effect.gen(function* () {
      const getIamPolicyBuckets = yield* storage.getIamPolicyBuckets;
      const setIamPolicyBuckets = yield* storage.setIamPolicyBuckets;

      // Same backoff as StorageBucket's syncIam: the get→set cycle races
      // other writers on the bucket policy (including sibling instances
      // of this resource); a stale etag fails the set, the retry re-reads.
      // ConfigError (bucket doesn't exist) is a terminal misconfiguration
      // — fail fast instead of burning the ~8-minute backoff on it.
      const etagRetry = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
        eff.pipe(
          Effect.retry({
            while: (e) => (e as { _tag?: string })?._tag !== "ConfigError",
            schedule: Schedule.max([
              Schedule.exponential(Duration.seconds(2)),
              Schedule.recurs(8),
            ]),
          }),
        );

      // Binding selector: with no condition, ONLY the unconditional
      // binding for `role` (conditional bindings are someone else's);
      // with a condition, the binding whose expression matches
      // byte-for-byte — title/description deliberately ignored so
      // hand-applied grants with the same expression are adopted.
      const bindingMatches = (
        b: { role?: string; condition?: { expression?: string } },
        role: string,
        condition?: StorageBucketIamMemberCondition,
      ) =>
        b.role === role &&
        (condition
          ? b.condition?.expression === condition.expression
          : !b.condition);

      const hasMember = (
        policy: storage.Policy,
        role: string,
        member: string,
        condition?: StorageBucketIamMemberCondition,
      ) =>
        (policy.bindings ?? []).some(
          (b) =>
            bindingMatches(b, role, condition) &&
            (b.members ?? []).includes(member),
        );

      return {
        // Identity IS the tuple; all fields are static values.
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        stables: ["bucket", "role", "member", "condition"],
        diff: Effect.fn(function* ({ news, olds = {}, output }) {
          if (!isResolved(news)) return undefined;
          // Prior identity from persisted attributes first, then olds —
          // mirrors Bucket.ts (`output?.name || olds.name`). `||`, not
          // `??`: an empty string in a partially-persisted attribute is
          // NOT a prior identity — treating it as one would force a
          // spurious replace whose delete targets the wrong (empty)
          // identity. If only `output` survives (e.g. props were lost),
          // a changed triple must still replace, or the old member is
          // never revoked.
          const priorBucket = output?.bucket || olds.bucket;
          const priorRole = output?.role || olds.role;
          const priorMember = output?.member || olds.member;
          if (
            (priorBucket && priorBucket !== news.bucket) ||
            (priorRole && priorRole !== news.role) ||
            (priorMember && priorMember !== news.member)
          ) {
            return { action: "replace" } as const;
          }
          // Condition expression is identity too — but only when a prior
          // identity exists at all (a partially-persisted record with no
          // bucket names no grant to revoke). Absent condition compares
          // as "" so unconditional↔conditional flips replace, while a
          // 0.10.x record (no condition attribute) vs. unconditional
          // props stays a no-op. `||` like the triple above: an empty
          // persisted expression is NOT a prior identity and must not
          // block the olds fallback.
          const priorCond =
            output?.condition?.expression || olds.condition?.expression || "";
          const newsCond = news.condition?.expression ?? "";
          if (priorBucket && priorCond !== newsCond) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news }) {
          yield* etagRetry(
            Effect.gen(function* () {
              const current = yield* getIamPolicyBuckets({
                bucket: news.bucket,
                optionsRequestedPolicyVersion: 3,
              }).pipe(
                Effect.catchTag("NotFound", () =>
                  Effect.fail(
                    new ConfigError({
                      message: `Bucket ${news.bucket} does not exist — StorageBucketIamMember grants on pre-existing buckets only.`,
                    }),
                  ),
                ),
              );
              if (hasMember(current, news.role, news.member, news.condition)) {
                return;
              }

              const bindings = (current.bindings ?? []).map((b) => ({
                ...b,
                members: [...(b.members ?? [])],
              }));
              const existing = bindings.find((b) =>
                bindingMatches(b, news.role, news.condition),
              );
              if (existing) {
                existing.members = [...(existing.members ?? []), news.member];
              } else {
                bindings.push({
                  role: news.role,
                  members: [news.member],
                  ...(news.condition
                    ? {
                        condition: {
                          title: news.condition.title,
                          ...(news.condition.description
                            ? { description: news.condition.description }
                            : {}),
                          expression: news.condition.expression,
                        },
                      }
                    : {}),
                });
              }
              yield* setIamPolicyBuckets({
                bucket: news.bucket,
                body: { ...current, bindings, version: 3 },
              });
            }),
          );
          return {
            bucket: news.bucket,
            role: news.role,
            member: news.member,
            ...(news.condition ? { condition: news.condition } : {}),
          };
        }),
        delete: Effect.fn(function* ({ output, olds }) {
          // Partially-persisted attributes (empty fields) name no real
          // grant — nothing to revoke, and getIamPolicy("") would 4xx.
          if (!output.bucket || !output.role || !output.member) return;
          // Prior condition with an olds fallback: if the persisted
          // attributes lost the condition while the live binding is
          // conditional, matching without it would target the
          // UNCONDITIONAL binding — either revoking a member some other
          // resource owns there, or no-op'ing and leaving the scoped
          // grant behind. Selected on expression TRUTHINESS (same rule
          // as diff's `||` chain): a stub condition with an empty
          // expression is not a prior identity and must not block olds.
          const condition = output.condition?.expression
            ? output.condition
            : olds?.condition?.expression
              ? olds.condition
              : undefined;
          yield* etagRetry(
            Effect.gen(function* () {
              const current = yield* getIamPolicyBuckets({
                bucket: output.bucket,
                optionsRequestedPolicyVersion: 3,
              }).pipe(
                // Bucket gone (or unreadable because gone) — the grant
                // went with it; idempotent success.
                Effect.catchTag("NotFound", () =>
                  Effect.succeed(undefined as storage.Policy | undefined),
                ),
              );
              if (
                !current ||
                !hasMember(current, output.role, output.member, condition)
              ) {
                return;
              }
              // Remove exactly our member from the matched binding;
              // drop the binding entirely if that empties it (GCS rejects
              // bindings with zero members).
              const bindings = (current.bindings ?? [])
                .map((b) =>
                  bindingMatches(b, output.role, condition)
                    ? {
                        ...b,
                        members: (b.members ?? []).filter(
                          (m) => m !== output.member,
                        ),
                      }
                    : { ...b, members: [...(b.members ?? [])] },
                )
                .filter((b) => (b.members?.length ?? 0) > 0);
              yield* setIamPolicyBuckets({
                bucket: output.bucket,
                body: { ...current, bindings, version: 3 },
              }).pipe(Effect.catchTag("NotFound", () => Effect.void));
            }),
          );
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const bucket = output?.bucket ?? olds?.bucket;
          const role = output?.role ?? olds?.role;
          const member = output?.member ?? olds?.member;
          const condition = output?.condition ?? olds?.condition;
          if (!bucket || !role || !member) return undefined;
          const current = yield* getIamPolicyBuckets({
            bucket,
            optionsRequestedPolicyVersion: 3,
          }).pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed(undefined as storage.Policy | undefined),
            ),
            Effect.catchTag("Forbidden", () =>
              Effect.succeed(undefined as storage.Policy | undefined),
            ),
          );
          if (!current) return undefined;
          // Absent member → undefined: the engine treats that as drift
          // and the next plan re-grants.
          if (!hasMember(current, role, member, condition)) return undefined;
          return {
            bucket,
            role,
            member,
            ...(condition ? { condition } : {}),
          };
        }),
      };
    }),
  );
