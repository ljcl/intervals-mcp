import { describe, expect, it } from "vitest";
import {
  bestRepeatHill,
  computeGrades,
  computeHillAnalysis,
  GAP_MAX_GRADE_PCT,
  gapBasis,
  gapFactor,
  gapGrades,
  gapModelLine,
  gapSourceOf,
  gradeAdjustedSpeeds,
  HillAnalysisError,
  type HillStreams,
  interpolateNulls,
  NOISY_GRADE_RMS_PCT,
  normalizeHillStreams,
  resolveGapModel,
} from "./hillAnalysis";

/**
 * Build 1 Hz streams from course legs. Each leg runs at a constant speed,
 * grade, and HR; altitude integrates the grade so grade_smooth, altitude,
 * and distance stay consistent.
 */
interface Leg {
  lengthM: number;
  gradePct: number;
  speedMs: number;
  hr?: number;
  cadence?: number;
  watts?: number;
  moving?: boolean;
}

function buildStreams(legs: Leg[]): HillStreams {
  const time: number[] = [0];
  const distance: number[] = [0];
  const altitude: number[] = [100];
  const grade: number[] = [0];
  const hr: number[] = [legs[0]?.hr ?? 0];
  const velocity: number[] = [legs[0]?.speedMs ?? 0];
  const cadence: number[] = [legs[0]?.cadence ?? 0];
  const watts: number[] = [legs[0]?.watts ?? 0];
  const moving: boolean[] = [true];

  for (const leg of legs) {
    const seconds = Math.round(leg.lengthM / leg.speedMs);
    for (let s = 0; s < seconds; s++) {
      time.push(time[time.length - 1]! + 1);
      distance.push(distance[distance.length - 1]! + leg.speedMs);
      altitude.push(
        altitude[altitude.length - 1]! + (leg.speedMs * leg.gradePct) / 100,
      );
      grade.push(leg.gradePct);
      hr.push(leg.hr ?? 0);
      velocity.push(leg.speedMs);
      cadence.push(leg.cadence ?? 0);
      watts.push(leg.watts ?? 0);
      moving.push(leg.moving ?? true);
    }
  }

  return {
    time,
    distance,
    altitude,
    grade_smooth: grade,
    heartrate: hr,
    velocity_smooth: velocity,
    cadence,
    watts,
    moving,
  };
}

/** Keep every `n`th sample (and the first), as a sparse recording would. */
function everyNth(streams: HillStreams, n: number): HillStreams {
  const keep = <T>(values: T[] | undefined) =>
    values?.filter((_, i) => i % n === 0);
  return {
    time: keep(streams.time)!,
    distance: keep(streams.distance)!,
    altitude: keep(streams.altitude),
    grade_smooth: keep(streams.grade_smooth),
    heartrate: keep(streams.heartrate),
    velocity_smooth: keep(streams.velocity_smooth),
    cadence: keep(streams.cadence),
    watts: keep(streams.watts),
    moving: keep(streams.moving),
  };
}

const flat = (lengthM: number, extra: Partial<Leg> = {}): Leg => ({
  lengthM,
  gradePct: 0,
  speedMs: 3.5,
  hr: 140,
  ...extra,
});
const climb = (lengthM: number, extra: Partial<Leg> = {}): Leg => ({
  lengthM,
  gradePct: 6,
  speedMs: 2.5,
  hr: 155,
  ...extra,
});

describe("gapFactor", () => {
  it("is 1 on the flat", () => {
    expect(gapFactor(0)).toBeCloseTo(1, 5);
  });

  it("credits uphill and discounts moderate downhill", () => {
    expect(gapFactor(0.06)).toBeGreaterThan(1);
    expect(gapFactor(-0.06)).toBeLessThan(1);
    expect(gapFactor(-0.06)).toBeGreaterThan(0);
  });

  it("clamps extreme gradients to a positive cost", () => {
    expect(gapFactor(-0.9)).toBeGreaterThan(0);
    expect(gapFactor(0.9)).toBe(gapFactor(0.35));
  });
});

describe("computeGrades", () => {
  it("derives grade from altitude even when grade_smooth is present", () => {
    const streams = buildStreams([flat(200), climb(400), flat(200)]);
    // grade_smooth disagrees with the altitude the segments report (#297).
    streams.grade_smooth = streams.grade_smooth!.map(() => -5);
    const result = computeGrades(normalizeHillStreams(streams));
    expect(result.source).toBe("computed");
    const mid = Math.floor(streams.time.length / 2);
    expect(result.grades[mid]).toBeCloseTo(6, 0);
  });

  it("uses the grade_smooth stream when there is no altitude", () => {
    const streams = buildStreams([flat(100)]);
    streams.altitude = undefined;
    const result = computeGrades(normalizeHillStreams(streams));
    expect(result.source).toBe("grade_smooth");
    expect(result.grades).toEqual(streams.grade_smooth);
  });

  it("derives grade from altitude over a window when grade_smooth is absent", () => {
    const streams = buildStreams([flat(200), climb(400), flat(200)]);
    streams.grade_smooth = undefined;
    const result = computeGrades(normalizeHillStreams(streams));
    expect(result.source).toBe("computed");
    // Mid-climb samples should read near the true 6%.
    const mid = Math.floor(streams.time.length / 2);
    expect(result.grades[mid]).toBeCloseTo(6, 0);
    expect(result.grades[5]).toBeCloseTo(0, 1);
  });

  it("throws without grade or altitude", () => {
    const streams = buildStreams([flat(100)]);
    streams.grade_smooth = undefined;
    streams.altitude = undefined;
    expect(() => computeGrades(normalizeHillStreams(streams))).toThrow(
      HillAnalysisError,
    );
  });

  it("falls back to computed when grade_smooth is entirely null", () => {
    const streams = buildStreams([flat(200), climb(400), flat(200)]);
    streams.grade_smooth = streams.grade_smooth!.map(() => null);
    const result = computeGrades(normalizeHillStreams(streams));
    expect(result.source).toBe("computed");
  });

  it("keeps grade_smooth as the source and interpolates across a partial null run", () => {
    const streams = buildStreams([flat(200), climb(400), flat(200)]);
    streams.altitude = undefined;
    const grade = streams.grade_smooth as (number | null)[];
    // Blank out a short mid-climb stretch; the values on either side are
    // both real recorded samples, not the whole stream going dark.
    const start = Math.floor(grade.length / 2) - 2;
    for (let i = start; i < start + 4; i++) grade[i] = null;

    const result = computeGrades(normalizeHillStreams(streams));

    expect(result.source).toBe("grade_smooth");
    // The interpolated gap sits close to the surrounding climb grade, not 0.
    expect(result.grades[start + 1]).toBeCloseTo(6, 0);
    expect(result.grades.every((g) => g != null && Number.isFinite(g))).toBe(
      true,
    );
  });
});

describe("gapGrades", () => {
  /** Cumulative distance for `n` samples `step` metres apart. */
  const distances = (n: number, step: number) =>
    Array.from({ length: n }, (_, i) => i * step);

  it("keeps a steady climb's grade and adds no warning", () => {
    const distance = distances(1000, 3.5);
    const result = gapGrades(
      distance.map(() => 3),
      distance,
    );
    expect(result.grades.every((g) => Math.abs(g - 3) < 1e-9)).toBe(true);
    expect(result.noiseRmsPct).toBeCloseTo(0, 9);
    expect(result.warning).toBeNull();
  });

  it("averages ±10% zero-mean noise out and flags the track as noisy", () => {
    const distance = distances(2000, 3.5);
    const noisy = distance.map((_, i) => (i % 2 === 0 ? 10 : -10));
    const result = gapGrades(noisy, distance);
    const worst = Math.max(...result.grades.map(Math.abs));
    // A 100 m window holds ~28 samples, so the residual is under 1%.
    expect(worst).toBeLessThan(1);
    expect(result.noiseRmsPct).toBeGreaterThan(NOISY_GRADE_RMS_PCT);
    expect(result.warning).toContain("noisy");
  });

  it("follows a grade change over about the window, not a sample", () => {
    const distance = distances(600, 1);
    const grades = distance.map((d) => (d < 300 ? 0 : 6));
    const result = gapGrades(grades, distance);
    expect(result.grades[100]).toBeCloseTo(0, 9);
    expect(result.grades[300]).toBeCloseTo(3, 0);
    expect(result.grades[500]).toBeCloseTo(6, 9);
    expect(result.warning).toBeNull();
  });

  it("clamps an averaged grade to the running range", () => {
    const distance = distances(200, 1);
    const result = gapGrades(
      distance.map(() => 60),
      distance,
    );
    expect(Math.max(...result.grades)).toBe(GAP_MAX_GRADE_PCT);
  });
});

describe("interpolateNulls", () => {
  it("straight-lines a null run bounded by known samples", () => {
    expect(interpolateNulls([0, null, null, 3])).toEqual([0, 1, 2, 3]);
  });

  it("holds the nearest known value flat across a leading or trailing gap", () => {
    expect(interpolateNulls([null, null, 5, 6])).toEqual([5, 5, 5, 6]);
    expect(interpolateNulls([5, 6, null, null])).toEqual([5, 6, 6, 6]);
  });

  it("passes fully-populated arrays through unchanged", () => {
    expect(interpolateNulls([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("refuses an all-null stream instead of filling it with 0", () => {
    expect(() => interpolateNulls([null, null, null])).toThrow(RangeError);
  });
});

describe("normalizeHillStreams", () => {
  it("interpolates null distance and altitude samples rather than zeroing them", () => {
    const streams = buildStreams([flat(1000), climb(500), flat(1000)]);
    const withGaps: HillStreams = {
      ...streams,
      distance: streams.distance.map((d, i) => (i % 50 === 1 ? null : d)),
      altitude: streams.altitude!.map((a, i) => (i % 70 === 2 ? null : a)),
      grade_smooth: undefined,
    };
    const normalized = normalizeHillStreams(withGaps);
    expect(
      normalized.distance.some((d) => d === 0 && streams.distance[0] !== 0),
    ).toBe(false);
    // Distance stays non-decreasing after interpolation.
    for (let i = 1; i < normalized.distance.length; i++) {
      expect(normalized.distance[i]).toBeGreaterThanOrEqual(
        normalized.distance[i - 1]!,
      );
    }
  });

  it("drops an entirely-null grade_smooth stream back to computed", () => {
    const streams = buildStreams([flat(200)]);
    streams.grade_smooth = streams.grade_smooth!.map(() => null);
    const normalized = normalizeHillStreams(streams);
    expect(normalized.grade_smooth).toBeUndefined();
  });

  it("drops an entirely-null altitude stream instead of reading it as flat", () => {
    const streams = buildStreams([flat(200)]);
    streams.altitude = streams.altitude!.map(() => null);
    const normalized = normalizeHillStreams(streams);
    expect(normalized.altitude).toBeUndefined();
  });
});

describe("computeHillAnalysis", () => {
  it("reports a flat run as having no climbs", () => {
    const analysis = computeHillAnalysis(buildStreams([flat(5000)]));
    expect(analysis.climbs).toHaveLength(0);
    expect(analysis.drift).toBeNull();
    expect(analysis.gradeSource).toBe("computed");
    expect(analysis.warnings.join(" ")).toContain("flat activity");
  });

  it("reports a computed grade source when grade_smooth is absent", () => {
    const streams = buildStreams([flat(1000), climb(500), flat(1000)]);
    streams.grade_smooth = undefined;
    const analysis = computeHillAnalysis(streams);
    expect(analysis.gradeSource).toBe("computed");
  });

  it("excludes null heart rate and cadence samples from a climb's average rather than treating them as zero", () => {
    const streams = buildStreams([flat(1000), climb(500), flat(1000)]);
    const climbStart = streams.grade_smooth!.indexOf(6);
    // Null out half the climb's HR and cadence samples.
    const withGaps: HillStreams = {
      ...streams,
      heartrate: streams.heartrate!.map((hr, i) =>
        i >= climbStart && i % 2 === 0 ? null : hr,
      ),
    };
    const analysis = computeHillAnalysis(withGaps);
    expect(analysis.climbs).toHaveLength(1);
    // The surviving samples are all 155 bpm, so the average must hold there,
    // not be dragged toward zero by the null samples. (The trailing 30 m
    // altitude window carries the climb a few 140 bpm samples past its top.)
    expect(analysis.climbs[0]!.avgHr).toBeGreaterThanOrEqual(154);
  });

  it("detects a single sustained climb with sane metrics", () => {
    const analysis = computeHillAnalysis(
      buildStreams([flat(1000), climb(500), flat(1000)]),
    );
    expect(analysis.climbs).toHaveLength(1);
    const c = analysis.climbs[0]!;
    expect(c.startKm).toBeCloseTo(1, 1);
    expect(c.lengthM).toBeGreaterThanOrEqual(450);
    expect(c.lengthM).toBeLessThanOrEqual(600);
    expect(c.avgGradePct).toBeCloseTo(6, 0);
    expect(c.elevationChangeM).toBeGreaterThan(25);
    // Within a beat: the trailing 30 m altitude window lags the top.
    expect(c.avgHr).toBeGreaterThanOrEqual(154);
    // 2.5 m/s = 400 s/km raw, less a few faster samples past the top that
    // the trailing altitude window keeps; GAP must be meaningfully faster.
    expect(Math.abs(c.paceSecPerKm! - 400)).toBeLessThanOrEqual(10);
    expect(c.gapPaceSecPerKm!).toBeLessThan(c.paceSecPerKm!);
  });

  // velocity_smooth runs about 1% above distance over time on real
  // recordings; segment GAP rides the same distance and moving time as pace
  // (#298), so the speed stream cannot move it.
  it("takes climb GAP from distance over moving time, not velocity_smooth", () => {
    const streams = buildStreams([flat(1000), climb(500), flat(1000)]);
    const base = computeHillAnalysis(streams).climbs[0]!;
    const fast = computeHillAnalysis({
      ...streams,
      velocity_smooth: streams.velocity_smooth!.map((v) => v! * 1.01),
    }).climbs[0]!;
    expect(fast.gapPaceSecPerKm).toBe(base.gapPaceSecPerKm);
    // 6% climb: GAP is the pace divided by the Minetti factor, edges aside.
    expect(
      Math.abs(base.gapPaceSecPerKm! - base.paceSecPerKm! / gapFactor(0.06)),
    ).toBeLessThanOrEqual(8);
  });

  // Smart recording samples every 10-20 s. Moving time took the 10 s
  // average weight cap, so a 15 s sample counted as 10 s and the pace came
  // out a third too fast (#222).
  it("reports the true pace and power when samples are 15 s apart", () => {
    const sparse = everyNth(
      buildStreams([flat(1000), climb(600, { watts: 250 }), flat(1000)]),
      15,
    );
    const analysis = computeHillAnalysis(sparse);
    expect(analysis.climbs).toHaveLength(1);
    const c = analysis.climbs[0]!;
    // 2.5 m/s = 400 s/km, the pace get-split-analysis reports too.
    expect(c.paceSecPerKm).toBeCloseTo(400, -1);
    expect(c.movingTimeS).toBeCloseTo(c.lengthM / 2.5, -1);
    // Power coverage compares capped weights, so full coverage stays full.
    expect(c.avgWatts).toBeCloseTo(250, 0);
  });

  it("ignores bumps shorter than the minimum length", () => {
    const analysis = computeHillAnalysis(
      buildStreams([flat(1000), climb(100), flat(1000)]),
    );
    expect(analysis.climbs).toHaveLength(0);
  });

  it("keeps one climb across a brief dip shorter than the grace distance", () => {
    const analysis = computeHillAnalysis(
      buildStreams([
        flat(500),
        climb(300),
        flat(100), // brief flat shelf mid-climb
        climb(300),
        flat(500),
      ]),
    );
    expect(analysis.climbs).toHaveLength(1);
    expect(analysis.climbs[0]!.lengthM).toBeGreaterThan(600);
  });

  it("splits climbs separated by more than the grace distance", () => {
    const analysis = computeHillAnalysis(
      buildStreams([flat(500), climb(300), flat(400), climb(300), flat(500)]),
    );
    expect(analysis.climbs).toHaveLength(2);
  });

  it("detects descents with their pace and cadence", () => {
    const analysis = computeHillAnalysis(
      buildStreams([
        flat(1000),
        { lengthM: 500, gradePct: -6, speedMs: 4.2, hr: 130, cadence: 92 },
        flat(1000),
      ]),
    );
    expect(analysis.descents).toHaveLength(1);
    const d = analysis.descents[0]!;
    expect(d.avgGradePct).toBeCloseTo(-6, 0);
    expect(d.elevationChangeM).toBeLessThan(0);
    expect(d.avgCadence).toBeCloseTo(92, 0);
    expect(d.paceSecPerKm).toBeCloseTo(1000 / 4.2, -1);
  });

  it("reports positive drift when late climbs cost more HR per GAP speed", () => {
    const analysis = computeHillAnalysis(
      buildStreams([
        flat(1000),
        climb(400, { hr: 150 }),
        flat(3000),
        climb(400, { hr: 165 }), // same speed and grade, higher HR
        flat(1000),
      ]),
    );
    expect(analysis.climbs).toHaveLength(2);
    expect(analysis.drift).not.toBeNull();
    expect(analysis.drift!.basis).toBe("hr_per_gap");
    expect(analysis.drift!.driftPct).toBeGreaterThan(5);
    expect(analysis.drift!.earlyClimbs).toBe(1);
    expect(analysis.drift!.lateClimbs).toBe(1);
  });

  it("falls back to GAP-pace drift without heart rate", () => {
    const streams = buildStreams([
      flat(1000),
      climb(400, { speedMs: 2.8 }),
      flat(3000),
      climb(400, { speedMs: 2.4 }), // slower late at the same grade
      flat(1000),
    ]);
    streams.heartrate = undefined;
    const analysis = computeHillAnalysis(streams);
    expect(analysis.drift!.basis).toBe("gap_pace");
    expect(analysis.drift!.driftPct).toBeGreaterThan(5);
    expect(analysis.warnings.join(" ")).toContain("No heart rate");
  });

  it("returns null drift when all climbs sit in one half", () => {
    const analysis = computeHillAnalysis(
      buildStreams([climb(400), flat(400), climb(400), flat(6000)]),
    );
    expect(analysis.climbs.length).toBeGreaterThanOrEqual(1);
    expect(analysis.drift).toBeNull();
    expect(analysis.warnings.join(" ")).toContain("early-vs-late");
  });

  it("excludes stopped time from climb pace", () => {
    const withStop = computeHillAnalysis(
      buildStreams([
        flat(1000),
        climb(200),
        { ...climb(100), speedMs: 0.2, moving: false },
        climb(200),
        flat(1000),
      ]),
    );
    expect(withStop.climbs).toHaveLength(1);
    // 400 m of genuine climbing at 2.5 m/s = 160 s moving; the 500 s
    // stopped shuffle must not appear in the pace.
    expect(withStop.climbs[0]!.paceSecPerKm).toBeLessThan(500);
  });

  it("aggregates climb totals", () => {
    const analysis = computeHillAnalysis(
      buildStreams([flat(500), climb(300), flat(3000), climb(500), flat(500)]),
    );
    expect(analysis.totals.climbCount).toBe(2);
    expect(analysis.totals.climbDistanceM).toBeGreaterThan(700);
    expect(analysis.totals.climbGainM).toBeGreaterThan(40);
  });

  it("throws on a missing distance stream", () => {
    expect(() =>
      computeHillAnalysis({ time: [0, 1], distance: [] as number[] }),
    ).toThrow(HillAnalysisError);
    expect(() =>
      computeHillAnalysis({ time: [0, 1], distance: [null, null] }),
    ).toThrow(HillAnalysisError);
  });

  it("refuses an all-null altitude with no grade rather than calling the run flat", () => {
    const streams = buildStreams([flat(1000), climb(500), flat(1000)]);
    streams.grade_smooth = undefined;
    streams.altitude = streams.altitude!.map(() => null);
    expect(() => computeHillAnalysis(streams)).toThrow(/elevation data/);
  });

  it("warns on a noisy elevation track and keeps climb GAP on the averaged grade", () => {
    const streams = buildStreams([flat(1000), climb(600), flat(1000)]);
    const clean = computeHillAnalysis(streams);
    // About ±2 m of barometric noise on the climb's altitude, on a 13-sample
    // cycle so the 30 m (12-sample) altitude window cannot cancel it. (On
    // the flat too, the raw grade would open phantom climbs: detection still
    // reads the per-sample grade.)
    streams.altitude = streams.altitude!.map((a, i) =>
      streams.grade_smooth![i] === 6 ? a! + (((i * 5) % 13) - 6) / 3 : a,
    );
    const noisy = computeHillAnalysis(streams);
    expect(clean.warnings.join(" ")).not.toContain("noisy");
    expect(noisy.warnings.join(" ")).toContain("elevation track is noisy");
    expect(noisy.climbs).toHaveLength(1);
    // Averaged, the noise cancels: the climb's GAP barely moves.
    const cleanGap = clean.climbs[0]!.gapPaceSecPerKm!;
    expect(
      Math.abs(noisy.climbs[0]!.gapPaceSecPerKm! - cleanGap) / cleanGap,
    ).toBeLessThan(0.01);
  });

  describe("segment power (ljcl/strava-mcp#213)", () => {
    it("reports power for a climb with full coverage", () => {
      const analysis = computeHillAnalysis(
        buildStreams([flat(1000), climb(500, { watts: 250 }), flat(1000)]),
      );
      expect(analysis.climbs).toHaveLength(1);
      expect(analysis.climbs[0]!.avgWatts).toBeCloseTo(250, 0);
    });

    it("excludes zero-watt dropout samples from the average", () => {
      const streams = buildStreams([
        flat(1000),
        climb(500, { watts: 250 }),
        flat(1000),
      ]);
      // Drop out a quarter of the climb's power to 0 (still >70% coverage).
      const watts = streams.watts!;
      const zeroStart = Math.floor(watts.length * 0.44);
      const zeroEnd = Math.floor(watts.length * 0.5);
      for (let i = zeroStart; i < zeroEnd; i++) watts[i] = 0;
      const analysis = computeHillAnalysis(streams);
      // The surviving samples are all 250 W, so the average must stay ~250,
      // not be dragged toward zero by the dropout.
      expect(analysis.climbs[0]!.avgWatts).toBeCloseTo(250, 0);
    });

    it("omits power when coverage is too thin", () => {
      const streams = buildStreams([
        flat(1000),
        climb(500, { watts: 250 }),
        flat(1000),
      ]);
      // Zero out the whole climb's power (a full stream-gap segment).
      const watts = streams.watts!;
      for (let i = 0; i < watts.length; i++) watts[i] = 0;
      const analysis = computeHillAnalysis(streams);
      expect(analysis.climbs[0]!.avgWatts).toBeNull();
    });

    it("leaves power absent when there is no watts stream", () => {
      const streams = buildStreams([flat(1000), climb(500), flat(1000)]);
      streams.watts = undefined;
      const analysis = computeHillAnalysis(streams);
      expect(analysis.climbs[0]!.avgWatts).toBeNull();
    });
  });
});

describe("bestRepeatHill", () => {
  /** 0-1000 m every 10 m; altitude rises `rise` m between `from` and `to`. */
  function track(from: number, to: number, rise: number) {
    const distance = Array.from({ length: 101 }, (_, i) => i * 10);
    const altitude = distance.map((d) =>
      d <= from
        ? 10
        : d >= to
          ? 10 + rise
          : 10 + (rise * (d - from)) / (to - from),
    );
    return { distance, altitude };
  }

  it("finds a 120 m hill at about 6.7%", () => {
    const { distance, altitude } = track(300, 420, 8);
    expect(bestRepeatHill(distance, altitude)).toEqual({
      start_m: 300,
      length_m: 120,
      grade_pct: 6.7,
    });
  });

  it.each([
    ["flat", track(300, 420, 0)],
    ["downhill", track(300, 420, -8)],
    ["a 30% wall", track(300, 400, 30)],
    ["a 30 m hill", track(300, 330, 2)],
  ])("is null for %s", (_label, { distance, altitude }) => {
    expect(bestRepeatHill(distance, altitude)).toBeNull();
  });

  it("interpolates null altitude, null when there is none", () => {
    const { distance, altitude } = track(300, 420, 8);
    const gappy: (number | null)[] = [...altitude];
    gappy[35] = null;
    expect(bestRepeatHill(distance, gappy)?.start_m).toBe(300);
    expect(
      bestRepeatHill(
        distance,
        distance.map(() => null),
      ),
    ).toBeNull();
  });
});

describe("resolveGapModel (#508)", () => {
  const ga = [null, 3.1, 3.2];

  it("follows the activity's Strava model when its stream has a sample", () => {
    expect(
      resolveGapModel(
        { gap_model: "STRAVA_RUN", use_elevation_correction: true },
        { ga_velocity: ga },
        "corrected",
      ),
    ).toEqual({ model: "strava", gaVelocity: ga, note: null });
  });

  it("follows it on the recorded altitude when the activity has no correction", () => {
    const result = resolveGapModel(
      { gap_model: "STRAVA_RUN", use_elevation_correction: false },
      { ga_velocity: ga },
      "barometric",
    );
    expect(result.model).toBe("strava");
  });

  it.each([
    ["NONE", "NONE"],
    ["missing", undefined],
    ["null", null],
    ["a model added later", "SOMETHING_NEW"],
  ])("uses Minetti with no note when gap_model is %s", (_, gap_model) => {
    expect(
      resolveGapModel({ gap_model }, { ga_velocity: ga }, "corrected"),
    ).toEqual({ model: "minetti", gaVelocity: undefined, note: null });
  });

  it.each([
    ["missing", undefined],
    ["all null", [null, null, null]],
  ])("uses Minetti with a note when the stream is %s", (_, stream) => {
    const result = resolveGapModel(
      { gap_model: "STRAVA_RUN" },
      { ga_velocity: stream },
      "corrected",
    );
    expect(result.model).toBe("minetti");
    expect(result.gaVelocity).toBeUndefined();
    expect(result.note).toContain("no intervals.icu grade-adjusted speed");
  });

  it("uses Minetti with a note when the analysis reads the recorded altitude of a corrected activity", () => {
    const result = resolveGapModel(
      { gap_model: "STRAVA_RUN", use_elevation_correction: true },
      { ga_velocity: ga },
      "barometric",
    );
    expect(result.model).toBe("minetti");
    expect(result.gaVelocity).toBeUndefined();
    expect(result.note).toContain("corrected elevation");
  });
});

describe("gapSourceOf and gapModelLine (#508)", () => {
  it("maps the model to the legacy gap_source value", () => {
    expect(gapSourceOf("strava")).toBe("intervals.icu");
    expect(gapSourceOf("minetti")).toBe("model");
    expect(gapSourceOf(null)).toBe("model");
  });

  it("names the model and adds the note", () => {
    expect(gapModelLine({ model: "strava", note: null })).toBe(
      "GAP model: Strava (the intervals.icu number for this activity)",
    );
    expect(gapModelLine({ model: "minetti", note: "Because." })).toBe(
      "GAP model: Minetti (computed here from grade). Because.",
    );
  });
});

describe("gapBasis (#508)", () => {
  const base = {
    time: [0, 1, 2, 3, 4],
    distance: [0, 3, 6, 9, 12],
  };

  it("is null with no GAP speed and no grade", () => {
    expect(gapBasis(base, null)).toBeNull();
  });

  it("weights each metre by the Minetti factor of the averaged grade", () => {
    const flatBasis = gapBasis(base, [0, 0, 0, 0, 0])!;
    expect(flatBasis.model).toBe("minetti");
    expect(flatBasis.metres).toEqual([0, 3, 3, 3, 3]);
    expect(flatBasis.seconds).toEqual([0, 1, 1, 1, 1]);

    const uphill = gapBasis(base, [6, 6, 6, 6, 6])!;
    expect(uphill.metres[1]).toBeCloseTo(3 * gapFactor(0.06), 6);
  });

  it("keeps a stopped sample's metres but not its seconds for Minetti", () => {
    const basis = gapBasis(
      { ...base, moving: [true, true, false, true, true] },
      [0, 0, 0, 0, 0],
    )!;
    expect(basis.metres[2]).toBe(3);
    expect(basis.seconds).toEqual([0, 1, 0, 1, 1]);
  });

  it("uses the GAP speed times moving time, whatever the grade says", () => {
    const basis = gapBasis(
      { ...base, ga_velocity: [3.3, 3.3, 3.6, 3.3, 3.3] },
      [20, 20, 20, 20, 20],
    )!;
    expect(basis.model).toBe("strava");
    expect(basis.warning).toBeNull();
    expect(basis.metres).toEqual([0, 3.3, 3.6, 3.3, 3.3]);
    expect(basis.seconds).toEqual([0, 1, 1, 1, 1]);
  });

  it("leaves a sample with no GAP speed, and a stopped one, out of both sums", () => {
    const basis = gapBasis(
      {
        ...base,
        ga_velocity: [3, null, 3, 3, 3],
        moving: [true, true, true, false, true],
      },
      null,
    )!;
    expect(basis.metres).toEqual([0, 0, 3, 0, 3]);
    expect(basis.seconds).toEqual([0, 0, 1, 0, 1]);
  });

  it("scales a long moving gap by its real seconds", () => {
    const basis = gapBasis(
      { time: [0, 1, 21], distance: [0, 3, 63], ga_velocity: [3, 3, 3.5] },
      null,
    )!;
    expect(basis.metres[2]).toBe(70);
    expect(basis.seconds[2]).toBe(20);
  });
});

describe("the Strava model through the analysis (#508)", () => {
  // A 6% climb at 2.5 m/s: Minetti says about 3.4 m/s flat-equivalent.
  const course = () => buildStreams([flat(600), climb(600), flat(600)]);
  const withGa = (speed: number): HillStreams => {
    const streams = course();
    return { ...streams, ga_velocity: streams.time.map(() => speed) };
  };

  it("normalizeHillStreams drops an all-null or misaligned GAP stream", () => {
    const streams = course();
    expect(normalizeHillStreams(streams).ga_velocity).toBeUndefined();
    expect(
      normalizeHillStreams({
        ...streams,
        ga_velocity: streams.time.map(() => null),
      }).ga_velocity,
    ).toBeUndefined();
    expect(
      normalizeHillStreams({ ...streams, ga_velocity: [3, 3] }).ga_velocity,
    ).toBeUndefined();
    expect(normalizeHillStreams(withGa(3)).ga_velocity).toHaveLength(
      streams.time.length,
    );
  });

  it("reports Minetti without the stream, as before", () => {
    const analysis = computeHillAnalysis(course());
    expect(analysis.gapModel).toBe("minetti");
    const gap = analysis.climbs[0]!.gapPaceSecPerKm!;
    expect(gap).toBeGreaterThan(280);
    expect(gap).toBeLessThan(310);
  });

  it("gives each climb the mean of intervals.icu's GAP speed", () => {
    const analysis = computeHillAnalysis(withGa(4));
    expect(analysis.gapModel).toBe("strava");
    expect(analysis.climbs[0]!.gapPaceSecPerKm).toBe(250);
    // The segment edge takes in a flat sample, so HR is just under 155.
    expect(analysis.climbs[0]!.hrPerGapSpeed).toBeCloseTo(155 / 4, 0);
  });

  it("gradeAdjustedSpeeds returns the stream itself for the Strava model", () => {
    const streams = withGa(4);
    streams.ga_velocity![5] = null;
    const result = gradeAdjustedSpeeds(streams)!;
    expect(result.model).toBe("strava");
    expect(result.gradeSource).toBeNull();
    expect(result.warning).toBeNull();
    expect(result.speeds[4]).toBe(4);
    expect(result.speeds[5]).toBeNull();
  });

  it("gradeAdjustedSpeeds needs no elevation for the Strava model", () => {
    const { altitude: _a, grade_smooth: _g, ...noElevation } = withGa(4);
    expect(gradeAdjustedSpeeds(noElevation)?.model).toBe("strava");
    const { ga_velocity: _ga, ...neither } = noElevation;
    expect(gradeAdjustedSpeeds(neither)).toBeNull();
  });

  it("gradeAdjustedSpeeds names Minetti and its grade source without the stream", () => {
    const result = gradeAdjustedSpeeds(course())!;
    expect(result.model).toBe("minetti");
    expect(result.gradeSource).toBe("computed");
  });
});
