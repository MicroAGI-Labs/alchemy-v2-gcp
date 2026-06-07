/**
 * Branded literal-union types for Artifact Registry repository props.
 *
 * Distilled's generated `format` and `mode` fields are open-tailed
 * unions (`"DOCKER" | … | (string & {})`) so the GCP server can ship
 * new variants without breaking SDK consumers. We mirror that shape
 * here so consumers get autocomplete for the values we expect to use
 * while still leaving the tail open for forward compatibility.
 *
 * @see https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories#Repository
 */

/**
 * Repository package format. Artifact Registry supports many formats
 * (Maven, NPM, APT, …); we keep the full enum-tail open but only
 * exercise `DOCKER` in this provider today. Other formats are still
 * reachable via the `(string & {})` tail.
 *
 * @see https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories#Format
 */
export type ArtifactRegistryFormat =
  | "DOCKER"
  | "MAVEN"
  | "NPM"
  | "APT"
  | "YUM"
  | "GOOGET"
  | "PYTHON"
  | "KFP"
  | "GO"
  | "GENERIC"
  | "RUBY"
  | (string & {});

/**
 * Repository mode. `STANDARD_REPOSITORY` hosts artifacts uploaded by
 * the user; `REMOTE_REPOSITORY` is a pull-through cache for an
 * upstream registry; `VIRTUAL_REPOSITORY` aggregates multiple upstreams
 * behind one URL. The provider does not type-check `VIRTUAL_REPOSITORY`
 * config today — pass it through via the `remoteRepositoryConfig`
 * field with a mode override, or wait for explicit support.
 *
 * @see https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories#Mode
 */
export type ArtifactRegistryMode =
  | "STANDARD_REPOSITORY"
  | "REMOTE_REPOSITORY"
  | "VIRTUAL_REPOSITORY"
  | (string & {});
