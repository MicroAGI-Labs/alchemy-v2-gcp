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

Long-running operations (`createProjects`, `patchProjects`, GKE cluster ops) are polled internally; reconcilers follow the [Alchemy reconciler doctrine](https://v2.alchemy.run/concepts/resource-lifecycle) (single observe → ensure → sync → return flow that converges from any starting state, including adoption).

## Resources

- **`GCP.Project`** — projects under an org or folder, with optional billing-account attach.
- **`GCP.ApiEnable`** — project-level GCP service enablement.
- **`GCP.Cluster`** — Standard GKE cluster.
- **`GCP.NodePool`** — node pool attached to a cluster, including accelerator (GPU) configurations.
- **`GCP.Network`** — VPC network.
- **`GCP.Subnetwork`** — VPC subnetwork.
- **`GCP.PsaConnection`** — Private Service Access peering for Google managed services.
- **`GCP.GlobalAddress`** — global IP address (typically used to reserve a PSA range).
- **`GCP.SharedVpcHost`** / **`GCP.SharedVpcServiceProject`** — Shared VPC enable/attach.
- **`GCP.ParallelstoreInstance`** — Parallelstore filesystem instance.

Each resource's full prop/attribute set is documented as JSDoc on the source.

## Adoption

`read` is gated on the alchemy internal labels `alchemy_app` / `alchemy_stage` / `alchemy_id`. Existing GCP resources lacking those labels are returned `Unowned` — the engine refuses to take them over without explicit `--adopt` (or `adopt(true)` on the resource call).

## License

Apache-2.0.
