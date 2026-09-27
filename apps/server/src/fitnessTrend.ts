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
import { addDays, daysBetween, isValidCalendarDate } from "./utils/localDate";
import { PACE_ACTIVITY_TYPES } from "./utils/running";

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
   * The last input day when its TSB is already ≥ 0, else the first projected
   * date on which TSB reaches 0; null if it never does within the projection
   * (or no projection was requested). See `tsbPositiveFrom`.
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
/**
 * Once a fresh band has started, it holds until TSB drops below this. With no
 * gap between entry and exit, TSB moving around +15 for weeks cut one fresh
 * spell into many 1-day bands (#44).
 */
export const FRESH_EXIT_TSB = 12;
/** Fewest days a fresh band needs, unless it runs to the last day. */
export const FRESH_MIN_DAYS = 3;
/** Fresh bands with this many days or fewer between them merge into one. */
export const FRESH_MERGE_GAP_DAYS = 2;
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
/**
 * Furthest ahead a taper target date may be. The solver sizes its day array
 * from the distance to the target, so an unbounded date is an unbounded
 * response: a typo like 2062-10-17 gave a 13,170-day plan of about 950 KB
 * (#44). A race more than about six months out needs a training plan, not a
 * taper.
 */
export const MAX_TAPER_DAYS = 180;

const CTL_DECAY = Math.exp(-1 / CTL_TIME_CONSTANT_DAYS);
const ATL_DECAY = Math.exp(-1 / ATL_TIME_CONSTANT_DAYS);

/** Round to one decimal place, the display precision every value here uses. */
export const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Display CTL/ATL/TSB from raw (unrounded) CTL and ATL: TSB is CTL − ATL of
 * the raw values, then each is rounded to 0.1. The one home for this, used by
 * the recurrence here, the wellness series (`fitnessTrendWellness.ts`) and
 * `get-wellness`, so a day's TSB is the same number on every surface.
 */
export function ctlAtlTsb(
  ctl: number,
  atl: number,
): { ctl: number; atl: number; tsb: number } {
  return { ctl: round1(ctl), atl: round1(atl), tsb: round1(ctl - atl) };
}

/**
 * `metric` on `day` minus `metric` exactly `days` calendar days earlier, or
 * null when the series has no day on that date. Looked up by date, not by
 * array index: a whole-body series leaves out days with no wellness, so an
 * index 7 back can be 9 calendar days back.
 */
function deltaLookup(series: FitnessTrendDay[]) {
  const byDate = new Map(series.map((day) => [day.date, day]));
  return (
    day: FitnessTrendDay,
    days: number,
    metric: "ctl" | "tsb",
  ): number | null => {
    const prior = byDate.get(addDays(day.date, -days));
    return prior ? round1(day[metric] - prior[metric]) : null;
  };
}

/**
 * CTL change over the `days` calendar days to the series' last day, by date;
 * null when the day `days` before it is not in the series. The one home for
 * the 7-day CTL change: `get-fitness-trend`'s `ctl_7d_delta`, the steep-ramp
 * bands, and the fitness-trend app's narration (through its payload) all
 * read it.
 */
export function ctlDelta(series: FitnessTrendDay[], days: number) {
  const last = series[series.length - 1];
  return last ? deltaLookup(series)(last, days, "ctl") : null;
}

/** TSB change over the `days` calendar days to the last day; see {@link ctlDelta}. */
export function tsbDelta(series: FitnessTrendDay[], days: number) {
  const last = series[series.length - 1];
  return last ? deltaLookup(series)(last, days, "tsb") : null;
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
    series.push({ date, load: round1(atlLoad), ...ctlAtlTsb(ctl, atl) });
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
    tsbPositiveDate:
      projection.length > 0
        ? tsbPositiveFrom(ctl - atl, endDate, tsbPositiveDate)
        : null,
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
 *
 * `positiveDateFrom` (inclusive) excludes an earlier crossing from
 * `tsbPositiveDate` without excluding those days from `days` itself: a
 * caller projecting unsynced "catch-up" days before today alongside the
 * actual future projection (`projectFromWellness`) still wants those catch-up
 * days in the series, but a crossing during them is a past or already-today
 * date, not a future one worth reporting as "returns positive on".
 */
export function projectLoads(
  start: { ctl: number; atl: number },
  startDate: string,
  loads: number[],
  options: { positiveDateFrom?: string } = {},
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
    days.push({ date, load: round1(load), ...ctlAtlTsb(ctl, atl) });
    const eligible =
      options.positiveDateFrom === undefined ||
      date >= options.positiveDateFrom;
    if (tsbPositiveDate === null && tsb >= 0 && eligible)
      tsbPositiveDate = date;
  }

  return { days, tsbPositiveDate };
}

/**
 * The one rule for `tsbPositiveDate`, on every path that projects: `today`
 * when today's raw TSB is already ≥ 0, else the first projected date it
 * reaches 0 (`crossing`). A projection starts the day after today, so without
 * the first branch a form of +12 today read as "returns positive" tomorrow
 * (#44). Callers print `tsbPositiveDate === today` as "already positive today".
 */
function tsbPositiveFrom(
  todayTsb: number,
  today: string,
  crossing: string | null,
): string | null {
  return todayTsb >= 0 ? today : crossing;
}

/**
 * Why a taper cannot be solved for `targetDate` from `today`, or null when it
 * can: the date must be a real calendar date, after today, and at most
 * {@link MAX_TAPER_DAYS} ahead. Every caller checks this before any fetch,
 * so a typo gets a clear error instead of a huge plan, a stack overflow
 * (9999-12-31), or a date that rolls over (2027-02-30 into March).
 */
export function taperTargetDateError(
  targetDate: string,
  today: string,
): string | null {
  if (!isValidCalendarDate(targetDate)) {
    return `targetDate ${targetDate} is not a real calendar date. Use YYYY-MM-DD.`;
  }
  const days = daysBetween(today, targetDate);
  if (days < 1) {
    return `targetDate ${targetDate} is not after today (${today}). A taper plan needs a date in the future.`;
  }
  if (days > MAX_TAPER_DAYS) {
    return `targetDate ${targetDate} is ${days} days after today (${today}); a taper plan covers at most ${MAX_TAPER_DAYS} days. Check the date, or pick one on or before ${addDays(today, MAX_TAPER_DAYS)}.`;
  }
  return null;
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
      note: `${targetDate} is not after ${fromDate}: a taper needs at least one day to work with.`,
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
    note = `Even complete rest only reaches TSB ${signedRound1(restTsb)} by ${targetDate}, short of the ${signedRound1(targetTsb)} target: the target date is too soon, or the target too high.`;
  }

  // A loop, not `Math.max(...shape)`: spreading a long array overflows the
  // call stack.
  let peakWeight = 0;
  for (const weight of shape) if (weight > peakWeight) peakWeight = weight;
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

/** Read-then-solve series from `loadWellnessFitnessSeries`, whole-body only. */
export interface ProjectFromWellnessInput {
  series: FitnessTrendDay[];
  /** Raw (unrounded) CTL/ATL to roll forward from; null when there is no usable data. */
  seed: { ctl: number; atl: number } | null;
  /** Date `seed` came from, the most recent day with a recorded CTL/ATL. */
  asOfDate: string | null;
  /** Today, in the caller's configured time zone. */
  endDate: string;
}

export interface ProjectFromWellnessOptions {
  /** Days to project past `endDate`; 0 (or a `taper` request) means no projection. */
  projectDays: number;
  plannedLoads?: PlannedLoads;
  taper?: TaperRequest;
}

export interface ProjectFromWellnessResult {
  projection: FitnessTrendDay[];
  tsbPositiveDate: string | null;
  taper: TaperPlan | null;
  /** Days between `asOfDate` and `endDate` not yet synced, rolled forward as rest. */
  unsyncedDays: number;
  /** e.g. plannedLoads dropped because a taper was solved instead. */
  warnings: string[];
}

/**
 * Whole-body projection/taper, shared by `get-fitness-trend`'s whole-body
 * path and the fitness-trend MCP App's data handler (see AGENTS.md's
 * "derived numbers have exactly one home") so the two surfaces cannot drift
 * the way they used to: a `projectDays: 0` request now always yields an
 * empty projection in both (previously the app kept rolling any unsynced
 * days forward as a "catch-up" projection even when none was asked for,
 * which could also surface a `tsbPositiveDate` that had already passed), and
 * a taper is always solved from `endDate` ("today"), never from `asOfDate`,
 * with any unsynced days between the two rolled forward as rest first, the
 * same catch-up rest days the projection uses, so the taper's day count
 * does not shrink just because wellness has not synced yet.
 */
export function projectFromWellness(
  input: ProjectFromWellnessInput,
  options: ProjectFromWellnessOptions,
): ProjectFromWellnessResult {
  const { series, seed, asOfDate, endDate } = input;
  const { projectDays, plannedLoads, taper } = options;
  const warnings: string[] = [];

  if (!seed || !asOfDate) {
    return {
      projection: [],
      tsbPositiveDate: null,
      taper: null,
      unsyncedDays: 0,
      warnings,
    };
  }

  const unsyncedDays = daysBetween(asOfDate, endDate);
  const firstProjectedDate = addDays(asOfDate, 1);

  if (taper) {
    if (plannedLoads && plannedLoads.length > 0) {
      warnings.push(
        "plannedLoads is ignored: a targetDate taper plan is solved instead of a projection.",
      );
    }
    // Roll any unsynced days forward as rest so the solve is anchored at
    // `endDate` ("today"), matching the projection below, rather than at
    // whatever day wellness last synced.
    const todaySeed =
      unsyncedDays > 0
        ? projectLoads(
            seed,
            firstProjectedDate,
            new Array(unsyncedDays).fill(0),
          ).days.at(-1)!
        : seed;
    return {
      projection: [],
      tsbPositiveDate: null,
      taper: solveTaperPlan(
        { ctl: todaySeed.ctl, atl: todaySeed.atl },
        endDate,
        taper,
        recentDailyLoad(series, RECENT_LOAD_DAYS),
      ),
      unsyncedDays,
      warnings,
    };
  }

  if (projectDays <= 0) {
    return {
      projection: [],
      tsbPositiveDate: null,
      taper: null,
      unsyncedDays,
      warnings,
    };
  }

  // The projection always ends at endDate + projectDays, regardless of how
  // far as_of trails endDate: the unsynced days in between are projected as
  // rest, then the actual projectDays continue past endDate. An explicit
  // projectDays always means "N days past today", not "N days past as_of".
  const totalProjectDays = unsyncedDays + projectDays;
  const futurePlannedLoads = (
    plannedLoads as PlannedLoad[] | undefined
  )?.filter((p) => p.date > endDate);
  const loads = resolvePlannedLoads(
    firstProjectedDate,
    totalProjectDays,
    futurePlannedLoads,
  );
  // A crossing during the unsynced catch-up days (before endDate) is a past
  // date, not a future one worth reporting: only a crossing on or after
  // endDate ("today") counts.
  const projected = projectLoads(seed, firstProjectedDate, loads, {
    positiveDateFrom: endDate,
  });
  return {
    projection: projected.days,
    // With unsynced days, endDate is in the catch-up and `positiveDateFrom`
    // already reports it; synced, the seed is today's value.
    tsbPositiveDate:
      unsyncedDays > 0
        ? projected.tsbPositiveDate
        : tsbPositiveFrom(
            seed.ctl - seed.atl,
            endDate,
            projected.tsbPositiveDate,
          ),
    taper: null,
    unsyncedDays,
    warnings,
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
  /**
   * What the band means: in the present tense ("now") when it runs to the
   * last day, the sentence `computeFlags` prints; in the past tense when it
   * ended earlier.
   */
  reason: string;
}

/**
 * Every stretch of the series that a coach would ring on the chart: deep
 * fatigue, freshness, and a steep CTL ramp. Dated, unlike `flags`, so a chart
 * can shade the actual days — which is why the flag strings are built here
 * rather than beside them, and `computeFlags` is a filter over these bands
 * (the chart and the prose cannot disagree about what counts as deep fatigue).
 *
 * `series` need not be calendar-consecutive (a whole-body series read from
 * wellness can have gaps, days with no recorded CTL/ATL, left out rather
 * than zero-filled): a run breaks at a gap rather than bridging it, and the
 * 7-day CTL ramp looks its prior day up by date, not by array index, so a
 * gap elsewhere in the series never misattributes which day is "7 days ago".
 *
 * Fresh bands are the one kind with hysteresis: a band starts at
 * {@link FRESH_TSB} and holds until TSB drops below {@link FRESH_EXIT_TSB};
 * bands at most {@link FRESH_MERGE_GAP_DAYS} apart merge (also across a
 * short wellness gap); and a band needs {@link FRESH_MIN_DAYS} days unless
 * it runs to the last day, which is the current state `computeFlags` reports.
 */
export function trendBands(series: FitnessTrendDay[]): TrendBand[] {
  const bands: TrendBand[] = [];
  if (series.length === 0) return bands;

  const lastIndex = series.length - 1;
  const deltaAt = deltaLookup(series);
  const calendarDays = (start: number, end: number) =>
    daysBetween(series[start]!.date, series[end]!.date) + 1;

  type Test = (day: FitnessTrendDay, index: number) => boolean;
  /** Runs that start where `enter` holds and continue while `stay` holds. */
  const runs = (
    enter: Test,
    stay: Test = enter,
  ): { start: number; end: number }[] => {
    const found: { start: number; end: number }[] = [];
    let start: number | null = null;
    let prevDate: string | null = null;
    for (let i = 0; i < series.length; i++) {
      const day = series[i]!;
      const gapFromPrev =
        prevDate !== null && addDays(prevDate, 1) !== day.date;
      if (start !== null && (gapFromPrev || !stay(day, i))) {
        found.push({ start, end: i - 1 });
        start = null;
      }
      if (start === null && enter(day, i)) start = i;
      prevDate = day.date;
    }
    if (start !== null) found.push({ start, end: lastIndex });
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
    days: calendarDays(start, end),
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
        end === lastIndex
          ? `TSB at or below ${DEEP_FATIGUE_TSB} for ${days} consecutive days: deep fatigue; an easy block or rest is overdue.`
          : `TSB was at or below ${DEEP_FATIGUE_TSB} for ${days} consecutive days (${series[start]!.date} to ${series[end]!.date}): deep fatigue, since eased.`,
      ),
    );
  }

  const freshRuns: { start: number; end: number }[] = [];
  for (const run of runs(
    (day) => day.tsb >= FRESH_TSB,
    (day) => day.tsb >= FRESH_EXIT_TSB,
  )) {
    const prev = freshRuns[freshRuns.length - 1];
    const daysApart = prev
      ? daysBetween(series[prev.end]!.date, series[run.start]!.date) - 1
      : Number.POSITIVE_INFINITY;
    if (prev && daysApart <= FRESH_MERGE_GAP_DAYS) {
      prev.end = run.end;
    } else {
      freshRuns.push({ ...run });
    }
  }
  for (const { start, end } of freshRuns) {
    const days = calendarDays(start, end);
    if (end !== lastIndex && days < FRESH_MIN_DAYS) continue;
    let peak = series[start]!.tsb;
    for (let i = start + 1; i <= end; i++) {
      peak = Math.max(peak, series[i]!.tsb);
    }
    const startDate = series[start]!.date;
    bands.push(
      band(
        "fresh",
        start,
        end,
        end === lastIndex
          ? `TSB at ${signedRound1(series[end]!.tsb)} (fresh since ${startDate}, peak ${signedRound1(peak)}): fresh and race-ready now, but fitness decays if this holds for long.`
          : `Fresh from ${startDate} to ${series[end]!.date} (${days} days, TSB peak ${signedRound1(peak)}).`,
      ),
    );
  }

  const rampAt = (index: number) => deltaAt(series[index]!, 7, "ctl") ?? 0;
  for (const { start, end } of runs(
    (_, index) => rampAt(index) >= RAMP_RISK_PER_WEEK,
  )) {
    bands.push(
      band(
        "steep-ramp",
        start,
        end,
        `CTL climbed ${rampAt(end)} in the ${end === lastIndex ? "last 7 days" : `7 days to ${series[end]!.date}`}: a steep ramp; sustained rates above ~${RAMP_RISK_PER_WEEK}/week carry injury and illness risk.`,
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

/**
 * Run types intervals.icu has no dedicated per-sport CTL/ATL for. Callers
 * here use array methods (`.includes()`, spread into a JSON-serialisable
 * list), so this re-exports `utils/running.ts`'s `PACE_ACTIVITY_TYPES`
 * (a `Set`, for `.has()` callers) as an array rather than duplicating the
 * same three literal strings a second time.
 */
export const RUN_TYPES: readonly string[] = [...PACE_ACTIVITY_TYPES];

/**
 * How far before the requested window a run-only computation starts summing
 * load. intervals.icu has no per-sport CTL/ATL, so the run-only series is
 * built locally, zero-seeded, and needs enough runway for the 42-day CTL
 * average to settle before the displayed window starts.
 */
export const RUN_ONLY_RUNWAY_DAYS = 150;

/** Minimal activity shape the run-only daily-load sum needs. */
export interface RunOnlyLoadActivity {
  start_date_local: string;
  icu_training_load?: number | null;
}

/**
 * Sums `icu_training_load` per local date for the given activities, keyed by
 * `start_date_local`.
 */
export function dailyLoadByDate(
  activities: RunOnlyLoadActivity[],
): Map<string, number> {
  const loads = new Map<string, number>();
  for (const activity of activities) {
    const date = activity.start_date_local.split("T")[0]!;
    loads.set(date, (loads.get(date) ?? 0) + (activity.icu_training_load ?? 0));
  }
  return loads;
}

export interface RunOnlyFitnessTrend {
  trend: FitnessTrendResult;
  /** First date of the zero-seeded runway (before the displayed window). */
  runwayStart: string;
  runwayDays: number;
}

/**
 * Builds the run-only CTL/ATL/TSB trend: sums `icu_training_load` per local
 * day over `runActivities` (caller-filtered to {@link RUN_TYPES}),
 * zero-seeds {@link RUN_ONLY_RUNWAY_DAYS} days before `options.endDate` minus
 * `options.days` so the 42-day CTL average has settled, then rolls
 * {@link buildFitnessTrend}'s recurrence forward across the whole runway.
 * The one home `get-fitness-trend`'s run-only path and `get-training-load`
 * both build this series through, so they can never disagree.
 */
export function buildRunOnlyFitnessTrend(
  runActivities: RunOnlyLoadActivity[],
  options: {
    endDate: string;
    days: number;
    runwayDays?: number;
    fitnessOptions?: FitnessTrendOptions;
  },
): RunOnlyFitnessTrend {
  const runwayDays = options.runwayDays ?? options.days + RUN_ONLY_RUNWAY_DAYS;
  const runwayStart = addDays(options.endDate, -(runwayDays - 1));
  const loadByDate = dailyLoadByDate(runActivities);

  const runwaySeries: FitnessTrendLoadDay[] = Array.from(
    { length: runwayDays },
    (_, i) => {
      const date = addDays(runwayStart, i);
      const load = loadByDate.get(date) ?? 0;
      return { date, ctlLoad: load, atlLoad: load };
    },
  );

  const trend = buildFitnessTrend(
    { days: runwaySeries },
    options.fitnessOptions ?? {},
  );

  return { trend, runwayStart, runwayDays };
}
