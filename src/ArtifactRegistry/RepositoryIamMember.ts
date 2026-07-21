import { ConfigError } from "@distilled.cloud/gcp";
import * as ar from "@distilled.cloud/gcp/artifactregistry-v1";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as GCP from "../Providers.ts";

/**
 * A single unconditional `(role, member)` IAM grant on an Artifact Registry
 * repository. The repository is referenced by its fully-qualified resource
 * name and is not created or deleted by this resource.
 *
 * Reconciliation is an additive read-modify-write: foreign bindings,
 * conditional bindings, members, policy version, and etag are preserved.
 * Deletion revokes only this exact member and removes an emptied binding.
 * The whole cycle retries boundedly on stale-etag conflicts so concurrent
 * policy writers compose safely.
 *
 * @example Read access to one Docker repository
 * ```typescript
 * yield* GCP.ArtifactRegistryRepositoryIamMember("EvalsAppsReader", {
 *   repository: apps.fullyQualifiedName,
 *   role: "roles/artifactregistry.reader",
 *   member: "serviceAccount:evals@example-project.iam.gserviceaccount.com",
 * });
 * ```
 */
export type ArtifactRegistryRepositoryIamMemberProps = {
  /**
   * Fully-qualified repository resource name:
   * `projects/{project}/locations/{location}/repositories/{repository}`.
   * Immutable — changing it replaces the grant.
   */
  repository: string;
  /** IAM role, e.g. `roles/artifactregistry.reader`. Immutable. */
  role: string;
  /** IAM member string, e.g. `serviceAccount:name@project.iam.gserviceaccount.com`. Immutable. */
  member: string;
};

export type ArtifactRegistryRepositoryIamMemberAttributes =
  ArtifactRegistryRepositoryIamMemberProps;

export type ArtifactRegistryRepositoryIamMember = Resource<
  "GCP.ArtifactRegistryRepositoryIamMember",
  ArtifactRegistryRepositoryIamMemberProps,
  ArtifactRegistryRepositoryIamMemberAttributes,
  never,
  GCP.Providers
>;

export const ArtifactRegistryRepositoryIamMember =
  Resource<ArtifactRegistryRepositoryIamMember>(
    "GCP.ArtifactRegistryRepositoryIamMember",
  );

export const ArtifactRegistryRepositoryIamMemberProvider = () =>
  Provider.effect(
    ArtifactRegistryRepositoryIamMember,
    Effect.gen(function* () {
      const getIamPolicy = yield* ar.getIamPolicyProjectsLocationsRepositories;
      const setIamPolicy = yield* ar.setIamPolicyProjectsLocationsRepositories;

      const hasMember = (policy: ar.Policy, role: string, member: string) =>
        (policy.bindings ?? []).some(
          (binding) =>
            binding.role === role &&
            !binding.condition &&
            (binding.members ?? []).includes(member),
        );

      const conflictRetry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.retry({
            while: (error) => (error as { _tag?: string })?._tag === "Conflict",
            schedule: Schedule.max([
              Schedule.exponential(Duration.millis(250)),
              Schedule.recurs(8),
            ]),
          }),
        );

      const readPolicy = (repository: string) =>
        getIamPolicy({
          resource: repository,
          "options.requestedPolicyVersion": 3,
        });

      return {
        stables: ["repository", "role", "member"],
        diff: Effect.fn(function* ({ news, olds = {}, output }) {
          if (!isResolved(news)) return undefined;
          const priorRepository = output?.repository || olds.repository;
          const priorRole = output?.role || olds.role;
          const priorMember = output?.member || olds.member;
          if (
            (priorRepository && priorRepository !== news.repository) ||
            (priorRole && priorRole !== news.role) ||
            (priorMember && priorMember !== news.member)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news }) {
          yield* conflictRetry(
            Effect.gen(function* () {
              const current = yield* readPolicy(news.repository).pipe(
                Effect.catchTag("NotFound", () =>
                  Effect.fail(
                    new ConfigError({
                      message: `Artifact Registry repository ${news.repository} does not exist — RepositoryIamMember grants on existing repositories only.`,
                    }),
                  ),
                ),
              );
              if (hasMember(current, news.role, news.member)) return;

              const bindings = (current.bindings ?? []).map((binding) => ({
                ...binding,
                members: [...(binding.members ?? [])],
              }));
              const existing = bindings.find(
                (binding) => binding.role === news.role && !binding.condition,
              );
              if (existing) {
                existing.members = [...(existing.members ?? []), news.member];
              } else {
                bindings.push({ role: news.role, members: [news.member] });
              }

              yield* setIamPolicy({
                resource: news.repository,
                body: {
                  policy: { ...current, bindings, version: 3 },
                },
              });
            }),
          );
          return {
            repository: news.repository,
            role: news.role,
            member: news.member,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!output.repository || !output.role || !output.member) return;
          yield* conflictRetry(
            Effect.gen(function* () {
              const current = yield* readPolicy(output.repository).pipe(
                Effect.catchTag("NotFound", () =>
                  Effect.succeed(undefined as ar.Policy | undefined),
                ),
              );
              if (!current || !hasMember(current, output.role, output.member)) {
                return;
              }

              const bindings = (current.bindings ?? [])
                .map((binding) =>
                  binding.role === output.role && !binding.condition
                    ? {
                        ...binding,
                        members: (binding.members ?? []).filter(
                          (member) => member !== output.member,
                        ),
                      }
                    : {
                        ...binding,
                        members: [...(binding.members ?? [])],
                      },
                )
                .filter((binding) => (binding.members?.length ?? 0) > 0);

              yield* setIamPolicy({
                resource: output.repository,
                body: {
                  policy: { ...current, bindings, version: 3 },
                },
              }).pipe(Effect.catchTag("NotFound", () => Effect.void));
            }),
          );
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const repository = output?.repository ?? olds?.repository;
          const role = output?.role ?? olds?.role;
          const member = output?.member ?? olds?.member;
          if (!repository || !role || !member) return undefined;

          const current = yield* readPolicy(repository).pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed(undefined as ar.Policy | undefined),
            ),
            Effect.catchTag("Forbidden", () =>
              Effect.succeed(undefined as ar.Policy | undefined),
            ),
          );
          if (!current || !hasMember(current, role, member)) return undefined;
          return { repository, role, member };
        }),
      };
    }),
  );
