import * as Effect from "effect/Effect";
import type { StorageBucket } from "./Bucket.ts";

/**
 * Bind a single `(role, member)` IAM grant onto a
 * {@link StorageBucket}.
 *
 * Target-side binding — same pattern as
 * {@link import("../CloudResourceManager/ProjectIamMember.ts").projectIamMember}
 * / `serviceAccountIamMember`. The bucket's `reconcile` merges all
 * bindings into a single `setIamPolicy` call on the bucket, preserving
 * foreign roles + members.
 *
 * Identity for dedup: the rendered SID is `IamMember(<bucket>, <key>)`.
 * The engine collapses binds by SID, so callers MUST supply a
 * stack-unique `key` per (bucket, role, member) triple.
 *
 * @example Granting a service account read+write on a bucket
 * ```typescript
 * yield* GCP.storageBucketIamMember(bucket, "TempBucketRw", {
 *   role: "roles/storage.objectUser",
 *   member: `serviceAccount:${sa.email}`,
 * });
 * ```
 */
export const storageBucketIamMember = (
  bucket: StorageBucket,
  key: string,
  args: { role: string; member: string },
): Effect.Effect<void> =>
  bucket.bind`IamMember(${bucket}, ${key})`({
    iamBindings: [{ role: args.role, members: [args.member] }],
  }) as unknown as Effect.Effect<void>;
