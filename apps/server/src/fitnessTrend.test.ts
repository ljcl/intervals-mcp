import { describe, expect, it } from "vitest";
import {
  ATL_TIME_CONSTANT_DAYS,
  addDays,
  buildFitnessTrend,
  CTL_TIME_CONSTANT_DAYS,
  computeFlags,
  DEEP_FATIGUE_DAYS,
  DEEP_FATIGUE_TSB,
  daysBetween,
  type FitnessTrendDay,
  type FitnessTrendLoadDay,
  FRESH_TSB,
  MAX_TAPER_DAILY_LOAD,
  projectFromWellness,
  RAMP_RISK_PER_WEEK,
  RECENT_LOAD_DAYS,
  recentDailyLoad,
  solveTaperPlan,
  TAPER_WEEK_DECAY,
  taperWeekWeights,
  trendBands,
} from "./fitnessTrend";

type LoadOverride = number | [ctlLoad: number, atlLoad: number];

/**
 * Build `count` consecutive days ending on `endDate`, defaulting to zero
 * load, with `overrides` setting specific dates (a single number feeds both
 * series; a `[ctlLoad, atlLoad]` tuple splits them).
 */
function window(
  endDate: string,
  count: number,
  overrides: Record<string, LoadOverride> = {},
): FitnessTrendLoadDay[] {
  const start = addDays(endDate, -(count - 1));
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(start, i);
    const override = overrides[date];
    const [ctlLoad, atlLoad] = Array.isArray(override)
      ? override
      : [override ?? 0, override ?? 0];
    return { date, ctlLoad, atlLoad };
  });
}

/** `load` on every one of `count` consecutive days ending on `endDate`. */
function constantWindow(
  endDate: string,
  count: number,
  load: number,
): FitnessTrendLoadDay[] {
  const start = addDays(endDate, -(count - 1));
  return Array.from({ length: count }, (_, i) => ({
    date: addDays(start, i),
    ctlLoad: load,
    atlLoad: load,
  }));
}

/** `load` on each of `count` consecutive days starting `startDate`. */
function rangeLoads(
  startDate: string,
  count: number,
  load: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < count; i++) out[addDays(startDate, i)] = load;
  return out;
}

describe("buildFitnessTrend", () => {
  it("returns an all-zero series with an all-zero input", () => {
    const trend = buildFitnessTrend({ days: window("2026-07-10", 5) });
    expect(trend.days).toHaveLength(5);
    expect(trend.days[0]!.date).toBe("2026-07-06");
    expect(trend.days[4]!.date).toBe("2026-07-10");
    for (const day of trend.days) {
      expect(day).toMatchObject({ load: 0, ctl: 0, atl: 0, tsb: 0 });
    }
    expect(trend.current).toEqual(trend.days[4]);
    expect(trend.flags).toEqual([]);
  });

  it("returns an empty result for an empty input", () => {
    const trend = buildFitnessTrend({ days: [] });
    expect(trend.days).toEqual([]);
    expect(trend.current).toBeNull();
    expect(trend.projection).toEqual([]);
    expect(trend.taper).toBeNull();
  });

  it("converges CTL and ATL toward a constant daily load", () => {
    const trend = buildFitnessTrend({
      days: constantWindow("2026-06-27", 300, 50),
    });
    const current = trend.current!;
    expect(current.ctl).toBeCloseTo(50, 0);
    expect(current.atl).toBeCloseTo(50, 0);
    expect(Math.abs(current.tsb)).toBeLessThan(1);
  });

  it("responds faster in ATL than CTL after a big day", () => {
    const trend = buildFitnessTrend({
      days: window("2026-07-10", 30, { "2026-07-09": 100 }),
    });
    const bigDay = trend.days.find((d) => d.date === "2026-07-09")!;
    // First responses: load * (1 − e^(−1/tc)).
    expect(bigDay.atl).toBeCloseTo(
      100 * (1 - Math.exp(-1 / ATL_TIME_CONSTANT_DAYS)),
      1,
    );
    expect(bigDay.ctl).toBeCloseTo(
      100 * (1 - Math.exp(-1 / CTL_TIME_CONSTANT_DAYS)),
      1,
    );
    expect(bigDay.atl).toBeGreaterThan(bigDay.ctl);
    expect(bigDay.tsb).toBeLessThan(0);
  });

  it("decays both curves through rest days", () => {
    const trend = buildFitnessTrend({
      days: window("2026-07-10", 20, { "2026-07-01": 80 }),
    });
    const loaded = trend.days.find((d) => d.date === "2026-07-01")!;
    const later = trend.days.find((d) => d.date === "2026-07-08")!;
    expect(later.ctl).toBeLessThan(loaded.ctl);
    expect(later.atl).toBeLessThan(loaded.atl);
    // A week after a single spike, fatigue has faded faster than fitness.
    expect(later.tsb).toBeGreaterThan(loaded.tsb);
  });

  it("projects zero-load decay and finds the TSB-positive date", () => {
    // Heavy recent week on top of little background: negative TSB now.
    const trend = buildFitnessTrend(
      { days: window("2026-07-10", 60, rangeLoads("2026-07-04", 7, 120)) },
      { projectDays: 21 },
    );
    expect(trend.current!.tsb).toBeLessThan(0);
    expect(trend.projection).toHaveLength(21);
    expect(trend.projection[0]!.date).toBe("2026-07-11");
    expect(trend.tsbPositiveDate).not.toBeNull();
    const positive = trend.projection.find(
      (d) => d.date === trend.tsbPositiveDate,
    )!;
    expect(positive.tsb).toBeGreaterThanOrEqual(0);
    const before = trend.projection[trend.projection.indexOf(positive) - 1];
    if (before) expect(before.tsb).toBeLessThan(0);
    // Zero-load projection: fitness only decays.
    expect(trend.projection[20]!.ctl).toBeLessThan(trend.current!.ctl);
  });

  it("returns null tsbPositiveDate when the projection stays negative", () => {
    const trend = buildFitnessTrend(
      { days: window("2026-07-10", 30, rangeLoads("2026-07-06", 5, 200)) },
      { projectDays: 2 },
    );
    expect(trend.current!.tsb).toBeLessThan(0);
    expect(trend.tsbPositiveDate).toBeNull();
  });
});

describe("exact reproduction of the 42/7 recurrence", () => {
  const CTL_DECAY = Math.exp(-1 / CTL_TIME_CONSTANT_DAYS);
  const ATL_DECAY = Math.exp(-1 / ATL_TIME_CONSTANT_DAYS);
  const round1 = (value: number) => Math.round(value * 10) / 10;

  /**
   * Independent reference implementation of `x_t = x_{t-1}·exp(-1/N) +
   * load_t·(1 - exp(-1/N))`, rounded the same way the module rounds its
   * displayed series, so the module's output should match it exactly.
   */
  function reference(
    seed: { ctl: number; atl: number },
    days: { ctlLoad: number; atlLoad: number }[],
  ): { ctl: number; atl: number }[] {
    let ctl = seed.ctl;
    let atl = seed.atl;
    return days.map(({ ctlLoad, atlLoad }) => {
      ctl = ctl * CTL_DECAY + ctlLoad * (1 - CTL_DECAY);
      atl = atl * ATL_DECAY + atlLoad * (1 - ATL_DECAY);
      return { ctl: round1(ctl), atl: round1(atl) };
    });
  }

  /** Deterministic pseudo-random loads in [0, 120), seeded for repeatability. */
  function syntheticLoads(count: number, seed: number): number[] {
    let s = seed;
    return Array.from({ length: count }, () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return round1((s / 0x7fffffff) * 120);
    });
  }

  it("matches a synthetic generator from a seed to floating-point precision", () => {
    const loads = syntheticLoads(150, 42);
    const days: FitnessTrendLoadDay[] = loads.map((load, i) => ({
      date: addDays("2026-01-01", i),
      ctlLoad: load,
      atlLoad: load,
    }));
    const seed = { ctl: 31.4, atl: 22.7 };
    const expected = reference(seed, days);

    const trend = buildFitnessTrend({ days, seed });

    expect(trend.days).toHaveLength(days.length);
    trend.days.forEach((day, i) => {
      expect(day.ctl).toBeCloseTo(expected[i]!.ctl, 9);
      expect(day.atl).toBeCloseTo(expected[i]!.atl, 9);
    });
  });

  it("reproduces separate CTL/ATL series when atlLoad carries extra strength load", () => {
    const enduranceLoads = syntheticLoads(120, 7);
    const strengthLoads = syntheticLoads(120, 99).map(
      (v, i) => (i % 3 === 0 ? v : 0), // strength only every third day
    );
    const days: FitnessTrendLoadDay[] = enduranceLoads.map((load, i) => ({
      date: addDays("2026-02-01", i),
      ctlLoad: load, // fitness ignores strength
      atlLoad: load + strengthLoads[i]!, // fatigue counts it
    }));
    const seed = { ctl: 40, atl: 55 };
    const expected = reference(seed, days);

    const trend = buildFitnessTrend({ days, seed });

    trend.days.forEach((day, i) => {
      expect(day.ctl).toBeCloseTo(expected[i]!.ctl, 9);
      expect(day.atl).toBeCloseTo(expected[i]!.atl, 9);
    });
    // The variant is a real test: strength load actually moved ATL above
    // what CTL alone would give on a strength day.
    const strengthDay = trend.days[3]!;
    expect(strengthDay.atl).toBeGreaterThan(strengthDay.ctl);
    expect(strengthLoads[3]).toBeGreaterThan(0);
  });

  it("seeds the recurrence instead of assuming zero", () => {
    const flat = constantWindow("2026-03-10", 10, 0);
    const trend = buildFitnessTrend({
      days: flat,
      seed: { ctl: 60, atl: 75 },
    });
    // Zero load every day: both curves purely decay from the seed.
    expect(trend.days[0]!.ctl).toBeCloseTo(round1(60 * CTL_DECAY), 9);
    expect(trend.days[0]!.atl).toBeCloseTo(round1(75 * ATL_DECAY), 9);
    expect(trend.days[9]!.ctl).toBeLessThan(trend.days[0]!.ctl);
  });
});

describe("planned-load projection", () => {
  /** Five hard days a week for `weeks` weeks, ending on 2026-06-28. */
  function block(weeks: number): FitnessTrendLoadDay[] {
    return Array.from({ length: weeks * 7 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 5, 28));
      d.setUTCDate(d.getUTCDate() - (weeks * 7 - 1 - i));
      const date = d.toISOString().split("T")[0]!;
      const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
      const load = isWeekend ? 0 : 60;
      return { date, ctlLoad: load, atlLoad: load };
    });
  }

  it("keeps the zero-load rest projection as the default", () => {
    const trend = buildFitnessTrend({ days: block(12) }, { projectDays: 5 });
    expect(trend.projection.map((d) => d.load)).toEqual([0, 0, 0, 0, 0]);
    expect(trend.taper).toBeNull();
  });

  it("projects consecutive planned loads and defaults projectDays to their length", () => {
    const trend = buildFitnessTrend(
      { days: block(12) },
      { plannedLoads: [70, 0, 70] },
    );
    expect(trend.projection).toHaveLength(3);
    expect(trend.projection.map((d) => [d.date, d.load])).toEqual([
      ["2026-06-29", 70],
      ["2026-06-30", 0],
      ["2026-07-01", 70],
    ]);
    // Loading past the window keeps fatigue up, so TSB sits below the
    // equivalent rest projection.
    const rest = buildFitnessTrend({ days: block(12) }, { projectDays: 3 });
    expect(trend.projection[2]!.tsb).toBeLessThan(rest.projection[2]!.tsb);
  });

  it("rests the days a dated plan does not name", () => {
    const trend = buildFitnessTrend(
      { days: block(12) },
      {
        projectDays: 4,
        plannedLoads: [
          { date: "2026-06-30", load: 90 },
          { date: "2026-07-02", load: 45 },
        ],
      },
    );
    expect(trend.projection.map((d) => d.load)).toEqual([0, 90, 0, 45]);
  });

  it("ignores planned days past the projection window", () => {
    const trend = buildFitnessTrend(
      { days: block(12) },
      { projectDays: 1, plannedLoads: [50, 50, 50] },
    );
    expect(trend.projection.map((d) => d.load)).toEqual([50]);
  });
});

describe("taperWeekWeights", () => {
  it("steps down one weight per week, first week heaviest", () => {
    expect(taperWeekWeights(21)).toEqual([
      1,
      TAPER_WEEK_DECAY,
      TAPER_WEEK_DECAY ** 2,
    ]);
  });

  it("counts a partial trailing week", () => {
    expect(taperWeekWeights(9)).toHaveLength(2);
    expect(taperWeekWeights(1)).toEqual([1]);
    expect(taperWeekWeights(0)).toEqual([1]);
  });
});

describe("recentDailyLoad", () => {
  it("averages the trailing window", () => {
    const series: FitnessTrendDay[] = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      load: i < 2 ? 999 : 10,
      ctl: 0,
      atl: 0,
      tsb: 0,
    }));
    // The two 999 days fall outside the trailing 28.
    expect(recentDailyLoad(series, RECENT_LOAD_DAYS)).toBe(10);
  });

  it("returns zero for an empty series", () => {
    expect(recentDailyLoad([], RECENT_LOAD_DAYS)).toBe(0);
  });
});

describe("solveTaperPlan", () => {
  // Mid-block state: fitness built up, carrying fatigue (TSB −15).
  const start = { ctl: 60, atl: 75 };

  it("lands on the target TSB on the target date", () => {
    const plan = solveTaperPlan(
      start,
      "2026-06-28",
      { targetDate: "2026-07-19", targetTsb: 10 },
      45,
    );
    expect(plan.feasible).toBe(true);
    expect(plan.note).toBeNull();
    expect(plan.achieved_tsb).toBeCloseTo(10, 1);
    expect(plan.days).toHaveLength(21);
    expect(plan.days[20]!.date).toBe("2026-07-19");
    expect(plan.days[20]!.tsb).toBeCloseTo(10, 1);
  });

  it("prescribes real training, stepping down week by week", () => {
    const plan = solveTaperPlan(
      start,
      "2026-06-28",
      { targetDate: "2026-07-19", targetTsb: 10 },
      45,
    );
    expect(plan.weeks).toHaveLength(3);
    expect(plan.weeks[0]!.daily_load).toBeGreaterThan(0);
    expect(plan.weeks[1]!.daily_load).toBeLessThan(plan.weeks[0]!.daily_load);
    expect(plan.weeks[2]!.daily_load).toBeLessThan(plan.weeks[1]!.daily_load);
    expect(plan.weeks.map((w) => w.days)).toEqual([7, 7, 7]);
    expect(plan.weeks[0]!.start_date).toBe("2026-06-29");
    expect(plan.weeks[2]!.end_date).toBe("2026-07-19");
    expect(plan.total_load).toBeCloseTo(
      plan.weeks.reduce((sum, w) => sum + w.week_load, 0),
      0,
    );
    // Reported against the 45/day the athlete has been averaging.
    expect(plan.weeks[0]!.pct_of_recent).toBeGreaterThan(0);
    expect(plan.recent_daily_load).toBe(45);
  });

  it("is a taper, not rest: more load than the zero-load projection", () => {
    const plan = solveTaperPlan(
      start,
      "2026-06-28",
      { targetDate: "2026-07-19", targetTsb: 10 },
      45,
    );
    const rest = solveTaperPlan(
      start,
      "2026-06-28",
      { targetDate: "2026-07-19", targetTsb: 10, weekWeights: [0, 0, 0] },
      45,
    );
    expect(plan.total_load).toBeGreaterThan(0);
    // Resting three weeks overshoots +10, which is exactly why a plan is
    // worth solving: it keeps the fitness the rest would shed.
    expect(rest.achieved_tsb).toBeGreaterThan(plan.achieved_tsb - 0.001);
    expect(plan.days[20]!.ctl).toBeGreaterThan(rest.days[20]!.ctl);
  });

  it("honours caller-supplied week weights", () => {
    const plan = solveTaperPlan(
      start,
      "2026-06-28",
      { targetDate: "2026-07-12", targetTsb: 5, weekWeights: [1, 1] },
      40,
    );
    expect(plan.weeks[0]!.daily_load).toBeCloseTo(plan.weeks[1]!.daily_load, 1);
    expect(plan.achieved_tsb).toBeCloseTo(5, 1);
  });

  it("reports a target that even complete rest cannot reach", () => {
    const plan = solveTaperPlan(
      start,
      "2026-06-28",
      { targetDate: "2026-06-30", targetTsb: 25 },
      45,
    );
    expect(plan.feasible).toBe(false);
    expect(plan.note).toContain("complete rest");
    expect(plan.total_load).toBe(0);
    // Still reports where rest actually lands.
    expect(plan.achieved_tsb).toBeLessThan(25);
    expect(plan.achieved_tsb).toBeGreaterThan(plan.days[0]!.tsb - 100);
  });

  it("caps an absurdly negative target at the daily-load ceiling", () => {
    const plan = solveTaperPlan(
      start,
      "2026-06-28",
      { targetDate: "2026-07-01", targetTsb: -150 },
      45,
    );
    expect(plan.feasible).toBe(false);
    expect(plan.note).toContain(String(MAX_TAPER_DAILY_LOAD));
    expect(Math.max(...plan.days.map((d) => d.load))).toBeCloseTo(
      MAX_TAPER_DAILY_LOAD,
      1,
    );
    expect(plan.achieved_tsb).toBeGreaterThan(-150);
  });

  it("rejects a target date that is not in the future", () => {
    const plan = solveTaperPlan(
      start,
      "2026-06-28",
      { targetDate: "2026-06-28", targetTsb: 10 },
      45,
    );
    expect(plan.feasible).toBe(false);
    expect(plan.note).toContain("at least one day");
    expect(plan.weeks).toEqual([]);
    expect(plan.days).toEqual([]);
    expect(plan.achieved_tsb).toBe(-15);
  });

  it("omits pct_of_recent when there is no recent load to compare to", () => {
    const plan = solveTaperPlan(start, "2026-06-28", {
      targetDate: "2026-07-05",
      targetTsb: 0,
    });
    expect(plan.weeks[0]!.pct_of_recent).toBeNull();
    expect(plan.recent_daily_load).toBe(0);
  });

  it("comes through buildFitnessTrend with the recorded window as its start", () => {
    const trend = buildFitnessTrend(
      {
        days: window("2026-06-28", 90, rangeLoads("2026-05-20", 40, 55)),
      },
      { taper: { targetDate: "2026-07-12", targetTsb: 8 } },
    );
    expect(trend.taper).not.toBeNull();
    expect(trend.taper!.achieved_tsb).toBeCloseTo(8, 1);
    expect(trend.taper!.days[0]!.date).toBe("2026-06-29");
    // The plan continues the recorded series, so it starts from its last day.
    const current = trend.current!;
    const first = trend.taper!.days[0]!;
    expect(Math.abs(first.ctl - current.ctl)).toBeLessThan(10);
    expect(trend.taper!.recent_daily_load).toBeGreaterThan(0);
  });
});

describe("daysBetween", () => {
  it("counts whole days in both directions", () => {
    expect(daysBetween("2026-06-28", "2026-07-05")).toBe(7);
    expect(daysBetween("2026-07-05", "2026-06-28")).toBe(-7);
    expect(daysBetween("2026-06-28", "2026-06-28")).toBe(0);
  });

  it("is unaffected by a DST boundary", () => {
    // Southern-hemisphere DST end, a UTC-safe arithmetic check.
    expect(daysBetween("2026-04-01", "2026-04-30")).toBe(29);
  });
});

describe("trendBands", () => {
  function day(date: string, tsb: number, ctl = 50): FitnessTrendDay {
    return { date, load: 0, ctl, atl: ctl - tsb, tsb };
  }

  it("dates a resolved deep-fatigue block the flags no longer raise", () => {
    const series = [
      day("2026-07-01", 0),
      ...Array.from({ length: DEEP_FATIGUE_DAYS }, (_, i) =>
        day(`2026-07-0${i + 2}`, DEEP_FATIGUE_TSB - 2),
      ),
      day("2026-07-08", 5),
    ];
    const bands = trendBands(series);
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({
      kind: "deep-fatigue",
      start_date: "2026-07-02",
      end_date: "2026-07-06",
      days: DEEP_FATIGUE_DAYS,
    });
    // The chart still shades it; the flag list has moved on.
    expect(computeFlags(series)).toEqual([]);
  });

  it("ignores a deep dip shorter than the streak threshold", () => {
    const series = [
      day("2026-07-01", DEEP_FATIGUE_TSB - 1),
      day("2026-07-02", DEEP_FATIGUE_TSB - 1),
      day("2026-07-03", 0),
    ];
    expect(trendBands(series)).toEqual([]);
  });

  it("breaks a run at a date gap instead of bridging it", () => {
    const series = [
      day("2026-07-01", DEEP_FATIGUE_TSB - 2),
      day("2026-07-02", DEEP_FATIGUE_TSB - 2),
      day("2026-07-03", DEEP_FATIGUE_TSB - 2),
      // 2026-07-04 is missing: a gap, not a rest day.
      day("2026-07-05", DEEP_FATIGUE_TSB - 2),
      day("2026-07-06", DEEP_FATIGUE_TSB - 2),
      day("2026-07-07", DEEP_FATIGUE_TSB - 2),
    ];
    // Six days at or below the threshold would meet DEEP_FATIGUE_DAYS (5) as
    // one run bridged across the gap; split by the gap, each side is only
    // 3 days and neither qualifies on its own.
    expect(trendBands(series)).toEqual([]);
  });

  it("looks up the CTL ramp's prior day by date, not by array index, across a gap", () => {
    const series = [
      day("2026-06-20", -5, 10),
      // 2026-06-21 through 2026-07-14 missing: a gap of several weeks.
      day("2026-07-15", -5, 20),
      day("2026-07-16", -5, 30),
      day("2026-07-17", -5, 40),
      day("2026-07-18", -5, 50),
      day("2026-07-19", -5, 60),
      day("2026-07-20", -5, 70),
      day("2026-07-21", -5, 80),
    ];
    // Array index 7 ("2026-07-21") minus 7 lands on index 0 ("2026-06-20"),
    // a month earlier, not 7 calendar days back (2026-07-14, itself missing);
    // an index-based lookback would misread this as a 70-point ramp.
    expect(trendBands(series).filter((b) => b.kind === "steep-ramp")).toEqual(
      [],
    );
  });

  it("bands each fresh stretch separately", () => {
    const series = [
      day("2026-07-01", FRESH_TSB + 1),
      day("2026-07-02", 0),
      day("2026-07-03", FRESH_TSB),
      day("2026-07-04", FRESH_TSB + 4),
    ];
    const fresh = trendBands(series).filter((b) => b.kind === "fresh");
    expect(fresh.map((b) => [b.start_date, b.end_date])).toEqual([
      ["2026-07-01", "2026-07-01"],
      ["2026-07-03", "2026-07-04"],
    ]);
    // Reason quotes the band's own last day, not the series' last day.
    expect(fresh[0]!.reason).toContain(`TSB at ${FRESH_TSB + 1}`);
  });

  it("bands a steep CTL ramp and needs a week of runway first", () => {
    const series = Array.from({ length: 12 }, (_, i) =>
      day(`2026-07-${String(i + 1).padStart(2, "0")}`, -5, 40 + i * 2),
    );
    const ramp = trendBands(series).filter((b) => b.kind === "steep-ramp");
    expect(ramp).toHaveLength(1);
    // Ramp needs day i-7, so the earliest possible band day is the 8th.
    expect(ramp[0]!.start_date).toBe("2026-07-08");
    expect(ramp[0]!.end_date).toBe("2026-07-12");
    expect(ramp[0]!.reason).toContain(
      `CTL climbed ${RAMP_RISK_PER_WEEK * 2.8}`,
    );
  });

  it("returns nothing for an empty series", () => {
    expect(trendBands([])).toEqual([]);
  });

  it("comes back from buildFitnessTrend alongside the flags", () => {
    const trend = buildFitnessTrend({
      days: window("2026-07-21", 60, rangeLoads("2026-07-01", 21, 150)),
    });
    expect(trend.bands.length).toBeGreaterThan(0);
    // Every flag is a band reason; bands may carry extra, older stretches.
    for (const flag of trend.flags) {
      expect(trend.bands.map((b) => b.reason)).toContain(flag);
    }
  });
});

describe("computeFlags", () => {
  function day(date: string, tsb: number, ctl = 50): FitnessTrendDay {
    return { date, load: 0, ctl, atl: ctl - tsb, tsb };
  }

  it("flags deep fatigue only when the streak reaches the window end", () => {
    const deep = Array.from({ length: DEEP_FATIGUE_DAYS }, (_, i) =>
      day(`2026-07-0${i + 1}`, DEEP_FATIGUE_TSB - 1),
    );
    expect(computeFlags(deep).join(" ")).toContain("deep fatigue");

    // Same streak but resolved (a fresh day after it): no flag.
    const resolved = [...deep, day("2026-07-06", 0)];
    expect(
      computeFlags(resolved).find((f) => f.includes("deep fatigue")),
    ).toBeUndefined();
  });

  it("does not flag a short deep-fatigue streak", () => {
    const days = [
      day("2026-07-01", 0),
      day("2026-07-02", DEEP_FATIGUE_TSB - 5),
      day("2026-07-03", DEEP_FATIGUE_TSB - 5),
    ];
    expect(
      computeFlags(days).find((f) => f.includes("deep fatigue")),
    ).toBeUndefined();
  });

  it("flags freshness at high positive TSB", () => {
    expect(computeFlags([day("2026-07-01", 20)]).join(" ")).toContain("fresh");
  });

  it("flags a steep CTL ramp over the trailing week", () => {
    const days = Array.from({ length: 9 }, (_, i) =>
      day(`2026-07-0${i + 1}`, -5, 40 + i),
    );
    expect(computeFlags(days).join(" ")).toContain("CTL climbed");
  });

  it("returns nothing for an empty series", () => {
    expect(computeFlags([])).toEqual([]);
  });
});

describe("projectFromWellness", () => {
  const ASOF = "2026-08-17";
  const ENDDATE = "2026-08-19"; // 2 unsynced days past asOfDate
  const SEED = { ctl: 60, atl: 40 };
  const series: FitnessTrendDay[] = [
    {
      date: ASOF,
      load: 80,
      ctl: SEED.ctl,
      atl: SEED.atl,
      tsb: SEED.ctl - SEED.atl,
    },
  ];

  it("gives an empty projection when projectDays is 0, even with unsynced days", () => {
    const result = projectFromWellness(
      { series, seed: SEED, asOfDate: ASOF, endDate: ENDDATE },
      { projectDays: 0 },
    );
    expect(result.projection).toEqual([]);
    expect(result.tsbPositiveDate).toBeNull();
    expect(result.taper).toBeNull();
    expect(result.unsyncedDays).toBe(2);
  });

  it("returns null for everything when there is no seed", () => {
    const result = projectFromWellness(
      { series: [], seed: null, asOfDate: null, endDate: ENDDATE },
      { projectDays: 14 },
    );
    expect(result).toEqual({
      projection: [],
      tsbPositiveDate: null,
      taper: null,
      unsyncedDays: 0,
      warnings: [],
    });
  });

  it("anchors a taper at endDate, not asOfDate, rolling unsynced days forward as rest", () => {
    const targetDate = addDays(ENDDATE, 21);
    const result = projectFromWellness(
      { series, seed: SEED, asOfDate: ASOF, endDate: ENDDATE },
      { projectDays: 0, taper: { targetDate, targetTsb: 10 } },
    );
    expect(result.taper).not.toBeNull();
    // Anchored at ENDDATE: the plan should run exactly 21 days, not 23 (which
    // anchoring at ASOF, 2 days earlier, would have produced).
    expect(result.taper!.days).toHaveLength(21);
    expect(result.taper!.days[0]!.date).toBe(addDays(ENDDATE, 1));

    const direct = solveTaperPlan(
      SEED,
      ASOF,
      { targetDate: addDays(ASOF, 23), targetTsb: 10 },
      recentDailyLoad(series, RECENT_LOAD_DAYS),
    );
    // A taper solved directly from ASOF over 23 days (2 unsynced + 21
    // requested) lands on the same target date and should reach the same
    // achieved TSB as the anchored-at-ENDDATE solve, since 2 rest days
    // change CTL/ATL identically whether folded into the taper solve itself
    // or rolled forward first.
    expect(result.taper!.achieved_tsb).toBeCloseTo(direct.achieved_tsb, 5);
  });

  it("warns that plannedLoads is dropped when a taper is requested", () => {
    const targetDate = addDays(ENDDATE, 21);
    const result = projectFromWellness(
      { series, seed: SEED, asOfDate: ASOF, endDate: ENDDATE },
      {
        projectDays: 0,
        plannedLoads: [{ date: addDays(ENDDATE, 3), load: 50 }],
        taper: { targetDate, targetTsb: 10 },
      },
    );
    expect(result.warnings).toContainEqual(
      expect.stringContaining("plannedLoads"),
    );
  });

  it("does not warn about plannedLoads when no taper is requested", () => {
    const result = projectFromWellness(
      { series, seed: SEED, asOfDate: ASOF, endDate: ENDDATE },
      {
        projectDays: 10,
        plannedLoads: [{ date: addDays(ENDDATE, 3), load: 50 }],
      },
    );
    expect(result.warnings).toEqual([]);
  });

  it("tsbPositiveDate never lands before endDate + 1", () => {
    const result = projectFromWellness(
      {
        series,
        seed: { ctl: 20, atl: 80 },
        asOfDate: ENDDATE,
        endDate: ENDDATE,
      },
      { projectDays: 30 },
    );
    if (result.tsbPositiveDate !== null) {
      expect(result.tsbPositiveDate > ENDDATE).toBe(true);
    }
  });
});
