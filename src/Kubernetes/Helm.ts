import { Credentials } from "@distilled.cloud/gcp";
import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved, somePropsAreDifferent } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import type * as GCP from "../Providers.ts";
import { gcpInternalLabels, hasAlchemyLabels } from "../Tags.ts";

/**
 * Install or upgrade a **Helm release** in a GKE cluster.
 *
 * Shells out to the `helm` CLI (v3.8+, required for OCI chart support) with a
 * temporary kubeconfig minted from the GKE cluster's endpoint + CA + an ADC
 * bearer token. The release is branded with alchemy-internal labels
 * (`alchemy_app` / `alchemy_stage` / `alchemy_id`) via `--labels`, so adoption
 * gating works the same as labelled GCP resources and K8s manifests — a
 * release created out of band reads back as {@link Unowned} until adopted.
 *
 * **Reconcile** runs `helm upgrade --install` (idempotent for both first
 * install and subsequent upgrades). **Delete** runs `helm uninstall`. **Read**
 * runs `helm status -o json` and checks the release's labels for ownership.
 *
 * Both OCI charts (`oci://…`) and repository charts (`repo/chart` with an
 * optional `repoUrl`) are supported. Inline `values` are serialized to a
 * temporary JSON file and passed via `--values`.
 *
 * @section Installing a chart
 * @example OCI chart with inline values
 * ```typescript
 * yield* GCP.HelmRelease("ArchilCsi", {
 *   endpoint: cluster.endpoint,
 *   caCertificate: cluster.clusterCaCertificate,
 *   name: "archil-csi-driver",
 *   namespace: "archil-system",
 *   chart: "oci://registry-1.docker.io/archildata/csi-driver-chart",
 *   createNamespace: true,
 *   values: {
 *     tolerations: [
 *       { key: "nvidia.com/gpu", operator: "Equal", value: "present", effect: "NoSchedule" },
 *     ],
 *   },
 * });
 * ```
 */
export type HelmReleaseProps = {
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
  /** Release name (helm `--name`). Immutable — replace if changed. */
  name: string;
  /** Target namespace. Immutable — replace if changed. */
  namespace: string;
  /**
   * Chart reference as you'd pass to `helm install`: an OCI URL
   * (`oci://registry…/chart`), a `repo/chart` pair, or a local path.
   * Immutable — replace if changed.
   */
  chart: string;
  /**
   * Chart version to pin. Mutable (upgrading the chart version is an
   * in-place `helm upgrade`).
   */
  version?: string;
  /**
   * Inline Helm values (serialized to a temp JSON file and passed via
   * `--values`). Mutable.
   */
  values?: Record<string, unknown>;
  /**
   * Create the namespace if it doesn't exist (`--create-namespace`).
   * @default false
   */
  createNamespace?: boolean;
  /**
   * Helm repository URL to add before install (`helm repo add`). Only used
   * when `chart` is a `repo/chart` reference (not OCI). The repo name is
   * derived from the first segment of `chart`.
   */
  repoUrl?: string;
  /**
   * Wait for all Kubernetes resources to be ready before returning
   * (`--wait --atomic`). Rolls back on failure.
   * @default false
   */
  wait?: boolean;
  /**
   * Timeout for `--wait` (Helm duration format, e.g. `"5m"`, `"300s"`).
   * @default "5m"
   */
  timeout?: string;
  /** Extra labels (alchemy ownership labels merge on top). Mutable. */
  labels?: Record<string, string>;
};

export type HelmReleaseAttributes = {
  /** Release name. */
  name: string;
  /** Namespace. */
  namespace: string;
  /** Chart reference (as declared). */
  chart: string;
  /** Resolved chart version (from `helm status`). */
  version: string | undefined;
  /** Release status (`"deployed"`, `"failed"`, `"pending-rollout"`, …). */
  status: string | undefined;
  /** Release revision number (increments on each upgrade). */
  revision: number | undefined;
  /** Control-plane endpoint, threaded through for delete/read. */
  endpoint: string;
  /** Cluster CA certificate, threaded through for delete/read. */
  caCertificate: string;
};

export type HelmRelease = Resource<
  "GCP.HelmRelease",
  HelmReleaseProps,
  HelmReleaseAttributes,
  never,
  GCP.Providers
>;
export const HelmRelease = Resource<HelmRelease>(
  "GCP.HelmRelease",
);

/** Error from a `helm` CLI invocation. */
export class HelmError extends Data.TaggedError("HelmError")<{
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
}> {}

/** Shape of `helm status -o json` output (only the fields we read). */
interface HelmReleaseStatus {
  name: string;
  namespace: string;
  revision: number;
  info: {
    status: string;
    first_deployed?: string;
    last_deployed?: string;
  };
  chart: {
    metadata: {
      name: string;
      version: string;
    };
  };
  labels?: Record<string, string>;
}

const toAttributes = (
  status: HelmReleaseStatus | undefined,
  parent: {
    name: string;
    namespace: string;
    chart: string;
    endpoint: string;
    caCertificate: string;
  },
): HelmReleaseAttributes => ({
  name: status?.name ?? parent.name,
  namespace: status?.namespace ?? parent.namespace,
  chart: parent.chart,
  version: status?.chart?.metadata?.version,
  status: status?.info?.status,
  revision: status?.revision,
  endpoint: parent.endpoint,
  caCertificate: parent.caCertificate,
});

/** Mint a fresh GKE connection (bearer token) from props + ADC credentials. */
const connect = Effect.fn("helm.connect")(function* (props: {
  endpoint: string;
  caCertificate: string;
}) {
  const { accessToken } = yield* yield* Credentials;
  return {
    endpoint: props.endpoint,
    caCertificate: props.caCertificate,
    token: Redacted.value(accessToken),
  };
});

export const HelmReleaseProvider = () =>
  Provider.effect(
    HelmRelease,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      /**
       * Write a temp kubeconfig (and optional values file) to a temp dir,
       * returning the paths. The caller is responsible for cleanup via
       * `Effect.acquireRelease` or `finally`.
       */
      const prepare = Effect.fn("helm.prepare")(function* (props: {
        endpoint: string;
        caCertificate: string;
        values?: Record<string, unknown>;
      }) {
        const connection = yield* connect(props);
        const dir = yield* fs.makeTempDirectory({ prefix: "helm-alchemy-" });
        const kubeconfigPath = path.join(dir, "kubeconfig.json");
        const valuesPath = props.values
          ? path.join(dir, "values.json")
          : undefined;

        // Kubeconfig with the cluster's CA + the ADC bearer token. The CA
        // is already base64-encoded (as GKE returns it), so it goes straight
        // into `certificate-authority-data`.
        const kubeconfig = JSON.stringify({
          apiVersion: "v1",
          kind: "Config",
          clusters: [
            {
              name: "gke",
              cluster: {
                "certificate-authority-data": props.caCertificate,
                server: `https://${props.endpoint}`,
              },
            },
          ],
          contexts: [
            {
              name: "gke",
              context: { cluster: "gke", user: "gke-user" },
            },
          ],
          "current-context": "gke",
          users: [
            {
              name: "gke-user",
              user: { token: connection.token },
            },
          ],
        });
        yield* fs.writeFileString(kubeconfigPath, kubeconfig);

        if (valuesPath && props.values) {
          // JSON is valid YAML — helm accepts it for --values.
          yield* fs.writeFileString(valuesPath, JSON.stringify(props.values));
        }

        return { dir, kubeconfigPath, valuesPath, connection };
      });

      /**
       * Run a `helm` command with `KUBECONFIG` pointing at the temp file.
       * Returns stdout/stderr/exitCode. Scoped so the child process is
       * cleaned up even on interruption.
       */
      const runHelm = Effect.fn("helm.run")(function* (args: {
        kubeconfigPath: string;
        helmArgs: string[];
      }) {
        const cmd = ChildProcess.make("helm", args.helmArgs, {
          shell: false,
          env: { ...process.env, KUBECONFIG: args.kubeconfigPath },
        });
        const handle = yield* cmd;
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            handle.exitCode,
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
          ] as const,
          { concurrency: 3 },
        );
        return { exitCode, stdout, stderr };
      });

      /** Run a helm command, mapping a non-zero exit to a HelmError. */
      const runHelmOrFail = Effect.fn("helm.runOrFail")(function* (args: {
        kubeconfigPath: string;
        helmArgs: string[];
      }) {
        const result = yield* runHelm(args);
        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            new HelmError({
              command: `helm ${args.helmArgs.join(" ")}`,
              exitCode: result.exitCode,
              stderr: result.stderr,
              stdout: result.stdout,
            }),
          );
        }
        return result;
      });

      return {
        // Identity (name/namespace/chart) and endpoint are unchanged by an
        // in-place upgrade. revision increments on every upgrade but the
        // resource is the same, so it's stable too.
        stables: ["name", "namespace", "chart", "endpoint", "revision"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const o = olds as HelmReleaseProps;
          // endpoint points at a specific cluster, and name/namespace/chart
          // are the release's identity — any change orphans the old release.
          if (
            somePropsAreDifferent(o, news, [
              "name",
              "namespace",
              "chart",
              "endpoint",
            ])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const { dir, kubeconfigPath, valuesPath } = yield* prepare(news);

          try {
            // Add helm repo if needed (non-OCI charts with repoUrl).
            if (news.repoUrl && !news.chart.startsWith("oci://")) {
              const repoName = news.chart.split("/")[0];
              yield* session.note(`Adding helm repo: ${repoName}`);
              yield* runHelmOrFail({
                kubeconfigPath,
                helmArgs: [
                  "repo",
                  "add",
                  repoName,
                  news.repoUrl,
                  "--force-update",
                ],
              });
              yield* runHelm({
                kubeconfigPath,
                helmArgs: ["repo", "update"],
              });
            }

            // Build alchemy ownership labels.
            const labels = {
              ...(news.labels ?? {}),
              ...(yield* gcpInternalLabels(id)),
            };
            const labelsFlag = Object.entries(labels)
              .map(([k, v]) => `${k}=${v}`)
              .join(",");

            // helm upgrade --install is idempotent for both first install
            // and subsequent upgrades.
            const helmArgs = [
              "upgrade",
              "--install",
              news.name,
              news.chart,
              "--namespace",
              news.namespace,
              ...(news.createNamespace ? ["--create-namespace"] : []),
              ...(news.version ? ["--version", news.version] : []),
              ...(valuesPath ? ["--values", valuesPath] : []),
              ...(labelsFlag ? ["--labels", labelsFlag] : []),
              ...(news.wait
                ? ["--wait", "--atomic", "--timeout", news.timeout ?? "5m"]
                : []),
            ];

            yield* session.note(
              `Running helm upgrade --install ${news.name} ${news.chart}`,
            );
            yield* runHelmOrFail({ kubeconfigPath, helmArgs });

            // Read the release status to return fresh attributes.
            const statusResult = yield* runHelmOrFail({
              kubeconfigPath,
              helmArgs: [
                "status",
                news.name,
                "--namespace",
                news.namespace,
                "-o",
                "json",
              ],
            });
            const status = JSON.parse(
              statusResult.stdout,
            ) as HelmReleaseStatus;

            return toAttributes(status, {
              name: news.name,
              namespace: news.namespace,
              chart: news.chart,
              endpoint: news.endpoint,
              caCertificate: news.caCertificate,
            });
          } finally {
            yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore);
          }
        }),
        delete: Effect.fn(function* ({ output }) {
          const { dir, kubeconfigPath } = yield* prepare(output);

          try {
            const result = yield* runHelm({
              kubeconfigPath,
              helmArgs: [
                "uninstall",
                output.name,
                "--namespace",
                output.namespace,
              ],
            });
            // "release: not found" is success (idempotent teardown).
            if (result.exitCode !== 0 && !/not found/i.test(result.stderr)) {
              return yield* Effect.fail(
                new HelmError({
                  command: `helm uninstall ${output.name}`,
                  exitCode: result.exitCode,
                  stderr: result.stderr,
                  stdout: result.stdout,
                }),
              );
            }
          } finally {
            yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore);
          }
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const endpoint = output?.endpoint ?? olds?.endpoint;
          const caCertificate = output?.caCertificate ?? olds?.caCertificate;
          const name = output?.name ?? olds?.name;
          const namespace = output?.namespace ?? olds?.namespace;
          const chart = output?.chart ?? olds?.chart;
          if (!endpoint || !caCertificate || !name || !namespace || !chart) {
            return undefined;
          }

          const { dir, kubeconfigPath } = yield* prepare({
            endpoint,
            caCertificate,
          });

          try {
            const result = yield* runHelm({
              kubeconfigPath,
              helmArgs: [
                "status",
                name,
                "--namespace",
                namespace,
                "-o",
                "json",
              ],
            });

            // Release not found → absent.
            if (result.exitCode !== 0 && /not found/i.test(result.stderr)) {
              return undefined;
            }
            if (result.exitCode !== 0) {
              return yield* Effect.fail(
                new HelmError({
                  command: `helm status ${name}`,
                  exitCode: result.exitCode,
                  stderr: result.stderr,
                  stdout: result.stdout,
                }),
              );
            }

            const status = JSON.parse(result.stdout) as HelmReleaseStatus;
            const attrs = toAttributes(status, {
              name,
              namespace,
              chart,
              endpoint,
              caCertificate,
            });
            return (yield* hasAlchemyLabels(id, status.labels))
              ? attrs
              : Unowned(attrs);
          } finally {
            yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore);
          }
        }),
      };
    }),
  );
