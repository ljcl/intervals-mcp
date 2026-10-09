import { describe, expect, it } from "vitest";
import streamsFixture from "./__fixtures__/intervals/streams.json";
import {
  buildActivityChartData,
  emptyActivityChartData,
  MAX_CHART_POINTS,
} from "./activityChartData";
import { round } from "./formatters";
import {
  type IntervalsActivity,
  type IntervalsInterval,
} from "./intervalsClient";
import { type IntervalsStreams } from "./intervalsStreams";
import { rawUnitDecimals } from "./streamPrecision";

const activity = (
  overrides: Partial<IntervalsActivity> = {},
): IntervalsActivity =>
  ({
    id: "i189807578",
    name: "Run 1",
    type: "Run",
    start_date_local: "2026-09-20T06:00:00",
    ...overrides,
  }) as IntervalsActivity;

const interval = (overrides: Partial<IntervalsInterval>): IntervalsInterval =>
  ({
    type: "WORK",
    label: null,
    start_time: 0,
    end_time: 10,
    ...overrides,
  }) as IntervalsInterval;

describe("buildActivityChartData", () => {
  it("downsamples jointly to at most MAX_CHART_POINTS and keeps arrays aligned", () => {
    const length = 2500;
    const time = Array.from({ length }, (_, i) => i);
    const heartrate = Array.from({ length }, (_, i) =>
      i % 7 === 0 ? null : 120 + (i % 20),
    );
    const cadence = Array.from({ length }, (_, i) =>
      i % 11 === 0 ? null : 80,
    );

    const data = buildActivityChartData(
      activity(),
      { time, heartrate, cadence, moving: [], length },
      [],
    );

    expect(data.streams.time.length).toBeLessThanOrEqual(MAX_CHART_POINTS);
    expect(data.streams.heartrate).toHaveLength(data.streams.time.length);
    expect(data.streams.cadence).toHaveLength(data.streams.time.length);
    // Gap-free and monotonic.
    for (let i = 1; i < data.streams.time.length; i += 1) {
      expect(data.streams.time[i]!).toBeGreaterThanOrEqual(
        data.streams.time[i - 1]!,
      );
      expect(data.streams.time[i]).not.toBeNull();
    }
  });

  it("fills gaps in distance but keeps nulls in metric streams", () => {
    const time = [0, 1, 2, 3, 4];
    const distance = [null, null, 10, 20, null];
    const heartrate = [null, 100, null, 110, 120];

    const data = buildActivityChartData(
      activity(),
      { time, distance, heartrate, moving: [], length: 5 },
      [],
    );

    expect(data.streams.distance).toEqual([10, 10, 10, 20, 20]);
    expect(data.streams.heartrate).toEqual([null, 100, null, 110, 120]);
  });

  it("omits the distance stream entirely rather than filling it with zeros when every sample is null", () => {
    const time = [0, 1, 2, 3, 4];
    const distance = [null, null, null, null, null];

    const data = buildActivityChartData(
      activity(),
      { time, distance, moving: [], length: 5 },
      [],
    );

    expect(data.streams.distance).toBeUndefined();
    expect(data.streams.time).toEqual(time);
  });

  it("maps one band per icu_intervals entry with indices on the downsampled time array", () => {
    // A 20 s auto-pause gap between index 3 (t=3) and index 4 (t=23):
    // start_time 23 does not equal raw index 4's position by seconds.
    const time = [0, 1, 2, 3, 23, 24, 25, 26];

    const intervals: IntervalsInterval[] = [
      interval({ type: "WORK", start_time: 0, end_time: 3 }),
      interval({ type: "RECOVERY", start_time: 3, end_time: 23 }),
      interval({ type: "WORK", start_time: 23, end_time: 26 }),
    ];

    const data = buildActivityChartData(
      activity(),
      { time, moving: [], length: time.length },
      intervals,
    );

    expect(data.laps).toHaveLength(3);
    expect(data.laps[0]).toMatchObject({
      type: "WORK",
      startIndex: 0,
      endIndex: 3,
    });
    expect(data.laps[1]).toMatchObject({
      type: "RECOVERY",
      label: null,
      name: "Recovery",
      startIndex: 3,
      // First index whose time >= 23 is index 4.
      endIndex: 4,
    });
    expect(data.laps[2]).toMatchObject({
      type: "WORK",
      startIndex: 4,
      endIndex: 7,
    });
  });

  it("names an unlabeled WORK band 'Lap N' and keeps a real label as the name", () => {
    const time = [0, 1, 2, 3];
    const intervals: IntervalsInterval[] = [
      interval({ type: "WORK", label: null, start_time: 0, end_time: 3 }),
      interval({
        type: "WORK",
        label: "Tempo",
        start_time: 3,
        end_time: 3,
      }),
    ];

    const data = buildActivityChartData(
      activity(),
      { time, moving: [], length: time.length },
      intervals,
    );

    expect(data.laps[0]?.name).toBe("Lap 1");
    expect(data.laps[0]?.label).toBeNull();
    expect(data.laps[1]?.name).toBe("Tempo");
    expect(data.laps[1]?.label).toBe("Tempo");
    expect(data.laps.map((l) => l.lapIndex)).toEqual([1, 2]);
  });

  it("carries activity identity through, defaulting name to type when unset", () => {
    const data = buildActivityChartData(
      activity({ name: null }),
      { time: [0, 1], moving: [], length: 2 },
      [],
    );

    expect(data.activityId).toBe("i189807578");
    expect(data.activityType).toBe("Run");
    expect(data.name).toBe("Run");
  });

  it("matches the real streams fixture's shape (no downsampling needed at 600 points)", () => {
    const byType = new Map(
      (streamsFixture as Array<{ type: string; data: (number | null)[] }>).map(
        (s) => [s.type, s.data],
      ),
    );

    const data = buildActivityChartData(
      activity(),
      {
        time: byType.get("time") as number[],
        distance: byType.get("distance"),
        heartrate: byType.get("heartrate"),
        cadence: byType.get("cadence"),
        stance_time: byType.get("stance_time"),
        vertical_oscillation: byType.get("vertical_oscillation"),
        vertical_ratio: byType.get("vertical_ratio"),
        step_length: byType.get("step_length"),
        moving: [],
        length: (byType.get("time") as number[]).length,
      },
      [],
    );

    expect(data.streams.time).toHaveLength(600);
    expect(data.streams.time.every((t) => t != null)).toBe(true);
    expect(data.streams.distance).toHaveLength(600);
    expect(data.streams.distance?.every((d) => d != null)).toBe(true);
    expect(data.streams.stance_time).toHaveLength(600);
    expect(data.streams.stance_time?.some((v) => v === null)).toBe(true);
  });
});

/**
 * A run with all 12 scalar chart columns holding long fractions, and a
 * null every 97 samples in each metric column.
 */
function longFractionStreams(length: number): IntervalsStreams {
  const column = (base: number, step: number) =>
    Array.from({ length }, (_, i) =>
      i % 97 === 0 ? null : base + i * step + 1 / 3,
    );
  return {
    time: Array.from({ length }, (_, i) => i + 1 / 7),
    distance: Array.from({ length }, (_, i) => i * 2.876543219),
    heartrate: column(140, 0.00731),
    watts: column(250, 0.0123),
    velocity_smooth: column(2.9, 0.000123),
    altitude: column(80, 0.0031),
    grade_smooth: column(-3, 0.00171),
    cadence: column(86, 0.000417),
    stance_time: column(240, 0.00213),
    vertical_oscillation: column(85, 0.00177),
    vertical_ratio: column(7, 0.000331),
    step_length: column(1100, 0.0147),
    moving: [],
    length,
  };
}

describe("buildActivityChartData wire precision", () => {
  it("chart payload stream values carry at most 2 decimals", () => {
    const data = buildActivityChartData(
      activity(),
      longFractionStreams(3600),
      [],
    );

    const columns = Object.entries(data.streams) as Array<
      [Parameters<typeof rawUnitDecimals>[0], (number | null)[]]
    >;
    expect(columns).toHaveLength(12);
    const offenders: string[] = [];
    for (const [key, values] of columns) {
      for (const v of values) {
        if (v == null) continue;
        if (round(v, 2) !== v || round(v, rawUnitDecimals(key)) !== v)
          offenders.push(`${key}: ${v}`);
      }
    }
    expect(offenders).toEqual([]);
    // Cadence stays in strides/min, so it keeps its one decimal.
    expect(
      data.streams.cadence?.some((v) => v != null && !Number.isInteger(v)),
    ).toBe(true);
  });

  it("rounds a short activity that needs no downsampling", () => {
    const length = 600;
    const data = buildActivityChartData(
      activity(),
      {
        time: Array.from({ length }, (_, i) => i),
        grade_smooth: Array.from({ length }, () => 1.7961273),
        moving: [],
        length,
      },
      [],
    );

    expect(data.streams.time).toHaveLength(length);
    expect(data.streams.grade_smooth?.[0]).toBe(1.8);
  });

  it.each([600, 3600])(
    "leaves the caller's streams unchanged (%i samples)",
    (length) => {
      const streams = longFractionStreams(length);
      const before = structuredClone(streams);

      const data = buildActivityChartData(activity(), streams, []);

      expect(streams).toEqual(before);
      expect(data.streams.heartrate).not.toBe(streams.heartrate);
    },
  );

  it("indexes bands on the unrounded time", () => {
    // Rounded first, time reads [0, 1, 1, 2], and a band that starts at
    // 1 s would start at index 1 rather than at 1.2 s, index 2.
    const time = [0, 0.6, 1.2, 1.8];

    const data = buildActivityChartData(
      activity(),
      { time, moving: [], length: time.length },
      [interval({ start_time: 1, end_time: 1.8 })],
    );

    expect(data.streams.time).toEqual([0, 1, 1, 2]);
    expect(data.laps[0]).toMatchObject({ startIndex: 2, endIndex: 3 });
  });
});

describe("emptyActivityChartData", () => {
  it("has nothing to plot and says so", () => {
    expect(emptyActivityChartData(activity())).toEqual({
      activityId: "i189807578",
      activityType: "Run",
      name: "Run 1",
      streams: { time: [] },
      laps: [],
      noStreams: true,
    });
  });

  it("carries the same identity fields as buildActivityChartData", () => {
    const unnamed = activity({ name: null, type: undefined });
    const built = buildActivityChartData(
      unnamed,
      { time: [0, 1], moving: [], length: 2 },
      [],
    );
    const empty = emptyActivityChartData(unnamed);

    expect(empty.activityId).toBe(built.activityId);
    expect(empty.activityType).toBe(built.activityType);
    expect(empty.name).toBe(built.name);
  });
});
