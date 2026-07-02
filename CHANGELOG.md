# Changelog

All notable changes to `@microagi/alchemy-gcp`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.10.0 — 2026-07-02

### Added

- **`GCP.StorageBucketIamMember`** — standalone resource managing a
  single `(bucket, role, member)` IAM entry on an **existing** GCS
  bucket by raw name (a bucket the stack does not create, adopt, or
  delete). Unlike the `storageBucketIamMember` binding helper — which
  requires a stack-owned `StorageBucket` target and is additive-only —
  this resource **revokes the member on delete** (dropping the binding
  if emptied), so grants disappear when the declaring resource leaves
  the stack. Member-scoped read-modify-write preserves all foreign
  roles/members verbatim; the get→set cycle retries with backoff for
  etag races; a missing bucket fails fast as `ConfigError`. `diff`
  replaces on any change to the triple (persisted `output` checked
  first, `||`-fallback so empty persisted fields are never treated as
  a prior identity); `read` reports member absence as drift so the
  engine re-grants. First consumer: research-infra's collab-reconciler
  per-group bucket read grants.

## 0.9.0 — 2026-06-30

### Added

- **`GCP.HelmRelease`** — Alchemy resource for managing Helm chart
  releases on GKE clusters (#8). _(Entry backfilled — 0.9.0 shipped
  without a changelog entry.)_

## 0.8.0 — 2026-06-17

### Added

- **`GCP.ServiceAccount`** — Alchemy resource for managing Google
  Cloud service accounts (GSAs). Wraps the iam-v1 API
  (`@distilled.cloud/gcp/unstable/iam-v1` — the `iamcredentials-v1`
  surface was already in the stable index; `iam-v1` lives under
  `unstable/` because the auto-generated codegen hasn't been manually
  reviewed). Adoption gated on an alchemy marker embedded in the
  GSA's `description` field (GSAs have no labels field, so the
  label-based pattern used by `GCP.Project` doesn't apply — see
  `Tags.descriptionHasAlchemyMarker`). Cold recovery (state loss)
  falls back to a project-wide scan-by-marker when persisted
  `output`/`olds` lack the `uniqueId`. Synchronous lifecycle — no LRO
  polling required.

- **`GCP.serviceAccountIamMember`** — target-side binding helper, the
  same shape as the existing `projectIamMember` and
  `subnetworkIamMember`. Records a `(role, member)` grant onto the
  GSA's binding bag; the ServiceAccount provider's `reconcile` merges
  all bound entries by role into a single `setIamPolicy` call on the
  GSA. Foreign bindings on the policy (non-alchemy roles, or members
  we don't manage on the same role) are preserved verbatim. Etag
  round-trip handles concurrent edits; `Conflict` triggers a
  re-read + retry.

### Use cases

- Workload Identity bindings — `roles/iam.workloadIdentityUser` on a
  GSA from a k8s SA. Replaces the manual `gcloud iam service-accounts
  add-iam-policy-binding` dance that's been applied out-of-band for
  the `research-ui` and `preview-builder` GSAs.
- Per-namespace `roles/artifactregistry.writer` on a GSA scoped to
  a single research pod (instead of project-wide via
  `projectIamMember`).
- Impersonation grants — `roles/iam.serviceAccountTokenCreator` /
  `roles/iam.serviceAccountUser`.

## 0.7.0 — 2026-06-16

### Added

- **`GCP.KubernetesManifest`** — generic Alchemy resource for *any*
  Kubernetes Kind/CRD, server-side-applied via
  `Content-Type: application/apply-patch+yaml` with `fieldManager=alchemy`
  and `force=true`. Kind → REST resource (plural + scope) resolved through
  the apiserver's discovery endpoint, so built-ins and CRDs work without a
  hard-coded kind→plural table. Adoption gated on the standard
  `alchemy_app`/`alchemy_stage`/`alchemy_id` label triple.

- **`clusterLayer` (`src/Kubernetes/connection.ts`)** — wires a GKE
  cluster into the typed `@distilled.cloud/kubernetes` SDK: ADC bearer
  token (`Credentials`) + an `HttpClient` whose `FetchHttpClient.Fetch` is
  overridden with a `node:https` fetch that trusts the per-cluster CA.
  The stock fetch can't verify the GKE cert (it's signed by the
  cluster's own CA, not a public root), so the override is required.

### Changed

- **`GCP.KubernetesSecret` convergence** — moved off the hand-rolled
  client onto typed `@distilled.cloud/kubernetes` core/v1 ops. Reconcile
  is now **create + replace (PUT)** with the observed `resourceVersion`
  for optimistic concurrency, bounded `Conflict` retry (recursive on the
  whole observe→write flow, up to 3 re-attempts), and read-modify-write
  metadata that preserves foreign annotations/owner references/finalizers
  (a PUT replaces the whole object, so spreading `...observed.metadata`
  first and overlaying only what we manage is essential — without it
  every reconcile would strip an `ownerReference` and break garbage
  collection). Validation scripts in `scripts/validate-k8s-{connection,
  secret,manifest}.ts` cover live cluster runs against `research-cluster-a`.

## 0.6.0 — 2026-06-14

### Added

- **`GCP.KubernetesSecret`** — first Kubernetes resource in the
  provider. Opaque Secret in a GKE cluster, driven via a hand-rolled
  REST client with ADC bearer auth + per-cluster CA trust. Adoptable via
  the standard alchemy-internal label triple.

### Changed

- **`Auth/Credentials.fromAuthProvider`** — same fix as `0.5.1`,
  re-asserted against the freshly bumped workspace pins.

## 0.5.1 — 2026-06-08

### Fixed

- **`Auth/Credentials.fromAuthProvider`** — adapt to upstream alchemy's
  `Profile` service refactor. `loadOrConfigure` is no longer a top-level
  export of `alchemy/Auth/Profile`; it's a method on the `Profile`
  `Context.Service`. The Layer now yields `Profile` and calls
  `profile.loadOrConfigure(...)`, mirroring the
  `Cloudflare/Credentials.ts` shape in alchemy upstream. Required for
  any alchemy version newer than the one this package was originally
  built against — without this fix, a downstream stack that imports
  `@microagi/alchemy-gcp` against current alchemy fails to load with
  `SyntaxError: Export named 'loadOrConfigure' not found`.

- **`GCP.ArtifactRegistryRepository` diff** — `somePropsAreDifferent`
  uses `!==` reference equality, which is always `true` for the
  `remoteRepositoryConfig` object after JSON round-trip through the
  state store. A plan against an unchanged stack would show
  `replace` (destroy + recreate), which on a remote repository
  destroys the pull-through cache. The diff now uses `deepEqual` for
  `remoteRepositoryConfig` and keeps `somePropsAreDifferent` only for
  string-typed stables.

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
