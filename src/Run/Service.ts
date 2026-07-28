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
 * A Cloud Run v2 Service — a managed serverless HTTP endpoint. Cloud
 * Run pulls a container image, scales it from zero up to the
 * configured maximum based on request rate, and fronts it with a
 * Google-managed URL (`https://{service}-{hash}-{region}.run.app`).
 * Per-Service IAM controls who can invoke it.
 *
 * **Resource model.** A Service holds a `template` (the desired
 * `RevisionTemplate`) plus traffic routing. Every change to `template`
 * server-side spawns a new immutable `Revision`; `traffic` (this resource)
 * picks which Revisions receive request percentages. Revisions and
 * Executions are side-effects and are NOT modeled by this resource —
 * inspect them via `getProjectsLocationsServicesRevisions` if needed.
 *
 * **Lifecycle.** observe → ensure (create, retrying on the well-known
 * "API not yet enabled" 403) → sync (patch with updateMask of changed
 * top-level fields) → sync IAM bindings → return.
 *
 * **Replace triggers.** Only identity fields (project, location, name)
 * force replacement. Everything else — image, env, scaling, traffic,
 * ingress, IAM — is in-place via `patch`. New revisions are auto-created
 * by Cloud Run on any `template.*` change.
 *
 * **Optimistic concurrency.** Patch and delete pass through the
 * observed `etag` so concurrent edits (e.g. from `gcloud run services
 * update`) surface as `Conflict` instead of silently overwriting.
 *
 * **Adoption.** Label-gated: a Service whose `labels` lack our
 * `alchemy_*` keys is wrapped in `Unowned(attrs)` from `read`, forcing
 * `--adopt` before takeover.
 *
 * **IAM.** Use {@link import("./IamMember.ts").serviceIamMember} to
 * bind `(role, member)` grants — the provider unions all bindings and
 * applies them via a single `setIamPolicy` round-trip, preserving
 * foreign roles + members.
 *
 * @section Creating a Cloud Run Service
 * @example Minimal "hello" service, public via IAM
 * ```typescript
 * const helloApi = yield* GCP.Service("HelloApi", {
 *   project: project.projectId,
 *   location: "europe-west4",
 *   template: {
 *     containers: [{ image: "gcr.io/cloudrun/hello" }],
 *   },
 * });
 * yield* GCP.serviceIamMember(helloApi, "PublicInvoker", {
 *   role: "roles/run.invoker",
 *   member: "allUsers",
 * });
 * // helloApi.uri → https://hello-api-XXXXX-ew.a.run.app
 * ```
 *
 * @example Internal-only service with explicit service account and scaling
 * ```typescript
 * const internal = yield* GCP.Service("Internal", {
 *   project: project.projectId,
 *   location: "europe-west4",
 *   ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
 *   scaling: { minInstanceCount: 1, maxInstanceCount: 10 },
 *   template: {
 *     serviceAccount: sa.email,
 *     containers: [{
 *       image: "europe-west4-docker.pkg.dev/proj/repo/app:latest",
 *       resources: { limits: { cpu: "1000m", memory: "512Mi" } },
 *     }],
 *   },
 * });
 * ```
 */
export type ServiceProps = {
  /** GCP project ID hosting the Service. Immutable — replace if changed. */
  project: string;
  /**
   * Cloud Run region (e.g. `europe-west4`). Cloud Run is a regional
   * product — there are no zonal Services. Immutable — replace if changed.
   */
  location: string;
  /**
   * Service name. Defaults to `createPhysicalName({ id, lowercase: true,
   * maxLength: 49 })`. Lowercase letters/digits/hyphens; must begin
   * with a letter and not end with a hyphen; **fewer than 50 characters**.
   * Immutable — replace if changed.
   */
  name?: string;
  /**
   * User-visible description (≤512 chars). Mutable via `patch`.
   */
  description?: string;
  /**
   * Resource labels. Alchemy internal labels (`alchemy_app`,
   * `alchemy_stage`, `alchemy_id`) are merged on top automatically.
   * Cloud Run rejects labels in `run.googleapis.com`,
   * `cloud.googleapis.com`, `serving.knative.dev`, or
   * `autoscaling.knative.dev` namespaces. Mutable via `patch`.
   */
  labels?: Record<string, string>;
  /**
   * Free-form annotations for external tools. Cloud Run rejects the
   * same reserved namespaces as `labels`. Mutable via `patch`.
   */
  annotations?: Record<string, string>;
  /**
   * Launch stage. `BETA` (or higher) is required to use preview
   * fields like GPU `nodeSelector` and Direct VPC `networkInterfaces`;
   * leaving this unset defaults to `GA`, which silently rejects
   * preview fields in the body. Mutable via `patch`.
   */
  launchStage?:
    | "ALPHA"
    | "BETA"
    | "GA"
    | "EARLY_ACCESS"
    | "PRELAUNCH"
    | "DEPRECATED";
  /** Ingress traffic policy. Mutable via `patch`. */
  ingress?:
    | "INGRESS_TRAFFIC_ALL"
    | "INGRESS_TRAFFIC_INTERNAL_ONLY"
    | "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
    | "INGRESS_TRAFFIC_NONE";
  /**
   * Disable the IAM permission check for invokers. When `true`, the
   * Service is publicly reachable regardless of IAM policy — a
   * deliberate footgun, surface it consciously. Prefer
   * `serviceIamMember(svc, "Public", { role: "roles/run.invoker", member: "allUsers" })`
   * for declarative public access. Mutable via `patch`.
   */
  invokerIamDisabled?: boolean;
  /**
   * Disable public resolution of the default `*.run.app` URI. When
   * `true`, the service is reachable only via custom domains / load
   * balancers. Mutable via `patch`.
   */
  defaultUriDisabled?: boolean;
  /** Service-level scaling. Mutable via `patch`. */
  scaling?: run.GoogleCloudRunV2ServiceScaling;
  /**
   * Traffic routing across Revisions. Defaults server-side to 100% to
   * the latest `Ready` revision. Mutable via `patch`.
   */
  traffic?: ReadonlyArray<run.GoogleCloudRunV2TrafficTarget>;
  /**
   * Audiences encoded into the auth token, for cross-service auth.
   * Mutable via `patch`.
   */
  customAudiences?: ReadonlyArray<string>;
  /**
   * Binary Authorization policy. Mutable via `patch`.
   */
  binaryAuthorization?: run.GoogleCloudRunV2BinaryAuthorization;
  /**
   * The Revision template — describes the desired Pod-equivalent.
   * **Required at create.** Mutable via `patch`; any change spawns a
   * new server-managed Revision.
   */
  template: run.GoogleCloudRunV2RevisionTemplate;
};

export type ServiceAttributes = {
  /** Service name (bare, without the `projects/.../services/` prefix). */
  name: string;
  /** Server-assigned UID — stable across rename-less mutations. */
  uid: string;
  /** Fully-qualified resource name `projects/{p}/locations/{l}/services/{n}`. */
  resourceName: string;
  /** GCP project ID, threaded through from props. */
  project: string;
  /** Region, threaded through from props. */
  location: string;
  /** Primary serving URI (`https://…run.app`). */
  uri: string;
  /** All URIs serving traffic (default + any tagged ones). */
  urls: ReadonlyArray<string>;
  /** Monotonically increasing generation, bumped on every patch. */
  generation: string | undefined;
  /** The generation currently serving traffic. */
  observedGeneration: string | undefined;
  /** Name of the latest Ready revision. */
  latestReadyRevision: string | undefined;
  /** Name of the latest created revision. */
  latestCreatedRevision: string | undefined;
  /** Overall readiness condition. */
  terminalCondition: run.GoogleCloudRunV2Condition | undefined;
  /** Per-traffic-target serving status. */
  trafficStatuses: ReadonlyArray<run.GoogleCloudRunV2TrafficTargetStatus>;
  /** Optimistic-concurrency etag. */
  etag: string | undefined;
  /** Labels currently set, including internals. */
  labels: Record<string, string>;
  /** Creation time. */
  createTime: string | undefined;
  /** Last-modified time. */
  updateTime: string | undefined;
};

export type Service = Resource<
  "GCP.Service",
  ServiceProps,
  ServiceAttributes,
  RunIamBindingContract,
  GCP.Providers
>;
export const Service = Resource<Service>("GCP.Service");

const fqName = (project: string, location: string, name: string) =>
  `projects/${project}/locations/${location}/services/${name}`;

const toServiceBody = (
  news: ServiceProps,
  desiredLabels: Record<string, string>,
): run.GoogleCloudRunV2Service => ({
  ...(news.description !== undefined ? { description: news.description } : {}),
  labels: desiredLabels,
  ...(news.annotations ? { annotations: news.annotations } : {}),
  ...(news.launchStage ? { launchStage: news.launchStage } : {}),
  ...(news.ingress ? { ingress: news.ingress } : {}),
  ...(news.invokerIamDisabled !== undefined
    ? { invokerIamDisabled: news.invokerIamDisabled }
    : {}),
  ...(news.defaultUriDisabled !== undefined
    ? { defaultUriDisabled: news.defaultUriDisabled }
    : {}),
  ...(news.scaling ? { scaling: news.scaling } : {}),
  ...(news.traffic ? { traffic: news.traffic } : {}),
  ...(news.customAudiences ? { customAudiences: news.customAudiences } : {}),
  ...(news.binaryAuthorization
    ? { binaryAuthorization: news.binaryAuthorization }
    : {}),
  template: news.template,
});

const toAttributes = (
  s: run.GoogleCloudRunV2Service,
  parent: { project: string; location: string; name: string },
): ServiceAttributes => ({
  name: parent.name,
  uid: s.uid ?? "",
  resourceName: s.name ?? fqName(parent.project, parent.location, parent.name),
  project: parent.project,
  location: parent.location,
  uri: s.uri ?? "",
  urls: s.urls ?? [],
  generation: s.generation,
  observedGeneration: s.observedGeneration,
  latestReadyRevision: s.latestReadyRevision,
  latestCreatedRevision: s.latestCreatedRevision,
  terminalCondition: s.terminalCondition,
  trafficStatuses: s.trafficStatuses ?? [],
  etag: s.etag,
  labels: { ...(s.labels ?? {}) },
  createTime: s.createTime,
  updateTime: s.updateTime,
});

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const getService = yield* run.getProjectsLocationsServices;
      const createService = yield* run.createProjectsLocationsServices;
      const patchService = yield* run.patchProjectsLocationsServices;
      const deleteService = yield* run.deleteProjectsLocationsServices;
      const getOperation = yield* run.getProjectsLocationsOperations;
      const getIamPolicy = yield* run.getIamPolicyProjectsLocationsServices;
      const setIamPolicy = yield* run.setIamPolicyProjectsLocationsServices;
      const awaitOperation = makeAwaitOperation(getOperation);
      const syncIam = makeSyncIam({ getIamPolicy, setIamPolicy });

      const observe = (project: string, location: string, name: string) =>
        getService({ name: fqName(project, location, name) }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as run.GoogleCloudRunV2Service | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as run.GoogleCloudRunV2Service | undefined),
          ),
        );

      const syncMutable = Effect.fn(function* (args: {
        name: string;
        observed: run.GoogleCloudRunV2Service;
        news: ServiceProps;
        desiredLabels: Record<string, string>;
        session: ScopedPlanStatusSession;
      }) {
        const desiredBody = toServiceBody(args.news, args.desiredLabels);
        const updateMaskFields: string[] = [];

        if ((args.observed.description ?? undefined) !== args.news.description) {
          updateMaskFields.push("description");
        }
        const labelDiff = diffTags(
          { ...(args.observed.labels ?? {}) },
          args.desiredLabels,
        );
        if (labelDiff.removed.length > 0 || labelDiff.upsert.length > 0) {
          updateMaskFields.push("labels");
        }
        if (!deepEqual(args.observed.annotations ?? {}, args.news.annotations ?? {})) {
          updateMaskFields.push("annotations");
        }
        if (
          args.news.launchStage !== undefined &&
          args.observed.launchStage !== args.news.launchStage
        ) {
          updateMaskFields.push("launchStage");
        }
        if (
          args.news.ingress !== undefined &&
          args.observed.ingress !== args.news.ingress
        ) {
          updateMaskFields.push("ingress");
        }
        if (
          args.news.invokerIamDisabled !== undefined &&
          (args.observed.invokerIamDisabled ?? false) !==
            args.news.invokerIamDisabled
        ) {
          updateMaskFields.push("invokerIamDisabled");
        }
        if (
          args.news.defaultUriDisabled !== undefined &&
          (args.observed.defaultUriDisabled ?? false) !==
            args.news.defaultUriDisabled
        ) {
          updateMaskFields.push("defaultUriDisabled");
        }
        if (args.news.scaling && !deepEqual(args.observed.scaling, args.news.scaling)) {
          updateMaskFields.push("scaling");
        }
        if (args.news.traffic && !deepEqual(args.observed.traffic ?? [], args.news.traffic)) {
          updateMaskFields.push("traffic");
        }
        if (
          args.news.customAudiences &&
          !deepEqual(args.observed.customAudiences ?? [], args.news.customAudiences)
        ) {
          updateMaskFields.push("customAudiences");
        }
        if (
          args.news.binaryAuthorization &&
          !deepEqual(args.observed.binaryAuthorization, args.news.binaryAuthorization)
        ) {
          updateMaskFields.push("binaryAuthorization");
        }
        // The Revision template is a deeply nested struct; diffing field
        // by field would be miles of code with no payoff. Deep-equal at
        // the top — patch sends the whole desired template if anything
        // inside differs. Cloud Run spawns a new Revision on patch only
        // when the template's content (modulo server-injected defaults)
        // actually changes, so resending an equivalent template after a
        // no-op reconcile is cheap.
        if (!deepEqual(args.observed.template, args.news.template)) {
          updateMaskFields.push("template");
        }

        if (updateMaskFields.length === 0) return;

        // Pass the observed etag through the body so a concurrent edit
        // racing us surfaces as Conflict instead of silently
        // overwriting. Cloud Run reads etag from the body (it's a
        // field on GoogleCloudRunV2Service, not a request-level param).
        const bodyWithEtag: run.GoogleCloudRunV2Service = {
          ...desiredBody,
          ...(args.observed.etag ? { etag: args.observed.etag } : {}),
        };
        const op = yield* patchService({
          name: args.name,
          updateMask: updateMaskFields.join(","),
          body: bodyWithEtag,
        }).pipe(
          Effect.catchTag("BadRequest", reshapeBadRequest("Service", "patch")),
        );
        if (op.name) yield* awaitOperation(op.name, args.session);
      });

      return {
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        stables: ["name", "uid", "resourceName", "project", "location"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as ServiceProps, news, [
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
          // Cloud Run service IDs must be <50 chars (server hard cap).
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, maxLength: 49 })).toLowerCase();

          // Plan-time validation: surface common footguns as typed
          // ConfigErrors before any state mutation. The server would
          // reject these too, but a 30 s wait + half-built state is a
          // worse experience than failing immediately.
          yield* validateRunName("Service", desiredName);
          yield* validateLabels(news.labels);
          yield* validateAnnotations(news.annotations);
          yield* validateContainers("Service", news.template.containers);

          const parent = `projects/${news.project}/locations/${news.location}`;
          const name = fqName(news.project, news.location, desiredName);
          const desiredLabels: Record<string, string> = {
            ...(news.labels ?? {}),
            ...internalLabels,
          };

          // 1. Observe — collapse 403 to "missing" alongside 404 (GCP
          //    surfaces 403 for resources/projects we can't see).
          let observed = yield* observe(news.project, news.location, desiredName);

          // 2. Ensure — same API-enable race as Cluster: a create can
          //    fire faster than ApiEnable's effect propagates and the
          //    server returns 403 with "If you enabled this API
          //    recently, wait a few minutes …". Retry the create call
          //    on that specific 403 for ~5 min; other Forbiddens
          //    propagate.
          if (!observed) {
            const op = yield* createService({
              parent,
              serviceId: desiredName,
              body: toServiceBody(news, desiredLabels),
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
              Effect.catchTag(
                "BadRequest",
                reshapeBadRequest("Service", "create"),
              ),
            );
            if (op?.name) yield* awaitOperation(op.name, session);
            observed = yield* getService({ name });
          }

          // 3. Sync — single patch with an updateMask of changed
          //    top-level fields. Template is diff'd shallowly (deep
          //    equality on the whole struct).
          yield* syncMutable({
            name,
            observed,
            news,
            desiredLabels,
            session,
          });

          // 4. Apply IAM bindings AFTER the service exists. Single
          //    setIamPolicy call covers all bindings for this service;
          //    foreign bindings are preserved verbatim. Etag round-trip
          //    handles concurrent edits.
          yield* syncIam({ resource: name, bindings });

          const final = yield* getService({ name });
          return toAttributes(final, {
            project: news.project,
            location: news.location,
            name: desiredName,
          });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const name = fqName(output.project, output.location, output.name);
          // Pass the etag we stored at last reconcile so a concurrent
          // edit racing this delete surfaces as Conflict. If we never
          // captured one (legacy state, adoption path), omit the
          // parameter — Cloud Run treats it as "don't check".
          yield* deleteService({
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
