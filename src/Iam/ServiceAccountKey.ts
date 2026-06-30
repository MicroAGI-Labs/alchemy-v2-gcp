import { ConfigError } from "@distilled.cloud/gcp";
import * as iam from "@distilled.cloud/gcp/unstable/iam-v1";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import type * as GCP from "../Providers.ts";

/**
 * A user-managed service account key (JSON credentials file). Lives
 * under a {@link import("./ServiceAccount.ts").ServiceAccount} and
 * produces a `privateKeyData` field (base64-encoded JSON key file)
 * available ONLY on create — `get`/`list` never return it.
 *
 * The `privateKeyData` attribute is marked stable so the engine
 * preserves it across reconciles (it cannot be re-read from the API).
 * On cold recovery (state loss), if the key exists but
 * `privateKeyData` is absent from state, the old key is deleted and a
 * new one is created so the `privateKeyData` is re-obtained.
 *
 * SA keys carry no labels or description, so adoption cannot be gated
 * by marker — the SA itself is alchemy-owned, and the key is managed
 * exclusively through this resource.
 *
 * @section Creating a ServiceAccountKey
 * @example Mint a JSON key for a GSA
 * ```typescript
 * const key = yield* GCP.ServiceAccountKey("TempBucketKey", {
 *   serviceAccount: sa.name,  // projects/{p}/serviceAccounts/{email}
 * });
 * // key.privateKeyData is the base64-encoded JSON key file
 * ```
 */
export type ServiceAccountKeyProps = {
  /**
   * The resource name of the parent service account, in the format
   * `projects/{PROJECT_ID}/serviceAccounts/{EMAIL_ADDRESS}`.
   * Immutable — changing it triggers a replacement (the key is
   * scoped to the SA).
   */
  serviceAccount: string;
  /**
   * Key algorithm. Defaults to `KEY_ALG_RSA_2048`. Immutable after
   * create.
   */
  keyAlgorithm?: "KEY_ALG_RSA_2048" | "KEY_ALG_RSA_1024";
  /**
   * Output format for the private key. Defaults to
   * `TYPE_GOOGLE_CREDENTIALS_FILE` (the Google Credentials JSON
   * format usable by gcloud, gsutil, and the gcsfuse CSI driver).
   */
  privateKeyType?: "TYPE_GOOGLE_CREDENTIALS_FILE" | "TYPE_PKCS12_FILE";
};

export type ServiceAccountKey = Resource<
  "GCP.ServiceAccountKey",
  ServiceAccountKeyProps,
  {
    /** Full resource name: `projects/{p}/serviceAccounts/{email}/keys/{keyId}`. */
    name: string;
    /**
     * Base64-encoded private key data (JSON key file). Only available
     * on create — not returned by `get`/`list`. Preserved in alchemy
     * state; on state loss the old key is deleted + a new one is
     * created to re-obtain it.
     */
    privateKeyData: string | undefined;
    /** Key algorithm used. */
    keyAlgorithm: string | undefined;
    /** Key type: `USER_MANAGED` or `SYSTEM_MANAGED`. */
    keyType: string | undefined;
    /** Key origin: `USER_PROVIDED` or `GOOGLE_PROVIDED`. */
    keyOrigin: string | undefined;
    /** Timestamp after which the key is valid (RFC 3339). */
    validAfterTime: string | undefined;
    /** Whether the key is disabled. */
    disabled: boolean | undefined;
  },
  never,
  GCP.Providers
>;

export const ServiceAccountKey = Resource<ServiceAccountKey>(
  "GCP.ServiceAccountKey",
);

const toAttributes = (k: iam.ServiceAccountKey): ServiceAccountKey["Attributes"] => ({
  name: k.name ?? "",
  privateKeyData: k.privateKeyData,
  keyAlgorithm: k.keyAlgorithm,
  keyType: k.keyType,
  keyOrigin: k.keyOrigin,
  validAfterTime: k.validAfterTime,
  disabled: k.disabled,
});

export const ServiceAccountKeyProvider = () =>
  Provider.effect(
    ServiceAccountKey,
    Effect.gen(function* () {
      const createProjectsServiceAccountsKeys =
        yield* iam.createProjectsServiceAccountsKeys;
      const deleteProjectsServiceAccountsKeys =
        yield* iam.deleteProjectsServiceAccountsKeys;
      const listProjectsServiceAccountsKeys =
        yield* iam.listProjectsServiceAccountsKeys;
      const getProjectsServiceAccountsKeys =
        yield* iam.getProjectsServiceAccountsKeys;

      // Find a user-managed key by name (direct probe).
      const observeKey = (keyName: string) =>
        getProjectsServiceAccountsKeys({
          name: keyName,
          publicKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE",
        }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as iam.ServiceAccountKey | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as iam.ServiceAccountKey | undefined),
          ),
        );

      // List all user-managed keys for the SA. Used for cold recovery
      // when the key name is not in state. Returns the first
      // user-managed key found (the SA is dedicated to this resource,
      // so there should be at most one user-managed key).
      const findUserManagedKey = Effect.fn(function* (
        serviceAccount: string,
      ) {
        const page = yield* listProjectsServiceAccountsKeys({
          name: serviceAccount,
          keyTypes: "USER_MANAGED",
        });
        const keys = page.keys ?? [];
        if (keys.length === 0) return undefined;
        // If there's exactly one user-managed key, adopt it.
        // If there are multiple, we can't determine which is ours —
        // return undefined so the engine plans a create (which will
        // Conflict, and the user must manually clean up).
        if (keys.length === 1) return keys[0];
        return undefined;
      });

      return {
        // privateKeyData is stable: it's set on create and never
        // changes. The engine preserves it across reconciles and
        // does not use it for drift detection.
        stables: ["name", "privateKeyData", "keyAlgorithm", "keyType"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const priorSa = olds.serviceAccount as string | undefined;
          if (priorSa && news.serviceAccount !== priorSa) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          // 1. Observe — check if the key exists by name (from
          //    state output). Fall back to listing user-managed
          //    keys for cold recovery.
          const keyName = output?.name;
          let observed: iam.ServiceAccountKey | undefined;

          if (keyName) {
            observed = yield* observeKey(keyName);
          }
          if (!observed) {
            observed = yield* findUserManagedKey(news.serviceAccount);
          }

          // 2. Ensure — create if missing. If the key exists but
          //    privateKeyData is not in state (state loss), delete
          //    the old key and create a new one so privateKeyData is
          //    re-obtained.
          if (!observed) {
            const created = yield* createProjectsServiceAccountsKeys({
              name: news.serviceAccount,
              body: {
                privateKeyType:
                  news.privateKeyType ?? "TYPE_GOOGLE_CREDENTIALS_FILE",
                keyAlgorithm: news.keyAlgorithm ?? "KEY_ALG_RSA_2048",
              },
            });
            return toAttributes(created);
          }

          // Key exists. If it is the same key we created before, preserve
          // privateKeyData from state. If the name differs, the key was
          // swapped out-of-band — fall through to delete + recreate so
          // privateKeyData matches the live key.
          if (output?.privateKeyData && observed.name === output.name) {
            return {
              ...toAttributes(observed),
              privateKeyData: output.privateKeyData,
            };
          }

          // Key exists but privateKeyData is missing from state (state
          // loss). Delete the old key and create a new one.
          yield* deleteProjectsServiceAccountsKeys({
            name: observed.name!,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));

          const created = yield* createProjectsServiceAccountsKeys({
            name: news.serviceAccount,
            body: {
              privateKeyType:
                news.privateKeyType ?? "TYPE_GOOGLE_CREDENTIALS_FILE",
              keyAlgorithm: news.keyAlgorithm ?? "KEY_ALG_RSA_2048",
            },
          });
          return toAttributes(created);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteProjectsServiceAccountsKeys({
            name: output.name,
          }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.catchTag("Forbidden", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const keyName = output?.name;
          const serviceAccount = olds.serviceAccount;

          let observed: iam.ServiceAccountKey | undefined;
          if (keyName) {
            observed = yield* observeKey(keyName);
          }
          if (!observed && serviceAccount) {
            observed = yield* findUserManagedKey(serviceAccount);
          }
          if (!observed) return undefined;

          // privateKeyData is not available from get/list — preserve it
          // from state output only when it still describes this key.
          const privateKeyData =
            output?.name && observed.name === output.name
              ? output.privateKeyData
              : undefined;

          return {
            ...toAttributes(observed),
            privateKeyData,
          };
        }),
      };
    }),
  );
