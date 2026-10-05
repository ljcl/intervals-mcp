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
