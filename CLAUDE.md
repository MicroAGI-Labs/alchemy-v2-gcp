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
  Tags.ts                           # GCP-flavored internal labels + ownership check
  Auth/
    AuthProvider.ts                 # Clank flow for `alchemy login` (ADC vs serviceAccountKey)
    Credentials.ts                  # bridge AuthProvider → @distilled.cloud/gcp Credentials
  CloudResourceManager/
    Project.ts                      # `GCP.Project` resource + provider
    index.ts
  Container/                        # (planned)
    Cluster.ts                      # `GCP.Cluster` (Standard GKE)
    NodePool.ts                     # `GCP.NodePool`
    index.ts
test/                               # (planned)
  CloudResourceManager/Project.test.ts
  Container/Cluster.test.ts
  Container/NodePool.test.ts
```

The folder name under `src/` matches the GCP API surface (`cloudresourcemanager`, `container`, `compute`) — same as `vendor/distilled/packages/gcp/src/services/`. Resource type strings use dotted form: `"GCP.Project"`, `"GCP.Cluster"`, `"GCP.NodePool"`.

## Resource skeleton

The actual `Project` provider is at `src/CloudResourceManager/Project.ts`. Its shape:

```ts
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager-v3";
import * as Effect from "effect/Effect";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import type * as GCP from "../Providers.ts";

// Operations are plural in the SDK (createProjects / getProjects /
// patchProjects / deleteProjects) — reflecting the GCP REST resource
// path `v3/projects/{projectsId}`. Don't write singular forms; they
// don't exist.

export type ProjectProps = {
  projectId?: string;          // not Input<…> — must be statically knowable in diff
  displayName?: string;
  parent: { type: "folder" | "organization"; id: string };
  labels?: Record<string, string>;
};

export type Project = Resource<
  "GCP.Project",
  ProjectProps,
  { projectId: string; projectNumber: string; name: string; /* … */ },
  never,                       // no binding contract for now
  GCP.Providers
>;
export const Project = Resource<Project>("GCP.Project");

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      // Acquire SDK clients ONCE — Credentials and HttpClient are
      // resolved here at provider construction. Use the captured
      // callables (e.g. `getProjects(input)`) inside lifecycle handlers
      // so we don't re-resolve services on every reconcile. This
      // matches `R2Bucket.ts` / every other alchemy provider.
      const getProjects = yield* crm.getProjects;
      const createProjects = yield* crm.createProjects;
      const patchProjects = yield* crm.patchProjects;
      const deleteProjects = yield* crm.deleteProjects;
      const getOperations = yield* crm.getOperations;

      return {
        stables: ["projectId", "projectNumber", "name"],
        diff: Effect.fn(function* ({ id, news, olds = {}, output }) {
          if (!isResolved(news)) return undefined;
          // Compare resolved projectId AND parent — both immutable; either
          // change → `{ action: "replace" }`.
        }),
        reconcile: Effect.fn(function* ({ id, news }) {
          // Always merge alchemy internal labels (alchemy_app /
          // alchemy_stage / alchemy_id from `gcpInternalLabels`) into
          // the desired label set so adoption gating in `read` works.
          //
          // 1. Observe — getProjects, catchTag NotFound → undefined
          // 2. Ensure — createProjects returns an LRO; awaitOperation
          //    polls getOperations until done. catchTag Conflict
          //    (project pre-exists / state-persistence race) and
          //    re-observe.
          // 3. Sync   — patchProjects with an `updateMask` for
          //    `display_name` / `labels`, diffed against OBSERVED state.
          // 4. Return — toAttributes(observed)
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteProjects({ name: `projects/${output.projectId}` })
            .pipe(/* awaitOperation, catchTag NotFound, catchTag BadRequest if DELETE_REQUESTED */);
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          // observeProject → if absent return undefined.
          // Otherwise: hasAlchemyLabels(id, observed.labels)
          //   ? toAttributes(observed)
          //   : Unowned(toAttributes(observed))
          // The Unowned brand makes the engine fail the plan unless
          // the user passes --adopt — important for billing-scoped
          // projects.
        }),
      };
    }),
  );
```

### GCP-specific gotchas

- **Long-running operations.** `createProjects` / `patchProjects` / `deleteProjects` return an `Operation`, not the resource. We poll `getOperations({ name })` with an exponential schedule (`Schedule.exponential(1s, 1.5).pipe(Schedule.both(Schedule.recurs(60)))`) until `done === true`. The success payload lives in `op.response`; failures land in `op.error` as a `Status`.
- **4xx errors are typed via per-operation distilled patches.** Out of the box, GCP discovery-document operations declare only `DefaultErrors` (the retryable categories: `Unauthorized`, `TooManyRequests`, `InternalServerError`, …) — `NotFound` / `Conflict` / `BadRequest` arrive *tagged* at runtime but are absent from the static error union. Per `vendor/distilled/AGENTS.md`, the proper fix is per-operation patches under `vendor/distilled/packages/gcp/patches/{service}/{operation}.json`. We've added patches for the `cloudresourcemanager` operations we use (`getProjects`, `createProjects`, `patchProjects`, `deleteProjects`, `getOperations`) so `Effect.catchTag("NotFound", …)` typechecks and works at runtime. **When adding a new GCP operation to a provider, add its 4xx tags to the matching patch file and regenerate** with `cd vendor/distilled/packages/gcp && bun run scripts/generate.ts --service <name> --version <vN>`.
- **`applyErrorMatchers` was broken upstream.** GCP's `traits.ts` originally routed `applyErrorMatchers` through `makeAnnotation`, which calls `.annotate(...)` on the argument — that only works for full Schemas, not the raw AST nodes a `TaggedErrorClass` exposes. The first patched service file blew up at module-load time. We fixed `vendor/distilled/packages/gcp/src/traits.ts` to mirror the Cloudflare approach (direct `cls.ast.annotations[symbol] = matchers`). If you bump the distilled submodule pin and `T.applyErrorMatchers is not a function` resurfaces, port the same fix.
- **Adoption gating uses internal labels.** `read` returns `Unowned(attrs)` when a project lacks all three of our `alchemy_app` / `alchemy_stage` / `alchemy_id` labels, forcing the user to pass `--adopt` (or wrap with `adopt(true)`) before takeover. Project `reconcile` always merges these internals into the user's labels (alchemy keys are reserved — they overwrite user-supplied values with the same key). The keys use `_` separators because GCP label keys disallow `:` (the alchemy default `alchemy::stack` would be rejected by GCP). See `src/Tags.ts` for `gcpInternalLabels` / `hasAlchemyLabels`.

## Hard rules (carried over from `vendor/alchemy/AGENTS.md`)

- **No `async`/`await`, no raw `Promise`, no `node:fs`, no `pathe`.** Use `Effect.fn` (not `Effect.fnUntraced` for resources — the upstream code base has migrated to `Effect.fn`), `FileSystem.FileSystem`, `Path.Path`, `HttpClient.HttpClient`. Sync Node calls (`crypto`, `process.cwd`, `Buffer`) wrap in `Effect.sync`.
- **Never `Effect.orDie` in lifecycle code** — it crashes the IaC engine.
- **Reconciler is one observe → ensure → sync → return flow.** Do **not** branch on `output === undefined` to split create vs update logic. Adoption (`output` defined, `olds` undefined) must traverse the same path.
- **Cloud state is authoritative.** `olds`/`output` are hints/caches. Re-read tags/labels from the live resource before diffing — never diff against `olds.labels`.
- **Stable physical names**: don't use `Date.now()`. Use `createPhysicalName` from `alchemy/PhysicalName` or rely on it being generated from `app + stage + id`. For names like `projectId`/`bucketName`/`clusterName` use `string` (not `Input<string>`) so `diff` can read them at plan time.
- **Tags/labels** — when a GCP resource accepts labels, brand it with `gcpInternalLabels(id)` (from `src/Tags.ts`) merged on top of user labels. Alchemy keys (`alchemy_app`/`alchemy_stage`/`alchemy_id`) are reserved and must overwrite any user-supplied collisions. Diff against observed cloud labels, not `olds`.
- **Idempotent `delete`**: 404/`NotFound` is success.

## Auth wiring

`@distilled.cloud/gcp` exports a `Credentials` `Context.Service` (`vendor/distilled/packages/gcp/src/credentials.ts`) and a default `CredentialsFromEnv` Layer that reads a static `GOOGLE_ACCESS_TOKEN`. That's wrong for our use case (ADC).

### What's implemented today

Two complementary entry points in `src/Auth/`:

- **`AuthProvider.ts`** — `GCPAuth` Layer that registers a `GCP` provider in the alchemy `AuthProviders` registry. Methods are `adc` (default; resolves via `google-auth-library` ADC) and `serviceAccountKey` (configure prompts for a JSON keyfile path; the path is stored in `~/.alchemy/credentials/{profile}/gcp-service-account.json`, the JSON itself stays where the user already has it). CI defaults to `{ method: "adc" }`. `read` mints a fresh access token and resolves a project from the profile config / env / `auth.getProjectId()`.
- **`Credentials.ts`** — exports two `Credentials` Layers:
  - `fromAuthProvider()` — bridges the registered `AuthProvider` into the `Credentials` tag re-exported from `@distilled.cloud/gcp`. Resolves the active profile via `ALCHEMY_PROFILE`, calls `loadOrConfigure` (so a missing profile triggers `configure`), then `auth.read`. This is what `providers()` wires by default.
  - `fromADC(project?)` — direct ADC bridge, no profile resolution. Useful for tests or single-profile stacks that don't want to engage the registry.

Both Layers satisfy the `Credentials` tag *re-exported from `@distilled.cloud/gcp`* — do **not** redeclare a parallel tag, or the SDK won't see our override.

ADC works locally (`gcloud auth application-default login`) and in CI (metadata server / workload identity); `serviceAccountKey` covers the local case where someone already has a key on disk.

## `providers()` bundle

Actual implementation (`src/Providers.ts`):

```ts
import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { GCPAuth } from "./Auth/AuthProvider.ts";
import { fromAuthProvider } from "./Auth/Credentials.ts";
import { Project, ProjectProvider } from "./CloudResourceManager/Project.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("GCP") {}
export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

export const providers = () =>
  Layer.effect(Providers, Provider.collection([Project])).pipe(
    Layer.provide(Layer.mergeAll(ProjectProvider())),
    Layer.provideMerge(fromAuthProvider()),
    Layer.provideMerge(GCPAuth),
    Layer.provideMerge(FetchHttpClient.layer),
  );
```

When `Cluster` / `NodePool` land they slot into the same shape — extend the `Provider.collection([...])` list and the inner `Layer.mergeAll(...)` of `*Provider()`s; the auth/HTTP wiring stays unchanged.

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
      return yield* GCP.Project("TestProj", { parent: { type: "folder", id: "<your-folder-id>" }, displayName: "test" });
    }));
    expect(created.projectId).toBeDefined();
    yield* stack.destroy();
  }),
);
```

Tests hit real GCP — they require ADC (`gcloud auth application-default login`) and a billing-enabled folder (use `research`, id `<your-folder-id>`). Project creates leave a 30-day soft-delete trail; clean up via `gcloud projects undelete` if needed. **No `Date.now()` in physical names** — derive from logical id so reruns hit the same resource.

For file/path access in tests, use `FileSystem.FileSystem` and `Path.Path` from `@effect/platform` — same rule as lifecycle code.

## Build / typecheck

```bash
# from this package (vendor/alchemy-v2-gcp/)
bunx tsc --noEmit
```

This package has no bundling step — `package.json` exports `./src/index.ts` directly. Bun resolves it via the `bun` export condition; Node consumers (the alchemy CLI) will need TypeScript at runtime — that's fine because alchemy's CLI runs `.ts` directly via tsdown's loader. We do **not** ship a `lib/` build.

There is no root `tsconfig.json` in `research-infra/` yet, so `bun tsc -b` from the repo root won't work. Each workspace member typechecks itself. (When all workspaces have `composite: true` we can add a root `tsconfig.json` with `references` and use `tsc -b`.)

`bunx tsc --noEmit` should be clean. If `cloudresourcemanager-v3.ts` lights up with readonly-variance errors, the distilled pin has slipped behind alchemy-run/distilled#259.

There is intentionally no `vitest.config.ts` yet — add one only when we wire up the first test. Mirror `vendor/alchemy/packages/alchemy/test/` setup if needed.

## Working conventions

- One Resource per file, co-located with its provider. Capabilities (Bindings) — if/when we add them — go in their own `{Capability}.ts` file with `Binding.Service` + `Binding.Policy` pairs.
- JSDoc the Resource and every prop/attribute. Upstream auto-generates docs from these; our copies feed future doc generation.
- Bump the submodule pin in the parent repo (`research-infra`) after committing changes here. Don't develop against an unpinned submodule.
- When in doubt about an Effect idiom or a lifecycle edge case, `vendor/alchemy/AGENTS.md` overrides this file.
