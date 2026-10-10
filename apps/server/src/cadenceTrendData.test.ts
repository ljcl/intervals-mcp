import { PACE_ZONES, type PaceZone } from "@intervals-mcp/data";
import { describe, expect, it } from "vitest";
import { buildCadenceTrendData, cadenceTrendLines } from "./cadenceTrendData";
import { type IntervalsActivity } from "./intervalsClient";

function activity(
  overrides: Partial<IntervalsActivity> = {},
): IntervalsActivity {
  return {
    id: "i1",
    name: "Easy Run",
    type: "Run",
    start_date_local: "2026-06-01T07:00:00",
    distance: 8000,
    moving_time: 2400,
    average_cadence: 84,
    average_speed: 3.33,
    ...overrides,
  } as IntervalsActivity;
}

describe("buildCadenceTrendData", () => {
  it("keeps only run types and drops the rest", () => {
    const result = buildCadenceTrendData(
      [activity(), activity({ id: "i2", type: "Ride" })],
      { days: 28 },
    );

    expect(result.days).toBe(28);
    expect(result).not.toHaveProperty("weeks");
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]?.id).toBe("i1");
  });

  it("keeps Run/TrailRun/VirtualRun", () => {
    const result = buildCadenceTrendData(
      [
        activity({ id: "i1", type: "Run" }),
        activity({ id: "i2", type: "TrailRun" }),
        activity({ id: "i3", type: "VirtualRun" }),
        activity({ id: "i4", type: "Walk" }),
      ],
      { days: 28 },
    );

    expect(result.activities.map((a) => a.id)).toEqual(["i1", "i2", "i3"]);
  });

  it("doubles cadence to steps/min via activityCadenceSpm", () => {
    const result = buildCadenceTrendData([activity({ average_cadence: 84 })], {
      days: 28,
    });

    expect(result.activities[0]?.averageCadence).toBe(168);
  });

  it("excludes a run with no recorded cadence rather than plotting it at 0 spm, and counts it", () => {
    const result = buildCadenceTrendData(
      [activity({ average_cadence: null })],
      { days: 28 },
    );

    expect(result.activities).toHaveLength(0);
    expect(result.excludedNoCadence).toBe(1);
  });

  it("counts multiple exclusions and leaves cadence-bearing runs untouched", () => {
    const result = buildCadenceTrendData(
      [
        activity({ id: "i1", average_cadence: 84 }),
        activity({ id: "i2", average_cadence: null }),
        activity({ id: "i3", average_cadence: undefined }),
      ],
      { days: 28 },
    );

    expect(result.activities.map((a) => a.id)).toEqual(["i1"]);
    expect(result.excludedNoCadence).toBe(2);
  });

  it("reports zero exclusions when every run has cadence", () => {
    const result = buildCadenceTrendData([activity()], { days: 28 });

    expect(result.excludedNoCadence).toBe(0);
  });

  it("derives pace in decimal minutes/km from distance over moving time, as every activity pace does", () => {
    // 12,031 m in 3,700 s moving is 5:08 /km; intervals.icu's average_speed
    // (3.277 m/s, over the watch's 3,671 s timer) would give 5:05.
    const result = buildCadenceTrendData(
      [activity({ distance: 12031, moving_time: 3700, average_speed: 3.277 })],
      { days: 28 },
    );

    expect(result.activities[0]?.averagePace).toBeCloseTo(5.13, 2);
    expect(result.noPaceCount).toBe(0);
  });

  it("falls back to average_speed when the run has no moving time", () => {
    const result = buildCadenceTrendData(
      [activity({ moving_time: null, average_speed: 3.33 })],
      { days: 28 },
    );

    // 1000 / 3.33 / 60 ≈ 5.005
    expect(result.activities[0]?.averagePace).toBeCloseTo(5.01, 2);
  });

  it("gives a run with no recorded speed a null pace instead of 0 min/km, but keeps it (it still has cadence)", () => {
    const result = buildCadenceTrendData(
      [activity({ distance: 0, average_speed: null })],
      { days: 28 },
    );

    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]?.averagePace).toBeNull();
    expect(result.noPaceCount).toBe(1);
  });

  it("counts multiple no-pace runs and leaves pace-bearing runs untouched", () => {
    const result = buildCadenceTrendData(
      [
        activity({ id: "i1", average_speed: 3.33 }),
        activity({ id: "i2", distance: null, average_speed: null }),
        activity({ id: "i3", distance: 0, average_speed: 0 }),
      ],
      { days: 28 },
    );

    expect(result.activities).toHaveLength(3);
    expect(result.activities[0]?.averagePace).not.toBeNull();
    expect(result.activities[1]?.averagePace).toBeNull();
    expect(result.activities[2]?.averagePace).toBeNull();
    expect(result.noPaceCount).toBe(2);
  });

  it("carries the intervals id through as a string", () => {
    const result = buildCadenceTrendData([activity({ id: "i189807578" })], {
      days: 28,
    });

    expect(result.activities[0]?.id).toBe("i189807578");
    expect(typeof result.activities[0]?.id).toBe("string");
  });

  it("reads the local calendar date without a UTC shift for a late-evening run", () => {
    // A run at 23:30 local time must stay on that calendar day: no `Z`
    // suffix means this must never round-trip through `new Date()`.
    const result = buildCadenceTrendData(
      [activity({ start_date_local: "2026-06-01T23:30:00" })],
      { days: 28 },
    );

    expect(result.activities[0]?.date).toBe("2026-06-01");
  });

  it("leaves out a run under 1 km and counts it, keeping a run with no distance", () => {
    const result = buildCadenceTrendData(
      [
        activity({ id: "i1", distance: 220, moving_time: 80 }),
        activity({ id: "i2", distance: 1000, moving_time: 330 }),
        activity({ id: "i3", distance: 0, moving_time: 1800 }),
        activity({ id: "i4", distance: null, moving_time: 1800 }),
      ],
      { days: 28 },
    );

    expect(result.activities.map((a) => a.id)).toEqual(["i2", "i3", "i4"]);
    expect(result.excludedShort).toBe(1);
  });

  it("carries the athlete's pace zones, else the fixed ones", () => {
    const zones: PaceZone[] = [
      { label: "Zone 1", minPace: 5.5, maxPace: null },
      { label: "Zone 2", minPace: null, maxPace: 5.5 },
    ];
    const athlete = buildCadenceTrendData([activity()], {
      days: 28,
      paceZones: zones,
    });
    expect(athlete.paceZones).toBe(zones);
    expect(athlete.paceZoneSource).toBe("athlete");

    for (const paceZones of [null, [], undefined]) {
      const fixed = buildCadenceTrendData([activity()], {
        days: 28,
        paceZones,
      });
      expect(fixed.paceZones).toBe(PACE_ZONES);
      expect(fixed.paceZoneSource).toBe("default");
    }
  });

  it("converts distance to km rounded to 2dp", () => {
    const result = buildCadenceTrendData([activity({ distance: 8123.456 })], {
      days: 28,
    });

    expect(result.activities[0]?.distance).toBe(8.12);
  });
});

describe("cadenceTrendLines", () => {
  const runs = (paces: Array<[number | null, number]>) =>
    buildCadenceTrendData(
      paces.map(([paceMinPerKm, spm], i) =>
        activity({
          id: `i${i + 1}`,
          name: `Run ${i + 1}`,
          start_date_local: `${new Date(Date.UTC(2026, 5, 20 - i)).toISOString().slice(0, 10)}T07:00:00`,
          distance: paceMinPerKm == null ? 0 : 10000,
          moving_time: paceMinPerKm == null ? 3000 : paceMinPerKm * 600,
          average_speed: null,
          average_cadence: spm / 2,
        }),
      ),
      { days: 28 },
    );

  it("lists each run's cadence, cadence by pace zone, and the slope against pace", () => {
    const lines = cadenceTrendLines(
      runs([
        [4.25, 176],
        [5, 170],
        [6, 160],
        [null, 166],
      ]),
    );
    expect(lines).toEqual([
      "Cadence Trends (last 4 weeks)",
      "Runs: 4",
      "Average cadence: 168 spm",
      "No pace recorded (cadence only): 1",
      "",
      "Cadence by run (newest first):",
      "  2026-06-20 Run 1 [i1]: 10.00 km, 4:15 /km, 176 spm",
      "  2026-06-19 Run 2 [i2]: 10.00 km, 5:00 /km, 170 spm",
      "  2026-06-18 Run 3 [i3]: 10.00 km, 6:00 /km, 160 spm",
      "  2026-06-17 Run 4 [i4]: 0.00 km, no pace, 166 spm",
      "",
      "Cadence by pace zone (fixed zones: the Run sport settings have no threshold pace or pace zones):",
      "  Threshold (faster than 4:00 /km): no runs",
      "  Tempo (4:30-4:00 /km): 1 run, mean 176 spm (176 to 176)",
      "  Moderate (5:30-4:30 /km): 1 run, mean 170 spm (170 to 170)",
      "  Easy (slower than 5:30 /km): 1 run, mean 160 spm (160 to 160)",
      "",
      "Cadence against pace: slope -9.2 spm per min/km over 3 runs: cadence rises 9.2 spm for each 1:00 /km faster.",
    ]);
  });

  it("buckets by the athlete's pace zones and names the runs under 1 km it left out", () => {
    // 4:50 /km threshold, as on the athlete's Run settings.
    const zones: PaceZone[] = [
      { label: "Zone 1", minPace: 6.22, maxPace: null },
      { label: "Zone 2", minPace: 5.51, maxPace: 6.22 },
      { label: "Zone 3", minPace: 5.12, maxPace: 5.51 },
      { label: "Zone 4", minPace: 4.83, maxPace: 5.12 },
      { label: "Zone 5", minPace: null, maxPace: 4.83 },
    ];
    const data = buildCadenceTrendData(
      [
        activity({ id: "i1", distance: 10000, moving_time: 2940 }), // 4:54
        activity({ id: "i2", distance: 10000, moving_time: 3600 }), // 6:00
        activity({ id: "i3", distance: 220, moving_time: 80 }),
      ],
      { days: 28, paceZones: zones },
    );
    const lines = cadenceTrendLines(data);

    expect(lines).toContain("Excluded (under 1 km): 1");
    const from = lines.indexOf(
      "Cadence by pace zone (the Run sport settings' pace zones):",
    );
    expect(lines.slice(from + 1, from + 6)).toEqual([
      "  Zone 1 (slower than 6:13 /km): no runs",
      "  Zone 2 (6:13-5:31 /km): 1 run, mean 168 spm (168 to 168)",
      "  Zone 3 (5:31-5:07 /km): no runs",
      "  Zone 4 (5:07-4:50 /km): 1 run, mean 168 spm (168 to 168)",
      "  Zone 5 (faster than 4:50 /km): no runs",
    ]);
  });

  it("says when there is no line to fit, and lists at most 60 runs", () => {
    const many = runs(
      Array.from({ length: 62 }, () => [5, 170] as [number, number]),
    );
    const lines = cadenceTrendLines(many);
    expect(lines.filter((l) => l.startsWith("  2026-"))).toHaveLength(60);
    expect(lines).toContain(
      "  (2 runs more; a shorter days window lists them)",
    );
    // Every run shares one pace: no slope.
    expect(lines.at(-1)).toBe(
      "Cadence against pace: no line, because fewer than 2 runs have both a pace and a cadence, or they all share one pace.",
    );
  });

  it("stops after the totals when the window has no runs with cadence", () => {
    expect(cadenceTrendLines(runs([]))).toEqual([
      "Cadence Trends (last 4 weeks)",
      "Runs: 0",
      "Average cadence: 0 spm",
    ]);
  });
});
