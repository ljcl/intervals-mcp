import { describe, expect, it } from "vitest";
import { gapFactor } from "./hillAnalysis";
import {
  ASCENT_HYSTERESIS_M,
  ascentFromAltitude,
  computeSplitAnalysis,
  EVEN_SPLIT_PCT,
  interpretSplit,
  MIN_HALF_MOVING_SECONDS,
  SplitAnalysisError,
  type SplitStreams,
} from "./splitAnalysis";

/**
 * Build streams from a list of `[metres, secondsPerKm]` legs at 1 Hz-ish
 * resolution, optionally with a per-leg grade in percent. Distance and time
 * are derived so pace is exactly what the leg asked for.
 */
function streams(
  legs: { metres: number; secPerKm: number; gradePct?: number; hr?: number }[],
  options: {
    sampleMetres?: number;
    withAltitude?: boolean;
    /** Zero-mean grade noise (%) added to sample `i` on top of the leg's grade. */
    gradeNoise?: (i: number) => number;
  } = {},
): SplitStreams {
  const step = options.sampleMetres ?? 10;
  const time: number[] = [0];
  const distance: number[] = [0];
  const altitude: number[] = [100];
  const grade: number[] = [0];
  const heartrate: number[] = [120];
  const velocity: number[] = [0];

  let t = 0;
  let d = 0;
  let alt = 100;
  for (const leg of legs) {
    const samples = Math.round(leg.metres / step);
    const speed = 1000 / leg.secPerKm;
    for (let i = 0; i < samples; i++) {
      const g = (leg.gradePct ?? 0) + (options.gradeNoise?.(time.length) ?? 0);
      t += step / speed;
      d += step;
      alt += (step * g) / 100;
      time.push(Math.round(t * 100) / 100);
      distance.push(Math.round(d * 100) / 100);
      altitude.push(Math.round(alt * 100) / 100);
      grade.push(g);
      heartrate.push(leg.hr ?? 140);
      velocity.push(speed);
    }
  }

  return {
    time,
    distance,
    heartrate,
    velocity_smooth: velocity,
    ...(options.withAltitude === false
      ? {}
      : { altitude, grade_smooth: grade }),
  };
}

/** Flat 5 km at a steady 5:00/km. */
const flat5k = () => streams([{ metres: 5000, secPerKm: 300 }]);

/**
 * Deterministic uniform noise in about [-amplitude, amplitude] (LCG, fixed
 * seed) for `n` samples, shifted to a mean of exactly 0 so the course stays
 * flat overall: a net rise would be real terrain that GAP should credit.
 */
function seededNoise(amplitude: number, n: number) {
  let state = 42;
  const values = Array.from({ length: n }, () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return (state / 2 ** 32) * 2 * amplitude - amplitude;
  });
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  return (i: number) => values[i]! - mean;
}

/** Relative difference of the whole-run GAP pace from raw pace. */
const gapVsRaw = (analysis: ReturnType<typeof computeSplitAnalysis>) =>
  Math.abs(
    analysis.totals.avgGapPaceSecPerKm! - analysis.totals.avgPaceSecPerKm!,
  ) / analysis.totals.avgPaceSecPerKm!;

describe("computeSplitAnalysis", () => {
  it("splits an even flat run into equal kilometres", () => {
    const analysis = computeSplitAnalysis(flat5k());

    expect(analysis.splits).toHaveLength(5);
    for (const split of analysis.splits) {
      expect(split.partial).toBe(false);
      expect(split.distanceM).toBe(1000);
      expect(split.paceSecPerKm).toBeCloseTo(300, 0);
      expect(split.avgHr).toBe(140);
    }
    expect(analysis.splits.map((s) => s.index)).toEqual([1, 2, 3, 4, 5]);
    expect(analysis.splits[0]!.startM).toBe(0);
    expect(analysis.splits[4]!.endM).toBe(5000);
    expect(analysis.totals.distanceM).toBe(5000);
    expect(analysis.totals.avgPaceSecPerKm).toBeCloseTo(300, 0);
  });

  it("marks a trailing partial split and keeps it out of fastest/slowest", () => {
    // 3.4 km: three full splits plus 400 m, the last one run hard.
    const analysis = computeSplitAnalysis(
      streams([
        { metres: 3000, secPerKm: 300 },
        { metres: 400, secPerKm: 220 },
      ]),
    );

    expect(analysis.splits).toHaveLength(4);
    const last = analysis.splits[3]!;
    expect(last.partial).toBe(true);
    expect(last.distanceM).toBe(400);
    // Its pace is extrapolated to a full km, so it must not win "fastest".
    expect(last.paceSecPerKm).toBeLessThan(300);
    expect(analysis.fastestSplitIndex).not.toBe(4);
    expect(analysis.slowestSplitIndex).not.toBe(4);
  });

  it("names the fastest and slowest split", () => {
    const analysis = computeSplitAnalysis(
      streams([
        { metres: 1000, secPerKm: 300 },
        { metres: 1000, secPerKm: 260 },
        { metres: 1000, secPerKm: 330 },
      ]),
    );

    expect(analysis.fastestSplitIndex).toBe(2);
    expect(analysis.slowestSplitIndex).toBe(3);
  });

  it("reports per-split elevation change and grade", () => {
    const analysis = computeSplitAnalysis(
      streams([
        { metres: 1000, secPerKm: 300, gradePct: 0 },
        { metres: 1000, secPerKm: 330, gradePct: 4 },
      ]),
    );

    expect(analysis.splits[0]!.elevationChangeM).toBeCloseTo(0, 0);
    expect(analysis.splits[1]!.elevationChangeM).toBeCloseTo(40, 0);
    expect(analysis.splits[1]!.avgGradePct).toBeCloseTo(4, 0);
    expect(analysis.totals.elevationGainM).toBeCloseTo(40, 0);
  });

  it("excludes stopped samples from pace but not from elapsed time", () => {
    const moved = flat5k();
    // Two minutes at a red light in the middle of split 3.
    const pauseIndex = moved.distance.findIndex((d) => d != null && d >= 2500);
    const stopped: SplitStreams = {
      ...moved,
      time: moved.time.map((t, i) => (i >= pauseIndex ? t + 120 : t)),
      moving: moved.time.map((_, i) => i !== pauseIndex),
    };

    const analysis = computeSplitAnalysis(stopped);
    const third = analysis.splits[2]!;

    expect(third.elapsedTimeS).toBeGreaterThan(third.movingTimeS + 100);
    expect(third.paceSecPerKm).toBeCloseTo(300, -1);
    expect(analysis.totals.elapsedTimeS).toBeGreaterThan(
      analysis.totals.movingTimeS + 100,
    );
  });

  it("divides a coarse sample interval across the boundary it straddles", () => {
    // 100 m between samples: every 10th interval straddles a km boundary.
    const analysis = computeSplitAnalysis(
      streams([{ metres: 3000, secPerKm: 300 }], { sampleMetres: 100 }),
    );

    for (const split of analysis.splits) {
      expect(split.distanceM).toBe(1000);
      expect(split.movingTimeS).toBeCloseTo(300, 0);
    }
  });

  it("throws without distance or time", () => {
    expect(() => computeSplitAnalysis({ time: [0, 1], distance: [] })).toThrow(
      SplitAnalysisError,
    );
    expect(() =>
      computeSplitAnalysis({
        distance: [0, 100],
      } as unknown as SplitStreams),
    ).toThrow(SplitAnalysisError);
  });

  it("throws when the activity covers no distance", () => {
    expect(() =>
      computeSplitAnalysis({ time: [0, 60, 120], distance: [0, 0, 0] }),
    ).toThrow(/no distance/i);
  });

  it("warns when the activity is shorter than one split", () => {
    const analysis = computeSplitAnalysis(
      streams([{ metres: 600, secPerKm: 300 }]),
    );

    expect(analysis.splits).toHaveLength(1);
    expect(analysis.splits[0]!.partial).toBe(true);
    expect(analysis.warnings.join(" ")).toContain("shorter than one km");
  });

  it("interpolates null distance samples rather than treating them as zero", () => {
    const base = flat5k();
    const withGaps: SplitStreams = {
      ...base,
      distance: base.distance.map((d, i) => (i % 40 === 3 ? null : d)),
    };
    const analysis = computeSplitAnalysis(withGaps);
    expect(analysis.totals.distanceM).toBeCloseTo(5000, -1);
    expect(analysis.splits).toHaveLength(5);
  });

  it("skips null heart rate samples instead of dragging the average to zero", () => {
    const base = flat5k();
    const withGaps: SplitStreams = {
      ...base,
      heartrate: base.heartrate!.map((hr, i) => (i % 3 === 0 ? null : hr)),
    };
    const analysis = computeSplitAnalysis(withGaps);
    for (const split of analysis.splits) {
      expect(split.avgHr).toBe(140);
    }
  });
});

describe("split verdict", () => {
  it("calls a genuine fade on flat ground a positive split", () => {
    const analysis = computeSplitAnalysis(
      streams([
        { metres: 5000, secPerKm: 300 },
        { metres: 5000, secPerKm: 330 },
      ]),
    );
    const verdict = analysis.verdict!;

    expect(verdict.shape).toBe("positive");
    expect(verdict.gapShape).toBe("positive");
    expect(verdict.deltaPct).toBeCloseTo(10, 0);
    expect(verdict.gapDeltaPct).toBeCloseTo(10, 0);
    // Flat: the terrain explains none of it.
    expect(verdict.terrainPct).toBeCloseTo(0, 0);
    expect(verdict.interpretation).toContain("that is fade, not terrain");
  });

  it("does not read a hilly back half as fade", () => {
    // Same effort throughout: the back half climbs, so raw pace slows while
    // grade-adjusted pace holds.
    const analysis = computeSplitAnalysis(
      streams([
        { metres: 5000, secPerKm: 300, gradePct: 0 },
        { metres: 5000, secPerKm: 345, gradePct: 3 },
      ]),
    );
    const verdict = analysis.verdict!;

    expect(verdict.shape).toBe("positive");
    expect(verdict.gapShape).not.toBe("positive");
    expect(verdict.terrainPct).toBeGreaterThan(EVEN_SPLIT_PCT);
    expect(verdict.secondHalfElevationChangeM).toBeGreaterThan(100);
    expect(verdict.interpretation).toMatch(/hillier|terrain/);
  });

  it("still finds fade hidden by a downhill finish", () => {
    // The back half drops 3% but only 5% faster — grade-adjusted, that is
    // slower than the flat first half.
    const analysis = computeSplitAnalysis(
      streams([
        { metres: 5000, secPerKm: 300, gradePct: 0 },
        { metres: 5000, secPerKm: 285, gradePct: -3 },
      ]),
    );
    const verdict = analysis.verdict!;

    expect(verdict.shape).toBe("negative");
    expect(verdict.gapShape).toBe("positive");
    expect(verdict.interpretation).toContain("downhill finish");
  });

  it("calls an even run even, on the clock and grade-adjusted", () => {
    const verdict = computeSplitAnalysis(flat5k()).verdict!;

    expect(verdict.shape).toBe("even");
    expect(verdict.gapShape).toBe("even");
    expect(Math.abs(verdict.deltaPct)).toBeLessThanOrEqual(EVEN_SPLIT_PCT);
    expect(verdict.interpretation).toContain("evenly paced");
  });

  it("cuts the halves at the midpoint of distance, not between splits", () => {
    // 7 km — an odd split count, so grouping splits could not halve it evenly.
    const analysis = computeSplitAnalysis(
      streams([{ metres: 7000, secPerKm: 300 }]),
    );
    const verdict = analysis.verdict!;

    expect(analysis.splits).toHaveLength(7);
    expect(verdict.firstHalfPaceSecPerKm).toBeCloseTo(
      verdict.secondHalfPaceSecPerKm,
      0,
    );
  });

  it("withholds a verdict when a half is too short to mean anything", () => {
    // 400 m all-out: well under the moving-time floor per half.
    const analysis = computeSplitAnalysis(
      streams([{ metres: 400, secPerKm: 200 }]),
    );

    expect(analysis.verdict).toBeNull();
    expect(analysis.warnings.join(" ")).toContain(
      `${Math.round(MIN_HALF_MOVING_SECONDS / 60)} minutes`,
    );
  });

  it("gives no grade-adjusted verdict without elevation", () => {
    // 10 km at 5:00/km then 5:30/km, no altitude or grade stream.
    const analysis = computeSplitAnalysis(
      streams(
        [
          { metres: 5000, secPerKm: 300 },
          { metres: 5000, secPerKm: 330 },
        ],
        { withAltitude: false },
      ),
    );

    expect(analysis.gradeSource).toBe("none");
    expect(analysis.warnings.join(" ")).toContain("No elevation or grade");
    const verdict = analysis.verdict!;
    // Grade is unknown, not flat: no GAP, no terrain share, no gap shape.
    expect(verdict.deltaPct).toBeCloseTo(10, 0);
    expect(verdict.gapDeltaPct).toBeNull();
    expect(verdict.terrainPct).toBeNull();
    expect(verdict.gapShape).toBeNull();
    expect(verdict.firstHalfGapPaceSecPerKm).toBeNull();
    expect(verdict.interpretation).toContain("No elevation data");
    expect(verdict.interpretation).not.toContain("grade-adjusted");
    expect(analysis.splits.every((s) => s.gapPaceSecPerKm === null)).toBe(true);
    expect(analysis.totals.avgGapPaceSecPerKm).toBeNull();
    expect(analysis.splits[0]!.elevationChangeM).toBeNull();
    expect(analysis.splits[0]!.avgGradePct).toBeNull();
    expect(analysis.totals.elevationGainM).toBeNull();
    expect(analysis.totals.elevationGainSource).toBeNull();
  });

  it("treats an all-null altitude stream as no elevation, not flat", () => {
    const base = streams([
      { metres: 5000, secPerKm: 300 },
      { metres: 5000, secPerKm: 330 },
    ]);
    const analysis = computeSplitAnalysis({
      ...base,
      grade_smooth: undefined,
      altitude: base.altitude!.map(() => null),
    });

    expect(analysis.gradeSource).toBe("none");
    expect(analysis.verdict!.gapDeltaPct).toBeNull();
  });

  it("reports grade_smooth as the source when the stream is present", () => {
    const analysis = computeSplitAnalysis(flat5k());
    expect(analysis.gradeSource).toBe("grade_smooth");
  });
});

describe("grade-adjusted pace on noisy elevation (#45)", () => {
  const flat10k = (gradeNoise: (i: number) => number) =>
    streams([{ metres: 10000, secPerKm: 300 }], { gradeNoise });

  it("keeps GAP within 1% of raw pace on a flat course with ±10% alternating grade noise", () => {
    const analysis = computeSplitAnalysis(
      flat10k((i) => (i % 2 === 0 ? 10 : -10)),
    );
    // Per sample, the Minetti factor averaged 1.13 here: GAP 13% too fast.
    expect(gapVsRaw(analysis)).toBeLessThan(0.01);
    expect(analysis.verdict!.gapShape).toBe("even");
    expect(analysis.warnings.join(" ")).toContain("elevation track is noisy");
    expect(analysis.verdict!.interpretation).toContain("approximate");
  });

  it("keeps GAP within 1% of raw pace with random ±10% grade noise", () => {
    const analysis = computeSplitAnalysis(flat10k(seededNoise(10, 1001)));
    expect(gapVsRaw(analysis)).toBeLessThan(0.01);
    expect(analysis.warnings.join(" ")).toContain("elevation track is noisy");
  });

  it("does the same when grade is derived from a noisy altitude track", () => {
    const noisy = flat10k(seededNoise(10, 1001));
    const analysis = computeSplitAnalysis({
      ...noisy,
      grade_smooth: undefined,
    });
    expect(analysis.gradeSource).toBe("computed");
    expect(gapVsRaw(analysis)).toBeLessThan(0.01);
  });

  it("still gives the Minetti value on a steady +3% climb", () => {
    const analysis = computeSplitAnalysis(
      streams([{ metres: 5000, secPerKm: 300, gradePct: 3 }]),
    );
    expect(
      Math.abs(analysis.totals.avgGapPaceSecPerKm! - 300 / gapFactor(0.03)),
    ).toBeLessThanOrEqual(1);
    expect(analysis.warnings.join(" ")).not.toContain("noisy");
  });

  it("adds no noise warning on a clean hilly course", () => {
    const analysis = computeSplitAnalysis(
      streams([
        { metres: 3000, secPerKm: 300, gradePct: 0 },
        { metres: 2000, secPerKm: 340, gradePct: 4 },
        { metres: 2000, secPerKm: 280, gradePct: -4 },
      ]),
    );
    expect(analysis.warnings.join(" ")).not.toContain("noisy");
  });
});

describe("elevation gain (#45)", () => {
  it("counts a climb that descends again inside one split", () => {
    // Every km climbs 20 m over 500 m and descends 20 m over the next 500 m:
    // each split's net change is 0, the real ascent 20 m per km.
    const legs = Array.from({ length: 5 }, () => [
      { metres: 500, secPerKm: 300, gradePct: 4 },
      { metres: 500, secPerKm: 300, gradePct: -4 },
    ]).flat();
    const analysis = computeSplitAnalysis(streams(legs));

    expect(analysis.splits[0]!.elevationChangeM).toBeCloseTo(0, 0);
    expect(analysis.totals.elevationGainM).toBeCloseTo(100, 0);
    expect(analysis.totals.elevationGainSource).toBe("computed");
  });

  it("prefers the activity's own total_elevation_gain", () => {
    const analysis = computeSplitAnalysis(flat5k(), {
      recordedElevationGainM: 693.4,
    });
    expect(analysis.totals.elevationGainM).toBe(693);
    expect(analysis.totals.elevationGainSource).toBe("intervals.icu");
  });
});

describe("ascentFromAltitude", () => {
  it("ignores noise smaller than the hysteresis", () => {
    const wobble = Array.from({ length: 200 }, (_, i) =>
      i % 2 === 0 ? 100 : 100 + ASCENT_HYSTERESIS_M - 0.5,
    );
    expect(ascentFromAltitude(wobble)).toBe(0);
  });

  it("counts each climb valley to peak", () => {
    expect(ascentFromAltitude([100, 110, 120, 105, 90, 95, 130, 128])).toBe(60);
  });

  it("counts a climb still going at the end", () => {
    expect(ascentFromAltitude([100, 99, 104, 108])).toBe(9);
  });

  it("is 0 for an empty stream", () => {
    expect(ascentFromAltitude([])).toBe(0);
  });
});

describe("interpretSplit", () => {
  it("covers every shape pairing with a distinct sentence", () => {
    const shapes = ["even", "positive", "negative"] as const;
    const sentences = new Set<string>();
    for (const shape of shapes) {
      for (const gapShape of shapes) {
        const text = interpretSplit(shape, gapShape, 5, -5);
        expect(text.length).toBeGreaterThan(20);
        sentences.add(text);
      }
    }
    expect(sentences.size).toBe(9);
  });

  it("splits the credit when hills own part of a real fade", () => {
    // 8% slower on the clock, 3% after correction: hills took 5 points, and
    // saying "not terrain" here would contradict the reported terrain share.
    expect(interpretSplit("positive", "positive", 8, 3)).toContain(
      "the terrain explains 5%",
    );
    // Flat fade: the terrain owns none of it.
    expect(interpretSplit("positive", "positive", 8, 7.5)).toContain(
      "that is fade, not terrain",
    );
  });

  it("flags the missing terrain correction when there is no GAP", () => {
    expect(interpretSplit("positive", "positive", 6, null)).toContain(
      "No elevation data",
    );
    expect(interpretSplit("negative", "negative", -6, null)).toContain(
      "negative split",
    );
    expect(interpretSplit("even", "even", 0.5, null)).toContain("even split");
  });
});
