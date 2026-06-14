import { Credentials } from "@distilled.cloud/kubernetes/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as https from "node:https";

/**
 * Bridges a GKE control plane into the layers that `@distilled.cloud/kubernetes`
 * operations require — letting us drive the cluster's kube-apiserver through the
 * typed distilled SDK (core/v1, apps/v1, batch, rbac, apiextensions/CRDs, …)
 * instead of hand-rolling one HTTP resource per kind.
 *
 * distilled operations resolve two services from context:
 *
 * - `KubernetesCredentials` (`{ token, apiBaseUrl }`) — the bearer token (a
 *   Google OAuth access token minted from the provider's ADC `Credentials`) and
 *   the API base URL (`https://<cluster endpoint>`).
 * - `HttpClient.HttpClient` — the transport. The GKE API server presents a cert
 *   signed by the cluster's *own* CA (not a public root), so a stock fetch fails
 *   TLS verification. We override {@link FetchHttpClient.Fetch} with a
 *   `node:https`-backed fetch that trusts the per-cluster CA — the same
 *   justified TLS exception the bespoke client made, but now routed through the
 *   typed SDK. (undici's `Agent`/`dispatcher` would be the fetch-native route,
 *   but undici isn't resolvable as a bare import here, and this reuses the
 *   transport we already trust.)
 *
 * @example
 * ```typescript
 * import { readCoreV1NamespacedSecret } from "@distilled.cloud/kubernetes/core";
 *
 * const secret = yield* readCoreV1NamespacedSecret({ namespace, name }).pipe(
 *   Effect.provide(clusterLayer({ endpoint, caCertificate, token })),
 * );
 * ```
 */

/** A resolved connection to a single GKE control plane. */
export interface ClusterConnection {
  /** Master endpoint — IP or hostname, no scheme (e.g. `34.1.2.3`). */
  readonly endpoint: string;
  /** Base64-encoded cluster CA certificate (PEM), as GKE returns it. */
  readonly caCertificate: string;
  /** Google OAuth access token (cloud-platform scope) for `Authorization`. */
  readonly token: Redacted.Redacted<string>;
}

/** Bounds a hung socket — Effect interruption can't abort an in-flight request. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A `globalThis.fetch`-shaped function that issues the request over `node:https`
 * trusting an explicit CA PEM, then resolves a standard `Response`. Effect's
 * {@link FetchHttpClient.layer} reads this via `fiber.getRef(Fetch)` and feeds
 * it `(url, { method, headers, body, signal })` per request.
 */
const caFetch = (caPem: string): typeof globalThis.fetch =>
  ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(href);

    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
    }

    const body = init?.body;
    if (
      body != null &&
      typeof body !== "string" &&
      !(body instanceof Uint8Array)
    ) {
      // Our k8s calls only ever send JSON (Raw/Uint8Array) bodies. A streaming
      // body would need different handling — fail loudly rather than silently
      // dropping it.
      return Promise.reject(
        new TypeError("caFetch: only string/Uint8Array request bodies are supported"),
      );
    }

    return new Promise<Response>((resolve, reject) => {
      const request = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers,
          ca: caPem,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
          );
          response.on("end", () => {
            const buffer = Buffer.concat(chunks);
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) {
                for (const v of value) responseHeaders.append(key, v);
              } else if (value != null) {
                responseHeaders.set(key, value);
              }
            }
            resolve(
              new Response(buffer.length > 0 ? buffer : null, {
                status: response.statusCode ?? 500,
                statusText: response.statusMessage ?? "",
                headers: responseHeaders,
              }),
            );
          });
        },
      );

      request.on("error", reject);
      // `timeout` only fires the event — destroy the socket ourselves so the
      // promise rejects instead of hanging.
      request.on("timeout", () =>
        request.destroy(
          new Error(`Kubernetes request timed out after ${REQUEST_TIMEOUT_MS}ms`),
        ),
      );
      // Honour Effect's abort signal so interruption tears down the socket.
      if (init?.signal) {
        if (init.signal.aborted) request.destroy(new Error("aborted"));
        else
          init.signal.addEventListener("abort", () =>
            request.destroy(new Error("aborted")),
          );
      }
      if (body != null) request.write(body);
      request.end();
    });
  }) as typeof globalThis.fetch;

/** `HttpClient` layer whose fetch trusts the given (base64 PEM) cluster CA. */
const caHttpClient = (
  caCertificate: string,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.provide(
    FetchHttpClient.layer,
    Layer.succeed(
      FetchHttpClient.Fetch,
      caFetch(Buffer.from(caCertificate, "base64").toString("utf8")),
    ),
  );

/** `KubernetesCredentials` layer for a single cluster + bearer token. */
const credentials = (
  endpoint: string,
  token: Redacted.Redacted<string>,
): Layer.Layer<Credentials> =>
  Layer.succeed(
    Credentials,
    Effect.succeed({ token, apiBaseUrl: `https://${endpoint}` }),
  );

/**
 * The full requirements layer for any `@distilled.cloud/kubernetes` operation
 * against one GKE cluster: credentials + a CA-trusting HTTP client.
 */
export const clusterLayer = (
  connection: ClusterConnection,
): Layer.Layer<Credentials | HttpClient.HttpClient> =>
  Layer.merge(
    credentials(connection.endpoint, connection.token),
    caHttpClient(connection.caCertificate),
  );
