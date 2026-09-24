import { describe, expect, it } from "vitest";
import {
  classifyRest,
  computeFade,
  computeHrSignal,
  computeIntervalAnalysis,
  detectRests,
  IntervalAnalysisError,
  type IntervalLap,
  type IntervalStreams,
  REST_LONG_STOP_MIN_SECONDS,
  REST_RECOVERY_MAX_SECONDS,
  REST_URBAN_MAX_SECONDS,
  selectCleanWorkLaps,
  type WorkRep,
} from "./intervalAnalysis";

/** Build 1 Hz streams from legs of constant speed/HR; speed 0 = stopped. */
interface Leg {
  seconds: number;
  speedMs: number;
  hr?: number;
  cadence?: number;
  watts?: number;
  moving?: boolean;
}

function buildStreams(legs: Leg[]): IntervalStreams {
  const time: number[] = [0];
  const distance: number[] = [0];
  const hr: number[] = [legs[0]?.hr ?? 0];
  const velocity: number[] = [legs[0]?.speedMs ?? 0];
  const cadence: number[] = [legs[0]?.cadence ?? 0];
  const watts: number[] = [legs[0]?.watts ?? 0];
  const moving: boolean[] = [legs[0]?.moving ?? legs[0]!.speedMs > 0.3];
  for (const leg of legs) {
    for (let s = 0; s < leg.seconds; s++) {
      time.push(time[time.length - 1]! + 1);
      distance.push(distance[distance.length - 1]! + leg.speedMs);
      hr.push(leg.hr ?? 0);
      velocity.push(leg.speedMs);
      cadence.push(leg.cadence ?? 0);
      watts.push(leg.watts ?? 0);
      moving.push(leg.moving ?? leg.speedMs > 0.3);
    }
  }
  return {
    time,
    distance,
    heartrate: hr,
    velocity_smooth: velocity,
    cadence,
    watts,
    moving,
  };
}

const easy = (seconds: number, extra: Partial<Leg> = {}): Leg => ({
  seconds,
  speedMs: 2.8,
  hr: 140,
  cadence: 84,
  ...extra,
});
const work = (seconds: number, extra: Partial<Leg> = {}): Leg => ({
  seconds,
  speedMs: 4.2,
  hr: 172,
  cadence: 92,
  ...extra,
});
const stop = (seconds: number, extra: Partial<Leg> = {}): Leg => ({
  seconds,
  speedMs: 0,
  hr: 120,
  moving: false,
  ...extra,
});

describe("detectRests", () => {
  it("finds stopped spans and ignores brief blips", () => {
    const streams = buildStreams([
      easy(300),
      stop(5),
      easy(100),
      stop(45),
      easy(300),
    ]);
    const rests = detectRests(streams);
    expect(rests).toHaveLength(1);
    expect(rests[0]!.durationS).toBeGreaterThanOrEqual(44);
    expect(rests[0]!.durationS).toBeLessThanOrEqual(46);
  });

  it("returns nothing without a moving stream", () => {
    const streams = buildStreams([easy(300)]);
    streams.moving = undefined;
    expect(detectRests(streams)).toEqual([]);
  });
});

describe("classifyRest", () => {
  it("matches the documented heuristic table", () => {
    expect(classifyRest(30, false).kind).toBe("traffic_light");
    expect(classifyRest(30, true).kind).toBe("recovery");
    expect(classifyRest(90, true).kind).toBe("recovery");
    expect(classifyRest(REST_RECOVERY_MAX_SECONDS, true).kind).toBe("recovery");
    expect(classifyRest(200, true).kind).toBe("other_stop");
    expect(classifyRest(120, false).kind).toBe("other_stop");
    expect(classifyRest(REST_LONG_STOP_MIN_SECONDS + 60, false).kind).toBe(
      "long_stop",
    );
    expect(classifyRest(REST_LONG_STOP_MIN_SECONDS + 60, true).kind).toBe(
      "long_stop",
    );
    expect(classifyRest(REST_URBAN_MAX_SECONDS - 1, false).kind).toBe(
      "traffic_light",
    );
  });
});

describe("computeIntervalAnalysis — stream path", () => {
  it("classifies an urban long run with a café stop as not intervals", () => {
    const analysis = computeIntervalAnalysis(
      buildStreams([
        easy(600),
        stop(25),
        easy(500),
        stop(40),
        easy(700),
        stop(400), // café
        easy(600),
        stop(30),
        easy(500),
      ]),
    );
    expect(analysis.isIntervals).toBe(false);
    expect(analysis.reps).toHaveLength(0);
    const kinds = analysis.rests.map((r) => r.kind);
    expect(kinds.filter((k) => k === "traffic_light")).toHaveLength(3);
    expect(kinds.filter((k) => k === "long_stop")).toHaveLength(1);
    expect(kinds).not.toContain("recovery");
    expect(analysis.reasoning).toContain("4 rests detected");
    expect(analysis.reasoning).toContain("3 traffic lights");
  });

  it("reconstructs a genuine repeats session with per-rep metrics", () => {
    // WU, stop, 4 x (190 s hard / 90 s standing recovery), CD.
    const analysis = computeIntervalAnalysis(
      buildStreams([
        easy(600),
        stop(30),
        work(190),
        stop(90),
        work(190),
        stop(90),
        work(190),
        stop(90),
        work(190, { speedMs: 4.0, hr: 178 }), // fading final rep
        stop(90),
        easy(400),
      ]),
    );
    expect(analysis.isIntervals).toBe(true);
    expect(analysis.source).toBe("streams");
    expect(analysis.reps).toHaveLength(4);
    const rep1 = analysis.reps[0]!;
    expect(rep1.paceSecPerKm).toBe(Math.round(1000 / 4.2));
    expect(rep1.avgHr).toBe(172);
    expect(rep1.distanceM).toBeGreaterThan(700);
    // Rest after the warm-up is a traffic light, the rest are recoveries.
    const kinds = analysis.rests.map((r) => r.kind);
    expect(kinds[0]).toBe("traffic_light");
    expect(kinds.filter((k) => k === "recovery")).toHaveLength(4);
    // Fade: last rep slower at higher HR.
    expect(analysis.fade).not.toBeNull();
    expect(analysis.fade!.paceDriftPct).toBeGreaterThan(3);
    expect(analysis.fade!.hrDriftBpm).toBe(6);
    expect(analysis.fade!.summary).toContain("rep 4 was");
    expect(analysis.fade!.summary).toContain("slower");
    expect(analysis.fade!.summary).toContain("higher HR");
  });

  it("reports per-rep power and excludes zero-watt dropouts (#213)", () => {
    const streams = buildStreams([
      easy(600),
      stop(30),
      work(190, { watts: 260 }),
      stop(90),
      work(190, { watts: 260 }),
      stop(90),
      work(190, { watts: 260 }),
      stop(90),
      easy(400),
    ]);
    // Drop out every 5th sample to 0 (~20% dropout, coverage stays >70%).
    for (let i = 0; i < streams.watts!.length; i += 5) streams.watts![i] = 0;
    const analysis = computeIntervalAnalysis(streams);
    expect(analysis.reps.length).toBeGreaterThanOrEqual(3);
    // Surviving samples are all 260 W; the dropouts must not drag the average.
    for (const rep of analysis.reps) {
      expect(rep.avgWatts).toBeCloseTo(260, 0);
    }
  });

  it("omits per-rep power when a rep sits in a power gap (#213)", () => {
    const analysis = computeIntervalAnalysis(
      buildStreams([
        easy(600),
        stop(30),
        work(190, { watts: 260 }),
        stop(90),
        work(190, { watts: 0 }), // full power dropout on this rep
        stop(90),
        work(190, { watts: 260 }),
        stop(90),
        easy(400),
      ]),
    );
    expect(analysis.reps).toHaveLength(3);
    expect(analysis.reps[0]!.avgWatts).toBeCloseTo(260, 0);
    expect(analysis.reps[1]!.avgWatts).toBeNull();
    expect(analysis.reps[2]!.avgWatts).toBeCloseTo(260, 0);
  });

  it("merges easy running across a traffic light instead of splitting", () => {
    const analysis = computeIntervalAnalysis(
      buildStreams([easy(600), stop(30), easy(600)]),
    );
    expect(analysis.isIntervals).toBe(false);
    expect(analysis.rests[0]!.kind).toBe("traffic_light");
    expect(analysis.reps).toHaveLength(0);
  });

  it("does not flag a continuous run with no rests as intervals", () => {
    const analysis = computeIntervalAnalysis(buildStreams([easy(3600)]));
    expect(analysis.isIntervals).toBe(false);
    expect(analysis.rests).toHaveLength(0);
  });

  it("downgrades confidence when unclassified stops exist", () => {
    const analysis = computeIntervalAnalysis(
      buildStreams([
        easy(600),
        stop(120), // 2 min stop after easy running: fits nothing
        easy(300),
        stop(30),
        work(190),
        stop(90),
        work(190),
        stop(90),
        easy(300),
      ]),
    );
    expect(analysis.rests[0]!.kind).toBe("other_stop");
    expect(analysis.confidence).toBe("medium");
  });
});

describe("computeIntervalAnalysis — lap path", () => {
  function lap(
    lapIndex: number,
    distanceM: number,
    movingTimeS: number,
    extra: Partial<IntervalLap> = {},
  ): IntervalLap {
    return {
      lapIndex,
      distanceM,
      movingTimeS,
      avgSpeedMs: distanceM / movingTimeS,
      avgHr: null,
      avgCadence: null,
      avgWatts: null,
      ...extra,
    };
  }

  const structuredLaps = [
    lap(1, 2000, 720, { avgHr: 138 }), // warm-up
    lap(2, 800, 190, { avgHr: 170 }),
    lap(3, 400, 240, { avgHr: 145 }), // jog recovery (still moving!)
    lap(4, 800, 191, { avgHr: 173 }),
    lap(5, 400, 240, { avgHr: 147 }),
    lap(6, 800, 193, { avgHr: 176 }),
    lap(7, 1500, 540, { avgHr: 140 }), // cool-down
  ];

  it("prefers clean structured laps over streams (jog recoveries)", () => {
    // Continuous movement — the stream path sees no rests at all.
    const analysis = computeIntervalAnalysis(
      buildStreams([easy(2400)]),
      structuredLaps,
    );
    expect(analysis.source).toBe("laps");
    expect(analysis.isIntervals).toBe(true);
    expect(analysis.reps).toHaveLength(3);
    expect(analysis.reps[0]!.avgHr).toBe(170);
    expect(analysis.reps[0]!.startKm).toBe(2);
    expect(analysis.fade!.hrDriftBpm).toBe(6);
    expect(analysis.confidence).toBe("high");
    expect(analysis.reasoning).toContain("clean structured laps");
  });

  it("falls back to streams when lap speeds are corrupted", () => {
    const corrupted = [
      lap(1, 2000, 720),
      lap(2, 800, 190), // 4.21 m/s
      lap(3, 400, 240),
      lap(4, 800, 240), // 3.33 m/s — same rep distance, wildly off pace
      lap(5, 400, 240),
      lap(6, 1500, 540),
    ];
    const analysis = computeIntervalAnalysis(
      buildStreams([
        easy(600),
        stop(30),
        work(190),
        stop(90),
        work(190),
        stop(90),
        easy(300),
      ]),
      corrupted,
    );
    expect(analysis.source).toBe("streams");
    expect(analysis.reps).toHaveLength(2);
  });

  it("selectCleanWorkLaps rejects too few laps", () => {
    expect(selectCleanWorkLaps(structuredLaps.slice(0, 2))).toBeNull();
  });
});

describe("computeFade", () => {
  const rep = (index: number, pace: number, hr: number | null): WorkRep => ({
    index,
    startKm: index,
    distanceM: 800,
    movingTimeS: 190,
    paceSecPerKm: pace,
    avgHr: hr,
    avgCadence: null,
    avgWatts: null,
  });

  it("needs at least two reps", () => {
    expect(computeFade([rep(1, 240, 170)])).toBeNull();
  });

  it("handles missing HR gracefully", () => {
    const fade = computeFade([rep(1, 240, null), rep(2, 250, null)]);
    expect(fade!.paceDriftPct).toBeCloseTo(4.2, 1);
    expect(fade!.hrDriftBpm).toBeNull();
    expect(fade!.summary).toContain("slower");
  });

  it("reports negative drift as faster", () => {
    const fade = computeFade([rep(1, 250, 170), rep(2, 240, 165)]);
    expect(fade!.paceDriftPct).toBeLessThan(0);
    expect(fade!.summary).toContain("faster");
    expect(fade!.summary).toContain("lower HR");
  });
});

describe("computeHrSignal", () => {
  it("reads sustained near-max time as a hard workout", () => {
    const signal = computeHrSignal(
      buildStreams([easy(600, { hr: 140 }), work(600, { hr: 180 })]),
    );
    expect(signal).not.toBeNull();
    expect(signal!.maxHr).toBe(180);
    expect(signal!.highIntensityShare).toBeGreaterThan(0.4);
    expect(signal!.assessment).toContain("hard workout");
  });

  it("reads flat easy HR as continuous effort", () => {
    // Max is a brief spike; almost no time near it.
    const signal = computeHrSignal(
      buildStreams([
        easy(1200, { hr: 138 }),
        work(10, { hr: 165 }),
        easy(1200, { hr: 140 }),
      ]),
    );
    expect(signal!.assessment).toContain("easy continuous");
  });

  it("returns null without HR", () => {
    const streams = buildStreams([easy(600)]);
    streams.heartrate = undefined;
    expect(computeHrSignal(streams)).toBeNull();
  });
});

describe("error handling", () => {
  it("throws on missing time stream", () => {
    expect(() => computeIntervalAnalysis({ time: [0], distance: [0] })).toThrow(
      IntervalAnalysisError,
    );
  });

  it("warns and reports low confidence without a moving stream or laps", () => {
    const streams = buildStreams([easy(600), work(190), easy(300)]);
    streams.moving = undefined;
    const analysis = computeIntervalAnalysis(streams);
    expect(analysis.warnings.join(" ")).toContain("No moving stream");
    expect(analysis.confidence).toBe("low");
    expect(analysis.isIntervals).toBe(false);
  });

  it("interpolates null distance samples instead of throwing or coercing to 0", () => {
    const streams = buildStreams([
      easy(600),
      stop(30),
      work(190),
      stop(90),
      work(190),
      stop(90),
      easy(300),
    ]);
    // A short mid-run dropout in the distance stream (not the leading/
    // trailing samples, which normalizeHillStreams' underlying
    // interpolateNulls holds flat rather than lerping).
    streams.distance[500] = null;
    streams.distance[501] = null;
    const analysis = computeIntervalAnalysis(streams);
    expect(analysis.reps).toHaveLength(2);
    // The interpolated distance keeps monotonic progress through the gap;
    // a rep spanning it does not read as 0 m or negative.
    for (const rep of analysis.reps) {
      expect(rep.distanceM).toBeGreaterThan(0);
    }
  });
});
