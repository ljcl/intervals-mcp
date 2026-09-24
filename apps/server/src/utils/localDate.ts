/**
 * Local-date helpers shared by tools that default a date range to "today" in
 * the athlete's configured time zone (`list-activities`, `get-wellness`).
 *
 * Both functions work on plain `YYYY-MM-DD` strings, the shape every
 * intervals.icu date-window parameter expects, so a tool never has to carry
 * a `Date` object across its own boundary.
 */

/**
 * Today's date (`YYYY-MM-DD`) in `tz`. `now` is injectable so a test can pin
 * the clock instead of depending on the wall clock.
 *
 * `en-CA` is the one built-in locale whose default numeric date format is
 * already `YYYY-MM-DD`.
 */
export function todayLocal(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
}

/**
 * Adds `n` (possibly negative) whole days to a `YYYY-MM-DD` date, using
 * UTC-midnight math so the result never shifts with a local time zone's DST
 * transitions.
 */
export function addDays(ymd: string, n: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const shifted = new Date(
    Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + n),
  );
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
