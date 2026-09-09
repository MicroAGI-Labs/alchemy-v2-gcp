import { ConfigError } from "@distilled.cloud/gcp";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as GCP from "../Providers.ts";

/** One additive consumer grant on an EXISTING shared reservation, including CUD reservations.
 * Never creates, resizes, deletes, or changes the sharing type of the reservation.
 * Existing grants are adopted without ownership: deleting this resource retains them.
 * Grants added by this resource are removed on deletion. If state is lost after an
 * add, recovery conservatively retains the grant rather than claiming ownership.
 * https://cloud.google.com/compute/docs/instances/reservations-modify
 */
export type ReservationShareProjectProps = {
  project: string;
  zone: string;
  reservation: string;
  /** Numeric consumer project number, required by the removal API. */
  consumerProjectNumber: string;
  /** Consumer project ID; responses may use this alias instead of its number. */
  consumerProjectId: string;
};
export type ReservationShareProjectAttributes = ReservationShareProjectProps & {
  reservationSelfLink: string;
  /** True only if this resource added the membership. */
  createdMembership: boolean;
};
export type ReservationShareProject = Resource<"GCP.ReservationShareProject", ReservationShareProjectProps, ReservationShareProjectAttributes, never, GCP.Providers>;
export const ReservationShareProject = Resource<ReservationShareProject>("GCP.ReservationShareProject");

const identityKeys = ["project", "zone", "reservation", "consumerProjectNumber", "consumerProjectId"] as const;
// Recovery can retain attributes without props, or retain props alongside sparse
// attributes. A populated observed identity always wins over the old declaration.
const priorIdentity = (olds?: Partial<ReservationShareProjectProps>, output?: Partial<ReservationShareProjectAttributes>) => ({
  project: output?.project || olds?.project,
  zone: output?.zone || olds?.zone,
  reservation: output?.reservation || olds?.reservation,
  consumerProjectNumber: output?.consumerProjectNumber || olds?.consumerProjectNumber,
  consumerProjectId: output?.consumerProjectId || olds?.consumerProjectId,
});
const completeIdentity = (props: ReturnType<typeof priorIdentity>): props is ReservationShareProjectProps =>
  identityKeys.every((key) => !!props[key]);

type Api = {
  get: Effect.Success<typeof compute.getReservations>;
  update: Effect.Success<typeof compute.updateReservations>;
  getOperation: Effect.Success<typeof compute.getZoneOperations>;
};

export const reservationHasConsumer = (reservation: compute.Reservation, consumer: Pick<ReservationShareProjectProps, "consumerProjectNumber" | "consumerProjectId">) => {
  const aliases = [consumer.consumerProjectNumber, consumer.consumerProjectId];
  return reservation.shareSettings?.shareType === "SPECIFIC_PROJECTS" &&
    Object.entries(reservation.shareSettings.projectMap ?? {}).some(([key, entry]) =>
      entry !== undefined && (aliases.includes(key) || (entry.projectId !== undefined && aliases.includes(entry.projectId))));
};

/** Exported for isolated lifecycle tests; production uses the same handlers. */
export const reservationShareProjectLifecycle = (api: Api): Provider.ProviderServiceInput<ReservationShareProject> => {
  const observe = (props: ReservationShareProjectProps) => api.get({
    project: props.project, zone: props.zone, reservation: props.reservation,
  }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  const attrs = (props: ReservationShareProjectProps, createdMembership: boolean): ReservationShareProjectAttributes => ({
    ...props, createdMembership,
    reservationSelfLink: `https://www.googleapis.com/compute/v1/projects/${props.project}/zones/${props.zone}/reservations/${props.reservation}`,
  });
  const validate = (props: ReservationShareProjectProps) => /^\d+$/.test(props.consumerProjectNumber)
    ? Effect.void : Effect.fail(new ConfigError({ message: "ReservationShareProject.consumerProjectNumber must be a numeric project number" }));
  const change = Effect.fn(function* (props: ReservationShareProjectProps, add: boolean) {
    yield* validate(props);
    const number = props.consumerProjectNumber;
    const op = yield* api.update({
      project: props.project, zone: props.zone, reservation: props.reservation,
      // A field-level PATCH preserves other grants, including concurrent additions.
      paths: [`shareSettings.projectMap.${number}`],
      body: { name: props.reservation, ...(add ? {
        shareSettings: { projectMap: { [number]: { projectId: number } } },
      } : {}) },
    });
    if (!op.name && op.status !== "DONE") return yield* new ConfigError({ message: "Reservation sharing update returned no operation name" });
    const completed = op.status === "DONE" ? op : yield* api.getOperation({
      project: props.project, zone: props.zone, operation: op.name!,
    }).pipe(
      Effect.flatMap((current) => current.status === "DONE" ? Effect.succeed(current) : Effect.fail({ _tag: "OperationPending" as const })),
      Effect.retry({ while: (error: { _tag?: string }) => error._tag === "OperationPending", schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(300)]) }),
    );
    if (completed.error) return yield* new ConfigError({ message: `Reservation sharing update failed: ${JSON.stringify(completed.error)}` });
  });
  return {
    nuke: { skip: true }, list: () => Effect.succeed([]),
    stables: ["project", "zone", "reservation", "consumerProjectNumber", "consumerProjectId", "reservationSelfLink"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      yield* validate(news);
      const prior = priorIdentity(olds, output);
      if (identityKeys.some((key) => prior[key] && prior[key] !== news[key])) return { action: "replace" } as const;
      if (!output) return undefined;
      const observed = yield* observe(news);
      return observed && reservationHasConsumer(observed, news) ? undefined : { action: "update" } as const;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      yield* validate(news);
      const observed = yield* observe(news);
      if (!observed) return yield* new ConfigError({ message: `Existing reservation ${news.project}/${news.zone}/${news.reservation} was not found` });
      if (observed.shareSettings?.shareType !== "SPECIFIC_PROJECTS") return yield* new ConfigError({ message: "ReservationShareProject requires an existing SPECIFIC_PROJECTS reservation; it never changes the reservation share type" });
      const present = reservationHasConsumer(observed, news);
      if (!present) {
        yield* change(news, true);
        const final = yield* observe(news);
        if (!final || !reservationHasConsumer(final, news)) return yield* new ConfigError({ message: "Reservation sharing operation completed without the requested consumer grant" });
      }
      return attrs(news, output?.createdMembership === true || !present);
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const props = priorIdentity(olds, output);
      if (!completeIdentity(props)) return undefined;
      yield* validate(props);
      const observed = yield* observe(props);
      if (!observed || !reservationHasConsumer(observed, props)) return undefined;
      // No metadata exists on a single projectMap entry. Unknown ownership is
      // deliberately non-destructive, including state-loss recovery/adoption.
      return attrs(props, output?.createdMembership ?? false);
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      if (output?.createdMembership !== true) return;
      const props = priorIdentity(olds, output);
      if (!completeIdentity(props)) return;
      yield* validate(props);
      const observed = yield* observe(props);
      if (observed && reservationHasConsumer(observed, props)) yield* change(props, false);
    }),
  };
};

export const ReservationShareProjectProvider = () => Provider.effect(ReservationShareProject, Effect.gen(function* () {
  return reservationShareProjectLifecycle({
    get: yield* compute.getReservations,
    update: yield* compute.updateReservations,
    getOperation: yield* compute.getZoneOperations,
  });
}));
