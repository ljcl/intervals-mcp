/**
 * How the athlete's intervals.icu shows form (#512): the one home of that
 * read. The setting is `icu_form_as_percent` on the athlete's own record,
 * which `FetchClient` never caches (it carries the API key), so this module
 * keeps the one boolean for an hour: get-fitness-trend then costs one more
 * request per hour, not one per call. A change to the setting in
 * intervals.icu shows here within that hour.
 *
 * A failed read is not kept and is not hidden: it fails the call, as any
 * other intervals.icu read does.
 */
import { type FormDisplay } from "./fitnessTrend";
import { getAthleteFormAsPercent } from "./intervalsClient";

/** How long one read of the setting is used. */
export const FORM_DISPLAY_TTL_MS = 3_600_000;

let cached: { value: FormDisplay; at: number } | null = null;

/** `percent` when the athlete has "form as percent" on, else `absolute`. */
export async function loadFormDisplay(
  apiKey: string,
  now: () => number = Date.now,
): Promise<FormDisplay> {
  if (cached && now() - cached.at < FORM_DISPLAY_TTL_MS) return cached.value;
  const value: FormDisplay = (await getAthleteFormAsPercent(apiKey))
    ? "percent"
    : "absolute";
  cached = { value, at: now() };
  return value;
}

/** Forgets the kept value. For tests. */
export function resetFormDisplay(): void {
  cached = null;
}
