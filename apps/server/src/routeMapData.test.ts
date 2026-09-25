import { describe, expect, it } from "vitest";
import streamsFixture from "./__fixtures__/intervals/streams.json";
import {
  type IntervalsActivity,
  type IntervalsInterval,
} from "./intervalsClient";
import { type IntervalsStreams } from "./intervalsStreams";
import { buildRouteMapData, MAX_ROUTE_MAP_POINTS } from "./routeMapData";

const activity = (
  overrides: Partial<IntervalsActivity> = {},
): IntervalsActivity =>
  ({
    id: "i189807578",
    name: "Morning Run",
    type: "Run",
    start_date_local: "2026-09-20T06:00:00",
    distance: 10000,
    total_elevation_gain: 96,
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

const streams = (overrides: Partial<IntervalsStreams>): IntervalsStreams =>
  ({
    time: [],
    moving: [],
    length: 0,
    ...overrides,
  }) as IntervalsStreams;

describe("buildRouteMapData", () => {
  it("drops samples whose latlng is null from every aligned stream", () => {
    const data = buildRouteMapData(
      activity(),
      streams({
        time: [0, 1, 2, 3],
        latlng: [null, [1, 100], [2, 101], null],
        heartrate: [140, 150, 160, 170],
      }),
      [],
    );

    expect(data.coordinates).toEqual([
      [1, 100],
      [2, 101],
    ]);
    expect(data.streams?.time).toEqual([1, 2]);
    expect(data.streams?.heartrate).toEqual([150, 160]);
    expect(data.start).toEqual([1, 100]);
    expect(data.end).toEqual([2, 101]);
  });

  it("returns empty coordinates and no streams when there is no latlng stream", () => {
    const data = buildRouteMapData(
      activity(),
      streams({ time: [0, 1, 2] }),
      [],
    );

    expect(data.coordinates).toEqual([]);
    expect(data.start).toBeNull();
    expect(data.end).toBeNull();
    expect(data.streams).toBeUndefined();
  });

  it("returns empty coordinates when every latlng sample is null", () => {
    const data = buildRouteMapData(
      activity(),
      streams({ time: [0, 1], latlng: [null, null] }),
      [],
    );

    expect(data.coordinates).toEqual([]);
  });

  it("returns empty coordinates for a stream-less activity (streams: null)", () => {
    const data = buildRouteMapData(activity(), null, []);

    expect(data.coordinates).toEqual([]);
    expect(data.start).toBeNull();
    expect(data.end).toBeNull();
    expect(data.streams).toBeUndefined();
    expect(data.annotations).toBeUndefined();
  });

  it("fills gaps in distance but keeps nulls in other metric streams", () => {
    const data = buildRouteMapData(
      activity(),
      streams({
        time: [0, 1, 2, 3, 4],
        latlng: [
          [0, 0],
          [0, 1],
          [0, 2],
          [0, 3],
          [0, 4],
        ],
        distance: [null, null, 10, 20, null],
        heartrate: [null, 100, null, 110, 120],
      }),
      [],
    );

    expect(data.streams?.distance).toEqual([10, 10, 10, 20, 20]);
    expect(data.streams?.heartrate).toEqual([null, 100, null, 110, 120]);
  });

  it("jointly downsamples to at most MAX_ROUTE_MAP_POINTS and keeps every stream aligned", () => {
    const length = 2500;
    const time = Array.from({ length }, (_, i) => i);
    const latlng: Array<[number, number] | null> = Array.from(
      { length },
      (_, i) => [-33.8568 + i * 0.00001, 151.2153 + i * 0.00001],
    );
    const heartrate = Array.from({ length }, (_, i) =>
      i % 7 === 0 ? null : 120 + (i % 20),
    );

    const data = buildRouteMapData(
      activity(),
      streams({ time, latlng, heartrate }),
      [],
    );

    expect(data.coordinates.length).toBeLessThanOrEqual(MAX_ROUTE_MAP_POINTS);
    expect(data.streams?.time).toHaveLength(data.coordinates.length);
    expect(data.streams?.heartrate).toHaveLength(data.coordinates.length);
    for (let i = 1; i < (data.streams?.time?.length ?? 0); i += 1) {
      expect(data.streams!.time![i]!).toBeGreaterThanOrEqual(
        data.streams!.time![i - 1]!,
      );
    }
  });

  it("marks only WORK interval ends, numbered among WORK intervals", () => {
    const time = [0, 1, 2, 3, 4, 5];
    const latlng: Array<[number, number]> = time.map((t) => [0, t]);
    const intervals: IntervalsInterval[] = [
      interval({ type: "WORK", start_time: 0, end_time: 2 }),
      interval({ type: "RECOVERY", start_time: 2, end_time: 3 }),
      interval({ type: "WORK", start_time: 3, end_time: 5 }),
    ];

    const data = buildRouteMapData(
      activity(),
      streams({ time, latlng }),
      intervals,
    );

    expect(data.annotations?.laps).toEqual([
      { lapIndex: 1, name: "Lap 1", endIndex: 2 },
      { lapIndex: 2, name: "Lap 2", endIndex: 5 },
    ]);
  });

  it("gives a one-lap run a single finish marker", () => {
    const time = [0, 1, 2, 3];
    const latlng: Array<[number, number]> = time.map((t) => [0, t]);
    const intervals: IntervalsInterval[] = [
      interval({ type: "WORK", start_time: 0, end_time: 3 }),
    ];

    const data = buildRouteMapData(
      activity(),
      streams({ time, latlng }),
      intervals,
    );

    expect(data.annotations?.laps).toHaveLength(1);
    expect(data.annotations?.laps?.[0]).toMatchObject({
      lapIndex: 1,
      name: "Lap 1",
      endIndex: 3,
    });
  });

  it("keeps a real label as the marker name instead of 'Lap N'", () => {
    const time = [0, 1, 2];
    const latlng: Array<[number, number]> = time.map((t) => [0, t]);
    const intervals: IntervalsInterval[] = [
      interval({ type: "WORK", label: "Tempo", start_time: 0, end_time: 2 }),
    ];

    const data = buildRouteMapData(
      activity(),
      streams({ time, latlng }),
      intervals,
    );

    expect(data.annotations?.laps?.[0]?.name).toBe("Tempo");
  });

  it("has no annotations when there are no WORK intervals", () => {
    const time = [0, 1, 2];
    const latlng: Array<[number, number]> = time.map((t) => [0, t]);
    const intervals: IntervalsInterval[] = [
      interval({ type: "RECOVERY", start_time: 0, end_time: 2 }),
    ];

    const data = buildRouteMapData(
      activity(),
      streams({ time, latlng }),
      intervals,
    );

    expect(data.annotations).toBeUndefined();
  });

  it("anchors waypoints on the distance stream and drops out-of-range ones", () => {
    const time = [0, 1, 2];
    const latlng: Array<[number, number]> = [
      [0, 0],
      [0, 1],
      [0, 2],
    ];
    const distance = [0, 5000, 10000];

    const data = buildRouteMapData(
      activity({ distance: 10000 }),
      streams({ time, latlng, distance }),
      [],
      [
        { km: 4, label: "Gel 1", kind: "fuel" },
        { km: 42, label: "Too far", kind: "climb" },
      ],
    );

    expect(data.annotations?.waypoints).toEqual([
      { km: 4, label: "Gel 1", kind: "fuel", index: 1 },
    ]);
    expect(data.waypointWarnings).toHaveLength(1);
    expect(data.waypointWarnings?.[0]).toContain("Too far");
  });

  it("builds a real, sanitized fixture end to end (streams.json)", () => {
    const lat = (
      streamsFixture as Array<{
        type: string;
        data: (number | null)[];
        data2?: (number | null)[];
      }>
    ).find((s) => s.type === "latlng")!;
    const heartrate = (
      streamsFixture as Array<{ type: string; data: (number | null)[] }>
    ).find((s) => s.type === "heartrate")!;
    const time = (
      streamsFixture as Array<{ type: string; data: (number | null)[] }>
    ).find((s) => s.type === "time")!;

    const latlng = lat.data.map((la, i) =>
      la != null && lat.data2![i] != null
        ? ([la, lat.data2![i]] as [number, number])
        : null,
    );

    const data = buildRouteMapData(
      activity(),
      streams({
        time: time.data as number[],
        latlng,
        heartrate: heartrate.data,
      }),
      [],
    );

    const nonNullSamples = latlng.filter((p) => p != null).length;
    expect(data.coordinates).toHaveLength(nonNullSamples);
    expect(data.coordinates[0]).toEqual([-33.8568, 151.2153]);
    expect(data.streams?.heartrate).toHaveLength(nonNullSamples);
  });
});
