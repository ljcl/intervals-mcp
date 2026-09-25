import { describe, expect, it } from "vitest";
import { poolSwim } from "./__fixtures__/pool-swim";
import { tempoRun } from "./__fixtures__/tempo-run";
import { smoothData, toChartData, toLapData } from "./normalize";
import { type ActivityStreamData, type ChartDataPoint } from "./types";

const streamData = (
  overrides: Partial<ActivityStreamData> & {
    streams: ActivityStreamData["streams"];
  },
): ActivityStreamData => ({
  activityId: "1",
  activityType: "Run",
  name: "Test",
  ...overrides,
});

describe("toChartData", () => {
  it("converts velocity to min/km pace for runs, capped at 15", () => {
    const points = toChartData(
      streamData({
        activityType: "Run",
        streams: { time: [0, 1, 2], velocity_smooth: [3.33, 0.5, 0] },
      }),
    );

    expect(points[0]?.pace).toBeCloseTo(1000 / 3.33 / 60, 3); // ~5:00/km
    expect(points[1]?.pace).toBe(15); // crawling → capped
    expect(points[2]?.pace).toBe(15); // stopped → capped, not Infinity
  });

  it("converts velocity to min/100m for swims, capped at 5", () => {
    const points = toChartData(
      streamData({
        activityType: "Swim",
        streams: { time: [0, 1], velocity_smooth: [1.25, 0] },
      }),
    );

    expect(points[0]?.pace).toBeCloseTo(100 / 1.25 / 60, 3); // 1:20/100m
    expect(points[1]?.pace).toBe(5);
  });

  it("converts velocity to km/h for rides", () => {
    const points = toChartData(
      streamData({
        activityType: "Ride",
        streams: { time: [0], velocity_smooth: [10] },
      }),
    );

    expect(points[0]?.pace).toBeCloseTo(36);
  });

  it("doubles running cadence (strides → steps) but not ride cadence", () => {
    const run = toChartData(
      streamData({
        activityType: "Run",
        streams: { time: [0], cadence: [87] },
      }),
    );
    const ride = toChartData(
      streamData({
        activityType: "Ride",
        streams: { time: [0], cadence: [87] },
      }),
    );

    expect(run[0]?.cadence).toBe(174);
    expect(ride[0]?.cadence).toBe(87);
  });

  it("strips all-zero altitude and grade streams (indoor/pool activities)", () => {
    const points = toChartData(
      streamData({
        activityType: "Swim",
        streams: {
          time: [0, 1, 2],
          altitude: [0, 0, 0],
          grade_smooth: [0, 0, 0],
        },
      }),
    );

    expect(points.every((p) => p.altitude === undefined)).toBe(true);
    expect(points.every((p) => p.grade === undefined)).toBe(true);
  });

  it("keeps altitude when any point is non-zero", () => {
    const points = toChartData(
      streamData({
        streams: { time: [0, 1], altitude: [0, 12] },
      }),
    );

    expect(points[0]?.altitude).toBe(0);
    expect(points[1]?.altitude).toBe(12);
  });

  it("maps a real fixture end to end", () => {
    const points = toChartData(tempoRun);

    expect(points).toHaveLength(tempoRun.streams.time!.length);
    expect(points[0]?.timeFormatted).toBe("00:00");
    expect(points.every((p) => (p.pace ?? 0) <= 15)).toBe(true);
  });

  it("renders a null velocity sample as a gap, not a capped pace spike", () => {
    const points = toChartData(
      streamData({
        activityType: "Run",
        streams: { time: [0, 1, 2], velocity_smooth: [3.33, null, 3.33] },
      }),
    );

    expect(points[1]?.pace).toBeNull();
    expect(points[1]?.pace).not.toBe(15);
  });

  it("renders a null cadence sample as null, not 0", () => {
    const points = toChartData(
      streamData({
        activityType: "Run",
        streams: { time: [0, 1], cadence: [87, null] },
      }),
    );

    expect(points[0]?.cadence).toBe(174);
    expect(points[1]?.cadence).toBeNull();
  });

  it("passes through null heartrate/power/altitude/grade samples as gaps", () => {
    const points = toChartData(
      streamData({
        streams: {
          time: [0, 1],
          heartrate: [140, null],
          watts: [200, null],
          altitude: [10, null],
          grade_smooth: [1, null],
        },
      }),
    );

    expect(points[1]?.heartrate).toBeNull();
    expect(points[1]?.power).toBeNull();
    expect(points[1]?.altitude).toBeNull();
    expect(points[1]?.grade).toBeNull();
  });

  it("passes running-dynamics streams through with their raw units, keeping nulls", () => {
    const points = toChartData(
      streamData({
        activityType: "Run",
        streams: {
          time: [0, 10],
          stance_time: [248, null],
          vertical_oscillation: [8.1, null],
          vertical_ratio: [6.9, null],
          step_length: [1210, null],
        },
      }),
    );

    expect(points[0]?.stanceTime).toBe(248);
    expect(points[0]?.verticalOscillation).toBe(8.1);
    expect(points[0]?.verticalRatio).toBe(6.9);
    expect(points[0]?.stepLength).toBe(1210);
    expect(points[1]?.stanceTime).toBeNull();
    expect(points[1]?.verticalOscillation).toBeNull();
    expect(points[1]?.verticalRatio).toBeNull();
    expect(points[1]?.stepLength).toBeNull();
  });

  it("leaves dynamics fields absent entirely when the activity never recorded them", () => {
    const points = toChartData(
      streamData({
        activityType: "Run",
        streams: { time: [0], heartrate: [140] },
      }),
    );

    expect(points[0]?.stanceTime).toBeUndefined();
    expect("stanceTime" in (points[0] ?? {})).toBe(false);
  });
});

describe("toLapData", () => {
  const base = {
    distance: 300,
    elapsedTime: 120,
    averageSpeed: null,
    averageHeartrate: null,
  };

  it("labels swim laps by distance, keeping meaningful names", () => {
    const laps = toLapData(
      streamData({
        activityType: "Swim",
        streams: { time: [0, 60, 120], distance: [0, 300, 600] },
        laps: [
          { ...base, name: "Lap 1", startIndex: 0, endIndex: 1, lapIndex: 1 },
          {
            ...base,
            name: "Kick set",
            startIndex: 1,
            endIndex: 2,
            lapIndex: 2,
          },
        ],
      }),
    );

    expect(laps[0]?.name).toBe("300m"); // generic "Lap N" replaced
    expect(laps[1]?.name).toBe("Kick set · 300m"); // meaningful name kept
  });

  it("flags rest laps by band type, not name or distance", () => {
    const laps = toLapData(
      streamData({
        streams: { time: [0, 60, 120] },
        laps: [
          {
            ...base,
            type: "RECOVERY",
            distance: 300,
            name: "Recovery",
            startIndex: 0,
            endIndex: 1,
            lapIndex: 1,
          },
          {
            ...base,
            type: "WORK",
            // Null distance (server can't always compute it) must not be
            // mistaken for a rest band.
            distance: null,
            name: "Surge",
            startIndex: 1,
            endIndex: 2,
            lapIndex: 2,
          },
        ],
      }),
    );

    expect(laps[0]?.isRest).toBe(true);
    expect(laps[1]?.isRest).toBe(false);
  });

  it("does not flag a lap named 'Rest' as rest unless its type is RECOVERY", () => {
    const laps = toLapData(
      streamData({
        streams: { time: [0, 60] },
        laps: [
          {
            ...base,
            type: "WORK",
            name: "Rest at wall",
            startIndex: 0,
            endIndex: 1,
            lapIndex: 1,
          },
        ],
      }),
    );

    expect(laps[0]?.isRest).toBe(false);
  });

  it("clamps lap end indices to the stream length", () => {
    const laps = toLapData(
      streamData({
        streams: { time: [0, 60], distance: [0, 500] },
        laps: [
          { ...base, name: "Lap 1", startIndex: 0, endIndex: 99, lapIndex: 1 },
        ],
      }),
    );

    expect(laps[0]?.endTime).toBe(60);
    expect(laps[0]?.endDistance).toBe(500);
  });

  it("returns empty without laps or a time stream", () => {
    expect(toLapData(streamData({ streams: { time: [0, 1] } }))).toEqual([]);
    expect(
      toLapData(
        streamData({
          streams: {},
          laps: [
            { ...base, name: "L", startIndex: 0, endIndex: 1, lapIndex: 1 },
          ],
        }),
      ),
    ).toEqual([]);
    expect(toLapData(poolSwim).length).toBeGreaterThan(0);
  });
});

describe("smoothData", () => {
  const series = (count: number, interval: number): ChartDataPoint[] =>
    Array.from({ length: count }, (_, i) => ({
      time: i * interval,
      timeFormatted: "",
      heartrate: i % 2 === 0 ? 100 : 200, // alternating → smoothing flattens
    }));

  it("auto-sizes the window to ~30 seconds of samples", () => {
    // 1s sampling: window ≈ 30 samples → alternation flattens toward 150.
    const smoothed = smoothData(series(100, 1));
    expect(Math.abs((smoothed[50]?.heartrate ?? 0) - 150)).toBeLessThan(5);

    // 15s sampling: window = max(3, 30/15) = 3 → only nearest neighbours.
    // Index 50 is even (100), neighbours odd (200): (200 + 100 + 200) / 3.
    const coarse = smoothData(series(100, 15));
    expect(coarse[50]?.heartrate).toBeCloseTo((200 + 100 + 200) / 3, 5);
  });

  it("respects an explicit window size", () => {
    const smoothed = smoothData(series(10, 1), 3);

    // Index 5 is odd (200), neighbours even (100): (100 + 200 + 100) / 3.
    expect(smoothed[5]?.heartrate).toBeCloseTo((100 + 200 + 100) / 3, 5);
  });

  it("returns short series unchanged", () => {
    const short = series(2, 1);

    expect(smoothData(short)).toBe(short);
  });

  it("smooths dynamics metrics but keeps their gaps as gaps", () => {
    const points: ChartDataPoint[] = Array.from({ length: 10 }, (_, i) => ({
      time: i,
      timeFormatted: "",
      stanceTime: i === 5 ? null : 240 + i,
    }));

    const smoothed = smoothData(points, 3);
    expect(smoothed[5]?.stanceTime).toBeNull();
    // Neighbours still average (gap excluded from the window's sum).
    expect(smoothed[4]?.stanceTime).toBeCloseTo((243 + 244) / 2, 5);
  });
});
