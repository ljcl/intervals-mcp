/**
 * Local-date helpers shared by tools that default a date range to "today" in
 * the athlete's configured time zone (`list-activities`, `get-wellness`).
 *
 * All functions work on plain `YYYY-MM-DD` strings, the shape every
 * intervals.icu date-window parameter expects, so a tool never has to carry
 * a `Date` object across its own boundary.
 */
import { z } from "zod";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

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

/**
 * Days from `oldest` to `newest` (both YYYY-MM-DD), in UTC-midnight math.
 * This is a *difference*, not a calendar-inclusive count: the same date both
 * ways is 0. Shared by every tool that caps a date-range input
 * (`list-activities`, `get-wellness`) so the max-range check has exactly one
 * home; see {@link validateRange} for the inclusive-count version those tools
 * actually want to enforce a cap.
 */
export function daysBetween(oldest: string, newest: string): number {
  const toUtcMs = (ymd: string) => {
    const [year, month, day] = ymd.split("-").map(Number);
    return Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  };
  return Math.round((toUtcMs(newest) - toUtcMs(oldest)) / 86_400_000);
}

/**
 * True when `ymd` is both `YYYY-MM-DD` shaped and a real calendar date.
 * `Date.UTC` silently rolls an out-of-range month/day forward (e.g.
 * 2026-02-30 becomes 2026-03-02 internally), so a regex-only shape check lets
 * a non-existent date through; this catches that by round-tripping the parsed
 * parts back through `Date.UTC` and checking nothing moved.
 */
export function isValidCalendarDate(ymd: string): boolean {
  if (!YMD_RE.test(ymd)) return false;
  const [year, month, day] = ymd.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Shared calendar-checked date-string schema for every tool date input
 * (`list-activities`' `oldest`/`newest`, `get-wellness`' `date`/`oldest`/`newest`):
 * `YYYY-MM-DD` shape, and a real calendar date (rejects `2026-02-30`). Each
 * call site chains its own `.optional()` and `.describe(...)`.
 */
export const dateInputSchema = z
  .string()
  .regex(YMD_RE, "must be a date in YYYY-MM-DD format")
  .refine(isValidCalendarDate, { message: "must be a real calendar date" });

/**
 * Validates an `oldest`/`newest` pair for a date-range tool input: `oldest`
 * must not be after `newest`, and the *calendar-inclusive* span (both
 * endpoints count, so the same date both ways is 1 day) must not exceed
 * `maxDays`. Returns `null` when the range is valid, or an error carrying the
 * athlete-facing message.
 *
 * Shared by `list-activities` (`maxDays` 366) and `get-wellness` (`maxDays`
 * 90) so the day-count math, and its "N days" wording, match in both tools.
 * `daysBetween` alone is a *difference*, not a count, and undercounts the
 * calendar span by one; comparing it directly against `maxDays` (the
 * previous behaviour) let a range one calendar day longer than advertised
 * through.
 */
export function validateRange(
  oldest: string,
  newest: string,
  maxDays: number,
): { message: string } | null {
  if (oldest > newest) {
    return {
      message: `oldest (${oldest}) is after newest (${newest}). Swap them or drop one to use its default.`,
    };
  }
  const days = daysBetween(oldest, newest) + 1;
  if (days > maxDays) {
    return {
      message: `${oldest} to ${newest} is ${days} days; the max range is ${maxDays} days. Narrow oldest/newest.`,
    };
  }
  return null;
}
