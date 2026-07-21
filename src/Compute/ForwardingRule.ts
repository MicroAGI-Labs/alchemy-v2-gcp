import * as compute from "@distilled.cloud/gcp/compute-v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { deepEqual, isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { gcpInternalLabels, hasAlchemyLabels } from "../Tags.ts";
import type * as GCP from "../Providers.ts";
import { makeAwaitRegionOperation } from "./Operations.ts";

/**
 * A regional forwarding rule. The intended use here is a **Private
 * Service Connect consumer endpoint** — binding a reserved internal
 * {@link Address} to a producer *service attachment* (e.g. the one
 * Cloud SQL publishes per PSC-enabled instance), so clients in this
 * VPC reach the producer service at that IP.
 *
 * PSC endpoint rules carry no ports / load-balancing scheme — the API
 * requires `loadBalancingScheme: ""` for them, which is what this
 * resource sends. The endpoint must be created in the **same region as
 * the service attachment**; set `allowPscGlobalAccess` so clients in
 * other regions of the VPC can still use it.
 *
 * Other forwarding-rule shapes (L4 ILB, NetLB, proxy LBs) are not
 * modelled — add props if/when needed.
 *
 * All connection-defining props are immutable here and trigger replace;
 * a PSC endpoint is cheap to recreate. Labels are mutable.
 *
 * @section Creating a PSC endpoint
 * @example Cloud SQL PSC endpoint with global access
 * ```typescript
 * const endpoint = yield* GCP.ForwardingRule("DbPscEndpoint", {
 *   project: hostProject.projectId,
 *   region: "europe-west1",
 *   network: vpc.selfLink,
 *   ipAddress: endpointIp.selfLink,
 *   target: "projects/<producer>/regions/europe-west1/serviceAttachments/<sa>",
 *   allowPscGlobalAccess: true,
 * });
 * ```
 */
export type ForwardingRuleProps = {
  /** GCP project ID hosting the rule. Immutable — replace if changed. */
  project: string;
  /** GCP region. Must match the target service attachment's region. Immutable — replace. */
  region: string;
  /**
   * Rule name. Defaults to `createPhysicalName({ id, lowercase: true,
   * maxLength: 63 })`. Immutable — replace if changed.
   */
  name?: string;
  /** Description (free-form). Set on create; immutable. */
  description?: string;
  /**
   * URL of the consumer VPC. Pass `vpc.selfLink` from a `GCP.Network`
   * to make alchemy sequence the rule after the VPC. Immutable — replace.
   */
  network: string;
  /**
   * The endpoint IP — a URL of a reserved `GCP.Address` (pass
   * `address.selfLink` for the dep edge) or a literal IP. Immutable —
   * replace.
   */
  ipAddress: string;
  /**
   * URI of the producer service attachment to connect to
   * (`projects/{p}/regions/{r}/serviceAttachments/{name}`). Immutable —
   * replace.
   */
  target: string;
  /**
   * Let clients in any region of the VPC use this endpoint (PSC global
   * access). Defaults to `false`. Immutable — replace.
   */
  allowPscGlobalAccess?: boolean;
  /**
   * Resource labels. Alchemy internal labels (`alchemy_app`,
   * `alchemy_stage`, `alchemy_id`) are merged on top automatically and
   * are reserved. Mutable via `setLabels`.
   */
  labels?: Record<string, string>;
};

export type ForwardingRuleAttributes = {
  /** Rule name. */
  name: string;
  /** GCP project ID, threaded through from props for delete/read. */
  project: string;
  /** GCP region, threaded through from props for delete/read. */
  region: string;
  /** Server-defined URL. */
  selfLink: string;
  /** Server-assigned numeric id. */
  id: string;
  /** The endpoint IP (the API always returns the literal IP). */
  ipAddress: string;
  /** Producer service attachment URI. */
  target: string | undefined;
  /** Consumer VPC URL. */
  network: string | undefined;
  /** PSC global access flag. */
  allowPscGlobalAccess: boolean;
  /** Server-assigned PSC connection id. */
  pscConnectionId: string | undefined;
  /** PSC connection status: `ACCEPTED`, `PENDING`, `REJECTED`, `CLOSED`, … */
  pscConnectionStatus: string | undefined;
  /** Labels currently set, including the alchemy internals. */
  labels: Record<string, string>;
};

export type ForwardingRule = Resource<
  "GCP.ForwardingRule",
  ForwardingRuleProps,
  ForwardingRuleAttributes,
  never,
  GCP.Providers
>;
export const ForwardingRule = Resource<ForwardingRule>("GCP.ForwardingRule");

const toForwardingRuleAttributes = (
  f: compute.ForwardingRule,
  parent: { project: string; region: string },
): ForwardingRuleAttributes => ({
  name: f.name ?? "",
  project: parent.project,
  region: parent.region,
  selfLink: f.selfLink ?? "",
  id: f.id ?? "",
  ipAddress: f.IPAddress ?? "",
  target: f.target,
  network: f.network,
  allowPscGlobalAccess: f.allowPscGlobalAccess ?? false,
  pscConnectionId: f.pscConnectionId,
  pscConnectionStatus: f.pscConnectionStatus,
  labels: { ...(f.labels ?? {}) },
});

export const ForwardingRuleProvider = () =>
  Provider.effect(
    ForwardingRule,
    Effect.gen(function* () {
      const getForwardingRules = yield* compute.getForwardingRules;
      const insertForwardingRules = yield* compute.insertForwardingRules;
      const deleteForwardingRules = yield* compute.deleteForwardingRules;
      const setLabelsForwardingRules = yield* compute.setLabelsForwardingRules;
      const getRegionOperations = yield* compute.getRegionOperations;
      const awaitOp = makeAwaitRegionOperation(getRegionOperations);

      const observe = (project: string, region: string, name: string) =>
        getForwardingRules({ project, region, forwardingRule: name }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as compute.ForwardingRule | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as compute.ForwardingRule | undefined),
          ),
        );

      const syncLabels = Effect.fn(function* (args: {
        project: string;
        region: string;
        observed: compute.ForwardingRule;
        desired: Record<string, string>;
        session: ScopedPlanStatusSession;
      }) {
        if (deepEqual(args.observed.labels ?? {}, args.desired)) return;
        const op = yield* setLabelsForwardingRules({
          project: args.project,
          region: args.region,
          resource: args.observed.name ?? "",
          body: {
            labels: args.desired,
            labelFingerprint: args.observed.labelFingerprint,
          },
        });
        if (op.name) {
          yield* awaitOp(args.project, args.region, op.name, args.session);
        }
      });

      return {
        stables: ["name", "project", "region", "selfLink", "id"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as ForwardingRuleProps, news, [
              "project",
              "region",
              "name",
              "network",
              "ipAddress",
              "target",
              "allowPscGlobalAccess",
            ])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const internalLabels = yield* gcpInternalLabels(id);
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const desiredLabels: Record<string, string> = {
            ...(news.labels ?? {}),
            ...internalLabels,
          };

          let observed = yield* observe(news.project, news.region, desiredName);

          if (!observed) {
            const body: compute.ForwardingRule = {
              name: desiredName,
              ...(news.description ? { description: news.description } : {}),
              network: news.network,
              IPAddress: news.ipAddress,
              target: news.target,
              // PSC consumer endpoints take no scheme — the API rejects
              // anything other than the empty string for them.
              loadBalancingScheme: "",
              ...(news.allowPscGlobalAccess !== undefined
                ? { allowPscGlobalAccess: news.allowPscGlobalAccess }
                : {}),
              labels: desiredLabels,
            };
            const op = yield* insertForwardingRules({
              project: news.project,
              region: news.region,
              body,
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as compute.Operation | undefined),
              ),
            );
            if (op?.name) {
              yield* awaitOp(news.project, news.region, op.name, session);
            }
            observed = yield* getForwardingRules({
              project: news.project,
              region: news.region,
              forwardingRule: desiredName,
            });
          }

          yield* syncLabels({
            project: news.project,
            region: news.region,
            observed,
            desired: desiredLabels,
            session,
          });

          const final = yield* getForwardingRules({
            project: news.project,
            region: news.region,
            forwardingRule: desiredName,
          });
          return toForwardingRuleAttributes(final, {
            project: news.project,
            region: news.region,
          });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const deletion = deleteForwardingRules({
            project: output.project,
            region: output.region,
            forwardingRule: output.name,
          }).pipe(
            Effect.flatMap((op) =>
              op.name
                ? awaitOp(output.project, output.region, op.name, session)
                : Effect.succeed(op),
            ),
          );
          yield* deletion.pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const project = output?.project ?? olds?.project;
          const region = output?.region ?? olds?.region;
          if (!project || !region) return undefined;
          const name =
            output?.name ??
            olds?.name ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const observed = yield* observe(project, region, name);
          if (!observed) return undefined;
          const attrs = toForwardingRuleAttributes(observed, {
            project,
            region,
          });
          return (yield* hasAlchemyLabels(id, observed.labels))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
