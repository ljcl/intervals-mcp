import { describe, expect, it } from "vitest";
import { buildCompareA11yDescription, buildCompareA11yTitle } from "./a11y";
import { type AlignedPoint } from "./types";

const data: AlignedPoint[] = [
  { x: 0, aHeartrate: 120, bHeartrate: 130, aPace: 5.5, bPace: 5.2 },
  { x: 500, aHeartrate: 150, bHeartrate: 165, aPace: 5.0, bPace: 4.8 },
  { x: 1000, aHeartrate: 160, bHeartrate: 172, aPace: 5.25, bPace: 5.0 },
];

describe("buildCompareA11yTitle", () => {
  it("names both activities", () => {
    expect(buildCompareA11yTitle("Steady", "Race")).toBe(
      'Comparison chart of "Steady" and "Race"',
    );
  });
});

describe("buildCompareA11yDescription", () => {
  const base = {
    nameA: "Steady",
    nameB: "Race",
    category: "run" as const,
    bothRunning: true,
    data,
    hidden: { a: false, b: false },
  };

  it("describes the metric, distance extent, and both ranges", () => {
    const text = buildCompareA11yDescription({
      ...base,
      metric: "heartrate",
      axis: "distance",
    });
    expect(text).toContain("Overlay of heart rate over 1.0 km, by distance.");
    expect(text).toContain('"Steady" ranges from 120 to 160 bpm.');
    expect(text).toContain('"Race" ranges from 130 to 172 bpm.');
  });

  it("narrates the time axis and formatted pace", () => {
    const text = buildCompareA11yDescription({
      ...base,
      metric: "pace",
      axis: "time",
    });
    expect(text).toContain("Overlay of pace over 16:40, by time.");
    expect(text).toContain('"Steady" ranges from 5\'00" to 5\'30" min/km.');
  });

  it("narrates swim pace per 100 m", () => {
    const text = buildCompareA11yDescription({
      ...base,
      category: "swim",
      bothRunning: false,
      data: [
        { x: 0, aPace: 1.5, bPace: 1.75 },
        { x: 100, aPace: 1.75, bPace: 2 },
      ],
      metric: "pace",
      axis: "time",
    });
    expect(text).toContain("Overlay of pace over 01:40, by time.");
    expect(text).toContain('"Steady" ranges from 1\'30" to 1\'45" per 100 m.');
  });

  it("calls pace speed in km/h for mixed pairs", () => {
    const text = buildCompareA11yDescription({
      ...base,
      category: "other",
      bothRunning: false,
      metric: "pace",
      axis: "time",
    });
    expect(text).toContain("Overlay of speed");
    expect(text).toContain("km/h");
  });

  it("notes a hidden line instead of its range", () => {
    const text = buildCompareA11yDescription({
      ...base,
      metric: "heartrate",
      axis: "distance",
      hidden: { a: true, b: false },
    });
    expect(text).toContain('"Steady" is hidden.');
    expect(text).toContain('"Race" ranges from 130 to 172 bpm.');
  });

  it("degrades to the metric alone on empty data", () => {
    const text = buildCompareA11yDescription({
      ...base,
      data: [],
      metric: "heartrate",
      axis: "distance",
    });
    expect(text).toBe("Overlay of heart rate.");
  });
});
