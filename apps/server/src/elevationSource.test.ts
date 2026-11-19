import { describe, expect, it } from "vitest";
import {
  elevationLines,
  recordedGainFor,
  resolveElevation,
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
