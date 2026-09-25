/**
 * CTL/ATL/TSB fitness-trend math for `get-fitness-trend`. Pure, source-agnostic
 * functions over daily loads the caller supplies, unit-tested next to
 * `trainingLoad.ts`.
 *
 * The model is the classic performance-management chart: CTL ("fitness") is
 * an exponentially weighted average of daily load with a 42-day time
 * constant, ATL ("fatigue") the same with a 7-day constant, and
 * TSB ("form") = CTL − ATL. CTL and ATL read separate load series
 * (`ctlLoad`/`atlLoad`) so a caller can, for example, count strength work
 * toward fatigue only; reproducing intervals.icu's own wellness CTL/ATL
 * exactly requires exactly this split. Callers own how load is measured
 * (relative effort, TRIMP, or anything else) and how it maps to each series.
 */

/** One day's inputs to the CTL/ATL recurrence. */
export interface FitnessTrendLoadDay {
  /** ISO date (YYYY-MM-DD) the loads apply to. */
  date: string;
  /** Load feeding the 42-day CTL ("fitness") recurrence that day. */
  ctlLoad: number;
  /** Load feeding the 7-day ATL ("fatigue") recurrence that day. */
  atlLoad: number;
}

/** Starting CTL/ATL the first day of `days` applies its recurrence to. */
export interface FitnessTrendSeed {
  ctl: number;
  atl: number;
}

export interface FitnessTrendInput {
  /** Consecutive daily loads, oldest first; the last entry is the current day. */
  days: FitnessTrendLoadDay[];
  /** Seed CTL/ATL to roll forward from. Defaults to `{ ctl: 0, atl: 0 }`. */
  seed?: FitnessTrendSeed;
}

export interface FitnessTrendDay {
  /** ISO date (YYYY-MM-DD) the values were computed for. */
  date: string;
  /**
   * The day's load, for display (0 on rest days). For the recorded series
   * this is `atlLoad`, the fuller of the two input measures, since a
   * caller's ATL load is typically a superset of its CTL load (e.g. strength
   * counting toward fatigue only). For projected/planned/taper days the same
   * load is fed to both series, so the distinction does not apply.
   */
  load: number;
  ctl: number;
  atl: number;
  tsb: number;
}

/** A day of planned (not yet recorded) training load. */
export interface PlannedLoad {
  /** ISO date (YYYY-MM-DD) the load is planned for. */
  date: string;
  load: number;
}

/**
 * Planned load for the projection, either as loads for consecutive days
 * starting the day after `endDate`, or dated (gaps count as rest days).
 */
export type PlannedLoads = number[] | PlannedLoad[];

/** What the taper solver is asked to land on. */
export interface TaperRequest {
  /** The day to arrive at `targetTsb` on (YYYY-MM-DD, past endDate). */
  targetDate: string;
  /** TSB wanted on the target date (e.g. +10 for a race). */
  targetTsb: number;
  /**
   * Relative weekly load weights, first projected week first. Defaults to
   * `taperWeekWeights` (geometric step-down toward the target date).
   */
  weekWeights?: number[];
}

/** One week of the solved taper plan. */
export interface TaperWeek {
  /** 1-based week of the plan. */
  week: number;
  start_date: string;
  end_date: string;
  /** Days in this week — the last week is short when the plan is not a multiple of 7. */
  days: number;
  /** Load to average per day across the week. */
  daily_load: number;
  /** Total load for the week (daily_load × days). */
  week_load: number;
  /**
   * The week's load as a percentage of what the athlete has been averaging
   * (trailing 28 days), or null when there is no recent load to compare to.
   */
  pct_of_recent: number | null;
}

export interface TaperPlan {
  target_date: string;
  target_tsb: number;
  /** TSB the plan actually lands on — equals target_tsb unless clamped. */
  achieved_tsb: number;
  /** False when the target is out of reach; `note` says why. */
  feasible: boolean;
  note: string | null;
  weeks: TaperWeek[];
  /** Day-by-day CTL/ATL/TSB under the plan, for charting past today. */
  days: FitnessTrendDay[];
  /** Total planned load across the plan. */
  total_load: number;
  /** Average daily load over the trailing 28 days, the pct_of_recent basis. */
  recent_daily_load: number;
}

export interface FitnessTrendOptions {
  /** Project this many days past the last input day (zero load unless plannedLoads says otherwise). */
  projectDays?: number;
  /**
   * Load to project with instead of rest. `projectDays` defaults to its
   * length, and days it does not cover project as rest.
   */
  plannedLoads?: PlannedLoads;
  /** Solve a load taper landing on a target TSB. */
  taper?: TaperRequest;
}

export interface FitnessTrendResult {
  days: FitnessTrendDay[];
  /** The endDate row, for headline values. Null only for an empty window. */
  current: FitnessTrendDay | null;
  /** Decay projection past endDate (zero load by default); empty when not requested. */
  projection: FitnessTrendDay[];
  /**
   * First projected date on which TSB crosses ≥ 0, or null if it never does
   * within the projection (or no projection was requested).
   */
  tsbPositiveDate: string | null;
  /** Solved taper plan when `taper` was requested, else null. */
  taper: TaperPlan | null;
  /** Dated stretches worth annotating on a chart. */
  bands: TrendBand[];
  flags: string[];
}

/** CTL time constant in days (chronic / "fitness"). */
export const CTL_TIME_CONSTANT_DAYS = 42;
/** ATL time constant in days (acute / "fatigue"). */
export const ATL_TIME_CONSTANT_DAYS = 7;
/** TSB at or below this is deep-fatigue territory. */
export const DEEP_FATIGUE_TSB = -25;
/** Consecutive days at or below DEEP_FATIGUE_TSB before flagging. */
export const DEEP_FATIGUE_DAYS = 5;
/** TSB at or above this reads as fresh / race-ready (detraining if held). */
export const FRESH_TSB = 15;
/** CTL gain per week above which the ramp carries injury/illness risk. */
export const RAMP_RISK_PER_WEEK = 5;
/**
 * Week-on-week load ratio the default taper shape steps down by, so a
 * three-week plan runs roughly 100 / 75 / 56 percent of its first week. The
 * solver scales the whole shape, so this only sets how front-loaded the plan
 * is, not how much work it prescribes.
 */
export const TAPER_WEEK_DECAY = 0.75;
/** Days averaged for the "percentage of recent training" comparison. */
export const RECENT_LOAD_DAYS = 28;
/**
 * Ceiling on a solved daily load. Training load above this is a race or a
 * very long hard day, so a plan asking for it every day is not a plan; the
 * solver clamps there and reports the TSB that lands instead.
 */
export const MAX_TAPER_DAILY_LOAD = 200;

const CTL_DECAY = Math.exp(-1 / CTL_TIME_CONSTANT_DAYS);
const ATL_DECAY = Math.exp(-1 / ATL_TIME_CONSTANT_DAYS);

/** Round to one decimal place, the display precision every value here uses. */
export const round1 = (value: number) => Math.round(value * 10) / 10;

/** Add (or subtract, for negative `days`) whole days to an ISO date. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0]!;
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Build the daily CTL/ATL/TSB series from `input.days`, rolling the
 * recurrence forward from `input.seed` (default `{ ctl: 0, atl: 0 }`). A
 * caller starting from zero should supply enough runway (~90 days) that the
 * early ramp has settled by the dates that matter; a caller with a known
 * prior CTL/ATL (e.g. intervals.icu's own wellness data) should seed it
 * instead. `input.days` must be consecutive calendar days; gaps are not
 * inferred as rest days.
 */
export function buildFitnessTrend(
  input: FitnessTrendInput,
  options: FitnessTrendOptions = {},
): FitnessTrendResult {
  const { plannedLoads, taper } = options;
  const projectDays =
    options.projectDays ??
    (plannedLoads !== undefined ? plannedLoads.length : 0);

  const series: FitnessTrendDay[] = [];
  const seed = input.seed ?? { ctl: 0, atl: 0 };
  let ctl = seed.ctl;
  let atl = seed.atl;
  for (const { date, ctlLoad, atlLoad } of input.days) {
    ctl = ctlLoad * (1 - CTL_DECAY) + ctl * CTL_DECAY;
    atl = atlLoad * (1 - ATL_DECAY) + atl * ATL_DECAY;
    series.push({
      date,
      load: round1(atlLoad),
      ctl: round1(ctl),
      atl: round1(atl),
      tsb: round1(ctl - atl),
    });
  }

  const endDate = series[series.length - 1]?.date;
  if (endDate === undefined) {
    return {
      days: series,
      current: null,
      projection: [],
      tsbPositiveDate: null,
      taper: null,
      bands: [],
      flags: [],
    };
  }

  const firstProjectedDate = addDays(endDate, 1);
  const { days: projection, tsbPositiveDate } = projectLoads(
    { ctl, atl },
    firstProjectedDate,
    resolvePlannedLoads(firstProjectedDate, projectDays, plannedLoads),
  );

  return {
    days: series,
    current: series[series.length - 1] ?? null,
    projection,
    tsbPositiveDate,
    taper: taper
      ? solveTaperPlan(
          { ctl, atl },
          endDate,
          taper,
          recentDailyLoad(series, RECENT_LOAD_DAYS),
        )
      : null,
    bands: trendBands(series),
    flags: computeFlags(series),
  };
}

/**
 * Line up planned load with the projected days. Numbers are consecutive days
 * from `startDate`; dated entries are matched by date, so a plan that names
 * only its hard days rests on the rest.
 */
export function resolvePlannedLoads(
  startDate: string,
  days: number,
  planned?: PlannedLoads,
): number[] {
  const loads = new Array<number>(Math.max(days, 0)).fill(0);
  if (!planned || planned.length === 0) return loads;

  if (typeof planned[0] === "number") {
    const numbers = planned as number[];
    for (let i = 0; i < loads.length && i < numbers.length; i++) {
      loads[i] = numbers[i]!;
    }
    return loads;
  }

  const byDate = new Map(
    (planned as PlannedLoad[]).map(({ date, load }) => [date, load]),
  );
  for (let i = 0; i < loads.length; i++) {
    loads[i] = byDate.get(addDays(startDate, i)) ?? 0;
  }
  return loads;
}

/**
 * Roll the CTL/ATL recurrence forward over a run of daily loads. Rounding
 * happens on the way out only; the TSB-crossing check reads the raw value, so
 * a -0.04 day does not read as positive because it rounds to -0.
 */
export function projectLoads(
  start: { ctl: number; atl: number },
  startDate: string,
  loads: number[],
): { days: FitnessTrendDay[]; tsbPositiveDate: string | null } {
  const days: FitnessTrendDay[] = [];
  let tsbPositiveDate: string | null = null;
  let ctl = start.ctl;
  let atl = start.atl;

  for (let i = 0; i < loads.length; i++) {
    const load = loads[i]!;
    ctl = load * (1 - CTL_DECAY) + ctl * CTL_DECAY;
    atl = load * (1 - ATL_DECAY) + atl * ATL_DECAY;
    const tsb = ctl - atl;
    const date = addDays(startDate, i);
    days.push({
      date,
      load: round1(load),
      ctl: round1(ctl),
      atl: round1(atl),
      tsb: round1(tsb),
    });
    if (tsbPositiveDate === null && tsb >= 0) tsbPositiveDate = date;
  }

  return { days, tsbPositiveDate };
}

/** TSB the recurrence lands on after `loads`, unrounded. */
function finalTsb(
  start: { ctl: number; atl: number },
  loads: number[],
): number {
  let ctl = start.ctl;
  let atl = start.atl;
  for (const load of loads) {
    ctl = load * (1 - CTL_DECAY) + ctl * CTL_DECAY;
    atl = load * (1 - ATL_DECAY) + atl * ATL_DECAY;
  }
  return ctl - atl;
}

/** Mean daily load over the trailing `window` days of a computed series. */
export function recentDailyLoad(
  series: FitnessTrendDay[],
  window: number,
): number {
  const tail = series.slice(-window);
  if (tail.length === 0) return 0;
  const total = tail.reduce((sum, day) => sum + day.load, 0);
  return round1(total / tail.length);
}

/**
 * Relative load weights for a taper of `days` days, one per (possibly short)
 * week, stepping down by `TAPER_WEEK_DECAY` toward the target date.
 */
export function taperWeekWeights(days: number): number[] {
  const weeks = Math.max(Math.ceil(days / 7), 1);
  return Array.from({ length: weeks }, (_, i) => TAPER_WEEK_DECAY ** i);
}

/**
 * Solve the load taper that lands on a target TSB.
 *
 * TSB after n days is `ctl0·a^n − atl0·b^n + Σ load_i·(…)`, which is *linear*
 * in the loads, so scaling one taper shape by `k` moves the landing TSB
 * linearly too: two projections (rest, and the shape at k = 1) pin the line
 * and the exact `k` follows. No search, no tolerance.
 *
 * Fatigue decays faster than fitness (`b < a`), so more load always means less
 * form on the target date: the line slopes down, and the two clamps are the
 * interesting cases. `k < 0` means even complete rest arrives short of the
 * target — the date is too soon. A daily load above `MAX_TAPER_DAILY_LOAD`
 * means the target is so negative it would take racing every day to hit;
 * both report the TSB that actually lands.
 */
export function solveTaperPlan(
  start: { ctl: number; atl: number },
  fromDate: string,
  request: TaperRequest,
  recentLoad = 0,
): TaperPlan {
  const { targetDate, targetTsb } = request;
  const days = daysBetween(fromDate, targetDate);
  const firstDate = addDays(fromDate, 1);

  if (days < 1) {
    return {
      target_date: targetDate,
      target_tsb: targetTsb,
      achieved_tsb: round1(start.ctl - start.atl),
      feasible: false,
      note: `${targetDate} is not after ${fromDate} — a taper needs at least one day to work with.`,
      weeks: [],
      days: [],
      total_load: 0,
      recent_daily_load: recentLoad,
    };
  }

  const weekWeights = request.weekWeights ?? taperWeekWeights(days);
  const shape = Array.from(
    { length: days },
    (_, i) => weekWeights[Math.min(Math.floor(i / 7), weekWeights.length - 1)]!,
  );

  const restTsb = finalTsb(
    start,
    shape.map(() => 0),
  );
  const unitTsb = finalTsb(start, shape);
  const slope = unitTsb - restTsb;

  let note: string | null = null;
  let feasible = true;
  // slope is < 0 for any positive shape; the guard is for a degenerate
  // all-zero shape, where no load moves TSB and rest is the only answer.
  let scale = slope === 0 ? 0 : (targetTsb - restTsb) / slope;

  if (scale <= 0) {
    scale = 0;
    feasible = false;
    note = `Even complete rest only reaches TSB ${signedRound1(restTsb)} by ${targetDate}, short of the ${signedRound1(targetTsb)} target — the target date is too soon, or the target too high.`;
  }

  const peakWeight = Math.max(...shape);
  const peakLoad = peakWeight * scale;
  if (peakLoad > MAX_TAPER_DAILY_LOAD) {
    scale = MAX_TAPER_DAILY_LOAD / peakWeight;
    feasible = false;
    note = `Reaching TSB ${signedRound1(targetTsb)} by ${targetDate} would take more than ${MAX_TAPER_DAILY_LOAD} training load a day; the plan is capped there.`;
  }

  const loads = shape.map((weight) => weight * scale);
  const projected = projectLoads(start, firstDate, loads);
  const landing = projected.days[projected.days.length - 1]!;

  const weeks: TaperWeek[] = [];
  for (let week = 0; week * 7 < days; week++) {
    const slice = loads.slice(week * 7, week * 7 + 7);
    const weekLoad = slice.reduce((sum, load) => sum + load, 0);
    weeks.push({
      week: week + 1,
      start_date: addDays(firstDate, week * 7),
      end_date: addDays(firstDate, week * 7 + slice.length - 1),
      days: slice.length,
      daily_load: round1(weekLoad / slice.length),
      week_load: round1(weekLoad),
      pct_of_recent:
        recentLoad > 0
          ? Math.round((weekLoad / (recentLoad * slice.length)) * 100)
          : null,
    });
  }

  return {
    target_date: targetDate,
    target_tsb: targetTsb,
    achieved_tsb: landing.tsb,
    feasible,
    note,
    weeks,
    days: projected.days,
    total_load: round1(loads.reduce((sum, load) => sum + load, 0)),
    recent_daily_load: recentLoad,
  };
}

const signedRound1 = (value: number) => {
  const rounded = round1(value);
  return `${rounded >= 0 ? "+" : ""}${rounded}`;
};

/** A dated stretch of the series worth annotating on a chart. */
export interface TrendBand {
  kind: "deep-fatigue" | "fresh" | "steep-ramp";
  start_date: string;
  end_date: string;
  days: number;
  /** The sentence `computeFlags` prints when the band reaches today. */
  reason: string;
}

/**
 * Every stretch of the series that a coach would ring on the chart: deep
 * fatigue, freshness, and a steep CTL ramp. Dated, unlike `flags`, so a chart
 * can shade the actual days — which is why the flag strings are built here
 * rather than beside them, and `computeFlags` is a filter over these bands
 * (the chart and the prose cannot disagree about what counts as deep fatigue).
 */
export function trendBands(series: FitnessTrendDay[]): TrendBand[] {
  const bands: TrendBand[] = [];
  if (series.length === 0) return bands;

  const runs = (
    predicate: (day: FitnessTrendDay, index: number) => boolean,
  ): { start: number; end: number }[] => {
    const found: { start: number; end: number }[] = [];
    let start: number | null = null;
    for (let i = 0; i < series.length; i++) {
      if (predicate(series[i]!, i)) {
        if (start === null) start = i;
      } else if (start !== null) {
        found.push({ start, end: i - 1 });
        start = null;
      }
    }
    if (start !== null) found.push({ start, end: series.length - 1 });
    return found;
  };

  const band = (
    kind: TrendBand["kind"],
    start: number,
    end: number,
    reason: string,
  ): TrendBand => ({
    kind,
    start_date: series[start]!.date,
    end_date: series[end]!.date,
    days: end - start + 1,
    reason,
  });

  // Kind order is the flag order: fatigue first, then freshness, then ramp.
  for (const { start, end } of runs((day) => day.tsb <= DEEP_FATIGUE_TSB)) {
    const days = end - start + 1;
    if (days < DEEP_FATIGUE_DAYS) continue;
    bands.push(
      band(
        "deep-fatigue",
        start,
        end,
        `TSB at or below ${DEEP_FATIGUE_TSB} for ${days} consecutive days — deep fatigue; an easy block or rest is overdue.`,
      ),
    );
  }

  for (const { start, end } of runs((day) => day.tsb >= FRESH_TSB)) {
    bands.push(
      band(
        "fresh",
        start,
        end,
        `TSB at ${series[end]!.tsb} (≥ +${FRESH_TSB}) — fresh and race-ready now, but fitness decays if this holds for long.`,
      ),
    );
  }

  const rampAt = (index: number) =>
    index >= 7 ? round1(series[index]!.ctl - series[index - 7]!.ctl) : 0;
  for (const { start, end } of runs(
    (_, index) => rampAt(index) >= RAMP_RISK_PER_WEEK,
  )) {
    bands.push(
      band(
        "steep-ramp",
        start,
        end,
        `CTL climbed ${rampAt(end)} in the last 7 days — a steep ramp; sustained rates above ~${RAMP_RISK_PER_WEEK}/week carry injury and illness risk.`,
      ),
    );
  }

  return bands;
}

/**
 * The flags worth raising *now*: a band that runs to the end of the window.
 * An old resolved deep-fatigue block is history, not a flag — it still shades
 * on the chart via `trendBands`.
 */
export function computeFlags(series: FitnessTrendDay[]): string[] {
  const last = series[series.length - 1];
  if (!last) return [];
  return trendBands(series)
    .filter((band) => band.end_date === last.date)
    .map((band) => band.reason);
}
