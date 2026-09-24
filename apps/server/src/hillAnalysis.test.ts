import { describe, expect, it } from "vitest";
import {
  computeGrades,
  computeHillAnalysis,
  gapFactor,
  HillAnalysisError,
  type HillStreams,
  interpolateNulls,
  normalizeHillStreams,
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
  it("prefers the grade_smooth stream", () => {
    const streams = buildStreams([flat(100)]);
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
});

describe("computeHillAnalysis", () => {
  it("reports a flat run as having no climbs", () => {
    const analysis = computeHillAnalysis(buildStreams([flat(5000)]));
    expect(analysis.climbs).toHaveLength(0);
    expect(analysis.drift).toBeNull();
    expect(analysis.gradeSource).toBe("grade_smooth");
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
    // not be dragged toward zero by the null samples.
    expect(analysis.climbs[0]!.avgHr).toBe(155);
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
    expect(c.avgHr).toBe(155);
    // 2.5 m/s = 400 s/km raw; GAP must be meaningfully faster than raw pace.
    expect(c.paceSecPerKm).toBeCloseTo(400, -1);
    expect(c.gapPaceSecPerKm!).toBeLessThan(c.paceSecPerKm!);
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
  });

  describe("segment power (#213)", () => {
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
