import { describe, expect, it } from "vitest";
import { type IntervalsAthletePaceCurves } from "./intervalsClient";
import {
  buildSplits,
  CS_MODEL_MAX_SECONDS,
  CS_MODEL_MIN_SECONDS,
  criticalSpeedModel,
  criticalSpeedPredict,
  daysBetween,
  extrapolationWeight,
  formatRaceTime,
  gradeConfidence,
  isWithinCriticalSpeedValidity,
  MIN_SOURCE_DISTANCE_M,
  NEGATIVE_SPLIT_PCT,
  paceCurveSourceEfforts,
  parseGoalTime,
  predictRace,
  RACE_DISTANCES,
  racePace,
  recencyWeight,
  riegelPredict,
  type SourceEffort,
  selectSourceEfforts,
} from "./racePrediction";

const REFERENCE = "2026-07-28";

const effort = (over: Partial<SourceEffort> = {}): SourceEffort => ({
  name: "10K",
  distanceMeters: 10000,
  elapsedSeconds: 2400, // 40:00
  date: "2026-07-01",
  activityId: "1",
  activityName: "Morning Run",
  ...over,
});

describe("riegelPredict", () => {
  it("returns the source time at the source distance", () => {
    expect(riegelPredict(1200, 5000, 5000)).toBeCloseTo(1200, 6);
  });

  it("applies T2 = T1 * (D2/D1)^1.06", () => {
    // A 20:00 5K predicts 10K at 1200 * 2^1.06 = 2502.6s ≈ 41:43.
    expect(riegelPredict(1200, 5000, 10000)).toBeCloseTo(1200 * 2 ** 1.06, 6);
  });

  it("predicts a faster pace at a shorter distance", () => {
    // Halving the distance takes *less* than half the time: the shorter race
    // is run at a quicker pace, which is the whole point of the exponent.
    const half = riegelPredict(2400, 10000, 5000)!;
    expect(half).toBeLessThan(1200);
    expect(half).toBeGreaterThan(1000);
    // And the round trip back out again recovers the original time.
    expect(riegelPredict(half, 5000, 10000)).toBeCloseTo(2400, 6);
  });

  it("returns null for degenerate inputs", () => {
    expect(riegelPredict(0, 5000, 10000)).toBeNull();
    expect(riegelPredict(1200, 0, 10000)).toBeNull();
    expect(riegelPredict(1200, 5000, 0)).toBeNull();
    expect(riegelPredict(Number.NaN, 5000, 10000)).toBeNull();
  });
});

describe("daysBetween", () => {
  it("counts whole days back from the reference", () => {
    expect(daysBetween("2026-07-01", "2026-07-28")).toBe(27);
    expect(daysBetween("2026-07-28", "2026-07-28")).toBe(0);
  });

  it("is negative for a date after the reference", () => {
    expect(daysBetween("2026-08-01", "2026-07-28")).toBe(-4);
  });

  it("returns 0 rather than NaN for an unparseable date", () => {
    expect(daysBetween("not-a-date", REFERENCE)).toBe(0);
  });
});

describe("recencyWeight", () => {
  it("halves every half-life", () => {
    expect(recencyWeight(0)).toBeCloseTo(1, 6);
    expect(recencyWeight(90)).toBeCloseTo(0.5, 6);
    expect(recencyWeight(180)).toBeCloseTo(0.25, 6);
  });

  it("floors so an ancient effort still counts for something", () => {
    expect(recencyWeight(100_000)).toBeGreaterThan(0);
  });
});

describe("extrapolationWeight", () => {
  it("is 1 at the same distance and symmetric in log space", () => {
    expect(extrapolationWeight(10000, 10000)).toBeCloseTo(1, 6);
    expect(extrapolationWeight(5000, 10000)).toBeCloseTo(
      extrapolationWeight(10000, 5000),
      6,
    );
  });

  it("falls off as the extrapolation widens", () => {
    const near = extrapolationWeight(10000, 21097.5);
    const far = extrapolationWeight(5000, 42195);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });
});

describe("selectSourceEfforts", () => {
  it("drops efforts shorter than the Riegel floor", () => {
    const selected = selectSourceEfforts(
      [
        effort({ name: "400m", distanceMeters: 400, elapsedSeconds: 70 }),
        effort({ name: "1K", distanceMeters: 1000, elapsedSeconds: 200 }),
        effort({ name: "1 mile", distanceMeters: 1609, elapsedSeconds: 330 }),
      ],
      REFERENCE,
    );

    expect(selected.map((s) => s.name)).toEqual(["1 mile"]);
    expect(MIN_SOURCE_DISTANCE_M).toBe(1500);
  });

  it("keeps only the fastest effort per distance", () => {
    const selected = selectSourceEfforts(
      [
        effort({ elapsedSeconds: 2400, activityId: "fast" }),
        effort({ elapsedSeconds: 2600, activityId: "slow" }),
      ],
      REFERENCE,
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.activityId).toBe("fast");
  });

  it("adds a recent effort when the outright best is stale", () => {
    const selected = selectSourceEfforts(
      [
        effort({
          elapsedSeconds: 2300,
          date: "2025-01-01",
          activityId: "old-pr",
        }),
        effort({
          elapsedSeconds: 2500,
          date: "2026-07-10",
          activityId: "recent",
        }),
      ],
      REFERENCE,
    );

    expect(selected.map((s) => s.activityId).sort()).toEqual([
      "old-pr",
      "recent",
    ]);
  });

  it("does not add a second candidate when the best is already recent", () => {
    const selected = selectSourceEfforts(
      [
        effort({ elapsedSeconds: 2300, date: "2026-07-20", activityId: "pr" }),
        effort({
          elapsedSeconds: 2500,
          date: "2026-07-10",
          activityId: "slower",
        }),
      ],
      REFERENCE,
    );

    expect(selected.map((s) => s.activityId)).toEqual(["pr"]);
  });

  it("buckets near-identical distances together and sorts by distance", () => {
    const selected = selectSourceEfforts(
      [
        effort({ distanceMeters: 21097.5, elapsedSeconds: 5400, name: "Half" }),
        effort({ distanceMeters: 5000, elapsedSeconds: 1200, name: "5K" }),
        effort({ distanceMeters: 5000.4, elapsedSeconds: 1300, name: "5K" }),
      ],
      REFERENCE,
    );

    expect(selected.map((s) => s.distanceMeters)).toEqual([5000, 21097.5]);
  });
});

describe("predictRace", () => {
  it("returns null when nothing can be extrapolated", () => {
    expect(predictRace([], 21097.5, "Half Marathon", REFERENCE)).toBeNull();
  });

  it("predicts from a single source and reports it as primary", () => {
    const prediction = predictRace(
      [effort({ elapsedSeconds: 2400 })],
      21097.5,
      "Half Marathon",
      REFERENCE,
    )!;

    expect(prediction.label).toBe("Half Marathon");
    expect(prediction.predictedSeconds).toBe(
      Math.round(riegelPredict(2400, 10000, 21097.5)!),
    );
    expect(prediction.primary.source.activityId).toBe("1");
    expect(prediction.spread).toBeNull();
    expect(prediction.contributions).toHaveLength(1);
  });

  it("weights the nearer distance above the far extrapolation", () => {
    const prediction = predictRace(
      [
        effort({ name: "5K", distanceMeters: 5000, elapsedSeconds: 1200 }),
        effort({ name: "10K", distanceMeters: 10000, elapsedSeconds: 2400 }),
      ],
      21097.5,
      "Half Marathon",
      REFERENCE,
    )!;

    // Same date, so extrapolation distance is the only differentiator.
    expect(prediction.primary.source.name).toBe("10K");
    expect(prediction.contributions[0]!.weight).toBeGreaterThan(
      prediction.contributions[1]!.weight,
    );
  });

  it("weights a recent effort above an equally-distant stale one", () => {
    const prediction = predictRace(
      [
        effort({ date: "2024-01-01", activityId: "stale" }),
        effort({
          distanceMeters: 10001,
          date: "2026-07-20",
          activityId: "fresh",
        }),
      ],
      21097.5,
      "Half Marathon",
      REFERENCE,
    )!;

    expect(prediction.primary.source.activityId).toBe("fresh");
  });

  it("lands the consensus between the individual estimates", () => {
    const prediction = predictRace(
      [
        effort({ name: "5K", distanceMeters: 5000, elapsedSeconds: 1140 }),
        effort({ name: "10K", distanceMeters: 10000, elapsedSeconds: 2500 }),
      ],
      21097.5,
      "Half Marathon",
      REFERENCE,
    )!;

    expect(prediction.predictedSeconds).toBeGreaterThanOrEqual(
      prediction.spread!.fastestSeconds,
    );
    expect(prediction.predictedSeconds).toBeLessThanOrEqual(
      prediction.spread!.slowestSeconds,
    );
    expect(prediction.spread!.rangeSeconds).toBe(
      prediction.spread!.slowestSeconds - prediction.spread!.fastestSeconds,
    );
  });

  it("derives km pace from the consensus time", () => {
    const prediction = predictRace(
      [effort({ elapsedSeconds: 2400 })],
      10000,
      "10K",
      REFERENCE,
    )!;

    expect(prediction.predictedSeconds).toBe(2400);
    expect(prediction.paceSecPerKm).toBe(240);
  });
});

describe("gradeConfidence", () => {
  const contribution = (over: Record<string, unknown> = {}) => ({
    source: effort(),
    predictedSeconds: 5400,
    ageDays: 10,
    recencyWeight: 0.9,
    extrapolationWeight: 0.5,
    weight: 0.45,
    ...over,
  });

  it("is low with no contributions at all", () => {
    expect(gradeConfidence([], 21097.5, 5400).confidence).toBe("low");
  });

  it("is medium on a single source even when everything else is ideal", () => {
    const graded = gradeConfidence([contribution()], 10000, 5400);
    expect(graded.confidence).toBe("medium");
    expect(graded.notes.join(" ")).toContain("Only one usable effort");
  });

  it("is high when several recent, nearby, agreeing efforts back it", () => {
    const graded = gradeConfidence(
      [
        contribution(),
        contribution({
          predictedSeconds: 5450,
          source: effort({ activityId: "2" }),
        }),
      ],
      10000,
      5400,
    );
    expect(graded.confidence).toBe("high");
  });

  it("drops to low when extrapolating far past the longest effort", () => {
    const graded = gradeConfidence(
      [contribution(), contribution({ predictedSeconds: 5400 })],
      42195,
      5400,
    );
    expect(graded.confidence).toBe("low");
    expect(graded.notes.join(" ")).toContain("beyond your longest");
  });

  it("drops to low on a very stale driving effort", () => {
    const graded = gradeConfidence(
      [
        contribution({ ageDays: 400 }),
        contribution({ predictedSeconds: 5410 }),
      ],
      10000,
      5400,
    );
    expect(graded.confidence).toBe("low");
    expect(graded.notes.join(" ")).toContain("400 days old");
  });

  it("drops to low when the sources wildly disagree", () => {
    const graded = gradeConfidence(
      [
        contribution({ predictedSeconds: 4500 }),
        contribution({ predictedSeconds: 6500 }),
      ],
      10000,
      5400,
    );
    expect(graded.confidence).toBe("low");
    expect(graded.notes.join(" ")).toContain("disagree");
  });

  it("never promotes back up after a demotion", () => {
    const graded = gradeConfidence(
      [contribution({ ageDays: 400 })],
      42195,
      5400,
    );
    expect(graded.confidence).toBe("low");
  });
});

describe("buildSplits", () => {
  it("splits an even 10K into ten equal kilometres", () => {
    const plan = buildSplits(2400, 10000, "km");

    expect(plan.splits).toHaveLength(10);
    expect(plan.splits.every((s) => Math.round(s.splitSeconds) === 240)).toBe(
      true,
    );
    expect(plan.splits.at(-1)?.cumulativeSeconds).toBeCloseTo(2400, 6);
    expect(plan.splits.at(-1)?.cumulativeMeters).toBe(10000);
  });

  it("ends a marathon with the 195 m partial split", () => {
    const plan = buildSplits(10800, RACE_DISTANCES.Marathon, "km");

    expect(plan.splits).toHaveLength(43);
    const last = plan.splits.at(-1)!;
    expect(last.segmentMeters).toBeCloseTo(195, 1);
    expect(last.splitSeconds).toBeLessThan(plan.splits[0]!.splitSeconds);
    // The partial's pace is stated per full km so it stays comparable.
    expect(last.paceSecPerUnit).toBeGreaterThan(0);
    expect(last.cumulativeSeconds).toBeCloseTo(10800, 0);
  });

  it("preserves the total under a negative split", () => {
    const even = buildSplits(5400, 21097.5, "km");
    const negative = buildSplits(5400, 21097.5, "km", NEGATIVE_SPLIT_PCT);

    expect(negative.splits.at(-1)!.cumulativeSeconds).toBeCloseTo(
      even.splits.at(-1)!.cumulativeSeconds,
      3,
    );
  });

  it("runs the first half slower and the second half faster", () => {
    const plan = buildSplits(5400, 21097.5, "km", NEGATIVE_SPLIT_PCT);
    const first = plan.splits[0]!;
    const last = plan.splits.at(-2)!; // -1 is the 97.5 m partial

    expect(first.paceSecPerUnit).toBeGreaterThan(last.paceSecPerUnit);
  });

  it("keeps the straddling split correct rather than snapping it to a half", () => {
    // Half marathon halfway is 10548.75 m, inside km 11.
    const plan = buildSplits(5400, 21097.5, "km", NEGATIVE_SPLIT_PCT);
    const straddling = plan.splits[10]!;
    const before = plan.splits[9]!;
    const after = plan.splits[11]!;

    // The straddling km is a blend: slower than the fast half, faster than
    // the slow half.
    expect(straddling.paceSecPerUnit).toBeLessThan(before.paceSecPerUnit);
    expect(straddling.paceSecPerUnit).toBeGreaterThan(after.paceSecPerUnit);
  });

  it("returns an empty table for degenerate inputs", () => {
    expect(buildSplits(0, 10000, "km").splits).toEqual([]);
    expect(buildSplits(2400, 0, "km").splits).toEqual([]);
  });
});

describe("parseGoalTime", () => {
  it("parses H:MM:SS and MM:SS", () => {
    expect(parseGoalTime("1:45:00")).toBe(6300);
    expect(parseGoalTime("45:30")).toBe(2730);
    expect(parseGoalTime("  20:00 ")).toBe(1200);
  });

  it("parses the h/m/s shorthand", () => {
    expect(parseGoalTime("1h45m")).toBe(6300);
    expect(parseGoalTime("90m")).toBe(5400);
    expect(parseGoalTime("3h")).toBe(10800);
    expect(parseGoalTime("2h30m15s")).toBe(9015);
  });

  it("parses a bare number of seconds", () => {
    expect(parseGoalTime("5400")).toBe(5400);
  });

  it("rejects nonsense and out-of-range components", () => {
    expect(parseGoalTime("")).toBeNull();
    expect(parseGoalTime("soon")).toBeNull();
    expect(parseGoalTime("1:75:00")).toBeNull();
    expect(parseGoalTime("45:75")).toBeNull();
    expect(parseGoalTime("0")).toBeNull();
  });
});

describe("formatters", () => {
  it("formats race times with padded components", () => {
    expect(formatRaceTime(2400)).toBe("40:00");
    expect(formatRaceTime(6300)).toBe("1:45:00");
    expect(formatRaceTime(3661)).toBe("1:01:01");
    expect(formatRaceTime(-5)).toBe("0:00");
  });

  it("derives km pace for a race", () => {
    const pace = racePace(2400, 10000)!;
    expect(pace.minPerKm).toBe("4:00");
  });

  it("returns null pace for a degenerate race", () => {
    expect(racePace(0, 10000)).toBeNull();
    expect(racePace(2400, 0)).toBeNull();
  });
});

describe("paceCurveSourceEfforts", () => {
  const curves = (
    over: Partial<IntervalsAthletePaceCurves> = {},
  ): IntervalsAthletePaceCurves =>
    ({
      list: [
        {
          id: "all",
          distance: [1000, 5000, 10000],
          values: [200, 1100, 2400],
          activity_id: ["i1", "i2", "i3"],
        },
        {
          id: "90d",
          distance: [1000, 5000, 10000],
          values: [205, 1150, null],
          activity_id: ["i4", "i5", null],
        },
      ],
      activities: {
        i1: { id: "i1", name: "1K race", start_date_local: "2024-01-01" },
        i2: { id: "i2", name: "5K race", start_date_local: "2024-02-01" },
        i3: { id: "i3", name: "10K race", start_date_local: "2024-03-01" },
        i4: { id: "i4", name: "Recent 1K", start_date_local: "2026-06-01" },
        i5: { id: "i5", name: "Recent 5K", start_date_local: "2026-06-15" },
      },
      ...over,
    }) as unknown as IntervalsAthletePaceCurves;

  it("maps both curves' points to source efforts, dropping points under the Riegel floor", () => {
    const efforts = paceCurveSourceEfforts(curves());

    // 1000 m is under MIN_SOURCE_DISTANCE_M (1500) on both curves.
    expect(
      efforts.every((e) => e.distanceMeters >= MIN_SOURCE_DISTANCE_M),
    ).toBe(true);
    expect(efforts.map((e) => e.activityId).sort()).toEqual(
      ["i2", "i3", "i5"].sort(),
    );
  });

  it("skips a curve point with no value or no owning activity", () => {
    const efforts = paceCurveSourceEfforts(curves());
    // The 90d curve's 10K point is null (no run reached 10K in 90 days),
    // so only the all-time 10K (i3) shows up, not a second phantom one.
    const tenK = efforts.filter((e) => e.distanceMeters === 10000);
    expect(tenK).toHaveLength(1);
    expect(tenK[0]?.activityId).toBe("i3");
  });

  it("labels each point by its distance, not a Strava-style name", () => {
    const efforts = paceCurveSourceEfforts(curves());
    const fiveK = efforts.find((e) => e.activityId === "i2");
    expect(fiveK?.name).toBe("5000 m");
  });

  it("returns nothing for a missing all/90d curve", () => {
    const efforts = paceCurveSourceEfforts({
      list: [],
      activities: {},
    } as unknown as IntervalsAthletePaceCurves);
    expect(efforts).toEqual([]);
  });
});

describe("criticalSpeedModel", () => {
  const listItem = (paceModels: unknown) =>
    ({ paceModels }) as unknown as IntervalsAthletePaceCurves["list"][number];

  it("reads the type: CS model's fields", () => {
    const model = criticalSpeedModel(
      listItem([{ type: "CS", criticalSpeed: 3.6, dPrime: 120, r2: 0.999 }]),
    );
    expect(model).toEqual({
      criticalSpeedMetersPerSec: 3.6,
      dPrimeMeters: 120,
      r2: 0.999,
    });
  });

  it("ignores a non-CS model in the same list", () => {
    const model = criticalSpeedModel(
      listItem([{ type: "OTHER", criticalSpeed: 3.6, dPrime: 120, r2: 0.9 }]),
    );
    expect(model).toBeNull();
  });

  it("returns null for a missing or degenerate model", () => {
    expect(criticalSpeedModel(undefined)).toBeNull();
    expect(criticalSpeedModel(listItem(null))).toBeNull();
    expect(
      criticalSpeedModel(
        listItem([{ type: "CS", criticalSpeed: 0, dPrime: 120, r2: 0.9 }]),
      ),
    ).toBeNull();
  });
});

describe("criticalSpeedPredict", () => {
  const model = { criticalSpeedMetersPerSec: 4, dPrimeMeters: 100, r2: 0.99 };

  it("computes time = (distance - dPrime) / criticalSpeed", () => {
    expect(criticalSpeedPredict(model, 5100)).toBeCloseTo(1250, 6);
  });

  it("returns null when the target does not exceed dPrime", () => {
    expect(criticalSpeedPredict(model, 100)).toBeNull();
    expect(criticalSpeedPredict(model, 50)).toBeNull();
  });
});

describe("isWithinCriticalSpeedValidity", () => {
  it("is true inside the stated 3-60 minute window", () => {
    expect(isWithinCriticalSpeedValidity(CS_MODEL_MIN_SECONDS)).toBe(true);
    expect(isWithinCriticalSpeedValidity(CS_MODEL_MAX_SECONDS)).toBe(true);
    expect(isWithinCriticalSpeedValidity(600)).toBe(true);
  });

  it("is false outside the window, e.g. a marathon-length prediction", () => {
    expect(isWithinCriticalSpeedValidity(CS_MODEL_MIN_SECONDS - 1)).toBe(false);
    expect(isWithinCriticalSpeedValidity(CS_MODEL_MAX_SECONDS + 1)).toBe(false);
    expect(isWithinCriticalSpeedValidity(3 * 3600)).toBe(false);
  });
});
