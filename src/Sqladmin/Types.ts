/**
 * Branded literal-union types for Cloud SQL props.
 *
 * Distilled's generated `databaseVersion` field is an open-tailed union
 * (`"POSTGRES_15" | … | (string & {})`) so the GCP server can ship new
 * versions without breaking SDK consumers. For our props we narrow to
 * the subset we actually support — at the moment, the supported
 * Postgres versions for greenfield instances. This gives consumers
 * compile-time autocomplete and rejects typos like `"POSTGES_15"`.
 *
 * MySQL / SQL Server enum members are intentionally omitted — we only
 * provision Postgres. Add a sibling `MySqlVersion` / `SqlServerVersion`
 * type if/when those land as targets.
 */

/**
 * Supported Postgres major versions for new Cloud SQL instances.
 *
 * Cloud SQL only allows creating instances on currently-supported
 * majors. As of 2026-06, that's 13–17 for greenfield; we expose 15+
 * since that's what new MicroAGI stacks target. Older versions can be
 * read/managed but should be migrated.
 *
 * @see https://cloud.google.com/sql/docs/postgres/db-versions
 */
export type PostgresVersion = "POSTGRES_15" | "POSTGRES_16" | "POSTGRES_17";

/**
 * Cloud SQL edition. `ENTERPRISE_PLUS` unlocks Data Cache, near-zero
 * downtime planned maintenance, and longer log retention; `ENTERPRISE`
 * is the standard tier.
 *
 * @see https://cloud.google.com/sql/docs/postgres/editions-intro
 */
export type SqlEdition = "ENTERPRISE" | "ENTERPRISE_PLUS";

/**
 * Data-disk type. PD_SSD is the default and what any new workload
 * should pick. PD_HDD is legacy and slower; only useful for archival
 * read replicas.
 *
 * @see https://cloud.google.com/sql/docs/postgres/instance-settings#storage-type-2ndgen
 */
export type SqlDataDiskType = "PD_SSD" | "PD_HDD";

/**
 * Availability type. `ZONAL` runs in one zone; `REGIONAL` runs a
 * standby in a second zone for HA at ~2× the cost.
 *
 * @see https://cloud.google.com/sql/docs/postgres/high-availability
 */
export type SqlAvailabilityType = "ZONAL" | "REGIONAL";

/**
 * Activation policy. `ALWAYS` keeps the instance on; `NEVER` parks
 * it (useful for occasional dev databases).
 *
 * @see https://cloud.google.com/sql/docs/postgres/start-stop-restart-instance
 */
export type SqlActivationPolicy = "ALWAYS" | "NEVER";

/**
 * Cloud SQL user auth type.
 *
 * - `BUILT_IN` — classic username + password Postgres role. The
 *   provider requires a `password` Redacted for this type.
 * - `CLOUD_IAM_USER` — a human IAM principal authenticated via the
 *   Cloud SQL Auth Proxy / IAM database authn token exchange.
 * - `CLOUD_IAM_SERVICE_ACCOUNT` — a GCP service-account principal,
 *   same auth mechanism as `CLOUD_IAM_USER`. The Postgres role name
 *   is the SA email **with the trailing `.gserviceaccount.com`
 *   stripped** (Cloud SQL caps role names at 63 chars; SA emails are
 *   longer than that).
 * - Open tail `(string & {})` keeps forward compatibility for
 *   `CLOUD_IAM_GROUP`, `CLOUD_IAM_GROUP_SERVICE_ACCOUNT`, etc.
 *
 * @see https://cloud.google.com/sql/docs/postgres/iam-authentication
 */
export type SqlUserType =
  | "BUILT_IN"
  | "CLOUD_IAM_USER"
  | "CLOUD_IAM_SERVICE_ACCOUNT"
  | "CLOUD_IAM_GROUP"
  | (string & {});

/**
 * Convenience predicate: `true` for any IAM-backed user type, where
 * passwords are forbidden and the principal is a GCP identity.
 *
 * Used by `Validation.ts` and `User.ts` to fan out between the
 * built-in password path and the IAM token-exchange path.
 */
export const isIamUserType = (
  type: SqlUserType | undefined,
): boolean =>
  type === "CLOUD_IAM_USER" ||
  type === "CLOUD_IAM_SERVICE_ACCOUNT" ||
  type === "CLOUD_IAM_GROUP" ||
  type === "CLOUD_IAM_GROUP_USER" ||
  type === "CLOUD_IAM_GROUP_SERVICE_ACCOUNT" ||
  type === "ENTRAID_USER";
