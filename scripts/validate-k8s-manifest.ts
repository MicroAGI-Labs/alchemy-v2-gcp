/**
 * Live check for the generic SSA manifest path: discovery + server-side apply
 * (with field pruning) + read + delete, via the raw client (`client.ts`).
 *
 *   ENDPOINT=35.204.30.182 \
 *   CA_B64="$(gcloud container clusters describe research-cluster-a \
 *     --project micro-research-cluster-a --location europe-west4 \
 *     --format='value(masterAuth.clusterCaCertificate)')" \
 *   K8S_TOKEN="$(gcloud auth application-default print-access-token)" \
 *   bun scripts/validate-k8s-manifest.ts
 */
import * as Effect from "effect/Effect";
import {
  applyObject,
  deleteObject,
  getObject,
  KubernetesApiError,
  type GkeConnection,
} from "../src/Kubernetes/client.ts";

const endpoint = process.env.ENDPOINT;
const caCertificate = process.env.CA_B64;
const token = process.env.K8S_TOKEN;
if (!endpoint || !caCertificate || !token) {
  throw new Error("set ENDPOINT, CA_B64, K8S_TOKEN");
}
const conn: GkeConnection = { endpoint, caCertificate, token };

const namespace = "default";
const name = "distilled-ssa-probe";
const apiVersion = "v1";
const kind = "ConfigMap";

const program = Effect.gen(function* () {
  yield* deleteObject(conn, apiVersion, kind, namespace, name);

  // APPLY with two keys.
  yield* applyObject(conn, {
    apiVersion,
    kind,
    metadata: { name, namespace, labels: { alchemy_app: "probe" } },
    data: { a: "1", b: "2" },
  });
  const r1 = yield* getObject(conn, apiVersion, kind, namespace, name);
  const d1 = (r1 as { data?: Record<string, string> }).data ?? {};
  console.log(`APPLY ok: data=${JSON.stringify(d1)} (expect a=1,b=2)`);

  // RE-APPLY dropping `b` and changing `a` — SSA should prune `b` (we own it).
  yield* applyObject(conn, {
    apiVersion,
    kind,
    metadata: { name, namespace, labels: { alchemy_app: "probe" } },
    data: { a: "changed" },
  });
  const r2 = yield* getObject(conn, apiVersion, kind, namespace, name);
  const d2 = (r2 as { data?: Record<string, string> }).data ?? {};
  console.log(`RE-APPLY ok: data=${JSON.stringify(d2)} (expect a=changed, NO b)`);

  // DELETE + confirm gone.
  yield* deleteObject(conn, apiVersion, kind, namespace, name);
  const gone = yield* getObject(conn, apiVersion, kind, namespace, name).pipe(
    Effect.map(() => false),
    Effect.catchIf(
      (e): e is KubernetesApiError =>
        e instanceof KubernetesApiError && e.statusCode === 404,
      () => Effect.succeed(true),
    ),
  );

  const pass =
    d1.a === "1" && d1.b === "2" && d2.a === "changed" && d2.b === undefined && gone;
  console.log(
    pass
      ? "\n✅ SSA apply + discovery + prune + delete PASSED"
      : "\n❌ FAILED",
  );
});

Effect.runPromise(program).catch((e) => {
  console.error("❌ error:", e);
  process.exit(1);
});
