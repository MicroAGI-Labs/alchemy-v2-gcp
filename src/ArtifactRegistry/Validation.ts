import { ConfigError } from "@distilled.cloud/gcp";
import * as Effect from "effect/Effect";
import type { ArtifactRegistryRepositoryProps } from "./Repository.ts";

/**
 * Plan-time validation for Artifact Registry resource props. Failing
 * fast with a typed `ConfigError` is friendlier than letting the user
 * wait for the API to reject the request, and unlike server-side
 * errors these surface before any state mutation happens.
 *
 * @see https://cloud.google.com/artifact-registry/docs/reference/rest/v1/projects.locations.repositories
 */

/**
 * Repository ID regex per
 * <https://cloud.google.com/artifact-registry/docs/repositories/create-repos#create>:
 * lowercase letters, digits and hyphens; must start with a letter or
 * digit; 1–63 chars total. The REST API documents up to 63; we cap at
 * 63 to match.
 *
 * @internal
 */
const REPOSITORY_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Validate an Artifact Registry repository ID.
 *
 * @see https://cloud.google.com/artifact-registry/docs/repositories/create-repos#create
 */
export const validateRepositoryName = (
  name: string,
): Effect.Effect<void, ConfigError> => {
  if (REPOSITORY_NAME_RE.test(name)) return Effect.void;
  return Effect.fail(
    new ConfigError({
      message: `Artifact Registry repository name ${JSON.stringify(name)} is invalid: must match /^[a-z0-9][a-z0-9-]{0,62}$/ (1–63 lowercase letters/digits/hyphens, starting with a letter or digit).`,
    }),
  );
};

/**
 * Validate the `mode` ↔ `remoteRepositoryConfig` invariant. Artifact
 * Registry rejects (with an opaque 400) any combination where:
 *
 * - `mode === "REMOTE_REPOSITORY"` but no `remoteRepositoryConfig`
 *   is supplied — the server has no upstream to point at.
 * - `mode === "STANDARD_REPOSITORY"` but a `remoteRepositoryConfig`
 *   IS supplied — standard repositories don't have an upstream.
 *
 * `VIRTUAL_REPOSITORY` is not validated here; pass-through for now.
 *
 * @see https://cloud.google.com/artifact-registry/docs/repositories/remote-repo
 */
export const validateModeConfig = (
  props: ArtifactRegistryRepositoryProps,
): Effect.Effect<void, ConfigError> => {
  const mode = props.mode ?? "STANDARD_REPOSITORY";
  if (mode === "REMOTE_REPOSITORY") {
    const docker = props.remoteRepositoryConfig?.dockerRepository;
    if (!docker) {
      return Effect.fail(
        new ConfigError({
          message: `Artifact Registry repository has mode "REMOTE_REPOSITORY" but no \`remoteRepositoryConfig.dockerRepository\` was provided. Pass either \`{ publicRepository: "DOCKER_HUB" }\` or \`{ customRepository: { uri: "https://nvcr.io" } }\`.`,
        }),
      );
    }
    return Effect.void;
  }
  if (mode === "STANDARD_REPOSITORY" && props.remoteRepositoryConfig) {
    return Effect.fail(
      new ConfigError({
        message: `Artifact Registry repository has mode "STANDARD_REPOSITORY" but \`remoteRepositoryConfig\` was supplied. Drop \`remoteRepositoryConfig\` or set \`mode: "REMOTE_REPOSITORY"\`.`,
      }),
    );
  }
  return Effect.void;
};

/**
 * Reshape a `BadRequest` from an Artifact Registry create/patch/delete
 * into a `ConfigError` with a remediation hint for the top failure
 * modes:
 *
 * 1. **Upstream validation failure** — `disableUpstreamValidation` is
 *    `false` (default) and AR's pre-flight HEAD request against the
 *    remote upstream failed. Surface the underlying message; the user
 *    can retry with `disableUpstreamValidation: true` if the upstream
 *    is intentionally gated.
 * 2. **KMS key not accessible** — the AR service agent does not have
 *    `cloudkms.cryptoKeyEncrypterDecrypter` on the supplied key.
 *
 * Anything else propagates verbatim — the underlying GCP message is
 * usually clear enough.
 */
export const reshapeBadRequest =
  (op: "create" | "patch" | "delete") =>
  (e: { message?: string }): Effect.Effect<never, ConfigError> => {
    const underlying = e.message ?? `unknown 400 from Repository ${op}`;
    let hint = "";
    if (/upstream|remote.*validation|HEAD/i.test(underlying)) {
      hint =
        " Artifact Registry validates the upstream remote on create. If the upstream rejects unauthenticated HEAD requests (private nvcr.io paths, etc.), supply `remoteRepositoryConfig.disableUpstreamValidation: true` or attach credentials via `upstreamCredentials`.";
    } else if (/kms|crypto.*key|encrypt/i.test(underlying)) {
      hint =
        " Grant `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the supplied `kmsKeyName` to the Artifact Registry service agent (`service-{projectNumber}@gcp-sa-artifactregistry.iam.gserviceaccount.com`).";
    }
    return Effect.fail(
      new ConfigError({
        message: `Artifact Registry Repository ${op} rejected: ${underlying}.${hint}`,
      }),
    );
  };
