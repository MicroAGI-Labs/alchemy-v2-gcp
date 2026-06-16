/**
 * Live lifecycle check for the distilled-backed Secret path: create → read →
 * replace → read → delete, through `connection.ts` + the typed core/v1 ops.
 *
 * Run against research-cluster-a (live endpoint + CA + ADC token via env):
 *   ENDPOINT=35.204.30.182 \
 *   CA_B64="$(gcloud container clusters describe research-cluster-a \
 *     --project micro-research-cluster-a --location europe-west4 \
 *     --format='value(masterAuth.clusterCaCertificate)')" \
 *   K8S_TOKEN="$(gcloud auth application-default print-access-token)" \
 *   bun scripts/validate-k8s-secret.ts
 */
import {
  createCoreV1NamespacedSecret,
  deleteCoreV1NamespacedSecret,
  readCoreV1NamespacedSecret,
  replaceCoreV1NamespacedSecret,
} from "@distilled.cloud/kubernetes/core";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { clusterLayer, type ClusterConnection } from "../src/Kubernetes/connection.ts";

const endpoint = process.env.ENDPOINT;
const caCertificate = process.env.CA_B64;
const token = process.env.K8S_TOKEN;
if (!endpoint || !caCertificate || !token) {
  throw new Error("set ENDPOINT, CA_B64, K8S_TOKEN");
}

const connection: ClusterConnection = {
  endpoint,
  caCertificate,
  token: Redacted.make(token),
};
const layer = clusterLayer(connection);

const namespace = "default";
const name = "distilled-upsert-probe";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const program = Effect.gen(function* () {
  // Clean any leftover from a prior run.
  yield* deleteCoreV1NamespacedSecret({ namespace, name }).pipe(
    Effect.provide(layer),
    Effect.catchTag("NotFound", () => Effect.void),
  );

  // CREATE — with a foreign annotation we expect replace to PRESERVE (#3).
  const created = yield* createCoreV1NamespacedSecret({
    namespace,
    fieldManager: "alchemy",
    metadata: {
      name,
      labels: { "alchemy_app": "probe" },
      annotations: { "probe.microagi/keep": "yes" },
    },
    type: "Opaque",
    data: { hello: b64("world") },
  }).pipe(Effect.provide(layer));
  console.log(
    `CREATE ok: uid=${created.metadata?.uid} rv=${created.metadata?.resourceVersion}`,
  );

  // READ
  const read1 = yield* readCoreV1NamespacedSecret({ namespace, name }).pipe(
    Effect.provide(layer),
  );
  const decoded1 = Buffer.from(read1.data?.hello ?? "", "base64").toString("utf8");
  console.log(`READ ok: data.hello=${JSON.stringify(decoded1)} (expect "world")`);

  // REPLACE — read-modify-write (mirrors Secret.ts replaceFrom): spread the
  // observed metadata so the foreign annotation survives the full-object PUT.
  const replaced = yield* replaceCoreV1NamespacedSecret({
    namespace,
    name,
    fieldManager: "alchemy",
    metadata: {
      ...read1.metadata,
      name,
      labels: { ...read1.metadata?.labels, "alchemy_app": "probe" },
      resourceVersion: read1.metadata?.resourceVersion,
    },
    type: "Opaque",
    data: { hello: b64("updated") },
  }).pipe(Effect.provide(layer));
  console.log(`REPLACE ok: rv ${read1.metadata?.resourceVersion} -> ${replaced.metadata?.resourceVersion}`);

  // READ again
  const read2 = yield* readCoreV1NamespacedSecret({ namespace, name }).pipe(
    Effect.provide(layer),
  );
  const decoded2 = Buffer.from(read2.data?.hello ?? "", "base64").toString("utf8");
  const keptAnnotation = read2.metadata?.annotations?.["probe.microagi/keep"];
  console.log(`READ ok: data.hello=${JSON.stringify(decoded2)} (expect "updated")`);
  console.log(`ANNOTATION preserved across replace: ${JSON.stringify(keptAnnotation)} (expect "yes")`);

  // DELETE
  yield* deleteCoreV1NamespacedSecret({ namespace, name }).pipe(
    Effect.provide(layer),
  );
  // Confirm gone.
  const gone = yield* readCoreV1NamespacedSecret({ namespace, name }).pipe(
    Effect.provide(layer),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );
  console.log(`DELETE ok: read-after-delete=${gone === "gone" ? "NotFound ✓" : "STILL PRESENT ✗"}`);

  const pass =
    decoded1 === "world" &&
    decoded2 === "updated" &&
    keptAnnotation === "yes" &&
    gone === "gone";
  console.log(pass ? "\n✅ create+replace upsert lifecycle PASSED" : "\n❌ FAILED");
});

Effect.runPromise(program).catch((e) => {
  console.error("❌ error:", e);
  process.exit(1);
});
