import { ConfigError } from "@distilled.cloud/gcp";
import * as storage from "@distilled.cloud/gcp/storage-v1";
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
 * Identity is the `(bucket, role, member)` triple; all three are
 * immutable — changing any replaces (the old triple is revoked, the new
 * one granted).
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
 */
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
};

export type StorageBucketIamMemberAttributes = {
  /** Bucket name, threaded through from props. */
  bucket: string;
  /** IAM role, threaded through from props. */
  role: string;
  /** IAM member, threaded through from props. */
  member: string;
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
            schedule: Schedule.exponential(Duration.seconds(2)).pipe(
              Schedule.both(Schedule.recurs(8)),
            ),
          }),
        );

      // Membership check scoped to the unconditional binding for `role`
      // — conditional bindings are someone else's and never touched.
      const hasMember = (
        policy: storage.Policy,
        role: string,
        member: string,
      ) =>
        (policy.bindings ?? []).some(
          (b) => b.role === role && !b.condition && (b.members ?? []).includes(member),
        );

      return {
        // Identity IS the triple; all three are static strings.
        stables: ["bucket", "role", "member"],
        diff: Effect.fn(function* ({ news, olds = {}, output }) {
          if (!isResolved(news)) return undefined;
          // Prior identity from persisted attributes first, then olds —
          // mirrors Bucket.ts. If only `output` survives (e.g. props were
          // lost), a changed triple must still replace, or the old member
          // is never revoked.
          const priorBucket = output?.bucket ?? olds.bucket;
          const priorRole = output?.role ?? olds.role;
          const priorMember = output?.member ?? olds.member;
          if (
            (priorBucket !== undefined && priorBucket !== news.bucket) ||
            (priorRole !== undefined && priorRole !== news.role) ||
            (priorMember !== undefined && priorMember !== news.member)
          ) {
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
              if (hasMember(current, news.role, news.member)) return;

              const bindings = (current.bindings ?? []).map((b) => ({
                ...b,
                members: [...(b.members ?? [])],
              }));
              const existing = bindings.find(
                (b) => b.role === news.role && !b.condition,
              );
              if (existing) {
                existing.members = [...(existing.members ?? []), news.member];
              } else {
                bindings.push({ role: news.role, members: [news.member] });
              }
              yield* setIamPolicyBuckets({
                bucket: news.bucket,
                body: { ...current, bindings, version: 3 },
              });
            }),
          );
          return { bucket: news.bucket, role: news.role, member: news.member };
        }),
        delete: Effect.fn(function* ({ output }) {
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
              if (!current || !hasMember(current, output.role, output.member)) {
                return;
              }
              // Remove exactly our member from the unconditional binding;
              // drop the binding entirely if that empties it (GCS rejects
              // bindings with zero members).
              const bindings = (current.bindings ?? [])
                .map((b) =>
                  b.role === output.role && !b.condition
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
          if (!hasMember(current, role, member)) return undefined;
          return { bucket, role, member };
        }),
      };
    }),
  );
