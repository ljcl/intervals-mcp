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
import { ctlAtlTsb, type FitnessTrendDay } from "./fitnessTrend";
import { round } from "./formatters";
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
  /**
   * Recorded days in the `lookbackDays` before `range.oldest`, oldest first:
   * prior days for the 7-day CTL change only, never part of `series`,
   * `seed` or `gapDates`. Empty when no lookback was asked for.
   */
  lookback: FitnessTrendDay[];
  /**
   * Rows after `range.newest` that intervals.icu already holds, oldest
   * first, when `futureDays` was asked for: its own projection from the
   * planned workouts on the calendar, read as given like `series`. A date
   * with no row is left out. Empty when no future was asked for.
   */
  planned: FitnessTrendDay[];
}

/**
 * Fetches wellness across `range` and builds the read (never recomputed)
 * whole-body series, the seed for a forward projection/taper, and any gaps.
 * `lookbackDays` widens the one request back that far for
 * {@link WellnessFitnessSeries.lookback}; `futureDays` widens it forward for
 * {@link WellnessFitnessSeries.planned}.
 */
export async function loadWellnessFitnessSeries(
  apiKey: string,
  range: { oldest: string; newest: string },
  options: { lookbackDays?: number; futureDays?: number } = {},
): Promise<WellnessFitnessSeries> {
  const lookbackStart = addDays(range.oldest, -(options.lookbackDays ?? 0));
  const wellness = await getWellness(
    apiKey,
    {
      oldest: lookbackStart,
      newest: addDays(range.newest, options.futureDays ?? 0),
    },
    { fields: FITNESS_TREND_WELLNESS_FIELDS },
  );
  const byDate = new Map(
    wellness
      .filter((w) => w.ctl != null && w.atl != null)
      .map((w) => [w.id, w]),
  );

  const dayOf = (date: string, w: (typeof wellness)[number]) => ({
    date,
    load: round(w.atlLoad ?? 0, 1),
    ...ctlAtlTsb(w.ctl!, w.atl!),
  });

  const lookback: FitnessTrendDay[] = [];
  const series: FitnessTrendDay[] = [];
  const gapDates: string[] = [];
  for (
    let date = lookbackStart;
    date <= range.newest;
    date = addDays(date, 1)
  ) {
    const inRange = date >= range.oldest;
    const w = byDate.get(date);
    if (!w) {
      if (inRange) gapDates.push(date);
      continue;
    }
    (inRange ? series : lookback).push(dayOf(date, w));
  }

  const planned: FitnessTrendDay[] = [];
  for (let i = 1; i <= (options.futureDays ?? 0); i++) {
    const date = addDays(range.newest, i);
    const w = byDate.get(date);
    if (w) planned.push(dayOf(date, w));
  }

  const lastDate = series[series.length - 1]?.date ?? null;
  const lastRow = lastDate ? byDate.get(lastDate)! : null;

  return {
    series,
    seed: lastRow ? { ctl: lastRow.ctl!, atl: lastRow.atl! } : null,
    asOfDate: lastDate,
    gapDates,
    lookback,
    planned,
  };
}
