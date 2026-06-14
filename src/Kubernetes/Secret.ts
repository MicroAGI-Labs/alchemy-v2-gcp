import { Credentials } from "@distilled.cloud/gcp";
import {
  createCoreV1NamespacedSecret,
  deleteCoreV1NamespacedSecret,
  readCoreV1NamespacedSecret,
  replaceCoreV1NamespacedSecret,
} from "@distilled.cloud/kubernetes/core";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved, somePropsAreDifferent } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type * as GCP from "../Providers.ts";
import { gcpInternalLabels, hasAlchemyLabels } from "../Tags.ts";
import { clusterLayer, type ClusterConnection } from "./connection.ts";

/**
 * An Opaque Kubernetes Secret in a GKE cluster.
 *
 * Driven through the typed `@distilled.cloud/kubernetes` SDK (core/v1) rather
 * than alchemy's upstream Kubernetes provider, which is EKS-only. The
 * control-plane connection (`endpoint` + `caCertificate`) comes from a
 * {@link GCP.Cluster}'s attributes; the bearer token is minted from the
 * provider's ADC {@link Credentials} and threaded into the cluster via
 * {@link clusterLayer} (which also trusts the per-cluster CA).
 *
 * Convergence is a typed **create-or-replace upsert** (not server-side apply):
 * `reconcile` reads the Secret, then `createCoreV1NamespacedSecret` if absent
 * or `replaceCoreV1NamespacedSecret` (a full PUT, carrying the observed
 * `resourceVersion` for optimistic concurrency) if present. A `PUT` is a full
 * object replacement, so dropping a key from `data` removes it from the stored
 * Secret — the same pruning SSA gave us, without needing the
 * `application/apply-patch+yaml` content type the typed PATCH op can't express.
 *
 * Ownership for adoption is gated on alchemy-internal `metadata.labels` (same
 * triple as labelled GCP resources), so a Secret created out of band reads back
 * as {@link Unowned} until adopted.
 *
 * @section Creating a Secret
 * @example Wire a Cloudflare tunnel token into the cluster
 * ```typescript
 * // `tunnel.token` is a `Redacted<string>`; pass it straight through —
 * // the value is unwrapped only at the moment it's written to the API, and
 * // stays redacted in logs/plan output.
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
   * String data (UTF-8 values, base64-encoded on the way to the API). Mutable.
   *
   * Values may be `Redacted<string>` (e.g. a resource's secret output like
   * `tunnel.token`) — they are unwrapped only when written to the Kubernetes
   * API and stay opaque in logs/plan output. Plain strings are accepted too.
   *
   * NOTE: the underlying values are persisted in alchemy stack state (the
   * engine diffs on the real value) — protect the state backend.
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

/** The subset of a distilled Secret response we read back. */
type SecretObject = {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
  };
  type?: string;
};

const toAttributes = (
  s: SecretObject | undefined,
  parent: {
    name: string;
    namespace: string;
    endpoint: string;
    caCertificate: string;
    type: string;
  },
): KubernetesSecretAttributes => ({
  name: s?.metadata?.name ?? parent.name,
  namespace: s?.metadata?.namespace ?? parent.namespace,
  endpoint: parent.endpoint,
  caCertificate: parent.caCertificate,
  type: s?.type ?? parent.type,
  uid: s?.metadata?.uid,
  resourceVersion: s?.metadata?.resourceVersion,
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
    token: accessToken,
  } satisfies ClusterConnection;
});

/** GET a Secret, mapping a 404 (`NotFound`) to `undefined`. */
const observe = (
  connection: ClusterConnection,
  namespace: string,
  name: string,
) =>
  readCoreV1NamespacedSecret({ namespace, name }).pipe(
    Effect.provide(clusterLayer(connection)),
    Effect.catchTag("NotFound", () =>
      Effect.succeed(undefined as SecretObject | undefined),
    ),
  );

/** Base64-encode the (possibly redacted) string values for the `data` field. */
const encodeData = (
  stringData: Record<string, Redacted.Redacted<string> | string>,
): Record<string, string> => {
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(stringData)) {
    const raw = Redacted.isRedacted(v) ? Redacted.value(v) : v;
    data[k] = Buffer.from(raw, "utf8").toString("base64");
  }
  return data;
};

export const KubernetesSecretProvider = () =>
  Provider.effect(
    KubernetesSecret,
    Effect.gen(function* () {
      return {
        // Attributes unchanged by an in-place update (so dependents can resolve
        // them at plan time): identity (name/namespace), the server-assigned
        // uid, and endpoint — which is a replace trigger, so it never changes
        // on update. caCertificate is intentionally excluded: it can rotate on
        // the same cluster.
        stables: ["name", "namespace", "endpoint", "uid"],
        diff: Effect.fn(function* ({ id, news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const o = olds as KubernetesSecretProps;
          // Compare the RESOLVED name and type (with their defaults applied),
          // not the raw props — otherwise omitting `name` on one side and
          // setting it to the generated physical name on the other (or the
          // same for `type`/"Opaque") triggers a spurious replace.
          const defaultName = (
            yield* createPhysicalName({ id, maxLength: 63 })
          ).toLowerCase();
          const sameName =
            (o.name ?? defaultName) === (news.name ?? defaultName);
          const sameType = (o.type ?? "Opaque") === (news.type ?? "Opaque");
          // Replace (create new + delete old) rather than in-place upsert on:
          // - `endpoint`: points at a different cluster (would orphan the old
          //   Secret). caCertificate is excluded — it can rotate on the same
          //   cluster and should just re-apply.
          // - `namespace`/`name`: the object's identity.
          // - `type`: immutable on a Kubernetes Secret; a PUT with a new type
          //   is rejected by the API.
          if (
            !sameName ||
            !sameType ||
            somePropsAreDifferent(o, news, ["namespace", "endpoint"])
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
          const layer = clusterLayer(connection);
          const data = encodeData(news.stringData);

          // Full-object PUT for an existing Secret — carries the observed
          // resourceVersion (the API requires it for updates and uses it for
          // optimistic concurrency).
          const replaceFrom = (observed: SecretObject) =>
            replaceCoreV1NamespacedSecret({
              namespace: news.namespace,
              name: desiredName,
              fieldManager: "alchemy",
              // Read-modify-write: a PUT replaces the WHOLE object, so preserve
              // the observed metadata (annotations, ownerReferences, finalizers,
              // …) and overlay only what we manage — otherwise every reconcile
              // strips fields other managers set (e.g. an ownerReference, which
              // would break garbage collection). `observed.metadata` carries the
              // full server object at runtime (the local type is a subset).
              // Labels merge (ours win) so foreign labels survive too. (The SSA
              // path — GCP.KubernetesManifest — does field-level pruning instead;
              // the typed PUT path deliberately preserves rather than prunes.)
              metadata: {
                ...observed.metadata,
                name: desiredName,
                labels: { ...observed.metadata?.labels, ...labels },
                resourceVersion: observed.metadata?.resourceVersion,
              },
              type: desiredType,
              data,
            }).pipe(Effect.provide(layer));

          // Observe → ensure: create if absent, else read-modify-write replace.
          // Adoption (output defined, olds undefined) traverses the same flow.
          const writeOnce = observe(
            connection,
            news.namespace,
            desiredName,
          ).pipe(
            Effect.flatMap((observed) =>
              observed
                ? replaceFrom(observed)
                : createCoreV1NamespacedSecret({
                    namespace: news.namespace,
                    fieldManager: "alchemy",
                    metadata: { name: desiredName, labels },
                    type: desiredType,
                    data,
                  }).pipe(Effect.provide(layer)),
            ),
          );

          // Retry the WHOLE observe→write flow on Conflict — a stale
          // resourceVersion (replace) or a create/delete race re-observes fresh
          // state and writes again, so a second conflict is handled too. Bounded
          // so a persistently-contended object fails (and the engine
          // re-reconciles) rather than spinning forever.
          const upsert = (attempt: number): typeof writeOnce =>
            writeOnce.pipe(
              Effect.catchTag("Conflict", (e) =>
                attempt < 3 ? upsert(attempt + 1) : Effect.fail(e),
              ),
            );
          const result = yield* upsert(0);

          return toAttributes(result, {
            name: desiredName,
            namespace: news.namespace,
            endpoint: news.endpoint,
            caCertificate: news.caCertificate,
            type: desiredType,
          });
        }),
        delete: Effect.fn(function* ({ output }) {
          const connection = yield* connect(output);
          yield* deleteCoreV1NamespacedSecret({
            namespace: output.namespace,
            name: output.name,
          }).pipe(
            Effect.provide(clusterLayer(connection)),
            // 404 is success (idempotent teardown).
            Effect.catchTag("NotFound", () => Effect.void),
          );
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
