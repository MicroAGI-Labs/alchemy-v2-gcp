import * as sql from "@distilled.cloud/gcp/sqladmin-v1";
import { Resource } from "alchemy";
import { isResolved, somePropsAreDifferent } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type * as GCP from "../Providers.ts";
import { makeAwaitOperation } from "./Operations.ts";
import { isIamUserType, type SqlUserType } from "./Types.ts";
import { reshapeBadRequest, validateUser } from "./Validation.ts";

/**
 * A Cloud SQL user (database role + auth binding).
 *
 * **Three auth modes:**
 *
 * - `BUILT_IN` — classic Postgres username/password. Requires
 *   `password`. The role exists only inside Postgres.
 * - `CLOUD_IAM_USER` — a human IAM principal. `name` is the user's
 *   email. Authenticates via the Cloud SQL Auth Proxy / IAM token
 *   exchange; no password.
 * - `CLOUD_IAM_SERVICE_ACCOUNT` — a GCP service account principal.
 *   `name` is the SA email with the trailing `.gserviceaccount.com`
 *   stripped (Postgres role names cap at 63 chars; full SA emails
 *   often exceed that). No password.
 *
 * The Postgres role itself is granted no privileges by default — wire
 * up grants via SQL (psql / migrations) once the user exists. Cloud
 * SQL IAM authn is independent of grant management.
 *
 * **Adoption.** Users carry no labels and no useful comparable shape
 * beyond `(name, host, type)`. `read` returns the observed user if it
 * exists at this address, `undefined` otherwise. No `Unowned` wrapper
 * — adoption is implicit; the worst case is alchemy issuing a no-op
 * patch / a delete on what it thinks is its own.
 *
 * **Replace triggers.** `project`, `instance`, `name`, `host`, `type`.
 * Type changes need a drop/recreate because Cloud SQL stores the auth
 * shape immutably; we surface that via replace.
 *
 * @example IAM service-account user (workload identity → DB role)
 * ```typescript
 * yield* GCP.SqlUser("AppSaUser", {
 *   project: instance.project,
 *   instance: instance.name,
 *   // App SA email is `app@my-project.iam.gserviceaccount.com` — strip
 *   // `.gserviceaccount.com` so the Postgres role name fits in 63 chars.
 *   name: "app@my-project.iam",
 *   type: "CLOUD_IAM_SERVICE_ACCOUNT",
 * });
 * ```
 *
 * @example Built-in user with a Redacted password
 * ```typescript
 * yield* GCP.SqlUser("MigratorUser", {
 *   project: instance.project,
 *   instance: instance.name,
 *   name: "migrator",
 *   password: Redacted.make(process.env.MIGRATOR_PASSWORD!),
 * });
 * ```
 *
 * @see https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/users
 * @see https://cloud.google.com/sql/docs/postgres/iam-authentication
 */
export type SqlUserProps = {
  /**
   * GCP project ID hosting the parent instance. Immutable — replace.
   * @see https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/users#User
   */
  project: string;
  /**
   * Parent Cloud SQL instance name. Immutable — replace.
   */
  instance: string;
  /**
   * User/role name. For `BUILT_IN`, any valid Postgres identifier.
   * For `CLOUD_IAM_USER`, the principal's email. For
   * `CLOUD_IAM_SERVICE_ACCOUNT`, the SA email **with the trailing
   * `.gserviceaccount.com` stripped** — Postgres role names cap at
   * 63 chars; full SA emails are typically 70+. Immutable — replace.
   */
  name: string;
  /**
   * Host the user can connect from. PostgreSQL ignores this and
   * defaults to `%` (any host). For MySQL it's load-bearing.
   * Immutable — replace.
   */
  host?: string;
  /**
   * Auth backend. Defaults to `BUILT_IN` if unset.
   * @see https://cloud.google.com/sql/docs/postgres/iam-authentication
   */
  type?: SqlUserType;
  /**
   * Password for `BUILT_IN` users. Required for that type; forbidden
   * for any IAM type (validated at plan time).
   */
  password?: Redacted.Redacted<string>;
};

export type SqlUserAttributes = {
  /** User name. */
  name: string;
  /** Parent instance name. */
  instance: string;
  /** Project ID. */
  project: string;
  /** Connecting host (defaults to `%` for Postgres). */
  host: string;
  /** Auth backend in effect. */
  type: string;
};

export type SqlUser = Resource<
  "GCP.SqlUser",
  SqlUserProps,
  SqlUserAttributes,
  never,
  GCP.Providers
>;
export const SqlUser = Resource<SqlUser>("GCP.SqlUser");

const toAttributes = (
  u: sql.User,
  parent: { project: string; instance: string; name: string; host: string },
): SqlUserAttributes => ({
  name: parent.name,
  instance: parent.instance,
  project: parent.project,
  host: u.host ?? parent.host,
  type: u.type ?? "BUILT_IN",
});

export const SqlUserProvider = () =>
  Provider.effect(
    SqlUser,
    Effect.gen(function* () {
      const getUsers = yield* sql.getUsers;
      const listUsers = yield* sql.listUsers;
      const insertUsers = yield* sql.insertUsers;
      const updateUsers = yield* sql.updateUsers;
      const deleteUsers = yield* sql.deleteUsers;
      const getOperations = yield* sql.getOperations;
      const awaitOperation = makeAwaitOperation(getOperations);

      /**
       * Observe a user. Cloud SQL's `getUsers` endpoint returns 404
       * for IAM-typed users in some Postgres minor versions — those
       * are listable but not directly addressable by `name`. Fall
       * back to a list filter on 404 to be safe.
       */
      const observe = (
        project: string,
        instance: string,
        name: string,
        host: string | undefined,
      ) =>
        getUsers({
          project,
          instance,
          name,
          ...(host ? { host } : {}),
        }).pipe(
          Effect.catchTag("NotFound", () =>
            listUsers({ project, instance }).pipe(
              Effect.map((res) =>
                (res.items ?? []).find(
                  (u) => u.name === name && (host ? u.host === host : true),
                ),
              ),
              Effect.catchTag("NotFound", () =>
                Effect.succeed(undefined as sql.User | undefined),
              ),
              Effect.catchTag("Forbidden", () =>
                Effect.succeed(undefined as sql.User | undefined),
              ),
            ),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as sql.User | undefined),
          ),
        );

      return {
        stables: ["name", "instance", "project", "host", "type"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as SqlUserProps, news, [
              "project",
              "instance",
              "name",
              "host",
              "type",
            ])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const desiredType = news.type ?? "BUILT_IN";
          const desiredHost = news.host ?? "%";

          yield* validateUser({
            name: news.name,
            type: desiredType,
            hasPassword: news.password !== undefined,
          });

          let observed = yield* observe(
            news.project,
            news.instance,
            news.name,
            news.host,
          );

          if (!observed) {
            const body: sql.User = {
              name: news.name,
              ...(news.host !== undefined ? { host: news.host } : {}),
              type: desiredType,
              ...(news.password
                ? { password: Redacted.value(news.password) }
                : {}),
            };
            const op = yield* insertUsers({
              project: news.project,
              instance: news.instance,
              body,
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as sql.Operation | undefined),
              ),
              Effect.catchTag(
                "BadRequest",
                reshapeBadRequest("User", "insert"),
              ),
            );
            if (op?.name) yield* awaitOperation(news.project, op.name, session);
            observed = yield* observe(
              news.project,
              news.instance,
              news.name,
              news.host,
            );
          } else if (
            // Only BUILT_IN users have a rotatable password. For IAM
            // users the type is fixed at insert and there's nothing
            // mutable to sync. We don't store/compare BUILT_IN
            // passwords (they're write-only on the API side) — if the
            // user explicitly supplies one we re-issue the update so
            // a rotated `Redacted` propagates, but we can't detect
            // drift here so this is a deliberate "user is source of
            // truth" path.
            !isIamUserType(desiredType) &&
            news.password
          ) {
            const op = yield* updateUsers({
              project: news.project,
              instance: news.instance,
              name: news.name,
              ...(news.host !== undefined ? { host: news.host } : {}),
              body: {
                name: news.name,
                ...(news.host !== undefined ? { host: news.host } : {}),
                type: desiredType,
                password: Redacted.value(news.password),
              },
            }).pipe(
              Effect.catchTag(
                "BadRequest",
                reshapeBadRequest("User", "update"),
              ),
            );
            if (op.name) yield* awaitOperation(news.project, op.name, session);
          }

          // observed is non-undefined here: either we just created it
          // and re-observed, or we found it pre-existing. If somehow
          // listUsers still returns nothing (eventual consistency
          // window), synthesise a minimal attribute set from inputs.
          if (!observed) {
            return {
              name: news.name,
              instance: news.instance,
              project: news.project,
              host: desiredHost,
              type: desiredType,
            } satisfies SqlUserAttributes;
          }
          return toAttributes(observed, {
            project: news.project,
            instance: news.instance,
            name: news.name,
            host: desiredHost,
          });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* deleteUsers({
            project: output.project,
            instance: output.instance,
            name: output.name,
            ...(output.host && output.host !== "%" ? { host: output.host } : {}),
          }).pipe(
            Effect.flatMap((op) =>
              op.name
                ? awaitOperation(output.project, op.name, session)
                : Effect.succeed(op),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.catchTag("BadRequest", reshapeBadRequest("User", "delete")),
          );
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const project = output?.project ?? olds?.project;
          const instance = output?.instance ?? olds?.instance;
          const name = output?.name ?? olds?.name;
          if (!project || !instance || !name) return undefined;
          const host = output?.host ?? olds?.host;
          const observed = yield* observe(project, instance, name, host);
          if (!observed) return undefined;
          return toAttributes(observed, {
            project,
            instance,
            name,
            host: host ?? "%",
          });
        }),
      };
    }),
  );
