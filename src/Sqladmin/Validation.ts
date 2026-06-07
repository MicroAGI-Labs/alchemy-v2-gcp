import { ConfigError } from "@distilled.cloud/gcp";
import * as Effect from "effect/Effect";
import { isIamUserType, type SqlUserType } from "./Types.ts";

/**
 * Plan-time validation for Cloud SQL resource props. Failing fast with
 * a typed `ConfigError` is friendlier than letting the user wait for
 * Cloud SQL to reject the request, and unlike server-side errors these
 * surface before any state mutation happens.
 *
 * @see https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances
 */

/**
 * Instance name regex per
 * <https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances#SqlInstance>:
 * 1–98 lowercase letters/digits/hyphens, must begin with a letter and
 * not end with a hyphen.
 *
 * @internal
 */
const INSTANCE_NAME_RE = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

/**
 * Database name length cap per
 * <https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/databases#Database>:
 * 1–64 chars. Postgres has additional character constraints (no NUL,
 * no embedded quotes) but the API rejects those, and they'd require
 * dialect-specific parsing here.
 *
 * @internal
 */
const DATABASE_NAME_MAX = 64;

/**
 * Validate a Cloud SQL instance name. Returns a `ConfigError` on the
 * failure channel if the name is invalid, otherwise succeeds.
 *
 * @see https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances#SqlInstance
 */
export const validateInstanceName = (
  name: string,
): Effect.Effect<void, ConfigError> => {
  if (INSTANCE_NAME_RE.test(name) && name.length >= 1 && name.length <= 98) {
    return Effect.void;
  }
  return Effect.fail(
    new ConfigError({
      message: `Cloud SQL instance name ${JSON.stringify(name)} is invalid: must match /^[a-z]([-a-z0-9]*[a-z0-9])?$/ (1–98 lowercase letters/digits/hyphens, start with letter, no trailing hyphen).`,
    }),
  );
};

/**
 * Validate a Cloud SQL database name (1–64 chars, non-empty).
 *
 * @see https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/databases#Database
 */
export const validateDatabaseName = (
  name: string,
): Effect.Effect<void, ConfigError> => {
  if (name.length >= 1 && name.length <= DATABASE_NAME_MAX) return Effect.void;
  return Effect.fail(
    new ConfigError({
      message: `Cloud SQL database name ${JSON.stringify(name)} is invalid: must be 1–${DATABASE_NAME_MAX} characters.`,
    }),
  );
};

/**
 * Validate a Cloud SQL user shape — primarily that the password/type
 * combination is consistent:
 *
 * - `BUILT_IN` users MUST carry a password.
 * - Any IAM user type (`CLOUD_IAM_USER`, `CLOUD_IAM_SERVICE_ACCOUNT`,
 *   `CLOUD_IAM_GROUP*`, `ENTRAID_USER`) MUST NOT carry a password —
 *   the IAM principal is authenticated by token exchange.
 *
 * Other types from the open tail of the enum (forward-compat) skip
 * the password check.
 *
 * @see https://cloud.google.com/sql/docs/postgres/users
 * @see https://cloud.google.com/sql/docs/postgres/iam-authentication
 */
export const validateUser = (args: {
  name: string;
  type: SqlUserType | undefined;
  hasPassword: boolean;
}): Effect.Effect<void, ConfigError> => {
  const type = args.type ?? "BUILT_IN";
  if (isIamUserType(type) && args.hasPassword) {
    return Effect.fail(
      new ConfigError({
        message: `Cloud SQL user ${JSON.stringify(args.name)} has type ${JSON.stringify(type)} (IAM-backed) but a password was supplied. IAM users authenticate via the Cloud SQL Auth Proxy / IAM token exchange — drop the \`password\` field.`,
      }),
    );
  }
  if (type === "BUILT_IN" && !args.hasPassword) {
    return Effect.fail(
      new ConfigError({
        message: `Cloud SQL user ${JSON.stringify(args.name)} has type "BUILT_IN" but no password was supplied. BUILT_IN users require a password — pass \`password: Redacted.make("...")\` or switch to an IAM type.`,
      }),
    );
  }
  return Effect.void;
};

/**
 * Reshape a `BadRequest` from a Cloud SQL Admin create/patch/delete
 * into a `ConfigError` with a remediation hint for the top failure
 * modes:
 *
 * 1. **Billing not enabled** — Cloud SQL refuses to provision against
 *    a project without billing. Common right after `ApiEnable` lands
 *    but before billing reconciles in a fresh project.
 * 2. **Private network not set up** — `privateNetwork` references a
 *    VPC that has no PSA peering for `servicenetworking.googleapis.com`.
 *    Surface the precondition.
 * 3. **Invalid tier** — typo'd `db-custom-…` or one outside the
 *    project's allow-list. Pass the underlying message through with
 *    a pointer to the tier catalogue.
 *
 * Anything else propagates verbatim — the underlying GCP message is
 * usually clear enough.
 *
 * @see https://cloud.google.com/sql/docs/postgres/instance-settings
 */
export const reshapeBadRequest =
  (kind: "Instance" | "Database" | "User", op: "insert" | "patch" | "update" | "delete") =>
  (e: { message?: string }): Effect.Effect<never, ConfigError> => {
    const underlying = e.message ?? `unknown 400 from ${kind} ${op}`;
    let hint = "";
    if (/billing/i.test(underlying)) {
      hint =
        " Cloud SQL requires billing to be enabled on the project. Attach a billing account (see `GCP.Project({ billingAccount })`) and retry.";
    } else if (/private.*service.*access|servicenetworking|peering/i.test(underlying)) {
      hint =
        " The host VPC needs a Private Services Access (PSA) peering with `servicenetworking.googleapis.com` before a private-IP Cloud SQL instance can attach. Provision a `GCP.GlobalAddress` (purpose=VPC_PEERING) and a `GCP.PsaConnection` on the VPC first.";
    } else if (/tier|machine.*type/i.test(underlying)) {
      hint =
        " Check the tier identifier against https://cloud.google.com/sql/docs/postgres/instance-settings — and remember that Enterprise Plus tiers (`db-perf-optimized-*`) require `edition: \"ENTERPRISE_PLUS\"`.";
    }
    return Effect.fail(
      new ConfigError({
        message: `Cloud SQL ${kind} ${op} rejected: ${underlying}.${hint}`,
      }),
    );
  };
