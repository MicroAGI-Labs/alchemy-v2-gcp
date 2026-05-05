# distilled core: GCP service `rootUrl` never applied + RFC 6570 reserved-expansion mishandled

After [`alchemy-run/distilled#260`](https://github.com/alchemy-run/distilled/pull/260) (path placeholder substitution) was merged, every read-by-name request from `@distilled.cloud/gcp` still fails — but with a **different** error than before. Two distinct gaps surface:

1. **No host is prepended.** The request URL is the relative path (`v3/projects/foo`) with no scheme/authority. `effect/unstable/http/HttpClient` rejects it via `new URL(url, undefined)` → `ERR_INVALID_URL`. The `T.Service.rootUrl` declared on every generated service file is never consumed.
2. **`/` inside resource names is wrongly percent-encoded.** PR #260 fixed substitution by stripping `{+name}` to `{name}` in the URL template. RFC 6570 distinguishes simple expansion (`{name}` — `/` becomes `%2F`) from reserved expansion (`{+name}` — `/` is preserved). GCP's discovery docs use `{+name}` precisely so resource names like `projects/microagi-research` stay literal on the wire. Stripping the `+` made every GCP path-by-name request emit `%2F` instead of `/`. The PR's regression test was permissive enough to accept either form, so the bug masquerades as fixed.

This document specifies one cohesive follow-up PR that closes both gaps.

## Symptom

End-to-end repro from this repo, with ADC available locally:

```bash
cd vendor/alchemy-v2-gcp && CI=1 bun test test/CloudResourceManager/Project.test.ts
```

```
error: InvalidUrl error (GET v3/projects%2Falchemy-test-rpilvq)
       _tag: "HttpClientError",
 ~effect/http/HttpClientError: "~effect/http/HttpClientError",

  request: {
    method: "GET",
    url: "v3/projects%2Falchemy-test-rpilvq",
    ...
  }
```

Both failure signatures are visible in that one URL:
- `v3/projects%2F...` — slash percent-encoded (gap 2).
- No `https://cloudresourcemanager.googleapis.com/` prefix — host missing (gap 1).

## How AWS and Cloudflare avoid this

Reference implementations inside the same monorepo for context:

### AWS — `vendor/distilled/packages/aws/src/client/api.ts`

AWS does **not** use `core.makeAPI`. It has a service-aware request pipeline that resolves an endpoint per call via a Smithy rules engine, then concatenates directly:

```ts
// vendor/distilled/packages/aws/src/client/api.ts:140
endpoint = `https://${serviceName}.${region}.amazonaws.com`;
// ...
// vendor/distilled/packages/aws/src/client/api.ts:191
url: `${endpoint}${fullPath}`,
```

Per-service hosts × per-region × custom-endpoint-overrides make a single `getBaseUrl(creds)` insufficient for AWS, so AWS opted out of `core.makeAPI` entirely.

### Cloudflare — `vendor/distilled/packages/cloudflare/src/client/api.ts`

Cloudflare has exactly one host. The base URL is bundled into credentials and exposed via `getBaseUrl`:

```ts
// vendor/distilled/packages/cloudflare/src/client/api.ts:429-431
const _API = makeAPI<Credentials>({
  credentials: Credentials,
  getBaseUrl: (creds: any) => creds.apiBaseUrl,
  // ...
});
```

`apiBaseUrl` is a field on `CloudflareCredentials` (`vendor/distilled/packages/cloudflare/src/credentials.ts:16`, etc.). Single tenancy → trivial.

### GCP

GCP has per-service hosts (`cloudresourcemanager.googleapis.com`, `container.googleapis.com`, …) — each known statically from the discovery doc, not per-credentials. That's why distilled stored it on the **service trait**:

```ts
// vendor/distilled/packages/gcp/src/services/cloudresourcemanager-v3.ts:14-19
const svc = T.Service({
  name: "cloudresourcemanager",
  version: "v3",
  rootUrl: "https://cloudresourcemanager.googleapis.com/",
  servicePath: "",
});
```

The trait is declared in core (`packages/core/src/traits.ts:384-403`), the accessor is exported (`getServiceTrait` at `:485`), and the generator emits it on every GCP service file. **`core/src/client.ts` never consults it.** Per-service base URL is the GCP-shaped path that distilled designed but never finished wiring.

## Architectural gap (gap 1)

Inside `packages/core/src/client.ts`, base URL is fetched per-request from the consumer's `getBaseUrl` callback:

```ts
// vendor/distilled/packages/core/src/client.ts:447
const baseUrl = config.getBaseUrl(creds as ResolvedCreds);
// ...
// vendor/distilled/packages/core/src/client.ts:482
let request = HttpClientRequest.make(method)(
  baseUrl + parts.path,
)
```

GCP's `makeAPI` config supplies an empty string and a comment promising the host comes from the Http trait — but the Http trait only carries `path`, never a host:

```ts
// vendor/distilled/packages/gcp/src/client/api.ts:50-64
/**
 * GCP API client.
 * Note: GCP uses per-service base URLs from the Discovery Documents,
 * so the base URL is set per-service via the Service trait, not globally.
 */
const _API = makeAPI<Credentials>({
  credentials: Credentials,
  getBaseUrl: (_creds: any) => "", // Set per-service via Http trait
  // ...
});
```

Result: `baseUrl` is `""` and the resolved URL is the bare path.

## Encoding gap (gap 2)

PR #260's generator change:

```ts
// vendor/distilled/packages/gcp/scripts/generate.ts:1063 (before #260)
path: method.flatPath ?? method.path,

// after #260 (current main)
path: stripReservedExpansion(method.path ?? method.flatPath),
// where stripReservedExpansion rewrites `{+x}` → `{x}`
```

The discovery doc for `cloudresourcemanager.projects.get` carries:

```jsonc
"path":     "v3/{+name}",       // RFC 6570 reserved-expansion
"flatPath": "v3/projects/{projectsId}",   // documentation only
"parameters": { "name": { "location": "path", "pattern": "^projects/[^/]+$", ... } }
```

`{+name}` says: `/` inside the value stays literal. After PR #260 the template becomes `v3/{name}`, and `buildRequestParts` substitutes via `encodeURIComponent`:

```ts
// vendor/distilled/packages/core/src/traits.ts:660
path = path.replace(
  `{${pathWireName}}`,
  encodeURIComponent(String(value)),
);
```

`encodeURIComponent("projects/microagi-research")` = `"projects%2Fmicroagi-research"`. The wire form is wrong by RFC 6570 (and by GCP's own URL contract, even though GCP REST happens to accept the encoded form for many resources). The discovery doc is unambiguous: `{+name}` is reserved-expansion, `/` must be preserved.

PR #260's regression test masked this:

```ts
// vendor/distilled/packages/gcp/test/path-substitution.test.ts:39-42
expect([
  "v3/projects/microagi-research",
  "v3/projects%2Fmicroagi-research",
]).toContain(parts.path);
```

Either form passes; the implementation produces the second; nobody notices.

## Proposed fix — single PR

Three source changes + tighten the test. All changes are inside `vendor/distilled/`. No `T.Service` / `T.HttpPath` schema migration needed; no consumer-side migration in alchemy-v2-gcp.

### Change 1 — generator: keep `{+name}` literally

`vendor/distilled/packages/gcp/scripts/generate.ts:1063`

```ts
// Before (current main, post-#260)
path: stripReservedExpansion(method.path ?? method.flatPath),

// After
path: method.path ?? method.flatPath,
```

Drop the `stripReservedExpansion` helper. The path emitted on every generated `T.Http({...})` becomes `"v3/{+name}"` (and analogues for other services).

### Change 2 — core: handle reserved-expansion in `buildRequestParts`

`vendor/distilled/packages/core/src/traits.ts:626-665` (`buildRequestParts`)

Currently the path-param branch only checks for `{<name>}`. Extend it to check `{+<name>}` first; when matched, substitute with **reserved-encoding** instead of `encodeURIComponent`:

```ts
// Add helper (top of file or inside the function)
const RESERVED_RFC3986 = /[^A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=]/g;
const encodeReserved = (v: string): string =>
  v.replace(RESERVED_RFC3986, encodeURIComponent);

// In buildRequestParts, replace the existing path-param branch:
const pathWireName = getPathParamWireName(prop);
if (pathWireName !== undefined) {
  nonBodyKeys.add(tsName);
  const reservedPlaceholder = `{+${pathWireName}}`;
  const simplePlaceholder = `{${pathWireName}}`;
  if (path.includes(reservedPlaceholder)) {
    path = path.replace(reservedPlaceholder, encodeReserved(String(value)));
  } else {
    path = path.replace(simplePlaceholder, encodeURIComponent(String(value)));
  }
  continue;
}
```

`encodeReserved` percent-encodes everything **except** RFC 3986 reserved characters (`:/?#[]@!$&'()*+,;=`) plus unreserved (`A-Za-z0-9-._~`). This is the standard RFC 6570 reserved-expansion algorithm. `/` is in the keep-list; `projects/microagi-research` becomes literally `projects/microagi-research`.

The simple-expansion branch is kept for any non-reserved discovery-doc paths (rare in GCP but exists in some methods, e.g. flat-form `{projectsId}` in flatPath-only services).

### Change 3 — core: fall back to service trait `rootUrl`

`vendor/distilled/packages/core/src/client.ts:447` (inside the per-request closure of `_API.make`)

```ts
// Before
const baseUrl = config.getBaseUrl(creds as ResolvedCreds);

// After
let baseUrl = config.getBaseUrl(creds as ResolvedCreds);
if (!baseUrl) {
  const svc = Traits.getServiceTrait(inputSchema.ast);
  if (svc?.rootUrl) {
    baseUrl = svc.rootUrl + (svc.servicePath ?? "");
  }
}
```

Apply the same change to the paginated branch around `:546` (`const requestUrl = baseUrl + parts.path;`) — extract a helper if cleaner.

This honors the existing `T.Service` contract:
- AWS unaffected (doesn't use `makeAPI`).
- Cloudflare unaffected (`getBaseUrl(creds)` returns a non-empty string, fallback never runs).
- GCP starts working.
- Any future SDK that declares `T.Service({ rootUrl, servicePath })` and supplies an empty `getBaseUrl` gets correct behaviour for free.

### Optional cleanup — `gcp/src/client/api.ts:50-64`

Now that the fallback exists, the misleading comment can be removed and `getBaseUrl` retained as `() => ""` (relies on the fallback) or dropped if the `makeAPI` config allows omitting it. Don't change the API surface in this PR; just delete the stale comment and tighten:

```ts
// vendor/distilled/packages/gcp/src/client/api.ts:50-57
/**
 * GCP API client.
 * Per-service base URLs come from the Service trait
 * (`T.Service({ rootUrl, servicePath })`) on each generated service file.
 * `core.makeAPI` consults the trait when `getBaseUrl` returns falsy.
 */
const _API = makeAPI<Credentials>({
  credentials: Credentials,
  getBaseUrl: () => "",
  // ...
});
```

## Test changes

### Replace `packages/gcp/test/path-substitution.test.ts`

Drop the permissive `expect([literal, %2F]).toContain(...)` form. Assert the literal-slash form exactly. Add a reserved-vs-simple expansion case if a generated service has both shapes (rare; if none exist, skip).

```ts
// vendor/distilled/packages/gcp/test/path-substitution.test.ts (rewritten)
import { describe, expect, it } from "vitest";
import {
  buildRequestParts,
  getHttpTrait,
} from "@distilled.cloud/core/traits";
import {
  GetProjectsRequest,
  DeleteProjectsRequest,
} from "../src/services/cloudresourcemanager-v3.ts";

describe("GCP path-template substitution", () => {
  it("preserves `/` inside reserved-expansion {+name}", () => {
    const ast = (GetProjectsRequest as unknown as { ast: any }).ast;
    const trait = getHttpTrait(ast)!;
    const parts = buildRequestParts(ast, trait, {
      name: "projects/microagi-research",
    });
    expect(parts.path).toBe("v3/projects/microagi-research");
  });

  it("preserves `/` for delete by name as well", () => {
    const ast = (DeleteProjectsRequest as unknown as { ast: any }).ast;
    const trait = getHttpTrait(ast)!;
    const parts = buildRequestParts(ast, trait, {
      name: "projects/microagi-research",
    });
    expect(parts.path).toBe("v3/projects/microagi-research");
  });

  it("percent-encodes characters that are NOT RFC 3986 reserved", () => {
    const ast = (GetProjectsRequest as unknown as { ast: any }).ast;
    const trait = getHttpTrait(ast)!;
    // A space is unreserved-encoded; a slash is preserved.
    const parts = buildRequestParts(ast, trait, {
      name: "projects/with space",
    });
    expect(parts.path).toBe("v3/projects/with%20space");
  });
});
```

### Add `packages/gcp/test/base-url.test.ts`

Cover gap 1 — exercise the full `makeAPI` request-build path and assert the resolved URL has the service host. Mock the HTTP client so we observe the outgoing `HttpClientRequest` without any network.

```ts
// vendor/distilled/packages/gcp/test/base-url.test.ts (new)
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import { Credentials } from "../src/credentials.ts";
import * as crm from "../src/services/cloudresourcemanager-v3.ts";

const fakeCreds = Layer.succeed(Credentials, {
  accessToken: Redacted.make("ya29.fake"),
  project: "fake",
});

// Capture the URL of the first outgoing request, then short-circuit with
// a 200 empty Project body.
const capturingHttpClient = (sink: { url?: string }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        sink.url = request.url;
        return HttpClientResponse.fromText({ status: 200, text: "{}" });
      }),
    ),
  );

describe("GCP base URL resolution", () => {
  it("prepends Service.rootUrl to the resolved path", async () => {
    const sink: { url?: string } = {};
    const program = Effect.gen(function* () {
      const op = yield* crm.getProjects;
      yield* op({ name: "projects/microagi-research" });
    });

    await Effect.runPromise(
      program.pipe(
        Effect.provide(capturingHttpClient(sink)),
        Effect.provide(fakeCreds),
      ),
    );

    expect(sink.url).toBe(
      "https://cloudresourcemanager.googleapis.com/v3/projects/microagi-research",
    );
  });
});
```

(The exact `HttpClient.make` shim shape may need adjustment to match the current effect-platform API; the assertion is the intent.)

### Add `packages/core/test/build-request-parts.test.ts` if not present

A core-level test asserting reserved-expansion semantics belongs alongside the generic `buildRequestParts` code, not just in `gcp/`. If `packages/core/test/` exists, add a focused test there using a synthetic schema (no GCP dependency) to cover:

- `{+x}` placeholder + value with `/` → literal `/` in resolved path
- `{x}` placeholder + value with `/` → `%2F` in resolved path
- `{+x}` placeholder + value with space → `%20` in resolved path

If `packages/core/test/` doesn't exist, leave the GCP test as the regression site and note the layering in the PR description.

## Verification

In `vendor/distilled/`:

```bash
bun run --filter '@distilled.cloud/core' --filter '@distilled.cloud/gcp' test
```

In `vendor/alchemy-v2-gcp/` (this repo's submodule), end-to-end against live GCP folder `<redacted-folder-id>` with ADC:

```bash
cd vendor/alchemy-v2-gcp && CI=1 bun test test/CloudResourceManager/Project.test.ts
```

Expected: both Project test cases pass (`create and delete` ≈ 60-90s, `create + update displayName + delete` ≈ 90-180s). Wall time ≈ 3-5 min total.

## Files affected (summary)

| Layer | File | Change |
|---|---|---|
| Generator | `vendor/distilled/packages/gcp/scripts/generate.ts:1063` | revert `stripReservedExpansion` strip; keep `{+name}` literally |
| Core path substitution | `vendor/distilled/packages/core/src/traits.ts:626-665` | reserved-expansion branch + `encodeReserved` helper |
| Core base URL | `vendor/distilled/packages/core/src/client.ts:447,~546` | fall back to `getServiceTrait(ast).rootUrl + servicePath` when `getBaseUrl(creds)` is empty |
| GCP service files | `vendor/distilled/packages/gcp/src/services/*.ts` | regenerate (mechanical: every `T.Http({ ..., path: "v3/{name}" })` becomes `"v3/{+name}"` for reserved cases) |
| GCP client comment | `vendor/distilled/packages/gcp/src/client/api.ts:50-57` | tighten the doc comment; behaviour unchanged |
| Tests | `vendor/distilled/packages/gcp/test/path-substitution.test.ts` | rewrite — drop `%2F` alternative, assert literal `/`, add reserved-vs-other-character case |
| Tests | `vendor/distilled/packages/gcp/test/base-url.test.ts` (new) | assert full URL includes `https://cloudresourcemanager.googleapis.com/` |
| Tests | `vendor/distilled/packages/core/test/build-request-parts.test.ts` (new, optional) | core-level reserved-expansion regression |

## Why this is the right shape

- Honors the discovery-doc spec verbatim (`{+name}` survives generation), so future audits against discovery docs remain trivial.
- Honors the `T.Service` trait that distilled already designed for this — no new traits, no signature changes, no consumer migration.
- Other distilled SDKs are unaffected: AWS bypasses `makeAPI`; Cloudflare's `getBaseUrl(creds)` returns a non-empty string so the fallback never runs.
- alchemy-v2-gcp needs zero changes — once the submodule pin advances past this PR, the existing `Project.test.ts` passes against live GCP.
