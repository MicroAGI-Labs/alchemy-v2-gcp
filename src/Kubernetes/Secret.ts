import { Credentials } from "@distilled.cloud/gcp";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type * as GCP from "../Providers.ts";
import { gcpInternalLabels, hasAlchemyLabels } from "../Tags.ts";
import {
  applySecret,
  deleteSecret,
  getSecret,
  KubernetesApiError,
  type GkeConnection,
  type SecretObject,
} from "./client.ts";

/**
 * An Opaque Kubernetes Secret in a GKE cluster.
 *
 * Unlike the rest of the GCP provider (which calls typed
 * `@distilled.cloud/gcp` operations), this resource talks directly to a
 * GKE cluster's Kubernetes API server — alchemy's upstream Kubernetes
 * provider is EKS-only. The control-plane connection (`endpoint` +
 * `caCertificate`) comes from a {@link GCP.Cluster}'s attributes; the
 * bearer token is minted from the provider's ADC {@link Credentials}.
 *
 * Ownership for adoption is gated on alchemy-internal `metadata.labels`
 * (same triple as labelled GCP resources), so a Secret created out of
 * band reads back as {@link Unowned} until adopted.
 *
 * @section Creating a Secret
 * @example Wire a Cloudflare tunnel token into the cluster
 * ```typescript
 * // `tunnel.token` is a `Redacted<string>`; pass it straight through —
 * // the value is unwrapped only at the moment it's written to the API,
 * // and stays redacted in logs/plan output.
 * yield* GCP.KubernetesSecret("CloudflaredTunnelSecret", {
 *   endpoint: cluster.endpoint,
 *   caCertificate: cluster.clusterCaCertificate,
 *   namespace: "admin",
 *   name: "cloudflared-tunnel",
 *   stringData: { TUNNEL_TOKEN: tunnel.token },
 * }).pipe(adopt(true)); // take over a secret previously applied by kubectl
 * ```
 */
export type KubernetesSecretProps = {
  /**
   * GKE control-plane endpoint (IP or hostname, no scheme) — typically
   * `cluster.endpoint`. Mutable (a cluster replace yields a new one).
   */
  endpoint: string;
  /**
   * Base64-encoded cluster CA certificate (PEM) — typically
   * `cluster.clusterCaCertificate`. Mutable.
   */
  caCertificate: string;
  /** Target namespace. Immutable — replace if changed. */
  namespace: string;
  /**
   * Secret name. Defaults to `createPhysicalName({ id, lowercase: true,
   * maxLength: 63 })`. Immutable — replace if changed.
   */
  name?: string;
  /** Secret `type`. Default `"Opaque"`. Mutable. */
  type?: string;
  /**
   * String data (written under `stringData`; UTF-8 values). Mutable.
   *
   * Values may be `Redacted<string>` (e.g. a resource's secret output
   * like `tunnel.token`) — they are unwrapped only when written to the
   * Kubernetes API and stay opaque in logs/plan output. Plain strings
   * are accepted too.
   *
   * NOTE: the underlying values are persisted in alchemy stack state
   * (the engine diffs on the real value) — protect the state backend.
   */
  stringData: Record<string, Redacted.Redacted<string> | string>;
  /** Extra metadata labels (alchemy ownership labels merge on top). Mutable. */
  labels?: Record<string, string>;
};

export type KubernetesSecretAttributes = {
  /** Secret name. */
  name: string;
  /** Namespace. */
  namespace: string;
  /** Control-plane endpoint, threaded through for delete/read. */
  endpoint: string;
  /** Cluster CA certificate, threaded through for delete/read. */
  caCertificate: string;
  /** Secret type. */
  type: string;
  /** Server-assigned uid. */
  uid: string | undefined;
  /** Server-assigned resourceVersion at last apply. */
  resourceVersion: string | undefined;
};

export type KubernetesSecret = Resource<
  "GCP.KubernetesSecret",
  KubernetesSecretProps,
  KubernetesSecretAttributes,
  never,
  GCP.Providers
>;
export const KubernetesSecret = Resource<KubernetesSecret>(
  "GCP.KubernetesSecret",
);

const toAttributes = (
  s: SecretObject,
  parent: {
    name: string;
    namespace: string;
    endpoint: string;
    caCertificate: string;
    type: string;
  },
): KubernetesSecretAttributes => ({
  name: s.metadata?.name ?? parent.name,
  namespace: s.metadata?.namespace ?? parent.namespace,
  endpoint: parent.endpoint,
  caCertificate: parent.caCertificate,
  type: s.type ?? parent.type,
  uid: s.metadata?.uid,
  resourceVersion: s.metadata?.resourceVersion,
});

/** Mint a fresh GKE connection from props + ADC credentials. */
const connect = Effect.fn("k8sSecret.connect")(function* (props: {
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

const observe = (connection: GkeConnection, namespace: string, name: string) =>
  getSecret(connection, namespace, name).pipe(
    Effect.catchIf(
      (e): e is KubernetesApiError =>
        e instanceof KubernetesApiError && e.statusCode === 404,
      () => Effect.succeed(undefined as SecretObject | undefined),
    ),
  );

export const KubernetesSecretProvider = () =>
  Provider.effect(
    KubernetesSecret,
    Effect.gen(function* () {
      return {
        // Attributes unchanged by an in-place update (so dependents can
        // resolve them at plan time): identity (name/namespace), the
        // server-assigned uid, and endpoint — which is a replace trigger,
        // so it never changes on update. caCertificate is intentionally
        // excluded: it can rotate on the same cluster.
        stables: ["name", "namespace", "endpoint", "uid"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          // `endpoint` identifies the target cluster — a change points at
          // a different cluster, so replace (create on the new one, delete
          // on the old) rather than an in-place SSA that would orphan the
          // old Secret. `caCertificate` is intentionally NOT here: it can
          // rotate on the same cluster and should just re-apply.
          if (
            somePropsAreDifferent(olds as KubernetesSecretProps, news, [
              "namespace",
              "name",
              "endpoint",
            ])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news }) {
          const desiredName =
            news.name ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const desiredType = news.type ?? "Opaque";
          const labels = {
            ...(news.labels ?? {}),
            ...(yield* gcpInternalLabels(id)),
          };
          const connection = yield* connect(news);

          // Unwrap any Redacted values at the last moment — Redacted is
          // kept opaque through Output resolution, so it arrives here as
          // a Redacted object that would JSON-serialize to "<redacted>"
          // if passed through verbatim.
          const stringData: Record<string, string> = {};
          for (const [k, v] of Object.entries(news.stringData)) {
            stringData[k] = Redacted.isRedacted(v) ? Redacted.value(v) : v;
          }

          // Server-side apply is an idempotent upsert — it both creates
          // the Secret if missing and converges its data/labels if it
          // exists, taking field-manager ownership (force=true).
          const applied = yield* applySecret(connection, {
            metadata: { name: desiredName, namespace: news.namespace, labels },
            type: desiredType,
            stringData,
          });

          return toAttributes(applied, {
            name: desiredName,
            namespace: news.namespace,
            endpoint: news.endpoint,
            caCertificate: news.caCertificate,
            type: desiredType,
          });
        }),
        delete: Effect.fn(function* ({ output }) {
          const connection = yield* connect(output);
          yield* deleteSecret(connection, output.namespace, output.name);
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const endpoint = output?.endpoint ?? olds?.endpoint;
          const caCertificate = output?.caCertificate ?? olds?.caCertificate;
          const namespace = output?.namespace ?? olds?.namespace;
          if (!endpoint || !caCertificate || !namespace) return undefined;
          const name =
            output?.name ??
            olds?.name ??
            (yield* createPhysicalName({ id, maxLength: 63 })).toLowerCase();
          const type = output?.type ?? olds?.type ?? "Opaque";

          const connection = yield* connect({ endpoint, caCertificate });
          const observed = yield* observe(connection, namespace, name);
          if (!observed) return undefined;

          const attrs = toAttributes(observed, {
            name,
            namespace,
            endpoint,
            caCertificate,
            type,
          });
          return (yield* hasAlchemyLabels(id, observed.metadata?.labels))
            ? attrs
            : Unowned(attrs);
        }),
      };
    }),
  );
