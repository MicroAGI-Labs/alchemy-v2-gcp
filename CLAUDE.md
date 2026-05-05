# alchemy-v2-gcp

GCP provider for [Alchemy v2](https://v2.alchemy.run). Authored as a separate git submodule (`MicroAGI-Labs/alchemy-v2-gcp`) — this is the **only** workspace in the parent `research-infra` repo where we write provider code. `vendor/alchemy/` and `vendor/distilled/` are read-only upstream.

The parent repo's [CLAUDE.md](../../CLAUDE.md) covers the workspace setup, version pinning, and why we use Bun. Read it first if you haven't.

## Goal

Implement Alchemy Resources for GCP — initially `Project` (org/folder/billing), `Cluster` (Standard GKE), and `NodePool`. SDK calls go through `@distilled.cloud/gcp` (typed, Effect-native, all 509 services from Discovery Documents); auth goes through ADC via a custom `Credentials` Layer.

## Canonical references — read these before writing code

- **`vendor/alchemy/AGENTS.md`** — the upstream contributor guide. Authoritative on file layout, the four-type `Resource` interface, the **reconciler doctrine**, tag handling, and the `Effect.fn`/no-async/no-`orDie` rules. Treat it as our spec.
- **Provider authoring guide:** <https://v2.alchemy.run/guides/custom-provider>
- **Concept docs:** [Resource](https://v2.alchemy.run/concepts/resource), [Provider](https://v2.alchemy.run/concepts/provider), [Resource Lifecycle](https://v2.alchemy.run/concepts/resource-lifecycle)
- **Reference resource implementations** to mirror:
  - `vendor/alchemy/packages/alchemy/src/Cloudflare/R2/R2Bucket.ts` — closest in shape to what we'll write (single SDK, simple resource, `diff` + `reconcile` + `delete` + `read`)
  - `vendor/alchemy/packages/alchemy/src/AWS/S3/Bucket.ts` — multi-aspect sync (tags, policy) via small per-aspect reconciler helpers
  - `vendor/alchemy/packages/alchemy/src/AWS/EC2/Vpc.ts` — auto-assigned id pattern (relevant for GCP project numbers)
  - `vendor/alchemy/packages/alchemy/src/Cloudflare/Providers.ts` — bundling Resources into a `providers()` Layer

## Layout (mirrors upstream conventions)

```
src/
  index.ts                          # re-export from Providers.ts
  Providers.ts                      # `providers()` Layer; `Providers` collection class
  Auth/
    AuthProvider.ts                 # Clank flow for `alchemy login` (env vs ADC vs SA key)
    Credentials.ts                  # bridge AuthProvider → @distilled.cloud/gcp Credentials
  CloudResourceManager/
    Project.ts                      # `GCP.Project` resource + provider
    index.ts
  Container/
    Cluster.ts                      # `GCP.Cluster` (Standard GKE)
    NodePool.ts                     # `GCP.NodePool`
    index.ts
test/
  CloudResourceManager/Project.test.ts
  Container/Cluster.test.ts
  Container/NodePool.test.ts
```

The folder name under `src/` matches the GCP API surface (`cloudresourcemanager`, `container`, `compute`) — same as `vendor/distilled/packages/gcp/src/services/`. Resource type strings use dotted form: `"GCP.Project"`, `"GCP.Cluster"`, `"GCP.NodePool"`.

## Resource skeleton

```ts
import * as crm from "@distilled.cloud/gcp/services/cloudresourcemanager-v3";
import * as Effect from "effect/Effect";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import type * as GCP from "../Providers.ts";

export type ProjectProps = {
  projectId?: string;          // not Input<…> — must be statically knowable in diff
  displayName?: string;
  parent: { type: "folder" | "organization"; id: string };
  labels?: Record<string, string>;
};

export type Project = Resource<
  "GCP.Project",
  ProjectProps,
  { projectId: string; projectNumber: string; createTime: string; parent: ProjectProps["parent"] },
  never,                       // no binding contract for now
  GCP.Providers
>;
export const Project = Resource<Project>("GCP.Project");

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      // Acquire SDK clients ONCE here. They yield from @distilled.cloud/gcp,
      // which depends on the Credentials service we provide via the AuthProvider bridge.
      const createProject = yield* crm.createProject;
      const getProject    = yield* crm.getProject;
      const updateProject = yield* crm.updateProject;
      const deleteProject = yield* crm.deleteProject;

      return {
        stables: ["projectId", "projectNumber"],
        diff: Effect.fn(function* ({ news, olds = {}, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.projectId ?? olds.projectId) !== (news.projectId ?? output?.projectId))
            return { action: "replace" } as const;
          // displayName/labels are mutable → fall through to default update
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          // 1. Observe — trust the cloud, not output/olds
          // 2. Ensure — create if missing; tolerate AlreadyExists as a race
          // 3. Sync   — patch each mutable aspect against OBSERVED state
          // 4. Return — fresh attributes
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteProject({ name: `projects/${output.projectId}` })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.projectId) return undefined;
          return yield* getProject({ name: `projects/${output.projectId}` }).pipe(
            Effect.map(p => ({ projectId: p.projectId!, projectNumber: p.projectNumber!, createTime: p.createTime!, parent: output.parent })),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
```

## Hard rules (carried over from `vendor/alchemy/AGENTS.md`)

- **No `async`/`await`, no raw `Promise`, no `node:fs`, no `pathe`.** Use `Effect.fn` (not `Effect.fnUntraced` for resources — the upstream code base has migrated to `Effect.fn`), `FileSystem.FileSystem`, `Path.Path`, `HttpClient.HttpClient`. Sync Node calls (`crypto`, `process.cwd`, `Buffer`) wrap in `Effect.sync`.
- **Never `Effect.orDie` in lifecycle code** — it crashes the IaC engine.
- **Reconciler is one observe → ensure → sync → return flow.** Do **not** branch on `output === undefined` to split create vs update logic. Adoption (`output` defined, `olds` undefined) must traverse the same path.
- **Cloud state is authoritative.** `olds`/`output` are hints/caches. Re-read tags/labels from the live resource before diffing — never diff against `olds.labels`.
- **Stable physical names**: don't use `Date.now()`. Use `createPhysicalName` from `alchemy/PhysicalName` or rely on it being generated from `app + stage + id`. For names like `projectId`/`bucketName`/`clusterName` use `string` (not `Input<string>`) so `diff` can read them at plan time.
- **Tags/labels** — when GCP resources accept labels, brand them with the alchemy internal tags (`createInternalTags(id)`) plus user labels. Diff against observed.
- **Idempotent `delete`**: 404/`NotFound` is success.

## Auth wiring

`@distilled.cloud/gcp` exports a `Credentials` `Context.Service` (`vendor/distilled/packages/gcp/src/credentials.ts`) and a default `CredentialsFromEnv` Layer that reads a static `GOOGLE_ACCESS_TOKEN`. That's wrong for our use case (ADC).

We must:

1. Build an `AuthProvider` (`src/Auth/AuthProvider.ts`) using `AuthProviderLayer<GCPAuthConfig, GCPResolvedCredentials>()("GCP", { configure, login, logout, prettyPrint, read })`. Auth methods: `adc` (default — `gcloud auth application-default login` locally, metadata server in CI) and `serviceAccountKey` (path to JSON, stored via `writeCredentials`).
2. Build `fromAuthProvider()` (`src/Auth/Credentials.ts`) — a `Layer.effect(Credentials, …)` that reads the active profile, calls `auth.read(profileName, config)`, and returns `{ accessToken, project }` matching the SDK's `Config` interface. **Provide the `Credentials` tag re-exported from `@distilled.cloud/gcp` — do not redeclare a parallel tag**, or the SDK won't see our overrides.
3. Use `google-auth-library`'s `GoogleAuth.getAccessToken()` (wrapped in `Effect.tryPromise`) inside `read` to mint a short-lived token from ADC. Wrap in `Redacted.make`.

## `providers()` bundle

```ts
// src/Providers.ts
import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { GCPAuth } from "./Auth/AuthProvider.ts";
import { fromAuthProvider } from "./Auth/Credentials.ts";
import { Project, ProjectProvider } from "./CloudResourceManager/Project.ts";
import { Cluster, ClusterProvider } from "./Container/Cluster.ts";
import { NodePool, NodePoolProvider } from "./Container/NodePool.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("GCP") {}
export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

export const providers = () =>
  Layer.effect(Providers, Provider.collection([Project, Cluster, NodePool])).pipe(
    Layer.provide(Layer.mergeAll(ProjectProvider(), ClusterProvider(), NodePoolProvider())),
    Layer.provideMerge(fromAuthProvider()),
    Layer.provideMerge(GCPAuth),
  );
```

Consumed from `apps/cluster/alchemy.run.ts`:

```ts
Alchemy.Stack("research", { providers: GCP.providers() }, Effect.gen(function* () {
  const project = yield* GCP.Project("ResearchProj", { … });
  const cluster = yield* GCP.Cluster("Main", { project: project.projectId, … });
  yield* GCP.NodePool("system",  { cluster, machineType: "e2-standard-4", … });
  yield* GCP.NodePool("compute", { cluster, machineType: "n2-standard-16", … });
  yield* GCP.NodePool("rtx6000", { cluster, machineType: "g2-standard-12", accelerators: [{ type: "nvidia-l40s", count: 1 }], … });
  yield* GCP.NodePool("B200",    { cluster, machineType: "a3-ultragpu-8g", accelerators: [{ type: "nvidia-b200", count: 8 }], … });
}));
```

## Testing

Use `alchemy/Test/Vitest`:

```ts
import * as Test from "alchemy/Test/Vitest";
import * as GCP from "../src/index.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider("create + delete a project", (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(Effect.gen(function* () {
      return yield* GCP.Project("TestProj", { parent: { type: "folder", id: "<redacted-folder-id>" }, displayName: "test" });
    }));
    expect(created.projectId).toBeDefined();
    yield* stack.destroy();
  }),
);
```

Tests hit real GCP — they require ADC (`gcloud auth application-default login`) and a billing-enabled folder (use `research`, id `<redacted-folder-id>`). Project creates leave a 30-day soft-delete trail; clean up via `gcloud projects undelete` if needed. **No `Date.now()` in physical names** — derive from logical id so reruns hit the same resource.

For file/path access in tests, use `FileSystem.FileSystem` and `Path.Path` from `@effect/platform` — same rule as lifecycle code.

## Build / typecheck

```bash
bun tsc -b           # from research-infra root, type-checks all workspaces
```

This package has no bundling step — `package.json` exports `./src/index.ts` directly. Bun resolves it via the `bun` export condition; Node consumers (the alchemy CLI) will need TypeScript at runtime — that's fine because alchemy's CLI runs `.ts` directly via tsdown's loader. We do **not** ship a `lib/` build.

There is intentionally no `vitest.config.ts` yet — add one only when we wire up the first test. Mirror `vendor/alchemy/packages/alchemy/test/` setup if needed.

## Working conventions

- One Resource per file, co-located with its provider. Capabilities (Bindings) — if/when we add them — go in their own `{Capability}.ts` file with `Binding.Service` + `Binding.Policy` pairs.
- JSDoc the Resource and every prop/attribute. Upstream auto-generates docs from these; our copies feed future doc generation.
- Bump the submodule pin in the parent repo (`research-infra`) after committing changes here. Don't develop against an unpinned submodule.
- When in doubt about an Effect idiom or a lifecycle edge case, `vendor/alchemy/AGENTS.md` overrides this file.
