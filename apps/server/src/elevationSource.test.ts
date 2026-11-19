import { describe, expect, it } from "vitest";
import {
  activityGainSource,
  climbGainSensitivity,
  decouplingSensitivity,
  ELEVATION_SENSITIVITY,
  elevationGainLine,
  elevationLines,
  elevationSourcePhrase,
  gapDeltaSensitivity,
  mixedElevationNote,
  recordedGainFor,
  resolveBothElevations,
  resolveElevation,
  streamGainM,
} from "./elevationSource";

const altitude = [10, 11, 12];
const fixed = [20, 22, 24];

describe("resolveElevation", () => {
  it("uses the corrected stream when correction is on and the stream exists", () => {
    const result = resolveElevation(
      { use_elevation_correction: true },
      { altitude, fixed_altitude: fixed },
    );
    expect(result).toEqual({
      altitude: fixed,
      source: "corrected",
      note: null,
    });
  });

  it("uses the recorded stream, with no note, when the caller asks for it", () => {
    const result = resolveElevation(
      { use_elevation_correction: true },
      { altitude, fixed_altitude: fixed },
      false,
    );
    expect(result).toEqual({ altitude, source: "barometric", note: null });
  });

  it("falls back with a note when correction is off, even with a corrected stream", () => {
    const result = resolveElevation(
      { use_elevation_correction: false },
      { altitude, fixed_altitude: fixed },
    );
    expect(result.altitude).toBe(altitude);
    expect(result.source).toBe("barometric");
    expect(result.note).toContain("correction is off");
  });

  it("treats a missing correction flag as off", () => {
    const result = resolveElevation({}, { altitude, fixed_altitude: fixed });
    expect(result.source).toBe("barometric");
    expect(result.note).toContain("correction is off");
  });

  it.each([
    ["missing", undefined],
    ["all null", [null, null, null]],
  ])("falls back with a note when the corrected stream is %s", (_, stream) => {
    const result = resolveElevation(
      { use_elevation_correction: true },
      { altitude, fixed_altitude: stream },
    );
    expect(result.altitude).toBe(altitude);
    expect(result.source).toBe("barometric");
    expect(result.note).toContain("no corrected altitude stream");
  });

  it("reports no source and no note without any altitude", () => {
    expect(resolveElevation({ use_elevation_correction: false }, {})).toEqual({
      altitude: undefined,
      source: null,
      note: null,
    });
  });
});

describe("recordedGainFor", () => {
  const activity = {
    use_elevation_correction: true,
    total_elevation_gain: 120,
  };

  it("keeps the activity's total for a corrected-elevation request", () => {
    expect(recordedGainFor(activity, true)).toBe(120);
  });

  it("drops the total, which follows corrected elevation, for a recorded-altitude request", () => {
    expect(recordedGainFor(activity, false)).toBeNull();
  });

  it("keeps the total when the activity has correction off", () => {
    expect(
      recordedGainFor({ ...activity, use_elevation_correction: false }, false),
    ).toBe(120);
  });

  it("is null without a total", () => {
    expect(
      recordedGainFor({ use_elevation_correction: false }, true),
    ).toBeNull();
  });
});

describe("elevationLines", () => {
  it("names the source and appends the note", () => {
    expect(elevationLines({ source: "corrected", note: null })).toEqual([
      "Elevation source: corrected (intervals.icu elevation correction)",
    ]);
    expect(elevationLines({ source: "barometric", note: "Why." })).toEqual([
      "Elevation source: barometric (recorded altitude). Why.",
    ]);
  });

  it("is empty without a source", () => {
    expect(elevationLines({ source: null, note: null })).toEqual([]);
  });
});

describe("activityGainSource (#509)", () => {
  it("names the source of the activity's own total", () => {
    expect(
      activityGainSource({
        use_elevation_correction: true,
        total_elevation_gain: 120,
      }),
    ).toBe("corrected");
    expect(
      activityGainSource({
        use_elevation_correction: false,
        total_elevation_gain: 120,
      }),
    ).toBe("barometric");
    expect(activityGainSource({ total_elevation_gain: 0 })).toBe("barometric");
  });

  it("is null when the activity has no total", () => {
    expect(
      activityGainSource({
        use_elevation_correction: true,
        total_elevation_gain: null,
      }),
    ).toBeNull();
    expect(activityGainSource({})).toBeNull();
  });
});

describe("mixedElevationNote (#509)", () => {
  it("is null when the sources agree or one is missing", () => {
    expect(mixedElevationNote("corrected", "corrected", "gain")).toBeNull();
    expect(mixedElevationNote("barometric", null, "gain")).toBeNull();
    expect(mixedElevationNote(null, null, "gain")).toBeNull();
  });

  it("names each side's source when they differ", () => {
    expect(
      mixedElevationNote("corrected", "barometric", "elevation gain"),
    ).toBe(
      "Activity 1's elevation gain is from corrected elevation and activity 2's from the recorded (barometric) altitude, so the two are not like for like.",
    );
    expect(elevationSourcePhrase("barometric")).toBe(
      "the recorded (barometric) altitude",
    );
  });
});

describe("resolveBothElevations", () => {
  it("resolves each source when the activity has both", () => {
    const both = resolveBothElevations(
      { use_elevation_correction: true },
      { altitude, fixed_altitude: fixed },
    );
    expect(both.corrected?.altitude).toBe(fixed);
    expect(both.barometric?.altitude).toBe(altitude);
    expect(both.note).toBeNull();
  });

  it("has no corrected source, with a note, when correction is off", () => {
    const both = resolveBothElevations(
      { use_elevation_correction: false },
      { altitude, fixed_altitude: fixed },
    );
    expect(both.corrected).toBeNull();
    expect(both.barometric?.source).toBe("barometric");
    expect(both.note).toBe(
      "The corrected elevation stream is not available (elevation correction is off for this activity in intervals.icu), so this shows the barometric result only.",
    );
  });

  it("names the missing stream when correction is on", () => {
    const both = resolveBothElevations(
      { use_elevation_correction: true },
      { altitude, fixed_altitude: [null, null] },
    );
    expect(both.corrected).toBeNull();
    expect(both.note).toContain(
      "the activity has no corrected altitude stream",
    );
  });

  it("says there is nothing to compare with no altitude at all", () => {
    const both = resolveBothElevations(
      { use_elevation_correction: true },
      { altitude: undefined, fixed_altitude: undefined },
    );
    expect(both.corrected).toBeNull();
    expect(both.barometric).toBeNull();
    expect(both.note).toContain("no elevation source to compare");
  });
});

describe("streamGainM", () => {
  it("sums the ascent past the hysteresis, skipping missing samples", () => {
    expect(streamGainM([10, null, 20, 15, 30])).toBe(25);
  });

  it("is null without a sample", () => {
    expect(streamGainM(undefined)).toBeNull();
    expect(streamGainM([null, null])).toBeNull();
  });
});

describe("elevationGainLine", () => {
  it("names each source's gain", () => {
    expect(elevationGainLine({ corrected: 78, barometric: 79 })).toBe(
      "Gain: corrected +78 m, barometric +79 m (summed from each altitude stream)",
    );
  });

  it("marks a missing source n/a", () => {
    expect(elevationGainLine({ corrected: null, barometric: 61 })).toContain(
      "corrected n/a, barometric +61 m",
    );
  });
});

describe("sensitivity checks", () => {
  const { decouplingPts, gapDeltaPts, climbGainPct, climbGainMinM } =
    ELEVATION_SENSITIVITY;

  it("warns on decoupling only past the threshold", () => {
    expect(decouplingSensitivity(0, decouplingPts).warning).toBeNull();
    const wide = decouplingSensitivity(-8.2, 1.7);
    expect(wide.difference).toBe(9.9);
    expect(wide.warning).toBe(
      `Decoupling differs by 9.9 points between elevation sources (-8.2% corrected, +1.7% barometric), more than ${decouplingPts}. Do not trust the GAP-based result for this run.`,
    );
  });

  it("warns on the grade-adjusted change only past the threshold", () => {
    expect(gapDeltaSensitivity(1, 1 + gapDeltaPts)?.warning).toBeNull();
    expect(gapDeltaSensitivity(-0.7, 4.4)?.warning).toContain(
      "Do not trust the grade-adjusted verdict",
    );
    expect(gapDeltaSensitivity(null, 4.4)).toBeNull();
  });

  it("warns on climb gain past the percent and the metres floor", () => {
    expect(climbGainSensitivity(19.5, 7.4).warning).toContain(
      "Climb gain differs by 62%",
    );
    // Past the percent, but only a few metres apart.
    expect(climbGainSensitivity(4, 4 + climbGainMinM - 1).warning).toBeNull();
    // Past the floor, but within the percent.
    expect(
      climbGainSensitivity(100, 100 * (1 - climbGainPct / 100)).warning,
    ).toBeNull();
    expect(climbGainSensitivity(0, 0)).toEqual({
      difference: 0,
      warning: null,
    });
  });
});
