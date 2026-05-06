import { ConfigError } from "@distilled.cloud/gcp";
import * as billing from "@distilled.cloud/gcp/cloudbilling-v1";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager-v3";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { diffTags } from "alchemy/Tags";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { gcpInternalLabels, hasAlchemyLabels } from "../Tags.ts";
import type * as GCP from "../Providers.ts";

/**
 * Parent for a GCP project — either a folder or an organization.
 */
export type ProjectParent =
  | { type: "folder"; id: string }
  | { type: "organization"; id: string };

export type ProjectProps = {
  /**
   * Globally-unique project ID. 6-30 lowercase letters/digits/hyphens,
   * must start with a letter, no trailing hyphens. If omitted, derived
   * deterministically from the stack/stage/logical-id via
   * `createPhysicalName`.
   *
   * Project IDs are immutable — changing this triggers a replacement.
   */
  projectId?: string;
  /**
   * User-visible display name. 4-30 chars, mutable.
   */
  displayName?: string;
  /**
   * The folder or organization that owns this project.
   *
   * Moving projects between parents is a separate API; treat as
   * replace-only for now.
   */
  parent: ProjectParent;
  /**
   * User-supplied labels. Alchemy-internal labels (`alchemy_app`,
   * `alchemy_stage`, `alchemy_id`) are merged in automatically and used
   * to gate `read`-time adoption — do not set those keys yourself.
   */
  labels?: Record<string, string>;
  /**
   * Billing account to attach to the project. Must be the
   * fully-qualified resource name `billingAccounts/{id}` (e.g.
   * `billingAccounts/<redacted-billing>`) — that's what
   * `cloudbilling.projects.updateBillingInfo` accepts in
   * `billingAccountName`; passing the bare id returns `400 Request
   * contains an invalid argument`. The prefix is enforced at the
   * type level here so the wrong shape fails at compile time.
   *
   * Required for any paid API (GKE, Compute, etc.) — fresh projects
   * have no billing account by default and refuse to enable paid
   * services until one is attached.
   *
   * Mutable via `cloudbilling.projects.updateBillingInfo`. Set to
   * `undefined` (omit) on a project that previously had billing
   * attached and the resource will detach billing on next reconcile,
   * which stops paid services on the project — be deliberate.
   *
   * The `cloudbilling.googleapis.com` API must be enabled on the
   * caller's ADC quota project (typically the user's primary
   * project), not on this target project. This is the same
   * precondition as `cloudresourcemanager.googleapis.com` for project
   * creation, so if you can create projects you can attach billing.
   */
  billingAccount?: BillingAccountName;
};

/**
 * Fully-qualified billing-account resource name. The
 * `billingAccounts/` prefix is the form GCP's APIs return and accept;
 * encoding it at the type level rules out the bare-id mistake at
 * compile time.
 */
export type BillingAccountName = `billingAccounts/${string}`;

/**
 * A GCP project under an organization or folder.
 *
 * Project creation is asynchronous: `createProjects` returns a
 * long-running `Operation` which we poll until `done`. The same applies
 * to `delete` and `patch`. Delete is soft (30-day window) on the
 * server side; we don't undelete.
 *
 * Adoption: a `read` returning a project that lacks our `alchemy_*`
 * labels is wrapped in `Unowned(attrs)`, so the engine fails the plan
 * unless the user passed `--adopt`. This matters more for GCP than for
 * R2 — projects carry billing.
 *
 * @section Creating a Project
 * @example Project under a folder
 * ```typescript
 * const project = yield* GCP.Project("Research", {
 *   parent: { type: "folder", id: "<redacted-folder-id>" },
 *   displayName: "Research Cluster",
 * });
 * ```
 *
 * @example Project with an explicit ID
 * ```typescript
 * const project = yield* GCP.Project("Research", {
 *   projectId: "microagi-research-001",
 *   parent: { type: "folder", id: "<redacted-folder-id>" },
 * });
 * ```
 */
export type Project = Resource<
  "GCP.Project",
  ProjectProps,
  {
    /** Globally-unique user-assigned id (e.g. `microagi-research-001`). */
    projectId: string;
    /**
     * Server-assigned numeric id (e.g. `415104041262`). String at
     * runtime — GCP encodes int64s as JSON strings to preserve
     * precision — but typed as `` `${number}` `` so callers can
     * compose project-number-form references (`PsaConnection`,
     * `ParallelstoreInstance`, `networkRef`) without manual coercion.
     */
    projectNumber: `${number}`;
    /** Resource name in the form `projects/{projectNumber}`. */
    name: string;
    /** Display name — may be `undefined` if never set. */
    displayName: string | undefined;
    /** Lifecycle state — `ACTIVE` for normal projects. */
    state: string;
    /** Parent resource string in the form `folders/123` / `organizations/456`. */
    parent: string;
    /** RFC3339 timestamp from the server. */
    createTime: string | undefined;
    /** Labels currently set on the project, including `alchemy_*` internals. */
    labels: Record<string, string>;
    /**
     * Billing account currently attached to the project (e.g.
     * `billingAccounts/XXXXXX-YYYYYY-ZZZZZZ`), or `undefined` when none
     * is attached.
     */
    billingAccount: BillingAccountName | undefined;
    /**
     * Whether the project is associated with an *open* billing account.
     * `false` when no billing account is attached or the attached
     * account is closed; `true` once an open account is attached and
     * paid services can be enabled.
     */
    billingEnabled: boolean;
  },
  never,
  GCP.Providers
>;

export const Project = Resource<Project>("GCP.Project");

const parentToString = (parent: ProjectParent): string =>
  parent.type === "folder" ? `folders/${parent.id}` : `organizations/${parent.id}`;

const createProjectId = (id: string, override: string | undefined) =>
  Effect.gen(function* () {
    if (override) return override;
    // GCP project IDs: 6-30 chars, lowercase letters/digits/hyphens,
    // must start with a letter. `createPhysicalName` already prepends
    // the stack name (which conventionally starts with a letter), so
    // the first-letter rule is satisfied by construction.
    return (yield* createPhysicalName({ id, maxLength: 30 })).toLowerCase();
  });

const toAttributes = (
  p: crm.Project,
  billingInfo: billing.ProjectBillingInfo | undefined,
): Project["Attributes"] => ({
  projectId: p.projectId!,
  // GCP returns the project number as a digit-only string. The cast
  // safely narrows from `string` to `` `${number}` `` — server-side
  // contract guarantees the shape (the empty-string fallback is a
  // belt-and-braces guard for malformed responses; downstream code
  // observes a project state of "ACTIVE" before consuming this).
  projectNumber: (p.name?.replace(/^projects\//, "") ?? "0") as `${number}`,
  name: p.name ?? `projects/${p.projectId}`,
  displayName: p.displayName,
  state: p.state ?? "ACTIVE",
  parent: p.parent ?? "",
  createTime: p.createTime,
  labels: { ...(p.labels ?? {}) },
  // GCP returns `billingAccountName` as a plain string but its format
  // is always `billingAccounts/{id}` — narrow at the boundary.
  billingAccount: (billingInfo?.billingAccountName || undefined) as
    | BillingAccountName
    | undefined,
  billingEnabled: billingInfo?.billingEnabled ?? false,
});

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      // Acquire SDK clients ONCE — Credentials and HttpClient are
      // resolved at provider construction, not on every reconcile.
      const getProjects = yield* crm.getProjects;
      const createProjects = yield* crm.createProjects;
      const patchProjects = yield* crm.patchProjects;
      const deleteProjects = yield* crm.deleteProjects;
      const getOperations = yield* crm.getOperations;
      const getBillingInfo = yield* billing.getBillingInfoProjects;
      const updateBillingInfo = yield* billing.updateBillingInfoProjects;

      const awaitOperation = Effect.fn(function* (
        operationName: string,
        session: ScopedPlanStatusSession,
      ) {
        const op = yield* getOperations({ name: operationName }).pipe(
          Effect.flatMap((current) =>
            current.done === true
              ? Effect.succeed(current)
              : Effect.fail({ _tag: "OperationPending" as const }),
          ),
          Effect.retry({
            while: (e: { _tag?: string }) => e?._tag === "OperationPending",
            schedule: Schedule.exponential(Duration.seconds(1), 1.5).pipe(
              Schedule.both(Schedule.recurs(60)),
              Schedule.tapOutput(() =>
                session.note(`Waiting for GCP operation ${operationName}…`),
              ),
            ),
          }),
        );

        if (op.error) {
          return yield* new ConfigError({
            message: `GCP operation ${operationName} failed: ${
              op.error.message ?? JSON.stringify(op.error)
            }`,
          });
        }
        return op;
      });

      const observeProject = (projectId: string) =>
        getProjects({ name: `projects/${projectId}` }).pipe(
          // GCP returns 403 Forbidden (not 404) when a project ID is
          // unknown or invisible to the caller — a deliberate choice to
          // avoid leaking project-ID existence across tenants. From this
          // provider's perspective both shapes mean "not present", so
          // observation should treat them identically.
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as crm.Project | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as crm.Project | undefined),
          ),
          // A project marked for deletion is still readable but in
          // `DELETE_REQUESTED` state. Treat as missing so the create
          // path runs; if the projectId is still reserved server-side
          // the create will fail with Conflict and surface a real
          // error.
          Effect.map((p) =>
            p && p.state && p.state !== "ACTIVE" ? undefined : p,
          ),
        );

      const requireProject = (projectId: string, context: string) =>
        observeProject(projectId).pipe(
          Effect.flatMap((p) =>
            p
              ? Effect.succeed(p)
              : Effect.fail(
                  new ConfigError({
                    message: `Project ${projectId} ${context}.`,
                  }),
                ),
          ),
        );

      // Read current billing association. Returns `undefined` when the
      // project is unknown to billing (NotFound) or invisible to the
      // caller (Forbidden) — same 403→missing collapse as the project
      // observe path.
      const observeBilling = (projectId: string) =>
        getBillingInfo({ name: `projects/${projectId}` }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as billing.ProjectBillingInfo | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as billing.ProjectBillingInfo | undefined),
          ),
        );

      // Attach / detach a billing account on the project. Pass empty
      // string to detach (GCP's documented contract — see the long
      // disclaimer on `updateBillingInfoProjects` warning that this
      // disables paid services on the project). Synchronous PUT, no
      // LRO involved.
      const syncBilling = Effect.fn(function* (
        projectId: string,
        observed: billing.ProjectBillingInfo | undefined,
        desired: string | undefined,
      ) {
        const observedAccount = observed?.billingAccountName ?? "";
        const desiredAccount = desired ?? "";
        if (observedAccount === desiredAccount) {
          return observed;
        }
        return yield* updateBillingInfo({
          name: `projects/${projectId}`,
          body: { billingAccountName: desiredAccount },
        }).pipe(
          // Surface the most common BadRequest mode — the billing
          // account's per-account project-attach quota — with a
          // remediation pointer. Soft-deleted projects continue to
          // hold quota for 30 days, so the typical fix is a quota
          // increase rather than waiting it out. Other 400s
          // (malformed account name, closed account, permission
          // mismatch) propagate untouched so the underlying API
          // message is preserved.
          // Surface the most common BadRequest mode with a clear
          // remediation pointer, and re-shape every BadRequest into
          // ConfigError so callers see one error class regardless of
          // the underlying GCP-side detail. The two patterns:
          //
          //   1. Billing-account project-attach quota exhausted —
          //      every soft-deleted project still holds quota for
          //      30 days. Real fix is a quota increase request.
          //   2. Other 400s (malformed account name, closed
          //      account, IAM mismatch on `billing.resourceAssociations.create`)
          //      — surface the underlying GCP message.
          Effect.catchTag("BadRequest", (e) => {
            // GCP returns the high-level message in `e.message` and
            // stuffs the structured detail (e.g. `QuotaFailure`) into
            // the response body's `details[]` array — which distilled
            // doesn't surface (only `message` is parsed in
            // `vendor/distilled/packages/gcp/src/client/api.ts:32-35`).
            //
            // The single most common 4xx on `updateBillingInfo` is
            // FAILED_PRECONDITION ("Precondition check failed.") for
            // the billing account's per-account project-attach quota.
            // Each successful attach — including soft-deleted projects
            // within their 30-day retention window — counts toward
            // this quota. There is no way to detect this case with
            // certainty from the surfaced error, so we always include
            // the quota-remediation hint alongside the underlying
            // message; users who hit a different 400 will still see
            // GCP's real reason in the prefix.
            const underlying = e.message ?? "unknown 400 from cloudbilling.updateBillingInfo";
            const isLikelyQuota = /precondition|FAILED_PRECONDITION/i.test(underlying);
            const hint = isLikelyQuota
              ? " This is most often the billing account's project-attach quota — request an increase at https://support.google.com/code/contact/billing_quota_increase, or use a different billing account."
              : "";
            return Effect.fail(
              new ConfigError({
                message: `Cannot attach billing account ${desiredAccount} to project ${projectId}: ${underlying}.${hint}`,
              }),
            );
          }),
        );
      });

      const syncMutable = Effect.fn(function* (
        observed: crm.Project,
        desired: { displayName: string | undefined; labels: Record<string, string> },
        session: ScopedPlanStatusSession,
      ) {
        const observedLabels = { ...(observed.labels ?? {}) };
        const updateMaskFields: string[] = [];
        if (desired.displayName !== observed.displayName) {
          updateMaskFields.push("display_name");
        }
        const labelDiff = diffTags(observedLabels, desired.labels);
        if (labelDiff.removed.length > 0 || labelDiff.upsert.length > 0) {
          updateMaskFields.push("labels");
        }

        if (updateMaskFields.length === 0) return observed;

        const op = yield* patchProjects({
          name: observed.name!,
          updateMask: updateMaskFields.join(","),
          body: {
            displayName: desired.displayName,
            labels: desired.labels,
          },
        });
        if (op.name) yield* awaitOperation(op.name, session);
        return yield* requireProject(
          observed.projectId!,
          "disappeared after patch",
        );
      });

      return {
        stables: ["projectId", "projectNumber", "name"],
        diff: Effect.fn(function* ({ id, news, olds = {}, output }) {
          if (!isResolved(news)) return undefined;
          const desiredId = yield* createProjectId(id, news.projectId);
          const currentId =
            output?.projectId ??
            (yield* createProjectId(id, olds.projectId));
          const desiredParent = parentToString(news.parent);
          const observedParent =
            output?.parent ??
            (olds.parent ? parentToString(olds.parent) : desiredParent);

          if (desiredId !== currentId || observedParent !== desiredParent) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const projectId = yield* createProjectId(id, news.projectId);
          const parent = parentToString(news.parent);
          const internalLabels = yield* gcpInternalLabels(id);
          const desiredLabels: Record<string, string> = {
            ...(news.labels ?? {}),
            ...internalLabels, // alchemy keys reserved — overwrite user values
          };

          // 1. Observe — cloud state is authoritative; `output`/`olds`
          //    are caches and may be stale or missing.
          let observed = yield* observeProject(projectId);

          // 2. Ensure — create if missing. `createProjects` returns an
          //    LRO; poll until done. `Conflict` covers two cases: a
          //    peer reconciler raced us, or a prior reconcile created
          //    the project but state-persistence failed. In both, the
          //    project exists — re-observe and converge.
          if (!observed) {
            const operation = yield* createProjects({
              body: {
                projectId,
                parent,
                displayName: news.displayName,
                labels: desiredLabels,
              },
            }).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));

            if (operation?.name) yield* awaitOperation(operation.name, session);

            observed = yield* requireProject(
              projectId,
              "did not appear after create",
            );
          }

          // 3. Sync — displayName + labels are mutable. Diff against
          //    OBSERVED state (not `olds`) so adoption converges
          //    correctly: if a foreign label set is on the project,
          //    the patch will replace it with our desired set
          //    (including alchemy internals).
          const synced = yield* syncMutable(
            observed,
            {
              displayName: news.displayName ?? observed.displayName,
              labels: desiredLabels,
            },
            session,
          );

          // 4. Sync billing association. Done after the project patch
          //    so the project resource is fully present before we
          //    attach billing (CRM project create is the LRO; billing
          //    update is synchronous).
          const observedBilling = yield* observeBilling(synced.projectId!);
          const finalBilling = yield* syncBilling(
            synced.projectId!,
            observedBilling,
            news.billingAccount,
          );

          return toAttributes(synced, finalBilling);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* deleteProjects({ name: `projects/${output.projectId}` }).pipe(
            Effect.flatMap((op) =>
              op.name ? awaitOperation(op.name, session) : Effect.succeed(op),
            ),
            // Already gone.
            Effect.catchTag("NotFound", () => Effect.void),
            // GCP returns 400 with "Project ... is already in
            // DELETE_REQUESTED" when delete is invoked on an already-
            // soft-deleted project. Treat that as idempotent success.
            // TODO(distilled): tag this state via patch — see finding 12.
            // The GCP `matchError` (vendor/distilled/packages/gcp/src/client/api.ts)
            // currently dispatches purely on HTTP status and ignores the
            // `message.includes` matcher in the patch JSON, so a per-operation
            // patch alone can't disambiguate this case from a real 400 without
            // also extending `matchError` to consult the matchers.
            Effect.catchTag("BadRequest", (e) =>
              /already.*delet|DELETE_REQUESTED/i.test(e.message ?? "")
                ? Effect.void
                : Effect.fail(e),
            ),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const projectId =
            output?.projectId ??
            (yield* createProjectId(id, olds?.projectId));
          const observed = yield* observeProject(projectId);
          if (!observed) return undefined;
          const observedBilling = yield* observeBilling(projectId);
          const attrs = toAttributes(observed, observedBilling);
          // Adoption gate: a project without our internal labels was
          // created outside this stack/stage/id. The engine surfaces
          // `Unowned(attrs)` to the user as "exists but is not ours" —
          // adoption requires `--adopt` (or `adopt(true)`).
          return (yield* hasAlchemyLabels(id, observed.labels))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
