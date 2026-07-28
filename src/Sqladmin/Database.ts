import * as sql from "@distilled.cloud/gcp/sqladmin-v1";
import { Resource } from "alchemy";
import { isResolved, somePropsAreDifferent } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import type * as GCP from "../Providers.ts";
import { makeAwaitOperation } from "./Operations.ts";
import { reshapeBadRequest, validateDatabaseName } from "./Validation.ts";

/**
 * A logical Postgres database inside a Cloud SQL instance.
 *
 * Cloud SQL `databases` resources are extremely thin — name, charset,
 * collation, parent instance. Use this resource to declaratively
 * create a tenant database (one per app, one per team, etc.) and let
 * alchemy track its lifecycle.
 *
 * **Adoption.** Cloud SQL databases carry NO labels. There is no
 * server-side adoption marker we can stamp without polluting the
 * collation field, so `read` is best-effort: it returns the observed
 * shape if the database exists at the same logical address, and
 * `undefined` otherwise. The caller is responsible for `--adopt` if
 * they want to take over an existing physical database; we do not
 * gate on labels here.
 *
 * **Replace triggers.** `project`, `instance`, `name`. Charset and
 * collation are immutable post-create in practice — the API accepts
 * a `patch` but ignores collation/charset drift, so we treat them as
 * "set once, then forgotten" and only diff name/parent.
 *
 * @example
 * ```typescript
 * const db = yield* GCP.SqlDatabase("AppDb", {
 *   project: instance.project,
 *   instance: instance.name,
 *   name: "app",
 * });
 * ```
 *
 * @see https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/databases
 */
export type SqlDatabaseProps = {
  /**
   * GCP project ID hosting the parent instance. Immutable — replace.
   * @see https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/databases#Database
   */
  project: string;
  /**
   * Parent Cloud SQL instance name (NOT the fully-qualified resource
   * name; just the bare `name`). Immutable — replace.
   */
  instance: string;
  /**
   * Database name. 1–64 chars; Postgres-specific naming applies (no
   * reserved words, etc.). Immutable — replace if changed.
   */
  name: string;
  /**
   * Server-side character set. Postgres-default is `UTF8`. Set at
   * create; not honoured on patch.
   * @see https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/databases#Database.FIELDS.charset
   */
  charset?: string;
  /**
   * Collation. Postgres-default is `en_US.UTF8`. Set at create; not
   * honoured on patch.
   * @see https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/databases#Database.FIELDS.collation
   */
  collation?: string;
};

export type SqlDatabaseAttributes = {
  /** Database name. */
  name: string;
  /** Parent instance name. */
  instance: string;
  /** Project ID. */
  project: string;
  /** Server-defined URL. */
  selfLink: string;
  /** Effective charset (server may default to `UTF8`). */
  charset: string | undefined;
  /** Effective collation. */
  collation: string | undefined;
};

export type SqlDatabase = Resource<
  "GCP.SqlDatabase",
  SqlDatabaseProps,
  SqlDatabaseAttributes,
  never,
  GCP.Providers
>;
export const SqlDatabase = Resource<SqlDatabase>("GCP.SqlDatabase");

const toAttributes = (
  d: sql.Database,
  parent: { project: string; instance: string; name: string },
): SqlDatabaseAttributes => ({
  name: parent.name,
  instance: parent.instance,
  project: parent.project,
  selfLink: d.selfLink ?? "",
  charset: d.charset,
  collation: d.collation,
});

export const SqlDatabaseProvider = () =>
  Provider.effect(
    SqlDatabase,
    Effect.gen(function* () {
      const getDatabases = yield* sql.getDatabases;
      const insertDatabases = yield* sql.insertDatabases;
      const deleteDatabases = yield* sql.deleteDatabases;
      const getOperations = yield* sql.getOperations;
      const awaitOperation = makeAwaitOperation(getOperations);

      const observe = (project: string, instance: string, database: string) =>
        getDatabases({ project, instance, database }).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(undefined as sql.Database | undefined),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(undefined as sql.Database | undefined),
          ),
        );

      return {
        nuke: { skip: true },
        list: () => Effect.succeed([]),
        stables: ["name", "instance", "project", "selfLink"],
        diff: Effect.fn(function* ({ news, olds = {} }) {
          if (!isResolved(news)) return undefined;
          if (
            somePropsAreDifferent(olds as SqlDatabaseProps, news, [
              "project",
              "instance",
              "name",
            ])
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          yield* validateDatabaseName(news.name);

          let observed = yield* observe(news.project, news.instance, news.name);

          if (!observed) {
            const op = yield* insertDatabases({
              project: news.project,
              instance: news.instance,
              body: {
                name: news.name,
                ...(news.charset ? { charset: news.charset } : {}),
                ...(news.collation ? { collation: news.collation } : {}),
              },
            }).pipe(
              Effect.catchTag("Conflict", () =>
                Effect.succeed(undefined as sql.Operation | undefined),
              ),
              Effect.catchTag(
                "BadRequest",
                reshapeBadRequest("Database", "insert"),
              ),
            );
            if (op?.name) yield* awaitOperation(news.project, op.name, session);
            observed = yield* getDatabases({
              project: news.project,
              instance: news.instance,
              database: news.name,
            });
          }

          return toAttributes(observed, {
            project: news.project,
            instance: news.instance,
            name: news.name,
          });
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* deleteDatabases({
            project: output.project,
            instance: output.instance,
            database: output.name,
          }).pipe(
            Effect.flatMap((op) =>
              op.name
                ? awaitOperation(output.project, op.name, session)
                : Effect.succeed(op),
            ),
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.catchTag(
              "BadRequest",
              reshapeBadRequest("Database", "delete"),
            ),
          );
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const project = output?.project ?? olds?.project;
          const instance = output?.instance ?? olds?.instance;
          const name = output?.name ?? olds?.name;
          if (!project || !instance || !name) return undefined;
          const observed = yield* observe(project, instance, name);
          if (!observed) return undefined;
          return toAttributes(observed, { project, instance, name });
        }),
      };
    }),
  );
