import { describe, expect, it } from "vitest";
import {
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
  options: { sampleMetres?: number; withAltitude?: boolean } = {},
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
      t += step / speed;
      d += step;
      alt += (step * (leg.gradePct ?? 0)) / 100;
      time.push(Math.round(t * 100) / 100);
      distance.push(Math.round(d * 100) / 100);
      altitude.push(Math.round(alt * 100) / 100);
      grade.push(leg.gradePct ?? 0);
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

  it("says the terrain correction is unavailable without elevation", () => {
    const analysis = computeSplitAnalysis(
      streams(
        [
          { metres: 5000, secPerKm: 300 },
          { metres: 5000, secPerKm: 330 },
        ],
        { withAltitude: false },
      ),
    );

    expect(analysis.gradeSource).toBe("computed");
    expect(analysis.warnings.join(" ")).toContain("No elevation or grade");
    const verdict = analysis.verdict!;
    // Grade is unknown, so GAP is raw pace: reported, but never dressed up as
    // a terrain-corrected verdict.
    expect(verdict.gapDeltaPct).toBeCloseTo(verdict.deltaPct, 0);
    expect(analysis.splits[0]!.elevationChangeM).toBeNull();
    expect(analysis.splits[0]!.avgGradePct).toBeNull();
  });

  it("reports grade_smooth as the source when the stream is present", () => {
    const analysis = computeSplitAnalysis(flat5k());
    expect(analysis.gradeSource).toBe("grade_smooth");
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
