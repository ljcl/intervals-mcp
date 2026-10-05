import { formatShortDate } from "@intervals-mcp/data";
import { describe, expect, it } from "vitest";
import {
  assignOverlayColors,
  buildCadenceSubtitle,
  buildZoneRows,
  computeSummaryStats,
  computeZoneStats,
  dayTimestamp,
  linearRegression,
  overlayRunLabel,
  overlayRunStatus,
  resampleOverlayRuns,
  rollingAverage,
  toOverlayPoints,
  trendTimeAxis,
} from "./normalize";
import {
  COMPARISON_COLORS,
  type OverlayPoint,
  type RunStreamState,
  type RunSummary,
} from "./types";

const run = (overrides: Partial<RunSummary>): RunSummary => ({
  id: "1",
  name: "Run",
  date: "2026-07-01T06:00:00Z",
  distance: 10,
  duration: 3000,
  averageCadence: 170,
  averagePace: 5,
  type: "Run",
  ...overrides,
});

/** Evenly spaced points: `count` samples covering 0..maxDistance km / 0..maxTime min. */
function makePoints(
  count: number,
  maxDistance: number,
  maxTime: number,
  cadence: (i: number) => number | undefined,
): OverlayPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    distance: (maxDistance * i) / (count - 1),
    time: (maxTime * i) / (count - 1),
    cadence: cadence(i),
  }));
}

describe("resampleOverlayRuns", () => {
  it("returns an empty dataset when no run has cadence", () => {
    const rows = resampleOverlayRuns(
      [{ id: "1", points: makePoints(5, 10, 60, () => undefined) }],
      "distance",
    );
    expect(rows).toEqual([]);
  });

  // Regression for ljcl/strava-mcp#110: the old index merge plotted every run's cadence
  // against the last-iterated run's x values, misaligning runs at
  // different speeds.
  it("keeps each run aligned to its own x values on the shared grid", () => {
    // Fast run: 10 km in 11 points; slow run: 5 km over the same 11 indices.
    // Constant cadences make any misalignment show up as a wrong value.
    const fast = { id: "1", points: makePoints(11, 10, 40, () => 180) };
    const slow = { id: "2", points: makePoints(11, 5, 40, () => 160) };

    const rows = resampleOverlayRuns([fast, slow], "distance", 10);

    // At 4 km both runs are mid-flight and keep their own cadence.
    const at4km = rows.find((r) => Math.abs((r.x ?? 0) - 4) < 1e-9)!;
    expect(at4km.cadence_1).toBeCloseTo(180);
    expect(at4km.cadence_2).toBeCloseTo(160);
  });

  it("interpolates linearly between samples", () => {
    // Cadence ramps 100 -> 200 over 0..10 km.
    const run = {
      id: "7",
      points: makePoints(11, 10, 60, (i) => 100 + i * 10),
    };

    const rows = resampleOverlayRuns([run], "distance", 20);

    const at2500m = rows.find((r) => Math.abs((r.x ?? 0) - 2.5) < 1e-9)!;
    expect(at2500m.cadence_7).toBeCloseTo(125);
  });

  // Regression for ljcl/strava-mcp#110: past a shorter run's end the old merge clamped to
  // its final point, fabricating a flat tail out to the longest run.
  it("leaves shorter runs undefined past their own extent", () => {
    const long = { id: "1", points: makePoints(11, 10, 60, () => 180) };
    const short = { id: "2", points: makePoints(11, 5, 30, () => 170) };

    const rows = resampleOverlayRuns([long, short], "distance", 10);

    const beyondShort = rows.filter((r) => (r.x ?? 0) > 5);
    expect(beyondShort.length).toBeGreaterThan(0);
    for (const row of beyondShort) {
      expect(row.cadence_2).toBeUndefined();
      expect(row.cadence_1).toBeCloseTo(180);
    }
  });

  it("uses time for the x axis in time mode", () => {
    const run = { id: "3", points: makePoints(11, 10, 50, () => 175) };

    const rows = resampleOverlayRuns([run], "time", 10);

    expect(rows[0]!.x).toBeCloseTo(0);
    expect(rows[rows.length - 1]!.x).toBeCloseTo(50);
    expect(rows.every((r) => r.cadence_3 !== undefined)).toBe(true);
  });

  it("breaks the series at an interior gap instead of bridging it", () => {
    // Middle sample missing: the line must not interpolate across it.
    const run = {
      id: "4",
      points: makePoints(5, 4, 20, (i) => (i === 2 ? undefined : 150)),
    };

    const rows = resampleOverlayRuns([run], "distance", 8);

    const at2km = rows.find((r) => Math.abs((r.x ?? 0) - 2) < 1e-9)!;
    expect(at2km.cadence_4).toBeUndefined();
    // Either side of the gap keeps its own real value.
    const at1km = rows.find((r) => Math.abs((r.x ?? 0) - 1) < 1e-9)!;
    const at3km = rows.find((r) => Math.abs((r.x ?? 0) - 3) < 1e-9)!;
    expect(at1km.cadence_4).toBeCloseTo(150);
    expect(at3km.cadence_4).toBeCloseTo(150);
  });

  it("leaves a run undefined before its leading gap", () => {
    // First two samples missing cadence.
    const run = {
      id: "5",
      points: makePoints(5, 4, 20, (i) => (i < 2 ? undefined : 150)),
    };

    const rows = resampleOverlayRuns([run], "distance", 8);

    const before = rows.filter((r) => (r.x ?? 0) < 2 - 1e-9);
    expect(before.length).toBeGreaterThan(0);
    for (const row of before) {
      expect(row.cadence_5).toBeUndefined();
    }
    const at3km = rows.find((r) => Math.abs((r.x ?? 0) - 3) < 1e-9)!;
    expect(at3km.cadence_5).toBeCloseTo(150);
  });

  it("leaves a run undefined after its trailing gap instead of extending the line", () => {
    // Last two samples missing cadence; a longer run keeps the grid going
    // past that point so the truncation is observable.
    const run = {
      id: "6",
      points: makePoints(5, 4, 20, (i) => (i >= 3 ? undefined : 150)),
    };
    const longer = { id: "9", points: makePoints(11, 10, 60, () => 160) };

    const rows = resampleOverlayRuns([run, longer], "distance", 10);

    const after = rows.filter((r) => (r.x ?? 0) > 2 + 1e-9);
    expect(after.length).toBeGreaterThan(0);
    for (const row of after) {
      expect(row.cadence_6).toBeUndefined();
    }
    const at1km = rows.find((r) => Math.abs((r.x ?? 0) - 1) < 1e-9)!;
    expect(at1km.cadence_6).toBeCloseTo(150);
  });
});

describe("rollingAverage", () => {
  it("averages over the centred window sorted by date, skipping zero cadence", () => {
    const result = rollingAverage(
      [
        run({ id: "3", date: "2026-07-03", averageCadence: 180 }),
        run({ id: "1", date: "2026-07-01", averageCadence: 160 }),
        run({ id: "2", date: "2026-07-02", averageCadence: 0 }), // dropout
      ],
      3,
    );

    // Sorted ascending; the middle entry averages its neighbours only.
    expect(result.map((r) => r.date)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
    expect(result[1]?.cadence).toBe(170); // (160 + 180) / 2, zero skipped
  });
});

describe("computeSummaryStats", () => {
  const NOW = Date.parse("2026-07-12T00:00:00Z");

  it("splits activities into current and previous halves deterministically", () => {
    const stats = computeSummaryStats(
      [
        // Within the last 2 weeks (current half of a 4-week window)
        run({ date: "2026-07-10T00:00:00Z", averageCadence: 180 }),
        run({ date: "2026-07-05T00:00:00Z", averageCadence: 176 }),
        // Older half
        run({ date: "2026-06-20T00:00:00Z", averageCadence: 170 }),
      ],
      4,
      NOW,
    );

    expect(stats.currentAvg).toBe(178);
    expect(stats.previousAvg).toBe(170);
    expect(stats.delta).toBe(8);
    expect(stats.runCount).toBe(3);
  });

  it("ignores zero-cadence runs and handles empty halves", () => {
    const stats = computeSummaryStats(
      [run({ date: "2026-07-10T00:00:00Z", averageCadence: 0 })],
      4,
      NOW,
    );

    expect(stats.currentAvg).toBe(0);
    expect(stats.previousAvg).toBe(0);
    expect(stats.delta).toBe(0);
  });
});

describe("computeZoneStats", () => {
  it("buckets runs by pace zone with mean/min/max per zone", () => {
    const stats = computeZoneStats([
      run({ averagePace: 3.8, averageCadence: 185 }), // Threshold (<4)
      run({ averagePace: 4.2, averageCadence: 180 }), // Tempo (4–4.5)
      run({ averagePace: 4.4, averageCadence: 176 }), // Tempo
      run({ averagePace: 6.0, averageCadence: 165 }), // Easy (5.5–20)
      run({ averagePace: 6.0, averageCadence: 0 }), // dropout, excluded
    ]);

    const byLabel = new Map(stats.map((s) => [s.zone.label, s]));
    expect(byLabel.get("Threshold")?.count).toBe(1);
    expect(byLabel.get("Tempo")?.mean).toBe(178);
    expect(byLabel.get("Tempo")?.min).toBe(176);
    expect(byLabel.get("Tempo")?.max).toBe(180);
    expect(byLabel.get("Easy")?.count).toBe(1);
    expect(byLabel.get("Moderate")?.count).toBe(0);
  });

  it("excludes a run with no recorded pace instead of coercing null into a zone", () => {
    const stats = computeZoneStats([
      run({ averagePace: 4.2, averageCadence: 180 }), // Tempo
      run({ averagePace: null, averageCadence: 175 }), // no speed, excluded
    ]);

    const byLabel = new Map(stats.map((s) => [s.zone.label, s]));
    expect(byLabel.get("Tempo")?.count).toBe(1);
    const totalCount = stats.reduce((sum, s) => sum + s.count, 0);
    expect(totalCount).toBe(1);
  });
});

describe("linearRegression", () => {
  it("fits a perfect line exactly", () => {
    const fit = linearRegression([
      { x: 1, y: 3 },
      { x: 2, y: 5 },
      { x: 3, y: 7 },
    ]);

    expect(fit?.slope).toBeCloseTo(2);
    expect(fit?.intercept).toBeCloseTo(1);
  });

  it("returns null for degenerate inputs", () => {
    expect(linearRegression([{ x: 1, y: 1 }])).toBeNull();
    // All x equal → zero denominator.
    expect(
      linearRegression([
        { x: 2, y: 1 },
        { x: 2, y: 9 },
      ]),
    ).toBeNull();
  });
});

describe("toOverlayPoints", () => {
  // The server's stream payload still carries velocity_smooth; the overlay
  // ignores it (it plots cadence only).
  const overlayData = (activityType: string) => ({
    activityId: "1",
    activityType,
    name: "Run",
    streams: {
      time: [0, 60, 120],
      distance: [0, 500, 1000],
      cadence: [85, 86, 87],
      velocity_smooth: [3.33, 0.5, 0],
    },
  });

  it("converts units and doubles running cadence", () => {
    const points = toOverlayPoints(overlayData("Run"));

    expect(points).toHaveLength(3);
    expect(points[0]).toMatchObject({ distance: 0, time: 0, cadence: 170 });
    expect(points[2]?.distance).toBe(1); // km
    expect(points[2]?.time).toBe(2); // minutes
    // Pace was a dead field here (no overlay line reads it), so it is gone.
    for (const point of points) expect(point).not.toHaveProperty("pace");
  });

  it("keeps ride cadence as rpm", () => {
    const points = toOverlayPoints(overlayData("Ride"));

    expect(points[0]?.cadence).toBe(85);
  });

  it("leaves cadence undefined at null samples (leading, interior, trailing)", () => {
    const points = toOverlayPoints({
      activityId: "1",
      activityType: "Run",
      name: "Run",
      streams: {
        time: [0, 60, 120, 180],
        distance: [0, 250, 500, 750],
        cadence: [null, 86, null, 87],
      },
    });

    expect(points).toHaveLength(4);
    // Leading null.
    expect(points[0]?.cadence).toBeUndefined();
    // Real values stay real (not coerced to 0 spm).
    expect(points[1]?.cadence).toBe(172); // running cadence doubled
    // Interior null.
    expect(points[2]?.cadence).toBeUndefined();
    // Trailing real value after a null still comes through.
    expect(points[3]?.cadence).toBe(174);
  });
});

describe("buildCadenceSubtitle", () => {
  it("counts runs over the window", () => {
    expect(buildCadenceSubtitle(18, 6)).toBe("18 runs · last 6 weeks");
  });

  it("uses singular forms for one run and one week", () => {
    expect(buildCadenceSubtitle(1, 1)).toBe("1 run · last 1 week");
  });

  it("still names the window with no runs in it", () => {
    expect(buildCadenceSubtitle(0, 12)).toBe("0 runs · last 12 weeks");
  });
});

describe("buildZoneRows", () => {
  const zone = (label: string) => ({ label, minPace: 0, maxPace: 0 });
  const stats = [
    { zone: zone("Threshold"), mean: 0, min: 0, max: 0, count: 0 },
    { zone: zone("Tempo"), mean: 178, min: 170, max: 190, count: 4 },
    { zone: zone("Moderate"), mean: 172, min: 168, max: 174, count: 6 },
    { zone: zone("Easy"), mean: 166, min: 150, max: 171, count: 9 },
  ];

  it("drops empty zones but keeps each zone's own index", () => {
    expect(buildZoneRows(stats).map((r) => [r.zone, r.zoneIndex])).toEqual([
      ["Tempo", 1],
      ["Moderate", 2],
      ["Easy", 3],
    ]);
  });

  it("draws whiskers from min to max, not a symmetric spread", () => {
    expect(buildZoneRows(stats)[0]?.error).toEqual([8, 12]);
  });

  it("keeps the fields the bars and narration read", () => {
    expect(buildZoneRows(stats)[2]).toMatchObject({
      zone: "Easy",
      mean: 166,
      min: 150,
      max: 171,
      count: 9,
    });
  });

  it("returns no rows when every zone is empty", () => {
    expect(buildZoneRows(computeZoneStats([]))).toEqual([]);
  });
});

describe("dayTimestamp", () => {
  it("reads the leading YYYY-MM-DD as a UTC day", () => {
    expect(dayTimestamp("2026-01-11")).toBe(Date.UTC(2026, 0, 11));
    expect(dayTimestamp("2026-01-11T07:30:00")).toBe(Date.UTC(2026, 0, 11));
  });

  it("puts a gap of three weeks three weeks apart", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(dayTimestamp("2026-02-01") - dayTimestamp("2026-01-11")).toBe(
      21 * day,
    );
  });
});

describe("trendTimeAxis", () => {
  const day = 24 * 60 * 60 * 1000;

  it("spans the runs when they fall on more than one day", () => {
    expect(
      trendTimeAxis([dayTimestamp("2026-01-01"), dayTimestamp("2026-01-20")]),
    ).toEqual({
      domain: ["dataMin", "dataMax"],
    });
  });

  it("widens a one-day span by a day each side with a single tick on it", () => {
    const ts = dayTimestamp("2026-01-01");
    expect(trendTimeAxis([ts])).toEqual({
      domain: [ts - day, ts + day],
      ticks: [ts],
    });
    expect(trendTimeAxis([ts, ts])).toEqual({
      domain: [ts - day, ts + day],
      ticks: [ts],
    });
  });
});

describe("assignOverlayColors", () => {
  it("colours runs by selection order, independent of what has loaded", () => {
    const colors = assignOverlayColors(["i3", "i1", "i2"]);
    expect([...colors.entries()]).toEqual([
      ["i3", COMPARISON_COLORS[0]],
      ["i1", COMPARISON_COLORS[1]],
      ["i2", COMPARISON_COLORS[2]],
    ]);
  });

  it("wraps past the end of the palette", () => {
    const ids = COMPARISON_COLORS.map((_, i) => `r${i}`).concat("extra");
    expect(assignOverlayColors(ids).get("extra")).toBe(COMPARISON_COLORS[0]);
  });
});

describe("overlayRunLabel", () => {
  const a = { id: "i10004", name: "Long Run", date: "2026-01-11" };
  const b = { id: "i10009", name: "Long Run", date: "2026-01-25" };
  const c = { id: "i10003", name: "Tempo", date: "2026-01-09" };

  it("adds the date only when another selected run shares the name", () => {
    expect(overlayRunLabel(a, [a, b, c])).toBe(
      `Long Run · ${formatShortDate("2026-01-11", "short")}`,
    );
    expect(overlayRunLabel(c, [a, b, c])).toBe("Tempo");
    expect(overlayRunLabel(a, [a, c])).toBe("Long Run");
  });
});

describe("overlayRunStatus", () => {
  const state = (over: Partial<RunStreamState> = {}): RunStreamState => ({
    run: run({}),
    points: [{ distance: 0, time: 0, cadence: 170 }],
    loading: false,
    error: null,
    progress: null,
    ...over,
  });

  it("counts a run with no fetch yet as loading, as the overlay does", () => {
    expect(overlayRunStatus(undefined, false)).toBe("loading");
  });

  it("reads each fetch state", () => {
    expect(
      overlayRunStatus(state({ points: null, loading: true }), false),
    ).toBe("loading");
    expect(
      overlayRunStatus(state({ points: null, error: "Error: boom" }), false),
    ).toBe("failed");
    expect(
      overlayRunStatus(state({ points: [], noStreams: true }), false),
    ).toBe("noStreams");
    expect(overlayRunStatus(state(), false)).toBe("drawn");
  });

  it("calls a loaded run hidden only while the legend hides it", () => {
    expect(overlayRunStatus(state(), true)).toBe("hidden");
    // Hiding cannot make a run that is not drawn look drawn, or hidden.
    expect(overlayRunStatus(state({ points: null, loading: true }), true)).toBe(
      "loading",
    );
    expect(overlayRunStatus(state({ points: [], noStreams: true }), true)).toBe(
      "noStreams",
    );
  });
});
