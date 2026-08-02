import { ConfigError } from "@distilled.cloud/gcp";
import * as iam from "@distilled.cloud/gcp/unstable/iam-v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import {
  descriptionHasAlchemyMarker,
  gcpAlchemyDescription,
  stripAlchemyMarker,
} from "../Tags.ts";
import type * as GCP from "../Providers.ts";
import { makeAwaitOperation } from "./Operations.ts";

/**
 * A Workload Identity **pool** — the trust boundary that lets identities from
 * outside GCP (another cloud's OIDC issuer, a Kubernetes cluster, a CI system)
 * impersonate a {@link import("./ServiceAccount.ts").ServiceAccount} without
 * anyone ever creating a service-account key.
 *
 * A pool on its own trusts nothing; it is a namespace. The trust is declared
 * by a {@link import("./WorkloadIdentityPoolProvider.ts").WorkloadIdentityPoolProvider}
 * inside it, and the grant by an `iam.workloadIdentityUser` binding on the
 * target GSA.
 *
 * ### Project number, not project ID
 *
 * The `principalSet://` member strings that reference this pool require the
 * project **number**, not its ID:
 *
 * ```
 * principalSet://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/POOL/*
 * ```
 *
 * A member string built with the project ID is accepted by `setIamPolicy`
 * and then silently never matches, which is a genuinely unpleasant thing to
 * debug. Prefer passing the project number as `project` so `name` comes back
 * in the form the bindings need.
 *
 * ### Deletion is soft
 *
 * `delete` puts the pool in state `DELETED` with an `expireTime` roughly 30
 * days out; it is purged only after that. **The pool ID cannot be reused
 * until it is purged.** Because of that, `reconcile` treats an existing
 * soft-deleted pool as recoverable and undeletes it rather than failing —
 * otherwise a destroy followed by a re-deploy inside the same month would be
 * unrecoverable without renaming the pool.
 *
 * All mutating operations are long-running; the provider polls them to
 * completion via {@link makeAwaitOperation}.
 *
 * @section Creating a WorkloadIdentityPool
 * @example Trust an EKS cluster's OIDC issuer
 * ```typescript
 * const pool = yield* GCP.WorkloadIdentityPool("EksPool", {
 *   project: "123456789",           // project NUMBER
 *   poolId: "eks-us-east-1",
 *   displayName: "EKS us-east-1",
 *   description: "Federates research-eks-us-east-1 service accounts.",
 * });
 * ```
 */
export type WorkloadIdentityPoolProps = {
  /**
   * Project that owns the pool. Accepts the project ID or number; prefer the
   * **number**, because `principalSet://` members require it (see above).
   */
  project: string;
  /**
   * Pool ID, 4–32 characters of `[a-z0-9-]`. Immutable — changing it
   * replaces the pool. The `gcp-` prefix is reserved by Google.
   */
  poolId: string;
  /** Display name, max 32 characters. */
  displayName?: string;
  /** Description, max 256 characters. */
  description?: string;
  /**
   * Disable the pool. A disabled pool exchanges no tokens; existing tokens
   * stop granting access and start working again if it is re-enabled.
   */
  disabled?: boolean;
};

export type WorkloadIdentityPoolAttributes = {
  /** Full resource name, `projects/{p}/locations/global/workloadIdentityPools/{id}`. */
  name: string;
  project: string;
  poolId: string;
  displayName: string | undefined;
  /** Description with the alchemy ownership marker stripped. */
  description: string | undefined;
  state: string | undefined;
  disabled: boolean | undefined;
};

export interface WorkloadIdentityPool
  extends Resource<
    "GCP.WorkloadIdentityPool",
    WorkloadIdentityPoolProps,
    WorkloadIdentityPoolAttributes,
    never,
    GCP.Providers
  > {}

export const WorkloadIdentityPool = Resource<WorkloadIdentityPool>(
  "GCP.WorkloadIdentityPool",
);

/**
 * Treat absent and empty-string as the same value.
 *
 * The patch below uses a FIXED `updateMask` while the body omits unset
 * optional fields — deliberately, since under a field mask an omitted field
 * means "clear it". The hazard is the comparison: if GCP echoes a cleared
 * field back as `""` rather than omitting it, a raw `!==` against `undefined`
 * would report drift on every deploy and churn a patch LRO forever.
 */
const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "") === (b ?? "");

/** `projects/{project}/locations/global` — the only supported location. */
export const poolParent = (project: string) =>
  `projects/${project}/locations/global`;

export const poolResourceName = (project: string, poolId: string) =>
  `${poolParent(project)}/workloadIdentityPools/${poolId}`;

/**
 * Alchemy provider factory for {@link WorkloadIdentityPool}.
 *
 * Deliberately NOT named `WorkloadIdentityPoolProvider`, which the repo's
 * `X` + `XProvider` convention would suggest: GCP already uses that exact
 * term for a different, user-facing resource — the OIDC provider inside a
 * pool ({@link import("./WorkloadIdentityPoolProvider.ts").WorkloadIdentityPoolProvider}).
 * The resource keeps GCP's name; this internal factory takes the awkward one.
 */
export const WorkloadIdentityPoolResourceProvider = () =>
  Provider.effect(
    WorkloadIdentityPool,
    Effect.gen(function* () {
      const getPool = yield* iam.getProjectsLocationsWorkloadIdentityPools;
      const createPool = yield* iam.createProjectsLocationsWorkloadIdentityPools;
      const patchPool = yield* iam.patchProjectsLocationsWorkloadIdentityPools;
      const deletePool = yield* iam.deleteProjectsLocationsWorkloadIdentityPools;
      const undeletePool =
        yield* iam.undeleteProjectsLocationsWorkloadIdentityPools;
      const getOperations =
        yield* iam.getProjectsLocationsWorkloadIdentityPoolsOperations;
      const awaitOperation = makeAwaitOperation(
        getOperations,
        "Workload Identity pool",
      );

      // Absent and invisible collapse to the same thing, matching the
      // ServiceAccount observer: a 403 on a resource we are about to create
      // is indistinguishable from a 404 without extra permissions we may not
      // have.
      const observePool = (project: string, poolId: string) =>
        getPool({ name: poolResourceName(project, poolId) }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as iam.WorkloadIdentityPool | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as iam.WorkloadIdentityPool | undefined),
          ),
        );

      const toAttrs = (
        project: string,
        poolId: string,
        pool: iam.WorkloadIdentityPool,
      ): WorkloadIdentityPoolAttributes => ({
        name: pool.name ?? poolResourceName(project, poolId),
        project,
        poolId,
        displayName: pool.displayName,
        description: stripAlchemyMarker(pool.description),
        state: pool.state,
        disabled: pool.disabled,
      });

      return {
        stables: ["name", "project", "poolId"],
        diff: Effect.fn(function* ({ olds = {}, news, output }) {
          if (!isResolved(news)) return undefined;
          const oldProps = olds as Partial<WorkloadIdentityPoolProps>;
          // Prefer live attributes over persisted props, and fall back to the
          // DESIRED value when neither is known — mirroring Project.ts.
          //
          // Defaulting to `undefined` instead would make an adoption (output
          // present, olds absent) compare `undefined !== news.project` and
          // return `replace`, deleting and recreating a live pool that was
          // already correct. Both fields are part of the resource name, so a
          // genuine change here really is a replacement; the point is only to
          // avoid inventing one.
          const currentProject = output?.project || oldProps.project || news.project;
          const currentPoolId = output?.poolId || oldProps.poolId || news.poolId;
          if (currentProject !== news.project || currentPoolId !== news.poolId) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const project = output?.project || olds?.project;
          const poolId = output?.poolId || olds?.poolId;
          if (!project || !poolId) return undefined;
          const pool = yield* observePool(project, poolId);
          if (!pool) return undefined;
          const attrs = toAttrs(project, poolId, pool);
          return (yield* descriptionHasAlchemyMarker(id, pool.description))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const { project, poolId } = news;
          const description = yield* gcpAlchemyDescription(
            id,
            news.description,
          );
          // Body is TOTAL over the patch's updateMask below: every masked
          // field is always present, with an explicit empty/default value
          // when the prop is unset. Behaviourally identical to omitting them
          // (a masked-but-absent field is cleared), but it states the intent
          // in code rather than relying on that field-mask subtlety, so
          // "clear displayName" cannot be misread as "leave it alone".
          const body: iam.WorkloadIdentityPool = {
            displayName: news.displayName ?? "",
            description,
            disabled: news.disabled ?? false,
          };

          let pool = yield* observePool(project, poolId);

          // A soft-deleted pool holds its ID for ~30 days. Undelete rather
          // than fail: otherwise destroy-then-redeploy is stuck until the
          // purge, with no way out but renaming the pool.
          if (pool?.state === "DELETED") {
            yield* session.note(
              `Undeleting soft-deleted Workload Identity pool ${poolId}…`,
            );
            const op = yield* undeletePool({
              name: poolResourceName(project, poolId),
              body: {},
            });
            if (op.name) yield* awaitOperation(op.name, session);
            pool = yield* observePool(project, poolId);
          }

          if (!pool) {
            const op = yield* createPool({
              parent: poolParent(project),
              workloadIdentityPoolId: poolId,
              body,
            });
            if (op.name) yield* awaitOperation(op.name, session);
            pool = yield* observePool(project, poolId);
            if (!pool) {
              return yield* new ConfigError({
                message: `Workload Identity pool ${poolId} in project ${project} was not readable after create.`,
              });
            }
          } else {
            // Only the mutable fields, and only when they actually differ —
            // an unconditional patch would churn an LRO on every deploy.
            const needsPatch =
              !sameText(pool.displayName, news.displayName) ||
              !sameText(pool.description, description) ||
              (pool.disabled ?? false) !== (news.disabled ?? false);
            if (needsPatch) {
              const op = yield* patchPool({
                name: poolResourceName(project, poolId),
                updateMask: "displayName,description,disabled",
                body,
              });
              if (op.name) yield* awaitOperation(op.name, session);
              pool = (yield* observePool(project, poolId)) ?? pool;
            }
          }

          yield* session.note(poolResourceName(project, poolId));
          return toAttrs(project, poolId, pool);
        }),
        delete: Effect.fn(function* ({ olds, output, session }) {
          // Fall back to props when attributes are incomplete. A create whose
          // LRO succeeded but whose follow-up read failed leaves state with
          // props and no usable attributes; a no-op destroy would then LEAK
          // the pool — and because deletion is soft, the leaked pool holds
          // its ID for ~30 days, blocking a re-deploy under the same name.
          // `||` not `??`: an empty string is never a valid identity here,
          // and a persisted `""` must fall through to the next source rather
          // than be taken as real. With `??` a corrupt/partial state entry
          // would short-circuit the fallback and turn destroy into a silent
          // no-op (or make diff replace a live resource).
          const project = output?.project || olds?.project;
          const poolId = output?.poolId || olds?.poolId;
          if (!project || !poolId) return;
          const op = yield* deletePool({
            name: poolResourceName(project, poolId),
          }).pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed({ name: undefined } as iam.Operation),
            ),
          );
          if (op.name) yield* awaitOperation(op.name, session);
        }),
      };
    }),
  );
