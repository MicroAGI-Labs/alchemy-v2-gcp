import { ConfigError } from "@distilled.cloud/gcp";
import * as storage from "@distilled.cloud/gcp/storage-v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { diffTags } from "alchemy/Tags";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  gcpInternalLabels,
  hasAlchemyLabels,
} from "../Tags.ts";
import type * as GCP from "../Providers.ts";

/**
 * A GCS bucket. Lives under a
 * {@link import("../CloudResourceManager/Project.ts").Project} and serves
 * as the target for {@link storageBucketIamMember} bindings (bucket-level
 * IAM grants merged into a single `setIamPolicy` call).
 *
 * Adoption is gated on alchemy internal labels (`alchemy_app` /
 * `alchemy_stage` / `alchemy_id`) — GCS buckets support labels, so the
 * same label-based adoption gate as `Project` applies. The labels are
 * merged into the user-supplied label set on create and never cleared.
 *
 * All lifecycle operations (`insertBuckets`, `getBuckets`, `patchBuckets`,
 * `deleteBuckets`) are synchronous — no LRO polling required.
 *
 * @section Creating a StorageBucket
 * @example Bucket with a 48-hour object TTL
 * ```typescript
 * const bucket = yield* GCP.StorageBucket("TempBucket", {
 *   project: project.projectId,
 *   name: "microagi-shared-temp",
 *   location: "europe-west4",
 *   storageClass: "STANDARD",
 *   lifecycle: {
 *     rule: [{
 *       action: { type: "Delete" },
 *       condition: { age: 2 },  // 2 days = 48 hours
 *     }],
 *   },
 * });
 * ```
 */
export type StorageBucketProps = {
  /**
   * GCP project id (e.g. `micro-research-shared`) the bucket lives
   * under. Immutable — changing this orphans the bucket and its IAM
   * bindings, so `diff` triggers a replacement.
   */
  project: string;
  /**
   * The bucket name. Must be globally unique, 3-222 chars, lowercase
   * letters, digits, hyphens, underscores, and dots. Immutable —
   * replaces.
   */
  name: string;
  /**
   * Bucket location, e.g. `europe-west4` (single region) or `EU`
   * (multi-region). Immutable — replaces.
   */
  location: string;
  /**
   * Storage class, e.g. `STANDARD`, `NEARLINE`, `COLDLINE`,
   * `ARCHIVE`. Defaults to `STANDARD` server-side. Mutable.
   */
  storageClass?: string;
  /**
   * Bucket lifecycle configuration. Used for object TTL (e.g.
   * `{ rule: [{ action: { type: "Delete" }, condition: { age: 2 } }] }`
   * deletes objects older than 2 days). Mutable.
   */
  lifecycle?: storage.Bucket["lifecycle"];
  /**
   * User-supplied labels. The alchemy internal labels are merged
   * automatically (see `gcpInternalLabels`). Alchemy keys are reserved
   * and overwrite user-supplied collisions.
   */
  labels?: Record<string, string>;
  /**
   * Whether uniform bucket-level access is enabled. Defaults to
   * `true` (recommended — ACLs are disabled, IAM is the sole authz
   * path). Mutable.
   */
  uniformBucketLevelAccess?: boolean;
};

/**
 * Single (role, members) entry on a bucket's IAM policy. Targets
 * declare this contract so {@link storageBucketIamMember} can `.bind`
 * IAM grants onto the bucket — the provider's `reconcile` merges all
 * bound entries by role into a single `setIamPolicy` call.
 */
export type StorageBucketIamBinding = {
  /** IAM role, e.g. `"roles/storage.objectUser"`. */
  role: string;
  /** Principals, e.g. `["serviceAccount:sa@project.iam.gserviceaccount.com"]`. */
  members: ReadonlyArray<string>;
};

export type StorageBucketBindingContract = {
  iamBindings: ReadonlyArray<StorageBucketIamBinding>;
};

export type StorageBucket = Resource<
  "GCP.StorageBucket",
  StorageBucketProps,
  {
    /** Bucket name (same as the prop). */
    name: string;
    /** Bucket ID (server-assigned, same as name for buckets). */
    id: string;
    /** Self-link URL. */
    selfLink: string;
    /** Bucket location. */
    location: string;
    /** Storage class. */
    storageClass: string | undefined;
    /** Lifecycle configuration. */
    lifecycle: storage.Bucket["lifecycle"];
    /** Labels (including alchemy internal labels). */
    labels: Record<string, string> | undefined;
    /** Metageneration (changes on metadata updates). */
    metageneration: string;
    /** Creation time (RFC 3339). */
    timeCreated: string;
    /** Last update time (RFC 3339). */
    updated: string;
  },
  StorageBucketBindingContract,
  GCP.Providers
>;

export const StorageBucket = Resource<StorageBucket>("GCP.StorageBucket");

const toAttributes = (b: storage.Bucket): StorageBucket["Attributes"] => ({
  name: b.name ?? "",
  id: b.id ?? b.name ?? "",
  selfLink: b.selfLink ?? "",
  location: b.location ?? "",
  storageClass: b.storageClass,
  lifecycle: b.lifecycle,
  labels: b.labels as Record<string, string> | undefined,
  metageneration: b.metageneration ?? "",
  timeCreated: b.timeCreated ?? "",
  updated: b.updated ?? "",
});

export const StorageBucketProvider = () =>
  Provider.effect(
    StorageBucket,
    Effect.gen(function* () {
      const getBuckets = yield* storage.getBuckets;
      const insertBuckets = yield* storage.insertBuckets;
      const patchBuckets = yield* storage.patchBuckets;
      const deleteBuckets = yield* storage.deleteBuckets;
      const listBuckets = yield* storage.listBuckets;
      const getIamPolicyBuckets = yield* storage.getIamPolicyBuckets;
      const setIamPolicyBuckets = yield* storage.setIamPolicyBuckets;

      const observeBucket = (name: string) =>
        getBuckets({ bucket: name }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as storage.Bucket | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as storage.Bucket | undefined),
          ),
        );

      const requireBucket = (name: string, context: string) =>
        observeBucket(name).pipe(
          Effect.flatMap((b) =>
            b
              ? Effect.succeed(b)
              : Effect.fail(
                  new ConfigError({
                    message: `Bucket ${name} ${context}.`,
                  }),
                ),
          ),
        );

      // List-scan for cold recovery. Alchemy labels on the bucket
      // identify our resources; the prefix narrows the scan.
      const findByAlchemyLabels = Effect.fn(function* (
        id: string,
        project: string,
        name: string,
      ) {
        let pageToken: string | undefined;
        for (let i = 0; i < 100; i++) {
          const page = yield* listBuckets({
            project,
            prefix: name.slice(0, Math.min(name.length, 10)),
            maxResults: 100,
            ...(pageToken ? { pageToken } : {}),
          });
          for (const b of page.items ?? []) {
            if (b.name === name && (yield* hasAlchemyLabels(id, b.labels as Record<string, string> | undefined))) {
              return b;
            }
          }
          pageToken = page.nextPageToken;
          if (!pageToken) return undefined;
        }
        return undefined;
      });

      // Sync mutable fields: storageClass, lifecycle, labels,
      // uniformBucketLevelAccess. Uses PATCH with the full bucket body
      // (GCS patch semantics merge supplied fields). Diff against
      // OBSERVED state, not `olds`, so adoption converges correctly.
      const syncMutable = Effect.fn(function* (
        observed: storage.Bucket,
        desired: {
          storageClass: string | undefined;
          lifecycle: storage.Bucket["lifecycle"];
          labels: Record<string, string>;
          uniformBucketLevelAccess: boolean;
        },
      ) {
        const needsUpdate =
          desired.storageClass !== observed.storageClass ||
          JSON.stringify(desired.lifecycle) !==
            JSON.stringify(observed.lifecycle) ||
          JSON.stringify(desired.labels) !==
            JSON.stringify(observed.labels ?? {}) ||
          desired.uniformBucketLevelAccess !==
            (observed.iamConfiguration?.uniformBucketLevelAccess?.enabled ?? false);

        if (!needsUpdate) return observed;

        return yield* patchBuckets({
          bucket: observed.name!,
          body: {
            storageClass: desired.storageClass,
            lifecycle: desired.lifecycle,
            labels: desired.labels,
            iamConfiguration: {
              uniformBucketLevelAccess: {
                enabled: desired.uniformBucketLevelAccess,
              },
            },
          },
        });
      });

      // Apply merged IAM bindings as a single setIamPolicy. Same
      // foreign-binding preservation + etag-retry pattern as
      // ServiceAccount's `syncIam`.
      const syncIam = (args: {
        bucketName: string;
        bindings: ReadonlyArray<
          import("alchemy/Resource").ResourceBinding<StorageBucketBindingContract>
        >;
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

          const current = yield* getIamPolicyBuckets({
            bucket: args.bucketName,
            optionsRequestedPolicyVersion: 3,
          });

          const existingBindings = (current.bindings ?? []).map((b) => ({
            ...b,
            members: [...(b.members ?? [])],
          }));
          let mutated = false;
          for (const [role, members] of desiredByRole) {
            let existing = existingBindings.find(
              (b) => b.role === role && !b.condition,
            );
            if (!existing) {
              existing = { role, members: [] };
              existingBindings.push(existing);
            }
            const merged = new Set([...(existing.members ?? []), ...members]);
            if (merged.size !== (existing.members?.length ?? 0)) mutated = true;
            existing.members = [...merged];
          }
          if (!mutated) return;

          yield* setIamPolicyBuckets({
            bucket: args.bucketName,
            body: {
              ...current,
              bindings: existingBindings,
              version: 3,
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

      return {
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        stables: ["name", "id", "selfLink", "location", "timeCreated"],
        diff: Effect.fn(function* ({ news, olds = {}, output }) {
          if (!isResolved(news)) return undefined;
          const priorName = output?.name || olds.name;
          const priorProject = olds.project;
          const priorLocation = olds.location;
          if (
            (priorName && news.name !== priorName) ||
            (priorProject && news.project !== priorProject) ||
            (priorLocation && news.location !== priorLocation)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, bindings, output }) {
          const internalLabels = yield* gcpInternalLabels(id);
          const mergedLabels = { ...(news.labels ?? {}), ...internalLabels };
          let created = false;

          // 1. Observe — cloud state is authoritative. Fall back to
          //    label-scan for cold recovery.
          let observed = yield* observeBucket(news.name);
          if (!observed) {
            observed = yield* findByAlchemyLabels(id, news.project, news.name);
          }

          // 2. Ensure — create if missing. insertBuckets is
          //    synchronous (returns the bucket, not an LRO). Conflict
          //    covers a peer reconciler race — re-observe.
          if (!observed) {
            observed = yield* insertBuckets({
              project: news.project,
              body: {
                name: news.name,
                location: news.location,
                storageClass: news.storageClass,
                lifecycle: news.lifecycle,
                labels: mergedLabels,
                iamConfiguration: {
                  uniformBucketLevelAccess: {
                    enabled: news.uniformBucketLevelAccess ?? true,
                  },
                },
              },
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as storage.Bucket | undefined),
              ),
            );
            created = !!observed;

            if (!observed) {
              observed = yield* requireBucket(news.name, "did not appear after create");
            }
          }

          // Refuse to mutate an existing unowned bucket on greenfield
          // create. The `read` handler returns Unowned(attrs) for
          // buckets without our labels, which gates adoption behind
          // --adopt. But reconcile runs before read on a first deploy,
          // so without this guard we'd sync mutable fields (labels,
          // lifecycle, UBLA) on a foreign bucket — bypassing the
          // adoption gate. Skip the check when we just created the
          // bucket (it has our labels) or when the engine already
          // adopted it (output is defined).
          if (
            !created &&
            !output &&
            !(yield* hasAlchemyLabels(
              id,
              observed.labels as Record<string, string> | undefined,
            ))
          ) {
            return yield* Effect.fail(
              new ConfigError({
                message:
                  `Bucket ${news.name} already exists without matching alchemy labels; use --adopt to take it over.`,
              }),
            );
          }

          // 3. Sync mutable fields against OBSERVED state.
          const synced = yield* syncMutable(observed, {
            storageClass: news.storageClass ?? observed.storageClass,
            lifecycle: news.lifecycle ?? observed.lifecycle,
            labels: mergedLabels,
            uniformBucketLevelAccess: news.uniformBucketLevelAccess ?? true,
          });

          // 4. Sync IAM bindings (storage.objectUser, etc.).
          yield* syncIam({
            bucketName: synced.name!,
            bindings,
          });

          return toAttributes(synced);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteBuckets({
            bucket: output.name,
          }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.catchTag("Forbidden", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const name = output?.name ?? olds?.name;
          const project = olds?.project as string | undefined;

          let observed: storage.Bucket | undefined;
          if (name) {
            observed = yield* observeBucket(name);
          }
          if (!observed && project) {
            observed = yield* findByAlchemyLabels(id, project, name ?? "");
          }
          if (!observed) return undefined;

          const attrs = toAttributes(observed);
          return (yield* hasAlchemyLabels(id, observed.labels as Record<string, string> | undefined))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
