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
import { poolResourceName } from "./WorkloadIdentityPool.ts";

/**
 * An OIDC **provider** inside a
 * {@link import("./WorkloadIdentityPool.ts").WorkloadIdentityPool} — the
 * thing that actually declares "I trust tokens issued by this URL".
 *
 * The canonical use is keyless federation from another cloud: point
 * `oidc.issuerUri` at an EKS/AKS/GKE cluster's OIDC issuer, and pods holding
 * a projected ServiceAccount token can impersonate a GSA with no key material
 * anywhere in the system.
 *
 * ### `attributeMapping` is required and `google.subject` is mandatory
 *
 * The mapping turns claims on the incoming token into Google attributes. At
 * minimum `google.subject` must be mapped; it is what `principal://` members
 * match on. For a Kubernetes issuer the subject claim is
 * `system:serviceaccount:{namespace}:{name}`, so:
 *
 * ```typescript
 * attributeMapping: { "google.subject": "assertion.sub" }
 * ```
 *
 * ### Set `allowedAudiences`, or the default is surprising
 *
 * When `oidc.allowedAudiences` is empty, GCP accepts only the *default*
 * audience — the full provider resource name prefixed with
 * `https://iam.googleapis.com/`. A Kubernetes projected token minted for
 * audience `sts.googleapis.com` (or anything else) is then rejected with a
 * generic audience error. Set this explicitly to whatever audience the
 * token is actually minted for.
 *
 * ### Constrain trust with `attributeCondition`
 *
 * An issuer-only trust accepts **every** identity that issuer can mint — on
 * a Kubernetes cluster, that is every ServiceAccount in every namespace. Pair
 * the provider with an `attributeCondition` (and a narrow `principal://`
 * member on the GSA binding) so a token from an unrelated namespace cannot
 * impersonate anything.
 *
 * @section Creating a WorkloadIdentityPoolProvider
 * @example Trust one Kubernetes ServiceAccount on an EKS cluster
 * ```typescript
 * const provider = yield* GCP.WorkloadIdentityPoolProvider("EksOidc", {
 *   project: "123456789",
 *   poolId: pool.poolId,
 *   providerId: "eks-oidc",
 *   oidc: {
 *     issuerUri: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC123",
 *     allowedAudiences: ["sts.googleapis.com"],
 *   },
 *   attributeMapping: { "google.subject": "assertion.sub" },
 *   attributeCondition:
 *     "assertion.sub == 'system:serviceaccount:admin:eks-auth-reconciler'",
 * });
 * ```
 */
export type WorkloadIdentityPoolProviderProps = {
  /** Project that owns the pool. Prefer the project **number**. */
  project: string;
  /** ID of the enclosing pool. */
  poolId: string;
  /**
   * Provider ID, 4–32 characters of `[a-z0-9-]`. Immutable — changing it
   * replaces the provider. The `gcp-` prefix is reserved by Google.
   */
  providerId: string;
  /** The OIDC issuer this provider trusts. */
  oidc: {
    /** Issuer URL. Must be HTTPS and serve an OIDC discovery document. */
    issuerUri: string;
    /**
     * Acceptable `aud` values. Leave unset only if the token is minted for
     * the provider's default audience — see the note above.
     */
    allowedAudiences?: string[];
    /**
     * Inline JWKS, for issuers whose keys are not publicly reachable. When
     * unset, GCP fetches `jwks_uri` from the issuer's discovery document,
     * which requires the issuer to be reachable from Google's network.
     */
    jwksJson?: string;
  };
  /**
   * Claim-to-attribute mapping. Must include `google.subject`.
   */
  attributeMapping: Record<string, string>;
  /** CEL expression further restricting which credentials are accepted. */
  attributeCondition?: string;
  /** Display name, max 32 characters. */
  displayName?: string;
  /** Description, max 256 characters. */
  description?: string;
  /** Disable the provider without deleting it. */
  disabled?: boolean;
};

export type WorkloadIdentityPoolProviderAttributes = {
  /** Full resource name, `…/workloadIdentityPools/{pool}/providers/{id}`. */
  name: string;
  project: string;
  poolId: string;
  providerId: string;
  issuerUri: string | undefined;
  // `readonly` because that is how the SDK models repeated fields; widening it
  // to a mutable array here would only force a copy at every use site.
  allowedAudiences: readonly string[] | undefined;
  attributeMapping: Record<string, string> | undefined;
  attributeCondition: string | undefined;
  displayName: string | undefined;
  description: string | undefined;
  state: string | undefined;
  disabled: boolean | undefined;
  /**
   * The audience string to put in a credential configuration, i.e.
   * `//iam.googleapis.com/{name}`. Provided because assembling it by hand is
   * easy to get subtly wrong (the leading `//`, and no scheme).
   */
  audience: string;
};

export interface WorkloadIdentityPoolProvider
  extends Resource<
    "GCP.WorkloadIdentityPoolProvider",
    WorkloadIdentityPoolProviderProps,
    WorkloadIdentityPoolProviderAttributes,
    never,
    GCP.Providers
  > {}

export const WorkloadIdentityPoolProvider =
  Resource<WorkloadIdentityPoolProvider>("GCP.WorkloadIdentityPoolProvider");

export const providerResourceName = (
  project: string,
  poolId: string,
  providerId: string,
) => `${poolResourceName(project, poolId)}/providers/${providerId}`;

const deepEqualRecord = (
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

export const WorkloadIdentityPoolProviderProvider = () =>
  Provider.effect(
    WorkloadIdentityPoolProvider,
    Effect.gen(function* () {
      const getProvider =
        yield* iam.getProjectsLocationsWorkloadIdentityPoolsProviders;
      const createProvider =
        yield* iam.createProjectsLocationsWorkloadIdentityPoolsProviders;
      const patchProvider =
        yield* iam.patchProjectsLocationsWorkloadIdentityPoolsProviders;
      const deleteProvider =
        yield* iam.deleteProjectsLocationsWorkloadIdentityPoolsProviders;
      const undeleteProvider =
        yield* iam.undeleteProjectsLocationsWorkloadIdentityPoolsProviders;
      const getOperations =
        yield* iam.getProjectsLocationsWorkloadIdentityPoolsProvidersOperations;
      const awaitOperation = makeAwaitOperation(
        getOperations,
        "Workload Identity provider",
      );

      const observeProvider = (
        project: string,
        poolId: string,
        providerId: string,
      ) =>
        getProvider({
          name: providerResourceName(project, poolId, providerId),
        }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(
              undefined as iam.WorkloadIdentityPoolProvider | undefined,
            ),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(
              undefined as iam.WorkloadIdentityPoolProvider | undefined,
            ),
          ),
        );

      const toAttrs = (
        project: string,
        poolId: string,
        providerId: string,
        provider: iam.WorkloadIdentityPoolProvider,
      ): WorkloadIdentityPoolProviderAttributes => {
        const name =
          provider.name ?? providerResourceName(project, poolId, providerId);
        return {
          name,
          project,
          poolId,
          providerId,
          issuerUri: provider.oidc?.issuerUri,
          allowedAudiences: provider.oidc?.allowedAudiences,
          attributeMapping: provider.attributeMapping,
          attributeCondition: provider.attributeCondition,
          displayName: provider.displayName,
          description: stripAlchemyMarker(provider.description),
          state: provider.state,
          disabled: provider.disabled,
          audience: `//iam.googleapis.com/${name}`,
        };
      };

      return {
        stables: ["name", "project", "poolId", "providerId", "audience"],
        diff: Effect.fn(function* ({ olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          const oldProps = olds as WorkloadIdentityPoolProviderProps;
          // All three are part of the resource name; the API cannot move a
          // provider between pools or rename it.
          if (
            oldProps.project !== news.project ||
            oldProps.poolId !== news.poolId ||
            oldProps.providerId !== news.providerId
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const project = output?.project ?? olds?.project;
          const poolId = output?.poolId ?? olds?.poolId;
          const providerId = output?.providerId ?? olds?.providerId;
          if (!project || !poolId || !providerId) return undefined;
          const provider = yield* observeProvider(project, poolId, providerId);
          if (!provider) return undefined;
          const attrs = toAttrs(project, poolId, providerId, provider);
          return (yield* descriptionHasAlchemyMarker(id, provider.description))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const { project, poolId, providerId } = news;
          if (!news.attributeMapping["google.subject"]) {
            // Caught here rather than at the API, which rejects it with a
            // message that does not name the missing key.
            return yield* new ConfigError({
              message: `Workload Identity provider ${providerId} must map 'google.subject' in attributeMapping.`,
            });
          }
          const description = yield* gcpAlchemyDescription(
            id,
            news.description,
          );
          const body: iam.WorkloadIdentityPoolProvider = {
            ...(news.displayName ? { displayName: news.displayName } : {}),
            description,
            ...(news.disabled !== undefined ? { disabled: news.disabled } : {}),
            attributeMapping: news.attributeMapping,
            ...(news.attributeCondition
              ? { attributeCondition: news.attributeCondition }
              : {}),
            oidc: {
              issuerUri: news.oidc.issuerUri,
              ...(news.oidc.allowedAudiences
                ? { allowedAudiences: news.oidc.allowedAudiences }
                : {}),
              ...(news.oidc.jwksJson ? { jwksJson: news.oidc.jwksJson } : {}),
            },
          };

          let provider = yield* observeProvider(project, poolId, providerId);

          // Same soft-delete reasoning as the pool: the ID is held until the
          // purge, so undelete rather than strand the deploy.
          if (provider?.state === "DELETED") {
            yield* session.note(
              `Undeleting soft-deleted Workload Identity provider ${providerId}…`,
            );
            const op = yield* undeleteProvider({
              name: providerResourceName(project, poolId, providerId),
              body: {},
            });
            if (op.name) yield* awaitOperation(op.name, session);
            provider = yield* observeProvider(project, poolId, providerId);
          }

          if (!provider) {
            const op = yield* createProvider({
              parent: poolResourceName(project, poolId),
              workloadIdentityPoolProviderId: providerId,
              body,
            });
            if (op.name) yield* awaitOperation(op.name, session);
            provider = yield* observeProvider(project, poolId, providerId);
            if (!provider) {
              return yield* new ConfigError({
                message: `Workload Identity provider ${providerId} in pool ${poolId} was not readable after create.`,
              });
            }
          } else {
            const needsPatch =
              provider.displayName !== news.displayName ||
              provider.description !== description ||
              (provider.disabled ?? false) !== (news.disabled ?? false) ||
              provider.attributeCondition !== news.attributeCondition ||
              !deepEqualRecord(
                provider.attributeMapping,
                news.attributeMapping,
              ) ||
              provider.oidc?.issuerUri !== news.oidc.issuerUri ||
              JSON.stringify(provider.oidc?.allowedAudiences ?? []) !==
                JSON.stringify(news.oidc.allowedAudiences ?? []) ||
              (provider.oidc?.jwksJson ?? undefined) !==
                (news.oidc.jwksJson ?? undefined);
            if (needsPatch) {
              const op = yield* patchProvider({
                name: providerResourceName(project, poolId, providerId),
                updateMask:
                  "displayName,description,disabled,attributeMapping,attributeCondition,oidc",
                body,
              });
              if (op.name) yield* awaitOperation(op.name, session);
              provider =
                (yield* observeProvider(project, poolId, providerId)) ??
                provider;
            }
          }

          yield* session.note(
            providerResourceName(project, poolId, providerId),
          );
          return toAttrs(project, poolId, providerId, provider);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          if (!output.project || !output.poolId || !output.providerId) return;
          const op = yield* deleteProvider({
            name: providerResourceName(
              output.project,
              output.poolId,
              output.providerId,
            ),
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
