import { describe, expect, it } from "vitest";
import { describeZoomWindow, indexRangeForValues } from "./brushWindow";

/** A 100-sample activity, one sample every 10 seconds. */
const time = Array.from({ length: 100 }, (_, i) => i * 10);

describe("indexRangeForValues", () => {
  it("covers the samples inside the window", () => {
    expect(indexRangeForValues(time, 100, 200)).toEqual({
      startIndex: 10,
      endIndex: 20,
    });
  });

  it("accepts the bounds either way round", () => {
    expect(indexRangeForValues(time, 200, 100)).toEqual(
      indexRangeForValues(time, 100, 200),
    );
  });

  it("clamps a window overhanging the end", () => {
    expect(indexRangeForValues(time, 900, 5000)).toEqual({
      startIndex: 90,
      endIndex: 99,
    });
  });

  it("clamps a window overhanging the start", () => {
    expect(indexRangeForValues(time, -500, 50)).toEqual({
      startIndex: 0,
      endIndex: 5,
    });
  });

  it("returns null for a window entirely past the end", () => {
    // 40–50 km of a 10 km run is a mistake worth reporting, not a reason to
    // silently show the finish.
    expect(indexRangeForValues(time, 5000, 6000)).toBeNull();
  });

  it("returns null when nothing was recorded on this axis", () => {
    expect(indexRangeForValues([], 0, 100)).toBeNull();
    expect(indexRangeForValues([undefined, undefined], 0, 100)).toBeNull();
  });

  it("widens a window narrower than the sample spacing", () => {
    // Recharts renders a zero-width brush as empty.
    const range = indexRangeForValues(time, 100, 101)!;
    expect(range.endIndex).toBeGreaterThan(range.startIndex);
  });

  it("widens backwards at the very end, where there is no next sample", () => {
    const range = indexRangeForValues(time, 990, 990)!;
    expect(range.endIndex).toBeGreaterThan(range.startIndex);
    expect(range.endIndex).toBe(99);
  });

  it("skips gaps instead of reading them as zero", () => {
    // A distance stream that starts late: treating the leading holes as 0
    // would drag every window back to the start of the activity.
    const distance = [undefined, undefined, 1000, 1100, 1200, 1300];

    expect(indexRangeForValues(distance, 1100, 1200)).toEqual({
      startIndex: 3,
      endIndex: 4,
    });
    expect(indexRangeForValues(distance, 0, 500)).toBeNull();
  });

  it("selects the whole series when asked for everything", () => {
    expect(indexRangeForValues(time, 0, 990)).toEqual({
      startIndex: 0,
      endIndex: 99,
    });
  });
});

describe("describeZoomWindow", () => {
  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const points = Array.from({ length: 100 }, (_, i) => ({
    time: i * 10,
    distance: i * 50,
  }));

  it("says nothing when no window is set", () => {
    expect(describeZoomWindow(points, "time", {}, fmt)).toBeNull();
  });

  it("says nothing when the whole activity is shown", () => {
    // "Zoomed to 0:00–16:30" of a 16:30 run is noise in every turn.
    expect(
      describeZoomWindow(points, "time", { startIndex: 0, endIndex: 99 }, fmt),
    ).toBeNull();
  });

  it("reads on the time axis when asked for time", () => {
    expect(
      describeZoomWindow(points, "time", { startIndex: 10, endIndex: 20 }, fmt),
    ).toBe("1:40–3:20");
  });

  it("reads on the distance axis when asked for distance", () => {
    expect(
      describeZoomWindow(
        points,
        "distance",
        { startIndex: 10, endIndex: 20 },
        fmt,
      ),
    ).toBe("0.50–1.00 km");
  });

  it("reads seconds, not km, for a time window on a swim (#65)", () => {
    // A swim's brush runs on distance, but a window asked for in seconds is
    // described in seconds: the same samples, the axis the caller used.
    const swim = points.map((p) => ({ ...p, distance: p.distance * 0.1 }));
    expect(
      describeZoomWindow(swim, "time", { startIndex: 6, endIndex: 12 }, fmt),
    ).toBe("1:00–2:00");
  });

  it("says nothing on the distance axis with no distances recorded", () => {
    const timeOnly = points.map(({ time }) => ({ time }));
    expect(
      describeZoomWindow(
        timeOnly,
        "distance",
        { startIndex: 10, endIndex: 20 },
        fmt,
      ),
    ).toBeNull();
  });
});
