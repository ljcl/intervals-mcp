import { describe, expect, it } from "vitest";
import streamsFixture from "./__fixtures__/intervals/streams.json";
import { buildActivityChartData, MAX_CHART_POINTS } from "./activityChartData";
import {
  type IntervalsActivity,
  type IntervalsInterval,
} from "./intervalsClient";

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
