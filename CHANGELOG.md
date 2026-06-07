# Changelog

All notable changes to `@microagi/alchemy-gcp`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.5.0 — 2026-06-07

Artifact Registry (artifactregistry v1) — Docker repositories, both
standard (self-hosted builds) and remote (pull-through caches for
Docker Hub and arbitrary upstreams like `nvcr.io`).

### Added

- **`GCP.ArtifactRegistryRepository`** — Artifact Registry repository
  resource for `format: "DOCKER"`. Supports:
  - `mode: "STANDARD_REPOSITORY"` — repository hosts images uploaded
    by the project (CI builds, etc.).
  - `mode: "REMOTE_REPOSITORY"` — pull-through cache. The upstream is
    either a Google-known preset (`{ publicRepository: "DOCKER_HUB" }`)
    or an arbitrary HTTPS Docker registry
    (`{ customRepository: { uri: "https://nvcr.io" } }`). Optional
    `upstreamCredentials` for authenticated upstreams (Secret
    Manager-backed password).
  - Mutable-via-patch fields: `description`, `labels`, `dockerConfig`
    (`immutableTags`), `cleanupPolicies`, `cleanupPolicyDryRun` —
    diff'd against observed cloud state and patched with a precise
    `updateMask`.
  - Replace triggers: `project`, `location`, `name`, `format`, `mode`,
    `kmsKeyName`, and any change to `remoteRepositoryConfig` (GCP
    refuses in-place updates here).
  - Standard adoption gate via `alchemy_*` labels — pre-existing
    repositories without our labels surface as `Unowned` and require
    `--adopt` to take over.
  - Same API-enable propagation retry (15s × 20 ≈ 5 min) as
    `Cluster` / `Service` / `SqlInstance` for the race between
    `ApiEnable` and the first create.
- **Plan-time validation** — repo-name regex
  (`/^[a-z0-9][a-z0-9-]{0,62}$/`), and the
  `mode` ↔ `remoteRepositoryConfig` invariant (REMOTE requires a
  docker upstream; STANDARD forbids a remote config). Fails fast with
  typed `ConfigError` before any state mutation.
- **Branded literal types** — `ArtifactRegistryFormat` (DOCKER,
  MAVEN, …) and `ArtifactRegistryMode`
  (STANDARD/REMOTE/VIRTUAL_REPOSITORY) with `(string & {})` tails for
  forward-compat with new server-side values.

### LRO

- `ArtifactRegistry/Operations.ts` — Cloud Run-style poller. AR
  operations use the standard `GoogleLongrunningOperation` shape
  (`.done: boolean`), distinct from Sqladmin's tri-state `.status`.
  Operation names are fully-qualified
  (`projects/{p}/locations/{l}/operations/{id}`).

## 0.4.0 — 2026-06-07

Cloud SQL (sqladmin v1) — Postgres instance + database + user, with
first-class IAM database authentication.

### Added

- **`GCP.SqlInstance`** — Cloud SQL for Postgres instance. Tier,
  edition, disk auto-resize, IP configuration (public IPv4 + private
  IP via PSA), backups + PITR, database flags, deletion protection,
  zonal/regional HA. Optimistic concurrency via the live
  `settings.settingsVersion` round-trip (Cloud SQL's `etag` field is
  deprecated). API-enable-propagation 403 retry mirroring the
  `Cluster` / `Service` providers.
- **`GCP.SqlDatabase`** — logical Postgres database. Thin resource —
  name, charset, collation. No labels on the GCP side so adoption is
  best-effort (no `Unowned` wrapper).
- **`GCP.SqlUser`** — Postgres role with three auth modes:
  - `BUILT_IN` — username + `Redacted` password.
  - `CLOUD_IAM_USER` — human IAM principal authenticated via the
    Cloud SQL Auth Proxy / IAM token exchange.
  - `CLOUD_IAM_SERVICE_ACCOUNT` — GCP service-account principal
    (name = SA email minus the `.gserviceaccount.com` tail).
  Plan-time validation rejects passwords on IAM users and missing
  passwords on `BUILT_IN`. Forward-compat `(string & {})` tail keeps
  newer IAM variants (`CLOUD_IAM_GROUP*`, `ENTRAID_USER`) reachable.
- **Branded literal types** from `Sqladmin/Types.ts` —
  `PostgresVersion` (15/16/17 only — narrower than distilled's
  open-tailed enum so typos are caught at compile time), `SqlEdition`,
  `SqlDataDiskType`, `SqlAvailabilityType`, `SqlActivationPolicy`,
  `SqlUserType`.
- **Plan-time validation** — instance name regex (1–98 chars,
  RFC 1123 label subset), database name length, user password/type
  consistency. Fails fast with a typed `ConfigError` before any state
  mutation.
- **`BadRequest` passthroughs** on `Instance`/`Database`/`User`
  create/patch/delete — billing-not-enabled, missing PSA peering,
  and invalid tier get remediation hints; anything else propagates
  verbatim.

### Notes

- Sqladmin operations use `status: "DONE"` (distinct from the
  `done: boolean` shape Cloud Resource Manager / Cloud Run / Lustre
  use). `Sqladmin/Operations.ts` polls `getOperations({ project,
  operation })` accordingly.
- `SqlInstance` adoption is label-gated through
  `settings.userLabels`. `SqlDatabase` and `SqlUser` cannot carry
  labels, so they trust the logical id / parent address alone — be
  cautious with `--adopt` on those.

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
