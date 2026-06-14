import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as https from "node:https";

/**
 * Raw, **server-side-apply-capable** GKE Kubernetes REST client.
 *
 * # Two ways this provider writes to a cluster — and when to use each
 *
 * There are two transports for talking to a GKE control plane. They are not
 * redundant; each is correct for a different shape of resource.
 *
 * ### 1. Typed per-kind ops — `@distilled.cloud/kubernetes` via `connection.ts`
 *
 * What {@link "./Secret.ts"} uses. A **create + replace (PUT)** upsert built
 * from the typed `core/v1` operations, with the cluster wired in by
 * `clusterLayer`.
 *
 * **Use when** the kind is known at author time and the resource fully owns the
 * object (Secret, ConfigMap, …).
 * - ✅ Typed inputs/outputs (real `metadata`/`data`/`type` fields), no
 *   discovery round-trip, no content-type fiddling.
 * - ⚠️ A PUT is a *full-object replacement*: it carries `resourceVersion` and
 *   overwrites every field — so it clobbers anything another manager set that
 *   you didn't include. Fine for objects you solely own; wrong for shared ones.
 * - ⚠️ Per-kind only — there's a distinct typed op per Kind.
 *
 * ### 2. This raw client — server-side apply of an **arbitrary** object
 *
 * What {@link "./KubernetesManifest.ts"} uses. A single `PATCH` with
 * `Content-Type: application/apply-patch+yaml`, `?fieldManager=alchemy&force=true`,
 * the object itself as the (untyped) body, and the resource path resolved from
 * the apiserver's **discovery** endpoint so *any* Kind works — built-ins and
 * CRDs alike.
 *
 * **Use when** the kind is dynamic/unknown (generic manifests, CRDs), **or**
 * you need server-side-apply semantics:
 * - **field-level merge / ownership** — apply touches only the fields
 *   `fieldManager: alchemy` declares, leaving fields owned by other managers
 *   (controllers, defaulting, admission) intact instead of clobbering them;
 * - **declarative pruning** — dropping a field you previously owned removes it,
 *   without a read-merge-write dance;
 * - **one idempotent call** — no read-before-write, no create-vs-replace
 *   branch, no `resourceVersion` juggling.
 * - ⚠️ Untyped body, plus one extra discovery `GET` to map Kind → resource.
 *
 * Rule of thumb: **known Kind you fully own → typed create/replace (path 1);
 * arbitrary Kind or shared/merge semantics → SSA (this client).**
 *
 * ---
 *
 * Both transports authenticate with a Google OAuth bearer token (cloud-platform
 * scope, minted from the provider's ADC credentials) and trust the cluster's
 * own CA. `node:https` is used here deliberately (rather than the Effect
 * `HttpClient`): the GKE API server presents a certificate signed by the
 * *per-cluster* CA — not a public root — so the request must trust an explicit,
 * runtime-resolved `ca` PEM. (`connection.ts`'s `clusterLayer` solves the same
 * CA-trust problem for the distilled path, by overriding `FetchHttpClient`.)
 * Calls are wrapped in `Effect.tryPromise` so failures surface as typed errors;
 * a socket timeout bounds hung requests (Effect interruption won't abort an
 * in-flight socket — the timeout is what guarantees a deploy can't block
 * forever).
 */
const REQUEST_TIMEOUT_MS = 30_000;

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
            timeout: REQUEST_TIMEOUT_MS,
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
        // `timeout` only fires the event — we must destroy the socket
        // ourselves so the promise rejects instead of hanging.
        request.on("timeout", () =>
          request.destroy(
            new KubernetesApiError({
              method,
              path,
              statusCode: 0,
              body: `request timed out after ${REQUEST_TIMEOUT_MS}ms`,
            }),
          ),
        );
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

/** A Kubernetes object as seen on the wire (only the fields we read back). */
export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Where a Kind lives in the REST hierarchy, from the discovery doc. */
interface ResourceInfo {
  /** Plural resource name, e.g. `secrets`, `deployments`. */
  plural: string;
  /** Whether instances are namespaced (vs cluster-scoped). */
  namespaced: boolean;
}

/**
 * Discovery path for an `apiVersion`: core group (`v1`) lives under `/api/v1`,
 * named groups (`apps/v1`, `networking.k8s.io/v1`) under `/apis/{group}/{ver}`.
 */
const apiPathPrefix = (apiVersion: string): string =>
  apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;

/**
 * Resolve a Kind to its REST resource (plural + scope) via the apiserver's
 * discovery endpoint. This is what lets SSA work for ANY kind — built-ins and
 * CRDs — without a hard-coded kind→plural table.
 */
export const resolveResource = (
  connection: GkeConnection,
  apiVersion: string,
  kind: string,
): Effect.Effect<ResourceInfo, KubernetesApiError> => {
  const path = apiPathPrefix(apiVersion);
  return (
    requestJson({ connection, method: "GET", path }) as Effect.Effect<
      { resources?: Array<{ name: string; namespaced: boolean; kind: string }> },
      KubernetesApiError
    >
  ).pipe(
    Effect.flatMap((doc) => {
      // Match on Kind, excluding subresources (their `name` contains a `/`,
      // e.g. `pods/status`).
      const match = (doc.resources ?? []).find(
        (r) => r.kind === kind && !r.name.includes("/"),
      );
      return match
        ? Effect.succeed({ plural: match.name, namespaced: match.namespaced })
        : Effect.fail(
            new KubernetesApiError({
              method: "GET",
              path,
              statusCode: 0,
              body: `Kind ${apiVersion}/${kind} not found in discovery (${path})`,
            }),
          );
    }),
  );
};

const objectPath = (
  apiVersion: string,
  info: ResourceInfo,
  namespace: string | undefined,
  name: string | undefined,
): string => {
  const prefix = apiPathPrefix(apiVersion);
  const collection = info.namespaced
    ? `${prefix}/namespaces/${namespace}/${info.plural}`
    : `${prefix}/${info.plural}`;
  return name ? `${collection}/${name}` : collection;
};

/**
 * Guard against building a `/namespaces/undefined/…` path: a namespaced Kind
 * with no namespace would otherwise GET/DELETE a bogus URL — the API returns
 * 404, which read treats as "absent" (phantom recreate) and delete tolerates as
 * success (orphan). Fail loudly instead. (No-op for cluster-scoped Kinds.)
 */
const requireNamespace = (
  method: string,
  apiVersion: string,
  kind: string,
  info: ResourceInfo,
  namespace: string | undefined,
): Effect.Effect<void, KubernetesApiError> =>
  info.namespaced && !namespace
    ? Effect.fail(
        new KubernetesApiError({
          method,
          path: "",
          statusCode: 0,
          body: `${apiVersion}/${kind} is namespaced — a namespace is required`,
        }),
      )
    : Effect.void;

/**
 * Server-side apply an arbitrary object (idempotent create-or-converge).
 * `force=true` makes alchemy the field manager even where another manager
 * currently owns a field we declare. Only the fields present in `object` are
 * managed; fields owned by other managers are left untouched, and dropping a
 * previously-declared field prunes it.
 */
export const applyObject = (
  connection: GkeConnection,
  object: KubeObject,
  fieldManager = "alchemy",
): Effect.Effect<KubeObject | undefined, KubernetesApiError> => {
  const apiVersion = object.apiVersion;
  const kind = object.kind;
  const name = object.metadata?.name;
  const namespace = object.metadata?.namespace;
  if (!apiVersion || !kind || !name) {
    return Effect.fail(
      new KubernetesApiError({
        method: "PATCH",
        path: "",
        statusCode: 0,
        body: "object must have apiVersion, kind and metadata.name",
      }),
    );
  }
  return resolveResource(connection, apiVersion, kind).pipe(
    Effect.flatMap((info) =>
      requireNamespace("PATCH", apiVersion, kind, info, namespace).pipe(
        Effect.flatMap(() => {
          const path = `${objectPath(apiVersion, info, namespace, name)}?fieldManager=${fieldManager}&force=true`;
          return requestJson({
            connection,
            method: "PATCH",
            path,
            contentType: "application/apply-patch+yaml",
            body: object as Record<string, unknown>,
          }) as Effect.Effect<KubeObject | undefined, KubernetesApiError>;
        }),
      ),
    ),
  );
};

/** GET an object; the caller maps `KubernetesApiError(404)` to "missing". */
export const getObject = (
  connection: GkeConnection,
  apiVersion: string,
  kind: string,
  namespace: string | undefined,
  name: string,
): Effect.Effect<KubeObject, KubernetesApiError> =>
  resolveResource(connection, apiVersion, kind).pipe(
    Effect.flatMap((info) =>
      requireNamespace("GET", apiVersion, kind, info, namespace).pipe(
        Effect.flatMap(
          () =>
            requestJson({
              connection,
              method: "GET",
              path: objectPath(apiVersion, info, namespace, name),
            }) as Effect.Effect<KubeObject, KubernetesApiError>,
        ),
      ),
    ),
  );

/** DELETE an object; 404 is tolerated as success (idempotent teardown). */
export const deleteObject = (
  connection: GkeConnection,
  apiVersion: string,
  kind: string,
  namespace: string | undefined,
  name: string,
): Effect.Effect<void, KubernetesApiError> =>
  resolveResource(connection, apiVersion, kind).pipe(
    Effect.flatMap((info) =>
      requireNamespace("DELETE", apiVersion, kind, info, namespace).pipe(
        Effect.flatMap(() =>
          requestJson({
            connection,
            method: "DELETE",
            path: objectPath(apiVersion, info, namespace, name),
          }),
        ),
      ),
    ),
    Effect.catchIf(
      (e): e is KubernetesApiError =>
        e instanceof KubernetesApiError && e.statusCode === 404,
      () => Effect.void,
    ),
  );
