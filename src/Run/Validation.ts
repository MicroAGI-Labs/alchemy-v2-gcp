import { ConfigError } from "@distilled.cloud/gcp";
import * as Effect from "effect/Effect";

/**
 * Plan-time validation for Cloud Run resource props. Failing fast with
 * a typed `ConfigError` is much friendlier than letting the user wait
 * 30 s for the server to reject the request — and unlike server-side
 * errors, these surface before any state mutation happens.
 *
 * Used by both `Service` and `Job` since the constraints are shared:
 * resource naming, label namespacing, and the "at least one container"
 * rule on the template.
 */

/**
 * Cloud Run resource names must match the
 * [RFC 1123](https://datatracker.ietf.org/doc/html/rfc1123) label
 * subset:
 * - lowercase letters, digits, and hyphens
 * - begin with a letter, not end with a hyphen
 * - <50 chars (server hard cap, distinct from the wider 63-char label
 *   limit other GCP resources use)
 *
 * @internal
 */
const RUN_NAME_RE = /^[a-z]([-a-z0-9]{0,47}[a-z0-9])?$/;

/**
 * Cloud Run rejects labels and annotations with keys in any of these
 * namespaces. Listed in `vendor/distilled/packages/gcp/src/services/run-v2.ts`
 * doc comments next to every `labels` / `annotations` field. Failing
 * fast here saves a 400 round-trip from the server.
 */
const RESERVED_LABEL_NAMESPACES = [
  "run.googleapis.com/",
  "cloud.googleapis.com/",
  "serving.knative.dev/",
  "autoscaling.knative.dev/",
];

const reservedNamespaceFor = (key: string): string | undefined =>
  RESERVED_LABEL_NAMESPACES.find((ns) => key.startsWith(ns));

/**
 * Validate a Cloud Run resource name (Service or Job). Returns a
 * `ConfigError` Effect on the failure channel if the name is invalid,
 * otherwise succeeds.
 *
 * The name comes from `props.name` (when the user supplied one) or
 * `createPhysicalName({ id, maxLength: 49 })` (when defaulted). The
 * defaulted path is already capped at 49; this guard mostly protects
 * the user-supplied path against a server-side reject after a long
 * deploy.
 */
export const validateRunName = (
  kind: "Service" | "Job",
  name: string,
): Effect.Effect<void, ConfigError> => {
  if (RUN_NAME_RE.test(name) && name.length < 50) return Effect.void;
  return Effect.fail(
    new ConfigError({
      message: `Cloud Run ${kind} name ${JSON.stringify(name)} is invalid: must match /^[a-z]([-a-z0-9]{0,47}[a-z0-9])?$/ (lowercase letters/digits/hyphens, starts with letter, no trailing hyphen, <50 chars).`,
    }),
  );
};

/**
 * Reject user labels in any of the Cloud Run reserved namespaces — the
 * server's 400 message ("Labels with run.googleapis.com namespace are
 * not allowed") is clear enough, but failing at plan time means the
 * stack never starts a deploy that's guaranteed to fail.
 *
 * Alchemy internals are merged *on top* of user labels and are NOT
 * subject to this check — they use the un-namespaced `alchemy_*` keys.
 */
export const validateLabels = (
  labels: Record<string, string> | undefined,
): Effect.Effect<void, ConfigError> => {
  if (!labels) return Effect.void;
  for (const key of Object.keys(labels)) {
    const ns = reservedNamespaceFor(key);
    if (ns) {
      return Effect.fail(
        new ConfigError({
          message: `Label key ${JSON.stringify(key)} uses reserved namespace ${JSON.stringify(ns)} — Cloud Run will reject this on create/patch. Strip the prefix or pick a different key.`,
        }),
      );
    }
  }
  return Effect.void;
};

/** Same check, applied to annotations (server has the same reservation). */
export const validateAnnotations = (
  annotations: Record<string, string> | undefined,
): Effect.Effect<void, ConfigError> => validateLabels(annotations);

/**
 * Cloud Run requires every Service template and Job task template to
 * declare at least one container. A `containers: []` body sails through
 * client-side type checks but the server rejects with a generic 400.
 */
export const validateContainers = (
  kind: "Service" | "Job",
  containers: ReadonlyArray<unknown> | undefined,
): Effect.Effect<void, ConfigError> => {
  if (containers && containers.length > 0) return Effect.void;
  return Effect.fail(
    new ConfigError({
      message: `Cloud Run ${kind} template must declare at least one container. Did you forget \`template.containers: [{ image: "…" }]\`?`,
    }),
  );
};

/**
 * Reshape a `BadRequest` from a Cloud Run create or patch into a
 * `ConfigError` with a remediation hint for the top failure modes:
 *
 * 1. **Billing not enabled** — the project's billing-account attach
 *    was missing or detached. Common after a fresh project + ApiEnable
 *    before billing reconciles.
 * 2. **Image not in an approved registry** — Cloud Run defaults reject
 *    Docker Hub and most non-Google registries when Binary Authorization
 *    is on. Surface the registry-allow-list pointer.
 * 3. **Reserved label/annotation namespace** — we catch user-supplied
 *    cases in `validateLabels`, but server-side checks also fire for
 *    fields nested inside `template` (we don't recurse) so leave this
 *    as a passthrough hint.
 *
 * Anything else propagates verbatim — the underlying GCP message is
 * usually clear ("invalid image reference", "memory limit too low").
 */
export const reshapeBadRequest =
  (kind: "Service" | "Job", op: "create" | "patch") =>
  (e: { message?: string }): Effect.Effect<never, ConfigError> => {
    const underlying = e.message ?? `unknown 400 from ${kind} ${op}`;
    let hint = "";
    if (/billing/i.test(underlying)) {
      hint =
        " Cloud Run requires billing to be enabled on the project. Attach a billing account (see `GCP.Project({ billingAccount })`) and retry.";
    } else if (/registry|image.*not.*allowed|disallowed.*image/i.test(underlying)) {
      hint =
        " Cloud Run rejects images from non-Google registries when Binary Authorization is on. Push to Artifact Registry (`*-docker.pkg.dev`) or relax the binary-auth policy.";
    } else if (/run\.googleapis\.com|knative\.dev|cloud\.googleapis\.com/i.test(underlying)) {
      hint =
        " A reserved label/annotation namespace is in use. Cloud Run forbids `run.googleapis.com/*`, `cloud.googleapis.com/*`, `serving.knative.dev/*`, and `autoscaling.knative.dev/*` on user fields.";
    }
    return Effect.fail(
      new ConfigError({
        message: `Cloud Run ${kind} ${op} rejected: ${underlying}.${hint}`,
      }),
    );
  };
