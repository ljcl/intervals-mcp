/**
 * Reads the whole-body CTL/ATL/TSB series directly from intervals.icu
 * wellness. The one home both `get-fitness-trend`'s whole-body path and the
 * fitness-trend MCP App's data handler read through, so the two surfaces can
 * never build this series two different ways (see AGENTS.md's "derived
 * numbers have exactly one home").
 *
 * Unlike run-only (computed locally from activity load through
 * `buildFitnessTrend`'s recurrence), whole-body CTL/ATL is intervals.icu's
 * own number for the day: read `ctl`/`atl` straight off the wellness record,
 * never recomputed. That also means a custom CTL/ATL time-constant
 * configured on the intervals.icu account is honoured automatically, since
 * nothing here re-derives the 42/7-day recurrence for this path. A day with
 * no recorded `ctl`/`atl` is a gap, not a zero-load day, so it is left out of
 * the series rather than filled with a fabricated zero.
 */
import { type FitnessTrendDay, round1 } from "./fitnessTrend";
import { getWellness } from "./intervalsClient";
import { addDays } from "./utils/localDate";

/** Wellness fields needed: the read values plus the display load. */
export const FITNESS_TREND_WELLNESS_FIELDS = [
  "id",
  "ctl",
  "atl",
  "ctlLoad",
  "atlLoad",
];

export interface WellnessFitnessSeries {
  /**
   * One entry per day with a recorded `ctl`/`atl`, oldest first, read
   * directly from wellness (never recomputed).
   */
  series: FitnessTrendDay[];
  /**
   * Raw (unrounded) `ctl`/`atl` of the most recent available day, to seed a
   * projection or taper solve forward from. Null when the window has no
   * usable wellness data.
   */
  seed: { ctl: number; atl: number } | null;
  /**
   * Date of the row `seed` came from: the most recent day in range with a
   * recorded `ctl`/`atl`, which is not always the newest date requested (a
   * day's wellness can land after the day itself, or be missing entirely).
   * Null when there is none.
   */
  asOfDate: string | null;
  /** Calendar dates inside the range with no recorded `ctl`/`atl`, oldest first. */
  gapDates: string[];
}

/**
 * Fetches wellness across `range` and builds the read (never recomputed)
 * whole-body series, the seed for a forward projection/taper, and any gaps.
 */
export async function loadWellnessFitnessSeries(
  apiKey: string,
  range: { oldest: string; newest: string },
): Promise<WellnessFitnessSeries> {
  const wellness = await getWellness(apiKey, range, {
    fields: FITNESS_TREND_WELLNESS_FIELDS,
  });
  const byDate = new Map(
    wellness
      .filter((w) => w.ctl != null && w.atl != null)
      .map((w) => [w.id, w]),
  );

  const series: FitnessTrendDay[] = [];
  const gapDates: string[] = [];
  for (let date = range.oldest; date <= range.newest; date = addDays(date, 1)) {
    const w = byDate.get(date);
    if (!w) {
      gapDates.push(date);
      continue;
    }
    series.push({
      date,
      load: round1(w.atlLoad ?? 0),
      ctl: round1(w.ctl!),
      atl: round1(w.atl!),
      tsb: round1(w.ctl! - w.atl!),
    });
  }

  const lastDate = series[series.length - 1]?.date ?? null;
  const lastRow = lastDate ? byDate.get(lastDate)! : null;

  return {
    series,
    seed: lastRow ? { ctl: lastRow.ctl!, atl: lastRow.atl! } : null,
    asOfDate: lastDate,
    gapDates,
  };
}
