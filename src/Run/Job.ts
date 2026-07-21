import * as run from "@distilled.cloud/gcp/run-v2";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { deepEqual, isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { diffTags } from "alchemy/Tags";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as GCP from "../Providers.ts";
import { gcpInternalLabels, hasAlchemyLabels } from "../Tags.ts";
import { makeSyncIam, type RunIamBindingContract } from "./IamSync.ts";
import { makeAwaitOperation } from "./Operations.ts";
import {
  reshapeBadRequest,
  validateAnnotations,
  validateContainers,
  validateLabels,
  validateRunName,
} from "./Validation.ts";

/**
 * A Cloud Run v2 Job — a managed batch workload. A Job holds an
 * `ExecutionTemplate` (parallelism + a `TaskTemplate` containing
 * containers); invoking the Job via `runProjectsLocationsJobs` creates
 * an immutable Execution that runs the configured number of tasks to
 * completion.
 *
 * **Declarative vs imperative.** This resource models the Job
 * *definition* — its template, parallelism, task count, IAM. The act
 * of *running* the Job is event-shaped (does not fit the
 * converge-to-desired-state model) and is left to user-side code:
 *
 * ```typescript
 * import * as run from "@distilled.cloud/gcp/run-v2";
 * const job = yield* GCP.Job("Nightly", { ... });
 * const runJob = yield* run.runProjectsLocationsJobs;
 * yield* runJob({
 *   name: `projects/${job.project}/locations/${job.location}/jobs/${job.name}`,
 * });
 * // returns an LRO; poll if you want to wait for completion
 * ```
 *
 * **Lifecycle.** observe → ensure (create, retrying the API-enable
 * race) → sync (patch full body if anything changed; Job's patch has
 * no `updateMask` — server diffs the body itself) → sync IAM bindings
 * → return.
 *
 * **Replace triggers.** Only identity fields (project, location, name)
 * force replacement. Everything else is in-place via `patch`. New
 * Executions are created independently by `runProjectsLocationsJobs`.
 *
 * **Optimistic concurrency.** Delete passes through the observed
 * `etag`; patch passes etag in the body so concurrent edits surface
 * as `Conflict` instead of silently overwriting.
 *
 * **Adoption.** Label-gated, same as {@link import("./Service.ts").Service}.
 *
 * **IAM.** Use {@link import("./IamMember.ts").jobIamMember} to bind
 * `(role, member)` grants — typically `roles/run.invoker` on the
 * service account that triggers the job.
 *
 * @section Creating a Cloud Run Job
 * @example Single-shot batch job
 * ```typescript
 * const job = yield* GCP.Job("ProcessBatch", {
 *   project: project.projectId,
 *   location: "europe-west4",
 *   template: {
 *     taskCount: 1,
 *     template: {
 *       maxRetries: 3,
 *       containers: [{
 *         image: "europe-west4-docker.pkg.dev/proj/repo/worker:latest",
 *       }],
 *     },
 *   },
 * });
 * ```
 *
 * @example Parallel job with custom service account and GPU
 * ```typescript
 * const train = yield* GCP.Job("Train", {
 *   project: project.projectId,
 *   location: "europe-west4",
 *   launchStage: "BETA",
 *   template: {
 *     taskCount: 8,
 *     parallelism: 8,
 *     template: {
 *       serviceAccount: sa.email,
 *       maxRetries: 0,
 *       timeout: "21600s",
 *       containers: [{
 *         image: "europe-west4-docker.pkg.dev/proj/repo/train:v2",
 *         resources: { limits: { cpu: "4", memory: "16Gi", "nvidia.com/gpu": "1" } },
 *       }],
 *       nodeSelector: { accelerator: "nvidia-l4" },
 *     },
 *   },
 * });
 * ```
 */
export type JobProps = {
  /** GCP project ID hosting the Job. Immutable — replace if changed. */
  project: string;
  /** Cloud Run region. Immutable — replace if changed. */
  location: string;
  /**
   * Job name. Defaults to `createPhysicalName({ id, lowercase: true,
   * maxLength: 49 })`. Lowercase letters/digits/hyphens; must begin
   * with a letter and not end with a hyphen; **fewer than 50 characters**.
   * Immutable — replace if changed.
   */
  name?: string;
  /** User-visible description. Mutable via `patch`. */
  description?: string;
  /**
   * Resource labels. Alchemy internal labels are merged on top
   * automatically. Cloud Run rejects reserved namespaces (same as
   * Service). Mutable via `patch`.
   */
  labels?: Record<string, string>;
  /** Free-form annotations. Mutable via `patch`. */
  annotations?: Record<string, string>;
  /**
   * Launch stage — `BETA` (or higher) required for preview features
   * (GPU node selectors, Direct VPC). Mutable via `patch`.
   */
  launchStage?:
    | "ALPHA"
    | "BETA"
    | "GA"
    | "EARLY_ACCESS"
    | "PRELAUNCH"
    | "DEPRECATED";
  /** Binary Authorization policy. Mutable via `patch`. */
  binaryAuthorization?: run.GoogleCloudRunV2BinaryAuthorization;
  /**
   * Token-suffix used to compose Execution names when the Job is
   * started via the GCP UI or `gcloud run jobs execute`. Required to
   * keep distinct from Job name + 63 chars. Mutable.
   */
  startExecutionToken?: string;
  /** Same as `startExecutionToken` but used on run completion. Mutable. */
  runExecutionToken?: string;
  /**
   * The Execution template — describes parallelism, task count, and
   * the inner `TaskTemplate` (containers, volumes, retry policy).
   * **Required at create.** Mutable via `patch`.
   */
  template: run.GoogleCloudRunV2ExecutionTemplate;
};

export type JobAttributes = {
  /** Job name (bare). */
  name: string;
  /** Server-assigned UID. */
  uid: string;
  /** Fully-qualified resource name. */
  resourceName: string;
  /** GCP project ID. */
  project: string;
  /** Region. */
  location: string;
  /** Monotonically increasing generation, bumped on every patch. */
  generation: string | undefined;
  /** Generation reflected in the latest reconciled state. */
  observedGeneration: string | undefined;
  /** Overall readiness condition. */
  terminalCondition: run.GoogleCloudRunV2Condition | undefined;
  /** Number of Executions created for this Job. */
  executionCount: number | undefined;
  /** Reference to the most recently created Execution, if any. */
  latestCreatedExecution: run.GoogleCloudRunV2ExecutionReference | undefined;
  /** True while Cloud Run is reconciling toward the desired state. */
  reconciling: boolean | undefined;
  /** Optimistic-concurrency etag. */
  etag: string | undefined;
  /** Labels currently set, including internals. */
  labels: Record<string, string>;
  /** Creation time. */
  createTime: string | undefined;
  /** Last-modified time. */
  updateTime: string | undefined;
};

export type Job = Resource<
  "GCP.Job",
  JobProps,
  JobAttributes,
  RunIamBindingContract,
  GCP.Providers
>;
export const Job = Resource<Job>("GCP.Job");

const fqName = (project: string, location: string, name: string) =>
  `projects/${project}/locations/${location}/jobs/${name}`;

const toJobBody = (
  news: JobProps,
  desiredLabels: Record<string, string>,
): run.GoogleCloudRunV2Job => ({
  labels: desiredLabels,
  ...(news.annotations ? { annotations: news.annotations } : {}),
  ...(news.launchStage ? { launchStage: news.launchStage } : {}),
  ...(news.binaryAuthorization
    ? { binaryAuthorization: news.binaryAuthorization }
    : {}),
  ...(news.startExecutionToken
    ? { startExecutionToken: news.startExecutionToken }
    : {}),
  ...(news.runExecutionToken
    ? { runExecutionToken: news.runExecutionToken }
    : {}),
  template: news.template,
});

const toAttributes = (
  j: run.GoogleCloudRunV2Job,
  parent: { project: string; location: string; name: string },
): JobAttributes => ({
  name: parent.name,
  uid: j.uid ?? "",
  resourceName: j.name ?? fqName(parent.project, parent.location, parent.name),
  project: parent.project,
  location: parent.location,
  generation: j.generation,
  observedGeneration: j.observedGeneration,
  terminalCondition: j.terminalCondition,
  executionCount: j.executionCount,
  latestCreatedExecution: j.latestCreatedExecution,
  reconciling: j.reconciling,
  etag: j.etag,
  labels: { ...(j.labels ?? {}) },
  createTime: j.createTime,
  updateTime: j.updateTime,
});

/**
 * Decide whether anything mutable on the Job changed since the last
 * reconcile. Job's `patch` has no `updateMask` parameter — the server
 * diffs the full body — so we just emit a single "changed / unchanged"
 * verdict and re-send the whole body if it differs.
 *
 * Labels go through `diffTags` (consistent with every other GCP
 * resource here); everything else is a `deepEqual` on the relevant
 * field. The `template` deep-equal is the load-bearing check —
 * Cloud Run injects server-side defaults into `template.template`
 * (e.g. `maxRetries: 3` when omitted), so the observed template may
 * have keys we never sent. Deep-equal on the OBSERVED side ⊆ NEWS
 * side is too strict; we rely on the user re-sending equivalent
 * inputs across reconciles so observed==news after the first patch.
 */
const jobMutated = (
  observed: run.GoogleCloudRunV2Job,
  news: JobProps,
  desiredLabels: Record<string, string>,
): boolean => {
  const labelDiff = diffTags(
    { ...(observed.labels ?? {}) },
    desiredLabels,
  );
  if (labelDiff.removed.length > 0 || labelDiff.upsert.length > 0) return true;
  if (!deepEqual(observed.annotations ?? {}, news.annotations ?? {})) return true;
  if (news.launchStage !== undefined && observed.launchStage !== news.launchStage) {
    return true;
  }
  if (
    news.binaryAuthorization &&
    !deepEqual(observed.binaryAuthorization, news.binaryAuthorization)
  ) {
    return true;
  }
  if (
    news.startExecutionToken !== undefined &&
    observed.startExecutionToken !== news.startExecutionToken
  ) {
    return true;
  }
  if (
    news.runExecutionToken !== undefined &&
    observed.runExecutionToken !== news.runExecutionToken
  ) {
    return true;
  }
  if (!deepEqual(observed.template, news.template)) return true;
  return false;
};

export const JobProvider = () =>
  Provider.effect(
    Job,
    Effect.gen(function* () {
      const getJob = yield* run.getProjectsLocationsJobs;
      const createJob = yield* run.createProjectsLocationsJobs;
      const patchJob = yield* run.patchProjectsLocationsJobs;
      const deleteJob = yield* run.deleteProjectsLocationsJobs;
      const getOperation = yield* run.getProjectsLocationsOperations;
      const getIamPolicy = yield* run.getIamPolicyProjectsLocationsJobs;
      const setIamPolicy = yield* run.setIamPolicyProjectsLocationsJobs;
      const awaitOperation = makeAwaitOperation(getOperation);
      const syncIam = makeSyncIam({ getIamPolicy, setIamPolicy });

      const observe = (project: string, location: string, name: string) =>
        getJob({ name: fqName(project, location, name) }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as run.GoogleCloudRunV2Job | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as run.GoogleCloudRunV2Job | undefined),
          ),
        );

      const syncMutable = Effect.fn(function* (args: {
        name: string;
        observed: run.GoogleCloudRunV2Job;
        news: JobProps;
        desiredLabels: Record<string, string>;
        session: ScopedPlanStatusSession;
      }) {
        if (!jobMutated(args.observed, args.news, args.desiredLabels)) return;
        const bodyWithEtag: run.GoogleCloudRunV2Job = {
          ...toJobBody(args.news, args.desiredLabels),
          ...(args.observed.etag ? { etag: args.observed.etag } : {}),
        };
        const op = yield* patchJob({
          name: args.name,
          body: bodyWithEtag,
        }).pipe(
          Effect.catchTag("BadRequest", reshapeBadRequest("Job", "patch")),
        );
        if (op.name) yield* awaitOperation(op.name, args.session);
      });

      return {
        stables: ["name", "uid", "resourceName", "project", "location"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as JobProps, news, [
              "project",
              "location",
              "name",
            ])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, session, bindings }) {
          const internalLabels = yield* gcpInternalLabels(id);
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, maxLength: 49 })).toLowerCase();

          yield* validateRunName("Job", desiredName);
          yield* validateLabels(news.labels);
          yield* validateAnnotations(news.annotations);
          // Job container constraint lives one level deeper (inside the
          // ExecutionTemplate's TaskTemplate).
          yield* validateContainers("Job", news.template.template?.containers);

          const parent = `projects/${news.project}/locations/${news.location}`;
          const name = fqName(news.project, news.location, desiredName);
          const desiredLabels: Record<string, string> = {
            ...(news.labels ?? {}),
            ...internalLabels,
          };

          let observed = yield* observe(news.project, news.location, desiredName);

          if (!observed) {
            const op = yield* createJob({
              parent,
              jobId: desiredName,
              body: toJobBody(news, desiredLabels),
            }).pipe(
              Effect.retry({
                while: (e: { _tag?: string; message?: string }) =>
                  e?._tag === "Forbidden" &&
                  /enabled this API recently|has not been used/i.test(
                    e.message ?? "",
                  ),
                schedule: Schedule.max([
                  Schedule.spaced(Duration.seconds(15)),
                  Schedule.recurs(20),
                ]).pipe(
                  Schedule.tap(() =>
                    session.note(
                      "Waiting for Cloud Run API enablement to propagate…",
                    ),
                  ),
                ),
              }),
              Effect.catchTag("Conflict", () =>
                Effect.succeed(
                  undefined as run.GoogleLongrunningOperation | undefined,
                ),
              ),
              Effect.catchTag("BadRequest", reshapeBadRequest("Job", "create")),
            );
            if (op?.name) yield* awaitOperation(op.name, session);
            observed = yield* getJob({ name });
          }

          yield* syncMutable({
            name,
            observed,
            news,
            desiredLabels,
            session,
          });

          yield* syncIam({ resource: name, bindings });

          const final = yield* getJob({ name });
          return toAttributes(final, {
            project: news.project,
            location: news.location,
            name: desiredName,
          });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const name = fqName(output.project, output.location, output.name);
          yield* deleteJob({
            name,
            ...(output.etag ? { etag: output.etag } : {}),
          }).pipe(
            Effect.flatMap((op) =>
              op.name ? awaitOperation(op.name, session) : Effect.succeed(op),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const project = output?.project ?? olds?.project;
          const location = output?.location ?? olds?.location;
          if (!project || !location) return undefined;
          const name =
            output?.name ??
            olds?.name ??
            (yield* createPhysicalName({ id, maxLength: 49 })).toLowerCase();
          const observed = yield* observe(project, location, name);
          if (!observed) return undefined;
          const attrs = toAttributes(observed, { project, location, name });
          return (yield* hasAlchemyLabels(id, observed.labels))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
