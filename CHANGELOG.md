# Changelog

All notable changes to `@microagi/alchemy-gcp`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0 — 2026-05-11

Cloud Run v2 — production polish on the Service + Job + IAM surface.

### Added

- **`GCP.Service`** — Cloud Run v2 HTTP service. Traffic routing,
  ingress controls (`INGRESS_TRAFFIC_ALL` / `INTERNAL_ONLY` /
  `INTERNAL_LOAD_BALANCER`), launch-stage gating, server-side
  template diffing, label-gated adoption, and full LRO polling.
- **`GCP.Job`** — Cloud Run v2 batch workload. Declarative
  definition of the Job (template, parallelism, task count, retries,
  GPU node selectors); execution is imperative via
  `runProjectsLocationsJobs` (documented in the resource JSDoc).
- **`GCP.serviceIamMember`** / **`GCP.jobIamMember`** — target-side
  IAM binding helpers. Provider unions all bindings per target and
  writes a single `setIamPolicy` per reconcile, preserving foreign
  roles and members. Etag round-trip absorbs CI/human contention.
- **Clean type re-exports** from the top level — `GCP.RevisionTemplate`,
  `GCP.ExecutionTemplate`, `GCP.TaskTemplate`, `GCP.Container`,
  `GCP.TrafficTarget`, `GCP.VpcAccess`, `GCP.NodeSelector`, etc. —
  so consumers no longer need to import from `@distilled.cloud/gcp`
  directly.
- **Plan-time validation** for Cloud Run resources — name regex
  (`<50 chars`, RFC 1123 label subset), reserved label/annotation
  namespaces (`run.googleapis.com/`, `cloud.googleapis.com/`,
  `serving.knative.dev/`, `autoscaling.knative.dev/`), and
  template-must-have-containers. Fails fast with a typed
  `ConfigError` before any state mutation.
- **`BadRequest` passthroughs** on Cloud Run create + patch — wrap
  the underlying GCP message with a remediation hint for billing
  not enabled, image-not-in-approved-registry, and reserved-namespace
  failures.

### Changed

- **Optimistic concurrency** on Cloud Run Service + Job — patch and
  delete now pass the observed `etag` so concurrent edits (e.g. via
  `gcloud run services update`) surface as `Conflict` instead of
  silently overwriting.
- README rewritten with categorised resource sections and Cloud Run
  examples.

### Notes

`apps/cluster` and other downstream stacks bumping past `0.2.x` should
swap `invokerIamDisabled: true` (sledgehammer) for the declarative
`serviceIamMember(svc, "Public", { role: "roles/run.invoker", member: "allUsers" })`
binding where possible — IAM history is auditable; the flag is not.

## 0.2.x

Pre-0.3 history is in `git log` — see commits up to and including
`c6bcb9d Add Cloud Run v2 Service resource`. Highlights:

- 0.2.0 — initial Cloud Run Service support (no IAM, no Job).
- 0.1.x — Project, ApiEnable, Cluster, NodePool, Network, Subnetwork,
  PsaConnection, GlobalAddress, SharedVpcHost, SharedVpcServiceProject,
  ManagedLustreInstance.
