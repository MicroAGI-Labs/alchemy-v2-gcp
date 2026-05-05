import * as Effect from "effect/Effect";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";

/**
 * GCP labels are stricter than AWS tags:
 *
 * - **Keys** must match `[a-z][a-z0-9_-]{0,62}`. Alchemy's default
 *   `createInternalTags` returns keys like `alchemy::stack` — `:` is
 *   illegal in a GCP label key, so we use `_` separators here.
 * - **Values** must match `[a-z0-9_-]{0,63}`. We lowercase and replace
 *   any out-of-range character with `-`.
 *
 * The label values together with the keys are what `read` uses to
 * decide whether a project is owned by this stack/stage/id (returning
 * plain attrs) or foreign (returning `Unowned(attrs)`).
 *
 * @see {@link https://cloud.google.com/resource-manager/docs/creating-managing-labels#requirements}
 */

const LABEL_KEY_APP = "alchemy_app";
const LABEL_KEY_STAGE = "alchemy_stage";
const LABEL_KEY_ID = "alchemy_id";

const sanitizeLabelValue = (raw: string): string => {
  const lowered = raw.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9_-]/g, "-");
  return replaced.slice(0, 63);
};

/**
 * Compute the alchemy-internal label set for a Resource. Merge the
 * result with user-provided labels (user wins on key collision is
 * deliberately disallowed — alchemy keys are reserved).
 */
export const gcpInternalLabels = Effect.fnUntraced(function* (id: string) {
  const stack = yield* Stack;
  const stage = yield* Stage;
  return {
    [LABEL_KEY_APP]: sanitizeLabelValue(stack.name),
    [LABEL_KEY_STAGE]: sanitizeLabelValue(stage),
    [LABEL_KEY_ID]: sanitizeLabelValue(id),
  } satisfies Record<string, string>;
});

/**
 * True when `labels` contains all three alchemy-internal keys with
 * values matching this stack/stage/id. Used in `read` to decide
 * adoption ownership.
 */
export const hasAlchemyLabels = Effect.fnUntraced(function* (
  id: string,
  labels: Record<string, string> | undefined,
) {
  if (!labels) return false;
  const expected = yield* gcpInternalLabels(id);
  return (
    labels[LABEL_KEY_APP] === expected[LABEL_KEY_APP] &&
    labels[LABEL_KEY_STAGE] === expected[LABEL_KEY_STAGE] &&
    labels[LABEL_KEY_ID] === expected[LABEL_KEY_ID]
  );
});

export {
  LABEL_KEY_APP as ALCHEMY_LABEL_APP,
  LABEL_KEY_STAGE as ALCHEMY_LABEL_STAGE,
  LABEL_KEY_ID as ALCHEMY_LABEL_ID,
};
