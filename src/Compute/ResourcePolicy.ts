import { ConfigError } from "@distilled.cloud/gcp";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import type { ScopedPlanStatusSession } from "alchemy/Cli/Cli";
import { deepEqual, isResolved, somePropsAreDifferent } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import type * as GCP from "../Providers.ts";
import { descriptionHasAlchemyMarker, gcpAlchemyDescription, stripAlchemyMarker } from "../Tags.ts";
import { makeAwaitRegionOperation } from "./Operations.ts";

/** Regional Compute workload placement policy. Immutable changes require a new
 * physical name; same-name replacements could delete a policy still in use.
 * A4X GB200 uses { type: "HIGH_THROUGHPUT", acceleratorTopology: "1x72" }.
 * https://cloud.google.com/compute/docs/instance-groups/create-workload-policies
 */
export type ResourcePolicyProps = {
  project: string;
  region: string;
  name: string;
  description?: string;
  workloadPolicy: {
    type: "HIGH_THROUGHPUT";
    acceleratorTopology: "1x72";
  };
};
export type ResourcePolicyAttributes = {
  project: string;
  region: string;
  name: string;
  selfLink: string;
  id: string;
  description: string | undefined;
  workloadPolicy: compute.ResourcePolicyWorkloadPolicy | undefined;
};
export type ResourcePolicy = Resource<"GCP.ResourcePolicy", ResourcePolicyProps, ResourcePolicyAttributes, never, GCP.Providers>;
export const ResourcePolicy = Resource<ResourcePolicy>("GCP.ResourcePolicy");

const identityKeys = ["project", "region", "name"] as const;
const priorIdentity = (olds?: Partial<ResourcePolicyProps>, output?: Partial<ResourcePolicyAttributes>) => ({
  project: output?.project || olds?.project,
  region: output?.region || olds?.region,
  name: output?.name || olds?.name,
});
const completeIdentity = (props: ReturnType<typeof priorIdentity>): props is Pick<ResourcePolicyProps, typeof identityKeys[number]> =>
  identityKeys.every((key) => !!props[key]);

/** Ignore API-defaulted fields we do not manage, such as acceleratorTopologyMode. */
export const resourcePolicyMatches = (observed: compute.ResourcePolicy, desired: ResourcePolicyProps) =>
  observed.workloadPolicy?.type === desired.workloadPolicy.type &&
  observed.workloadPolicy?.acceleratorTopology === desired.workloadPolicy.acceleratorTopology &&
  (stripAlchemyMarker(observed.description) ?? "") === (desired.description ?? "");

const immutableChangeError = (name: string) => new ConfigError({
  message: `Resource policy ${name} has incompatible immutable workloadPolicy or description; choose a new resource policy name before changing these fields`,
});

export const ResourcePolicyProvider = () => Provider.effect(ResourcePolicy, Effect.gen(function* () {
  const get = yield* compute.getResourcePolicies;
  const insert = yield* compute.insertResourcePolicies;
  const remove = yield* compute.deleteResourcePolicies;
  const awaitOp = makeAwaitRegionOperation(yield* compute.getRegionOperations);
  const complete = Effect.fn(function* (op: compute.Operation, props: { project: string; region: string }, session: ScopedPlanStatusSession) {
    if (op.error) return yield* new ConfigError({ message: `Resource policy operation failed: ${JSON.stringify(op.error)}` });
    if (op.name) return yield* awaitOp(props.project, props.region, op.name, session);
    if (op.status !== "DONE") return yield* new ConfigError({ message: "Resource policy operation returned no operation name" });
    return op;
  });
  const observe = (props: { project: string; region: string; name: string }) => get({
    project: props.project, region: props.region, resourcePolicy: props.name,
  }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  const attrs = (observed: compute.ResourcePolicy, props: { project: string; region: string; name: string }): ResourcePolicyAttributes => ({
    project: props.project, region: props.region, name: props.name,
    selfLink: observed.selfLink ?? `https://www.googleapis.com/compute/v1/projects/${props.project}/regions/${props.region}/resourcePolicies/${props.name}`,
    id: observed.id ?? "", description: stripAlchemyMarker(observed.description), workloadPolicy: observed.workloadPolicy,
  });
  return {
    nuke: { skip: true }, list: () => Effect.succeed([]),
    stables: ["project", "region", "name", "selfLink", "id"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const prior = priorIdentity(olds, output);
      if (identityKeys.some((key) => prior[key] && prior[key] !== news[key])) return { action: "replace" } as const;
      // Never replace the same physical policy, even if somebody already made
      // the desired change remotely: replacement GC would delete that policy.
      if (olds?.workloadPolicy && (!deepEqual(olds.workloadPolicy, news.workloadPolicy) || (olds.description ?? "") !== (news.description ?? ""))) return yield* immutableChangeError(news.name);
      if (!output) return undefined;
      const observed = yield* observe(news);
      if (!observed) return { action: "update" } as const;
      if (!resourcePolicyMatches(observed, news)) return yield* immutableChangeError(news.name);
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, session }) {
      if (olds?.workloadPolicy && !somePropsAreDifferent(olds, news, ["project", "region", "name"]) && (!deepEqual(olds.workloadPolicy, news.workloadPolicy) || (olds.description ?? "") !== (news.description ?? ""))) return yield* immutableChangeError(news.name);
      let observed = yield* observe(news);
      if (!observed) {
        const op = yield* insert({ project: news.project, region: news.region, body: {
          name: news.name, description: yield* gcpAlchemyDescription(id, news.description), workloadPolicy: news.workloadPolicy,
        } });
        yield* complete(op, news, session);
        observed = yield* observe(news);
      }
      if (!observed || !resourcePolicyMatches(observed, news)) return yield* immutableChangeError(news.name);
      return attrs(observed, news);
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const props = priorIdentity(olds, output);
      if (!completeIdentity(props)) return undefined;
      const observed = yield* observe(props);
      if (!observed) return undefined;
      const result = attrs(observed, props);
      return (yield* descriptionHasAlchemyMarker(id, observed.description)) ? result : Unowned(result);
    }),
    delete: Effect.fn(function* ({ olds, output, session }) {
      const props = priorIdentity(olds, output);
      if (!completeIdentity(props)) return;
      yield* remove({ project: props.project, region: props.region, resourcePolicy: props.name }).pipe(
        Effect.flatMap((op) => complete(op, props, session)),
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  };
}));
