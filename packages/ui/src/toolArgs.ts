/**
 * Readers for host tool arguments. A host passes the model's raw arguments,
 * and the server's aliases let those use old spellings (`activity_id`,
 * `activity_id_1`, `weeks`), so each app's `parseToolInput` reads them
 * tolerantly with these before anything else sees them.
 */

/** The raw arguments as a record; anything else reads as no arguments. */
export function toolArgRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * The first of `keys` holding a usable activity id, as a string (`"latest"`
 * included), or null when none does. A safe-integer number, which the server
 * accepts at runtime, becomes its digit string.
 */
export function toolArgId(
  args: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value;
    if (typeof value === "number" && Number.isSafeInteger(value))
      return String(value);
  }
  return null;
}

/**
 * Spellings of each activity-id input, the tool's own name first. They mirror
 * `ALIAS_GROUPS` in `apps/server/src/argAliases.ts`, the server's aliases, so
 * an app reads every spelling the server accepted from the model.
 */
export const ID_ARG_KEYS = ["id", "activity_id", "activityId"] as const;
export const ACTIVITY_ID1_ARG_KEYS = [
  "activityId1",
  "activity_id_1",
  "activity_id1",
  "activityId_1",
  "id1",
] as const;
export const ACTIVITY_ID2_ARG_KEYS = [
  "activityId2",
  "activity_id_2",
  "activity_id2",
  "activityId_2",
  "id2",
] as const;

/** The arguments of an app that takes one activity id. */
export interface IdToolArgs {
  id: string;
}

/**
 * `parseToolInput` for an app that takes one activity id: `{ id }` from any
 * of {@link ID_ARG_KEYS}, or null without one, so the root shows the
 * missing-id error.
 */
export function parseIdToolArgs(raw: unknown): IdToolArgs | null {
  const id = toolArgId(toolArgRecord(raw), ...ID_ARG_KEYS);
  return id === null ? null : { id };
}
