import { Credentials } from "@distilled.cloud/gcp";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved, somePropsAreDifferent } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type * as GCP from "../Providers.ts";
import { gcpInternalLabels, hasAlchemyLabels } from "../Tags.ts";
import {
  applyObject,
  deleteObject,
  getObject,
  KubernetesApiError,
  type GkeConnection,
  type KubeObject,
} from "./client.ts";

/**
 * Apply an **arbitrary** Kubernetes object to a GKE cluster via server-side
 * apply — the generic escape hatch for any Kind (built-ins and CRDs alike),
 * complementing the typed {@link "./Secret.ts"} resource.
 *
 * Convergence is a single `application/apply-patch+yaml` PATCH with
 * `fieldManager: alchemy`, `force: true`. SSA merges by field ownership: only
 * the fields you declare are managed, fields owned by other managers/controllers
 * are left intact, and dropping a previously-declared field prunes it. The REST
 * path is resolved from the apiserver's discovery endpoint, so no per-Kind code
 * is required. See {@link "./client.ts"} for the full create/replace-vs-SSA
 * rationale and when to prefer each.
 *
 * Ownership for adoption is gated on alchemy-internal `metadata.labels` (same
 * triple as labelled GCP resources), so an object created out of band reads
 * back as {@link Unowned} until adopted.
 *
 * @section Applying a manifest
 * @example A ConfigMap
 * ```typescript
 * yield* GCP.KubernetesManifest("AppConfig", {
 *   endpoint: cluster.endpoint,
 *   caCertificate: cluster.clusterCaCertificate,
 *   apiVersion: "v1",
 *   kind: "ConfigMap",
 *   name: "app-config",
 *   namespace: "admin",
 *   body: { data: { LOG_LEVEL: "info" } },
 * });
 * ```
 * @example A namespaced CRD instance
 * ```typescript
 * yield* GCP.KubernetesManifest("Tunnel", {
 *   endpoint: cluster.endpoint,
 *   caCertificate: cluster.clusterCaCertificate,
 *   apiVersion: "networking.cfargotunnel.com/v1alpha1",
 *   kind: "TunnelBinding",
 *   name: "research-ui",
 *   namespace: "admin",
 *   body: { spec: { ... } },
 * });
 * ```
 */
export type KubernetesManifestProps = {
  /**
   * GKE control-plane endpoint (IP or hostname, no scheme) — typically
   * `cluster.endpoint`. A change points at a different cluster → replace.
   */
  endpoint: string;
  /**
   * Base64-encoded cluster CA certificate (PEM) — typically
   * `cluster.clusterCaCertificate`. Mutable (can rotate on the same cluster).
   */
  caCertificate: string;
  /** Object `apiVersion`, e.g. `"v1"`, `"apps/v1"`. Immutable — replace. */
  apiVersion: string;
  /** Object `kind`, e.g. `"ConfigMap"`, `"Deployment"`. Immutable — replace. */
  kind: string;
  /** `metadata.name`. Immutable — replace. */
  name: string;
  /**
   * `metadata.namespace`. Required for namespaced Kinds, omit for cluster-scoped
   * ones. Immutable — replace.
   */
  namespace?: string;
  /** Extra `metadata.labels` (alchemy ownership labels merge on top). Mutable. */
  labels?: Record<string, string>;
  /**
   * The rest of the object — everything except `apiVersion`/`kind`/`metadata`
   * (e.g. `spec`, `data`, `rules`). Mutable; may carry resolved Inputs from
   * other resources. SSA prunes any key dropped from a later apply.
   */
  body?: Record<string, unknown>;
};

export type KubernetesManifestAttributes = {
  /** Object apiVersion. */
  apiVersion: string;
  /** Object kind. */
  kind: string;
  /** metadata.name. */
  name: string;
  /** metadata.namespace (undefined for cluster-scoped objects). */
  namespace: string | undefined;
  /** Server-assigned uid. */
  uid: string | undefined;
  /** Server-assigned resourceVersion at last apply. */
  resourceVersion: string | undefined;
  /** Control-plane endpoint, threaded through for delete/read. */
  endpoint: string;
  /** Cluster CA certificate, threaded through for delete/read. */
  caCertificate: string;
};

export type KubernetesManifest = Resource<
  "GCP.KubernetesManifest",
  KubernetesManifestProps,
  KubernetesManifestAttributes,
  never,
  GCP.Providers
>;
export const KubernetesManifest = Resource<KubernetesManifest>(
  "GCP.KubernetesManifest",
);

const toAttributes = (
  o: KubeObject | undefined,
  parent: {
    apiVersion: string;
    kind: string;
    name: string;
    namespace: string | undefined;
    endpoint: string;
    caCertificate: string;
  },
): KubernetesManifestAttributes => ({
  apiVersion: o?.apiVersion ?? parent.apiVersion,
  kind: o?.kind ?? parent.kind,
  name: o?.metadata?.name ?? parent.name,
  namespace: o?.metadata?.namespace ?? parent.namespace,
  uid: o?.metadata?.uid,
  resourceVersion: o?.metadata?.resourceVersion,
  endpoint: parent.endpoint,
  caCertificate: parent.caCertificate,
});

/** Mint a fresh GKE connection (plain bearer token) from props + ADC creds. */
const connect = Effect.fn("k8sManifest.connect")(function* (props: {
  endpoint: string;
  caCertificate: string;
}) {
  const { accessToken } = yield* yield* Credentials;
  return {
    endpoint: props.endpoint,
    caCertificate: props.caCertificate,
    token: Redacted.value(accessToken),
  } satisfies GkeConnection;
});

/** GET the object, mapping a 404 to `undefined`. */
const observe = (
  connection: GkeConnection,
  apiVersion: string,
  kind: string,
  namespace: string | undefined,
  name: string,
) =>
  getObject(connection, apiVersion, kind, namespace, name).pipe(
    Effect.catchIf(
      (e): e is KubernetesApiError =>
        e instanceof KubernetesApiError && e.statusCode === 404,
      () => Effect.succeed(undefined as KubeObject | undefined),
    ),
  );

export const KubernetesManifestProvider = () =>
  Provider.effect(
    KubernetesManifest,
    Effect.gen(function* () {
      return {
        // Identity (apiVersion/kind/name/namespace) and the server-assigned uid
        // are unchanged by an in-place apply. endpoint is a replace trigger so
        // it never changes on update; caCertificate is excluded (can rotate).
        stables: [
          "apiVersion",
          "kind",
          "name",
          "namespace",
          "uid",
          "endpoint",
        ],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const o = olds as KubernetesManifestProps;
          // apiVersion/kind/name/namespace are the object's identity, and
          // endpoint points at a specific cluster — any change orphans the old
          // object, so create new + delete old.
          if (
            somePropsAreDifferent(o, news, [
              "apiVersion",
              "kind",
              "name",
              "namespace",
              "endpoint",
            ])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news }) {
          const labels = {
            ...(news.labels ?? {}),
            ...(yield* gcpInternalLabels(id)),
          };
          const connection = yield* connect(news);

          // Build the full object: identity + merged labels + the user body.
          // SSA is declarative — we send exactly what we manage (no
          // resourceVersion), and force ownership of any field we name.
          const object: KubeObject = {
            ...news.body,
            apiVersion: news.apiVersion,
            kind: news.kind,
            metadata: {
              name: news.name,
              ...(news.namespace ? { namespace: news.namespace } : {}),
              labels,
            },
          };

          const applied = yield* applyObject(connection, object);

          // A 2xx apply normally echoes the object, but an empty-body success is
          // possible — re-read so we always return real attributes (uid/
          // resourceVersion). Use getObject (not observe): a missing object
          // after a successful apply is a real failure, not "absent".
          const final =
            applied?.metadata != null
              ? applied
              : yield* getObject(
                  connection,
                  news.apiVersion,
                  news.kind,
                  news.namespace,
                  news.name,
                );

          return toAttributes(final, {
            apiVersion: news.apiVersion,
            kind: news.kind,
            name: news.name,
            namespace: news.namespace,
            endpoint: news.endpoint,
            caCertificate: news.caCertificate,
          });
        }),
        delete: Effect.fn(function* ({ output }) {
          const connection = yield* connect(output);
          yield* deleteObject(
            connection,
            output.apiVersion,
            output.kind,
            output.namespace,
            output.name,
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const endpoint = output?.endpoint ?? olds?.endpoint;
          const caCertificate = output?.caCertificate ?? olds?.caCertificate;
          const apiVersion = output?.apiVersion ?? olds?.apiVersion;
          const kind = output?.kind ?? olds?.kind;
          const name = output?.name ?? olds?.name;
          const namespace = output?.namespace ?? olds?.namespace;
          if (!endpoint || !caCertificate || !apiVersion || !kind || !name) {
            return undefined;
          }

          const connection = yield* connect({ endpoint, caCertificate });
          const observed = yield* observe(
            connection,
            apiVersion,
            kind,
            namespace,
            name,
          );
          if (!observed) return undefined;

          const attrs = toAttributes(observed, {
            apiVersion,
            kind,
            name,
            namespace,
            endpoint,
            caCertificate,
          });
          return (yield* hasAlchemyLabels(id, observed.metadata?.labels))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
