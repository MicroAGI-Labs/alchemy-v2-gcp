import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as https from "node:https";

/**
 * Minimal GKE Kubernetes REST client.
 *
 * Talks to a GKE cluster's control plane over HTTPS using:
 * - a Google OAuth bearer token (cloud-platform scope), minted from the
 *   provider's ADC {@link Credentials}, and
 * - the cluster's own CA certificate for TLS verification.
 *
 * `node:https` is used deliberately here (rather than the Effect
 * `HttpClient`): the GKE API server presents a certificate signed by the
 * *per-cluster* CA — not a public root — so the request must trust an
 * explicit, runtime-resolved `ca` PEM. This is the same justified TLS
 * exception upstream alchemy makes in its own Kubernetes client
 * (`vendor/alchemy/packages/alchemy/src/Kubernetes/client.ts`). All calls
 * are wrapped in `Effect.tryPromise` so they still participate in the
 * Effect runtime (tracing, interruption, typed errors).
 */

/** Connection details for a single GKE control plane. */
export interface GkeConnection {
  /** Master endpoint — IP or hostname, no scheme (e.g. `34.1.2.3`). */
  endpoint: string;
  /** Base64-encoded cluster CA certificate (PEM), as GKE returns it. */
  caCertificate: string;
  /** Google OAuth access token (cloud-platform scope) for `Authorization`. */
  token: string;
}

/** A non-2xx (or transport) response from the Kubernetes API server. */
export class KubernetesApiError extends Data.TaggedError(
  "KubernetesApiError",
)<{
  method: string;
  path: string;
  statusCode: number;
  body: string;
}> {}

const requestJson = Effect.fn("k8s.requestJson")(function* ({
  connection,
  method,
  path,
  body,
  contentType,
}: {
  connection: GkeConnection;
  method: string;
  path: string;
  body?: Record<string, unknown>;
  contentType?: string;
}) {
  const url = new URL(path, `https://${connection.endpoint}`);
  const payload = body ? JSON.stringify(body) : undefined;
  const ca = Buffer.from(connection.caCertificate, "base64").toString("utf8");

  return yield* Effect.tryPromise({
    try: () =>
      new Promise<unknown>((resolve, reject) => {
        const request = https.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method,
            headers: {
              Authorization: `Bearer ${connection.token}`,
              Accept: "application/json",
              ...(payload
                ? {
                    "Content-Type":
                      contentType ?? "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                  }
                : {}),
            },
            ca,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            response.on("end", () => {
              const responseBody = Buffer.concat(chunks).toString("utf8");
              const statusCode = response.statusCode ?? 500;

              if (statusCode < 200 || statusCode >= 300) {
                reject(
                  new KubernetesApiError({
                    method,
                    path,
                    statusCode,
                    body: responseBody,
                  }),
                );
                return;
              }

              if (!responseBody.trim()) {
                resolve(undefined);
                return;
              }

              try {
                resolve(JSON.parse(responseBody));
              } catch {
                resolve(responseBody);
              }
            });
          },
        );

        request.on("error", reject);
        if (payload) request.write(payload);
        request.end();
      }),
    catch: (error) =>
      error instanceof KubernetesApiError
        ? error
        : new KubernetesApiError({
            method,
            path,
            statusCode: 0,
            body: error instanceof Error ? error.message : String(error),
          }),
  });
});

/** Live view of a Kubernetes Secret object (subset we care about). */
export interface SecretObject {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
  };
  type?: string;
}

const secretPath = (namespace: string, name: string) =>
  `/api/v1/namespaces/${namespace}/secrets/${name}`;

/** GET a Secret; the caller maps `KubernetesApiError(404)` to "missing". */
export const getSecret = (
  connection: GkeConnection,
  namespace: string,
  name: string,
) =>
  requestJson({
    connection,
    method: "GET",
    path: secretPath(namespace, name),
  }) as Effect.Effect<SecretObject, KubernetesApiError>;

/**
 * Server-side apply a Secret (idempotent create-or-update). `force=true`
 * makes alchemy the field manager even if another manager owns fields.
 */
export const applySecret = (
  connection: GkeConnection,
  secret: {
    metadata: { name: string; namespace: string; labels?: Record<string, string> };
    type: string;
    stringData: Record<string, string>;
  },
) =>
  requestJson({
    connection,
    method: "PATCH",
    path: `${secretPath(secret.metadata.namespace, secret.metadata.name)}?fieldManager=alchemy&force=true`,
    contentType: "application/apply-patch+yaml",
    body: { apiVersion: "v1", kind: "Secret", ...secret },
  }) as Effect.Effect<SecretObject, KubernetesApiError>;

/** DELETE a Secret; 404 is tolerated as success (idempotent teardown). */
export const deleteSecret = (
  connection: GkeConnection,
  namespace: string,
  name: string,
) =>
  requestJson({
    connection,
    method: "DELETE",
    path: secretPath(namespace, name),
  }).pipe(
    Effect.catchIf(
      (e): e is KubernetesApiError =>
        e instanceof KubernetesApiError && e.statusCode === 404,
      () => Effect.void,
    ),
  );
