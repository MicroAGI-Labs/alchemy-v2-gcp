/**
 * Live validation of src/Kubernetes/connection.ts against a real GKE cluster.
 *
 * Drives a clean cluster-scoped distilled op (listCoreV1Namespace — no path
 * params, complete output schema) through `clusterLayer`, proving end-to-end:
 *   - the CA-trusting node:https fetch verifies the GKE per-cluster cert,
 *   - the ADC bearer token authenticates, and
 *   - distilled decodes the typed output.
 *
 * Run (from vendor/alchemy-v2-gcp):
 *   CLUSTER_STATE=../../apps/cluster/.alchemy/state/research-fleet/dev_andy/ClusterA-Cluster.json \
 *   K8S_TOKEN="$(gcloud auth application-default print-access-token)" \
 *   bun scripts/validate-k8s-connection.ts
 */
import { listCoreV1Namespace } from "@distilled.cloud/kubernetes/core";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as fs from "node:fs";
import { clusterLayer } from "../src/Kubernetes/connection.ts";

const statePath = process.env.CLUSTER_STATE;
const token = process.env.K8S_TOKEN;
if (!statePath || !token) {
  console.error("Set CLUSTER_STATE (cluster state json) and K8S_TOKEN (access token).");
  process.exit(2);
}

const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const out = state.attr ?? state.output ?? state.attributes ?? state;
// Live overrides win over (possibly stale) persisted state.
const endpoint: string = process.env.ENDPOINT ?? out.endpoint;
const caCertificate: string =
  process.env.CA_B64 ?? out.clusterCaCertificate ?? out.caCertificate;

console.log(`Target: https://${endpoint} (CA ${caCertificate?.length ?? 0} b64 chars)`);

const program = listCoreV1Namespace({}).pipe(
  Effect.provide(
    clusterLayer({ endpoint, caCertificate, token: Redacted.make(token) }),
  ),
  Effect.map((res: { items?: ReadonlyArray<{ metadata?: { name?: string } }> }) =>
    (res.items ?? []).map((i) => i.metadata?.name),
  ),
);

Effect.runPromise(program).then(
  (names) => {
    console.log(`OK — apiserver returned ${names.length} namespaces:`);
    console.log("  " + names.join(", "));
  },
  (err) => {
    console.error("FAIL:");
    console.error(err);
    process.exit(1);
  },
);
