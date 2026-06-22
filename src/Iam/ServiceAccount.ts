import { ConfigError } from "@distilled.cloud/gcp";
import * as iam from "@distilled.cloud/gcp/unstable/iam-v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { diffTags } from "alchemy/Tags";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  descriptionHasAlchemyMarker,
  gcpAlchemyDescription,
  stripAlchemyMarker,
} from "../Tags.ts";
import type * as GCP from "../Providers.ts";

/**
 * A GCP service account (GSA). Lives under a {@link import("../CloudResourceManager/Project.ts").Project}
 * and serves as the federated identity target for Workload Identity
 * (`iam.gke.io/gcp-service-account: <email>` on a k8s SA) and as the
 * principal in any IAM grant that should out-live a human user.
 *
 * Adoption is gated on an alchemy marker embedded in the GSA's
 * `description` field (see `gcpAlchemyDescription` /
 * `descriptionHasAlchemyMarker`) — GSAs have no labels field, so the
 * label-based adoption gate used by Project can't apply. The marker is
 * only written on insert; `description` is mutable but we never *clear*
 * it because doing so would orphan the adoption signal.
 *
 * All lifecycle operations (`createProjectsServiceAccounts`,
 * `patchProjectsServiceAccounts`, `deleteProjectsServiceAccounts`) are
 * synchronous — no LRO polling required.
 *
 * @section Creating a ServiceAccount
 * @example Minimal GSA under a project
 * ```typescript
 * const gsa = yield* GCP.ServiceAccount("Builder", {
 *   project: project.projectId,
 *   accountId: "research-builder",
 *   displayName: "Research pod build + push (BuildKit client)",
 * });
 * ```
 *
 * @example With explicit description and Workload Identity binding
 * ```typescript
 * const gsa = yield* GCP.ServiceAccount("Builder", {
 *   project: project.projectId,
 *   accountId: "research-builder",
 *   displayName: "Research pod build + push",
 *   description: "Used by per-researcher BuildKit clients to push to AR.",
 * });
 * yield* GCP.serviceAccountIamMember(gsa, "ClusterA-WorkloadIdentity", {
 *   role: "roles/iam.workloadIdentityUser",
 *   member: `serviceAccount:${projectA.projectId}.svc.id.goog[researchers/build]`,
 * });
 * ```
 */
export type ServiceAccountProps = {
  /**
   * GCP project id (e.g. `micro-research-shared`) the GSA lives under.
   * Immutable — changing this orphans the GSA's unique id and any
   * bindings, so `diff` triggers a replacement.
   */
  project: string;
  /**
   * The account id segment of the service account's email. Must match
   * `[a-z]([-a-z0-9]*[a-z0-9])`, 6-30 chars. Immutable — replaces.
   */
  accountId: string;
  /**
   * User-visible display name. Max 100 UTF-8 bytes. Mutable.
   */
  displayName?: string;
  /**
   * User-supplied description (max 256 UTF-8 bytes). The alchemy
   * ownership marker is prepended automatically — see
   * `gcpAlchemyDescription`. The user-supplied portion is preserved
   * verbatim and surfaced back through `Attributes.description`.
   */
  description?: string;
};

/**
 * Single (role, members) entry on a GSA's IAM policy. Targets declare
 * this contract so capabilities (e.g. Workload Identity) can `.bind`
 * IAM grants onto the GSA — the provider's `reconcile` merges all
 * bound entries by role into a single `setIamPolicy` call.
 */
export type ServiceAccountIamBinding = {
  /** IAM role, e.g. `"roles/iam.workloadIdentityUser"`. */
  role: string;
  /** Principals, e.g. `["serviceAccount:foo.svc.id.goog[ns/ksa]"]`. */
  members: ReadonlyArray<string>;
};

export type ServiceAccountBindingContract = {
  iamBindings: ReadonlyArray<ServiceAccountIamBinding>;
};

export type ServiceAccount = Resource<
  "GCP.ServiceAccount",
  ServiceAccountProps,
  {
    /** Full resource name, e.g. `projects/micro-research-shared/serviceAccounts/research-builder@micro-research-shared.iam.gserviceaccount.com`. */
    name: string;
    /** Email address derived from the account id, e.g. `research-builder@micro-research-shared.iam.gserviceaccount.com`. */
    email: string;
    /** Server-assigned stable numeric id. */
    uniqueId: string;
    /** Project the GSA lives under. */
    projectId: string;
    /** Account id (the part before `@`). */
    accountId: string;
    /** User-visible display name, or `undefined` if never set. */
    displayName: string | undefined;
    /** User-visible description (without the alchemy marker), or `undefined` if never set. */
    description: string | undefined;
    /** Whether the GSA is currently disabled. */
    disabled: boolean;
  },
  ServiceAccountBindingContract,
  GCP.Providers
>;

export const ServiceAccount = Resource<ServiceAccount>("GCP.ServiceAccount");

const toAttributes = (sa: iam.ServiceAccount): ServiceAccount["Attributes"] => {
  const accountId = (sa.email ?? "").split("@")[0];
  return {
    name: sa.name ?? "",
    email: sa.email ?? "",
    uniqueId: sa.uniqueId ?? "",
    projectId: sa.projectId ?? "",
    accountId,
    displayName: sa.displayName,
    description: stripAlchemyMarker(sa.description),
    disabled: sa.disabled ?? false,
  };
};

export const ServiceAccountProvider = () =>
  Provider.effect(
    ServiceAccount,
    Effect.gen(function* () {
      const getProjectsServiceAccounts = yield* iam.getProjectsServiceAccounts;
      const createProjectsServiceAccounts = yield* iam.createProjectsServiceAccounts;
      const patchProjectsServiceAccounts = yield* iam.patchProjectsServiceAccounts;
      const deleteProjectsServiceAccounts = yield* iam.deleteProjectsServiceAccounts;
      const listProjectsServiceAccounts = yield* iam.listProjectsServiceAccounts;
      const getIamPolicyProjectsServiceAccounts = yield* iam.getIamPolicyProjectsServiceAccounts;
      const setIamPolicyProjectsServiceAccounts = yield* iam.setIamPolicyProjectsServiceAccounts;

      const resourceName = (projectId: string, accountId: string) =>
        `projects/${projectId}/serviceAccounts/${accountId}`;

      const observeServiceAccount = (projectId: string, accountId: string) =>
        getProjectsServiceAccounts({
          name: resourceName(projectId, accountId),
        }).pipe(
          // GSAs that don't exist OR that the caller can't see both
          // collapse to "absent" — same 403→missing pattern as the
          // project observer.
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as iam.ServiceAccount | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as iam.ServiceAccount | undefined),
          ),
        );

      const requireServiceAccount = (
        projectId: string,
        accountId: string,
        context: string,
      ) =>
        observeServiceAccount(projectId, accountId).pipe(
          Effect.flatMap((sa) =>
            sa
              ? Effect.succeed(sa)
              : Effect.fail(
                  new ConfigError({
                    message: `ServiceAccount ${accountId} in project ${projectId} ${context}.`,
                  }),
                ),
          ),
        );

      // List-page scan for cold recovery. Alchemy marker in the
      // description field identifies our GSAs; the page boundary is
      // arbitrary — we still need to page through to find any marker
      // that happens to fall past the first page.
      const findByAlchemyMarker = Effect.fn(function* (
        id: string,
        projectId: string,
      ) {
        let pageToken: string | undefined;
        // Up to 100 pages × 100 items per page = 10000 GSAs; well past
        // any realistic project size. If we ever exceed that we should
        // cap and warn rather than silently miss matches.
        for (let i = 0; i < 100; i++) {
          const page = yield* listProjectsServiceAccounts({
            name: `projects/${projectId}`,
            ...(pageToken ? { pageToken } : {}),
            pageSize: 100,
          });
          for (const sa of page.accounts ?? []) {
            if (yield* descriptionHasAlchemyMarker(id, sa.description)) {
              return sa;
            }
          }
          pageToken = page.nextPageToken;
          if (!pageToken) return undefined;
        }
        return undefined;
      });

      // Sync mutable fields: displayName + description. Both use
      // `updateMask` so we only PATCH what actually changed. Diff
      // against OBSERVED state, not `olds`, so adoption converges
      // correctly when a foreign description is on the GSA.
      const syncMutable = Effect.fn(function* (
        observed: iam.ServiceAccount,
        desired: {
          displayName: string | undefined;
          descriptionWithMarker: string;
          descriptionUserOnly: string | undefined;
        },
      ) {
        const updateMaskFields: string[] = [];
        if (desired.displayName !== observed.displayName) {
          updateMaskFields.push("display_name");
        }
        const descDiff = diffTags(
          { description: observed.description ?? "" },
          { description: desired.descriptionWithMarker },
        );
        if (
          descDiff.removed.length > 0 ||
          descDiff.upsert.length > 0
        ) {
          updateMaskFields.push("description");
        }

        if (updateMaskFields.length === 0) return observed;

        return yield* patchProjectsServiceAccounts({
          name: observed.name!,
          body: {
            updateMask: updateMaskFields.join(","),
            serviceAccount: {
              displayName: desired.displayName,
              description: desired.descriptionWithMarker,
            },
          },
        });
      });

      // Apply merged IAM bindings as a single setIamPolicy. Same
      // foreign-binding preservation + etag-retry pattern as the
      // Project's `syncIam` — see `src/CloudResourceManager/Project.ts:421-474`.
      const syncIam = (args: {
        resourceName: string;
        bindings: ReadonlyArray<
          import("alchemy/Resource").ResourceBinding<ServiceAccountBindingContract>
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

          const current = yield* getIamPolicyProjectsServiceAccounts({
            resource: args.resourceName,
            "options.requestedPolicyVersion": 3,
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

          yield* setIamPolicyProjectsServiceAccounts({
            resource: args.resourceName,
            body: {
              policy: { ...current, bindings: existingBindings, version: 3 },
            },
          });
        }).pipe(
          Effect.retry({
            schedule: Schedule.exponential(Duration.seconds(2)).pipe(
              Schedule.both(Schedule.recurs(8)),
            ),
          }),
        );

      return {
        // Stable identity: accountId + project; both immutable; either
        // change → replace. The server-assigned uniqueId is also stable
        // for the lifetime of the GSA (re-create gets a different one).
        stables: ["accountId", "projectId", "uniqueId", "name", "email"],
        diff: Effect.fn(function* ({ id, news, olds = {}, output }) {
          if (!isResolved(news)) return undefined;
          // Replace ONLY when a prior identity is actually known AND differs.
          // A partial/adopted state can lack the persisted accountId/projectId
          // (an adoption that never persisted full Attributes leaves
          // output.projectId === "" / undefined). Treating that "unknown" as a
          // replace spuriously deletes+recreates a live, correctly-named GSA
          // (and churns its uniqueId → breaks Workload-Identity bindings).
          // When the prior identity is absent, fall through to reconcile, which
          // observes the live resource and re-persists its Attributes. The
          // truthiness guard covers both `undefined` and the `""` toAttributes
          // default; a genuine accountId/project change still has a non-empty
          // prior value to compare against, so real replacements are unaffected.
          const priorAccount = output?.accountId ?? olds.accountId;
          const priorProject = output?.projectId ?? olds.project;
          if (
            (priorAccount && news.accountId !== priorAccount) ||
            (priorProject && news.project !== priorProject)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, bindings }) {
          const descriptionWithMarker = yield* gcpAlchemyDescription(
            id,
            news.description,
          );

          // 1. Observe — cloud state is authoritative. A second
          //    scan-by-marker covers the cold-recovery case where
          //    persisted `output`/`olds` lost the uniqueId after
          //    state loss. We prefer the direct-by-name probe first
          //    (cheap) and fall back to the scan only when direct
          //    observation returned `undefined`.
          let observed = yield* observeServiceAccount(news.project, news.accountId);
          if (!observed) {
            observed = yield* findByAlchemyMarker(id, news.project);
          }

          // 2. Ensure — create if missing. createProjectsServiceAccounts
          //    is synchronous (returns the SA, not an LRO). Conflict
          //    covers a peer reconciler race — re-observe.
          if (!observed) {
            observed = yield* createProjectsServiceAccounts({
              name: `projects/${news.project}`,
              body: {
                accountId: news.accountId,
                serviceAccount: {
                  displayName: news.displayName,
                  description: descriptionWithMarker,
                },
              },
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as iam.ServiceAccount | undefined),
              ),
            );

            if (!observed) {
              observed = yield* requireServiceAccount(
                news.project,
                news.accountId,
                "did not appear after create",
              );
            }
          }

          // 3. Sync mutable fields against OBSERVED state.
          const synced = yield* syncMutable(observed, {
            displayName: news.displayName ?? observed.displayName,
            descriptionWithMarker,
            descriptionUserOnly: news.description,
          });

          // 4. Sync IAM bindings (Workload Identity, impersonators, …).
          //    Single setIamPolicy on the GSA with merged bindings;
          //    foreign roles preserved. Etag-retried internally.
          yield* syncIam({
            resourceName: synced.name!,
            bindings,
          });

          return toAttributes(synced);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Synchronous delete — Empty response, no LRO. NotFound
          // means the GSA was already deleted (or never existed in our
          // scope); both are idempotent successes.
          yield* deleteProjectsServiceAccounts({
            name: output.name,
          }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.catchTag("Forbidden", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          // Direct-by-name probe when we have any handle on the
          // accountId. Falls back to a project-wide scan-by-marker
          // for cold recovery after state loss.
          const accountId =
            output?.accountId ?? olds?.accountId;
          const projectId =
            output?.projectId ?? olds?.project;

          let observed: iam.ServiceAccount | undefined;
          if (accountId && projectId) {
            observed = yield* observeServiceAccount(projectId, accountId);
          }
          if (!observed && projectId) {
            observed = yield* findByAlchemyMarker(id, projectId);
          }
          if (!observed) return undefined;

          const attrs = toAttributes(observed);
          // Adoption gate via description marker (see Tags.ts §description).
          return (yield* descriptionHasAlchemyMarker(id, observed.description))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
