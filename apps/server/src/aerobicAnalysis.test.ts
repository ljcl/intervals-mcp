import { describe, expect, it } from "vitest";
import {
  AerobicAnalysisError,
  computeAerobicAnalysis,
  interpretDecoupling,
  MIN_MOVING_SECONDS,
  speedEfficiencyFactor,
} from "./aerobicAnalysis";

/** 1 Hz streams of `seconds` samples from per-second value functions. */
function makeStreams(
  seconds: number,
  values: {
    heartrate?: (t: number) => number;
    watts?: (t: number) => number;
    velocity?: (t: number) => number;
    moving?: (t: number) => boolean;
  },
) {
  const time = Array.from({ length: seconds }, (_, i) => i);
  return {
    time,
    heartrate: values.heartrate ? time.map(values.heartrate) : undefined,
    watts: values.watts ? time.map(values.watts) : undefined,
    velocity_smooth: values.velocity ? time.map(values.velocity) : undefined,
    moving: values.moving ? time.map(values.moving) : undefined,
  };
}

describe("computeAerobicAnalysis", () => {
  it("reports ~0% decoupling for a perfectly steady effort", () => {
    const streams = makeStreams(3600, {
      heartrate: () => 150,
      watts: () => 250,
    });
    const analysis = computeAerobicAnalysis(streams);
    expect(analysis.basis).toBe("power");
    expect(analysis.decouplingPct).toBeCloseTo(0, 5);
    expect(analysis.normalizedOutput).toBeCloseTo(250, 0);
    expect(analysis.efficiencyFactor).toBeCloseTo(250 / 150, 3);
  });

  it("reports positive decoupling when HR drifts at constant power", () => {
    // HR climbs linearly 140 → 154 (+10%) over the run at fixed power.
    const streams = makeStreams(3600, {
      heartrate: (t) => 140 + (14 * t) / 3600,
      watts: () => 250,
    });
    const analysis = computeAerobicAnalysis(streams);
    // First-half avg HR ≈ 143.5, second ≈ 150.5 → ratio drop ≈ 4.7%.
    expect(analysis.decouplingPct).toBeGreaterThan(4);
    expect(analysis.decouplingPct).toBeLessThan(5.5);
    expect(analysis.firstHalf.avgHeartrate).toBeLessThan(
      analysis.secondHalf.avgHeartrate,
    );
  });

  it("reports negative decoupling for a strong negative split", () => {
    const streams = makeStreams(3600, {
      heartrate: () => 150,
      watts: (t) => (t < 1800 ? 230 : 260),
    });
    const analysis = computeAerobicAnalysis(streams);
    expect(analysis.decouplingPct).toBeLessThan(-5);
  });

  it("excludes stopped time so a café stop cannot poison the halves", () => {
    // Identical steady effort, but a 10-minute mid-run stop where HR falls.
    // With `moving` honoured the stop must not register as second-half decay.
    const streams = makeStreams(4200, {
      heartrate: (t) => (t >= 1800 && t < 2400 ? 90 : 150),
      watts: (t) => (t >= 1800 && t < 2400 ? 0 : 250),
      moving: (t) => !(t >= 1800 && t < 2400),
    });
    const analysis = computeAerobicAnalysis(streams);
    expect(analysis.decouplingPct).toBeCloseTo(0, 1);
    expect(analysis.excludedStoppedSeconds).toBeGreaterThanOrEqual(599);
    expect(analysis.movingSeconds).toBeLessThan(3700);
  });

  it("falls back to the speed basis with a warning when watts are absent", () => {
    const streams = makeStreams(3600, {
      heartrate: () => 150,
      velocity: () => 3.2,
    });
    const analysis = computeAerobicAnalysis(streams);
    expect(analysis.basis).toBe("speed");
    expect(analysis.warnings.join(" ")).toContain("speed:HR");
    // Running EF: metres-per-minute per beat.
    expect(analysis.efficiencyFactor).toBeCloseTo((3.2 * 60) / 150, 3);
    expect(analysis.intensityFactor).toBeNull();
  });

  it("computes IF from threshold power on the power basis", () => {
    const streams = makeStreams(3600, {
      heartrate: () => 150,
      watts: () => 250,
    });
    const analysis = computeAerobicAnalysis(streams, { thresholdPower: 300 });
    expect(analysis.intensityFactor).toBeCloseTo(250 / 300, 3);
  });

  it("weights normalized power toward surges (NP > average)", () => {
    // Alternating 100 W / 400 W minutes: average 250, NP well above it.
    const streams = makeStreams(3600, {
      heartrate: () => 150,
      watts: (t) => (Math.floor(t / 60) % 2 === 0 ? 100 : 400),
    });
    const analysis = computeAerobicAnalysis(streams);
    expect(analysis.normalizedOutput).toBeGreaterThan(280);
  });

  it("drops warm-up minutes before splitting halves", () => {
    // First 10 minutes at easy warm-up HR; steady after. Without exclusion
    // decoupling reads positive (cheap first half); with it, ~0.
    const streams = makeStreams(3600, {
      heartrate: (t) => (t < 600 ? 120 : 155),
      watts: () => 250,
    });
    const withoutExclusion = computeAerobicAnalysis(streams);
    const withExclusion = computeAerobicAnalysis(streams, {
      excludeWarmupSeconds: 600,
    });
    expect(withoutExclusion.decouplingPct).toBeGreaterThan(3);
    expect(withExclusion.decouplingPct).toBeCloseTo(0, 1);
    expect(withExclusion.excludedWarmupSeconds).toBeGreaterThanOrEqual(600);
  });

  it("warns on short runs and missing moving stream", () => {
    const streams = makeStreams(MIN_MOVING_SECONDS / 2, {
      heartrate: () => 150,
      watts: () => 250,
    });
    const analysis = computeAerobicAnalysis(streams);
    const joined = analysis.warnings.join(" ");
    expect(joined).toContain("moving time analysed");
    expect(joined).toContain("No moving stream");
  });

  it("caps pathological recording gaps instead of letting them dominate", () => {
    // A 2-hour gap between two samples must not outweigh the rest.
    const time = [...Array.from({ length: 1200 }, (_, i) => i), 8400];
    const heartrate = time.map((t) => (t === 8400 ? 190 : 150));
    const watts = time.map(() => 250);
    const analysis = computeAerobicAnalysis({ time, heartrate, watts });
    expect(Math.abs(analysis.decouplingPct)).toBeLessThan(2);
  });

  it("throws an actionable error without a heart rate stream", () => {
    const streams = makeStreams(3600, { watts: () => 250 });
    expect(() => computeAerobicAnalysis(streams)).toThrow(AerobicAnalysisError);
    expect(() => computeAerobicAnalysis(streams)).toThrow(/heart rate/i);
  });

  it("throws without any output stream", () => {
    const streams = makeStreams(3600, { heartrate: () => 150 });
    expect(() => computeAerobicAnalysis(streams)).toThrow(/power nor a speed/i);
  });

  it("throws when exclusions consume the whole run", () => {
    const streams = makeStreams(1200, {
      heartrate: () => 150,
      watts: () => 250,
    });
    expect(() =>
      computeAerobicAnalysis(streams, { excludeWarmupSeconds: 3600 }),
    ).toThrow(/No usable moving samples/i);
  });
});

describe("speedEfficiencyFactor", () => {
  it("is metres per minute per beat", () => {
    // 5:00/km is 200 m/min; at 150 bpm that is 1.333 m per beat.
    expect(speedEfficiencyFactor(1000 / 300, 150)).toBeCloseTo(4 / 3, 6);
  });

  it("scores the same speed per beat equally, whatever the pace", () => {
    // 6:00/km at 125 bpm covers as much ground per beat as 5:00/km at 150.
    expect(speedEfficiencyFactor(1000 / 360, 125)).toBeCloseTo(
      speedEfficiencyFactor(1000 / 300, 150),
      9,
    );
  });
});

describe("interpretDecoupling", () => {
  it("maps the documented bands", () => {
    expect(interpretDecoupling(-3)).toContain("negative");
    expect(interpretDecoupling(2)).toContain("excellent");
    expect(interpretDecoupling(7)).toContain("moderate");
    expect(interpretDecoupling(12)).toContain("high");
  });
});
