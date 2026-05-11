# @microagi/alchemy-gcp

GCP provider for [Alchemy v2](https://v2.alchemy.run) — Effect-native Infrastructure-as-Code. Alchemy ships only AWS + Cloudflare providers out of the box; this package fills the GCP gap.

Resources are implemented against [`@distilled.cloud/gcp`](https://github.com/alchemy-run/distilled) (Effect-native, typed GCP SDK generated from the Google Discovery Documents). Authentication uses Google Application Default Credentials via [`google-auth-library`](https://www.npmjs.com/package/google-auth-library), bridged into the `Credentials` `Context.Service` exported by `@distilled.cloud/gcp`.

## Install

```sh
bun add @microagi/alchemy-gcp alchemy@next @distilled.cloud/gcp effect
# or
npm install @microagi/alchemy-gcp alchemy@next @distilled.cloud/gcp effect
```

`alchemy`, `@distilled.cloud/gcp`, and `effect` are peer dependencies — they must resolve to a single instance in your dependency tree so that the `Credentials` `Context.Service` tag identity is preserved.

The `next` dist-tag is required for `alchemy` because `latest` still points at the v1 line (`0.93.x`); v2 betas live under `next`.

## Authenticate

```sh
gcloud auth application-default login   # local
# or, in CI / on GCP, ADC resolves automatically via the metadata server
```

A `serviceAccountKey` flow is also wired through `alchemy login`.

## Use

`alchemy.run.ts`:

```ts
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as GCP from "@microagi/alchemy-gcp";

export default Alchemy.Stack(
  "research",
  {
    providers: GCP.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* GCP.Project("ResearchProj", {
      parent: { type: "folder", id: "<your-folder-id>" },
      displayName: "research",
      billingAccount: "billingAccounts/<your-billing-account>",
    });

    const cluster = yield* GCP.Cluster("Main", {
      project: project.projectId,
      location: "us-central1",
      network: "default",
      initialNodePool: {
        name: "default-pool",
        initialNodeCount: 1,
        config: { machineType: "e2-standard-4" },
      },
    });

    yield* GCP.NodePool("compute", {
      project: project.projectId,
      location: "us-central1",
      clusterName: cluster.name,
      initialNodeCount: 2,
      config: { machineType: "n2-standard-16" },
    });
  }),
);
```

Run it with the alchemy CLI:

```sh
bun alchemy plan ./alchemy.run.ts
bun alchemy deploy ./alchemy.run.ts
bun alchemy destroy ./alchemy.run.ts
```

`Alchemy.localState()` writes Alchemy's resource state to `.alchemy/` next to the stack file. `Alchemy.inMemoryState()` is fine for tests but loses state between runs. For team use, swap in `httpStateStore()`.

Long-running operations (`createProjects`, `patchProjects`, GKE cluster ops, Cloud Run service deploys) are polled internally; reconcilers follow the [Alchemy reconciler doctrine](https://v2.alchemy.run/concepts/resource-lifecycle) (single observe → ensure → sync → return flow that converges from any starting state, including adoption).

## Resources

### Foundation
- **`GCP.Project`** — projects under an org or folder, with optional billing-account attach.
- **`GCP.ApiEnable`** — project-level GCP service enablement.

### Compute
- **`GCP.Cluster`** — Standard GKE cluster.
- **`GCP.NodePool`** — node pool attached to a cluster, including accelerator (GPU) configurations.

### Networking
- **`GCP.Network`** — VPC network.
- **`GCP.Subnetwork`** — VPC subnetwork.
- **`GCP.PsaConnection`** — Private Service Access peering for Google managed services.
- **`GCP.GlobalAddress`** — global IP address (typically used to reserve a PSA range).
- **`GCP.SharedVpcHost`** / **`GCP.SharedVpcServiceProject`** — Shared VPC enable/attach.

### Serverless (Cloud Run v2)
- **`GCP.Service`** — Cloud Run HTTP service with traffic routing, ingress controls, and IAM.
- **`GCP.Job`** — Cloud Run batch workload (declarative definition; trigger execution imperatively via `runProjectsLocationsJobs`).
- **`GCP.serviceIamMember`** / **`GCP.jobIamMember`** — bind `(role, member)` IAM grants on Cloud Run resources. Provider unions all bindings and writes one `setIamPolicy` per target, preserving foreign roles.

### Storage
- **`GCP.ManagedLustreInstance`** — Managed Lustre filesystem instance.

Each resource's full prop/attribute set is documented as JSDoc on the source.

### Cloud Run example

```ts
const api = yield* GCP.Service("HelloApi", {
  project: project.projectId,
  location: "europe-west4",
  template: {
    containers: [{ image: "gcr.io/cloudrun/hello" }],
  },
});

// Declarative public access — preferred over `invokerIamDisabled: true`,
// which bypasses IAM entirely and leaves no audit trail.
yield* GCP.serviceIamMember(api, "PublicInvoker", {
  role: "roles/run.invoker",
  member: "allUsers",
});

// Batch workload — definition only; execution is imperative.
const batch = yield* GCP.Job("ProcessBatch", {
  project: project.projectId,
  location: "europe-west4",
  template: {
    taskCount: 1,
    template: {
      maxRetries: 3,
      containers: [{ image: "europe-west4-docker.pkg.dev/proj/repo/worker:v1" }],
    },
  },
});
```

Clean type aliases are re-exported from the top level so consumers don't need to import from `@distilled.cloud/gcp` directly: `GCP.RevisionTemplate`, `GCP.Container`, `GCP.TrafficTarget`, `GCP.VpcAccess`, `GCP.NodeSelector`, etc.

## Adoption

`read` is gated on the alchemy internal labels `alchemy_app` / `alchemy_stage` / `alchemy_id`. Existing GCP resources lacking those labels are returned `Unowned` — the engine refuses to take them over without explicit `--adopt` (or `adopt(true)` on the resource call).

For resources that don't carry labels (Network, Subnetwork), the same `(app, stage, id)` triple is encoded as a sentinel inside `description` and matched on `read`.

## Optimistic concurrency

Resources with server-side fingerprints (Cloud Run Service/Job, Subnetwork) pass the observed `etag`/`fingerprint` through patch and delete calls. A concurrent edit between observe and patch surfaces as `Conflict` rather than silently overwriting.

## License

Apache-2.0.
