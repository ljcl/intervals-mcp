import { type RouteMapData } from "../types";

/**
 * A loopy activity track (start and finish near each other). Synthetic:
 * anchored to the sanitized fixture origin (first point -33.8568, 151.2153,
 * matching `__fixtures__/intervals/streams.json`), not a real place.
 */
const loopCoordinates: Array<[number, number]> = [
  [-33.8568, 151.2153],
  [-33.8557, 151.221],
  [-33.855, 151.227],
  [-33.8543, 151.233],
  [-33.8538, 151.239],
  [-33.8534, 151.245],
  [-33.8531, 151.251],
  [-33.8536, 151.257],
  [-33.8552, 151.26],
  [-33.8574, 151.2595],
  [-33.859, 151.256],
  [-33.8597, 151.25],
  [-33.86, 151.244],
  [-33.8602, 151.238],
  [-33.8603, 151.232],
  [-33.8601, 151.226],
  [-33.8594, 151.2205],
  [-33.8582, 151.2165],
  [-33.857, 151.2154],
];

export const loopActivity: RouteMapData = {
  source: "activity",
  id: "i1234567890",
  name: "Harbour Loop",
  activityType: "Run",
  distance: 8230,
  elevationGain: 96,
  coordinates: loopCoordinates,
  start: loopCoordinates[0]!,
  end: loopCoordinates[loopCoordinates.length - 1]!,
};

/** Interpolated samples per leg when densifying a hand-written track. */
const POINTS_PER_LEG = 8;

/**
 * Densify a coarse track to stream resolution, so a fixture can carry streams
 * aligned index-for-index with its coordinates.
 */
function densify(track: Array<[number, number]>): Array<[number, number]> {
  return track.flatMap(([lat, lng], i) => {
    const next = track[i + 1];
    if (!next) return [[lat, lng] as [number, number]];
    return Array.from({ length: POINTS_PER_LEG }, (_, j) => {
      const t = j / POINTS_PER_LEG;
      return [lat + (next[0] - lat) * t, lng + (next[1] - lng) * t] as [
        number,
        number,
      ];
    });
  });
}

/**
 * The loop densified to GPS-stream resolution, with deterministic synthetic
 * metric streams aligned to each point, to exercise metric coloring, the
 * hover scrub, and the elevation strip.
 */
const streamCoordinates = densify(loopCoordinates);

const n = streamCoordinates.length;
const SAMPLE_SECONDS = 5;

const velocity = Array.from(
  { length: n },
  (_, i) => 2.9 + 0.7 * Math.sin(i / 9) + 0.3 * Math.sin(i / 3.5),
);
const time = Array.from({ length: n }, (_, i) => i * SAMPLE_SECONDS);
const distance = velocity.reduce<number[]>((acc, v, i) => {
  acc.push((acc[i - 1] ?? 0) + v * SAMPLE_SECONDS);
  return acc;
}, []);
const altitude = Array.from(
  { length: n },
  (_, i) => 24 + 16 * Math.sin(i / 14) + 5 * Math.sin(i / 5),
);
const heartrate = Array.from(
  { length: n },
  (_, i) => 146 + 16 * Math.sin(i / 11 + 1) + 4 * Math.sin(i / 4),
);
const watts = Array.from(
  { length: n },
  (_, i) => 215 + 55 * Math.sin(i / 7) + 15 * Math.sin(i / 3),
);
const gradeSmooth = altitude.map((a, i) => {
  const prev = altitude[i - 1] ?? a;
  const run = velocity[i]! * SAMPLE_SECONDS;
  return Math.round(((a - prev) / run) * 1000) / 10;
});

export const streamLoopActivity: RouteMapData = {
  source: "activity",
  id: "i1234567891",
  name: "Harbour Tempo",
  activityType: "Run",
  distance: distance[n - 1]!,
  elevationGain: 124,
  coordinates: streamCoordinates,
  start: streamCoordinates[0]!,
  end: streamCoordinates[n - 1]!,
  streams: {
    time,
    distance,
    altitude,
    heartrate,
    watts,
    velocity_smooth: velocity,
    grade_smooth: gradeSmooth,
  },
};

/**
 * The stream activity plus lap annotation anchors, to exercise the split
 * overlay layer and its toggle.
 */
export const annotatedActivity: RouteMapData = {
  ...streamLoopActivity,
  id: "i1234567892",
  name: "Harbour Race",
  annotations: {
    laps: [
      { lapIndex: 1, name: "Lap 1", endIndex: Math.floor(n / 3) },
      { lapIndex: 2, name: "Lap 2", endIndex: Math.floor((2 * n) / 3) },
    ],
  },
};

/** First sample at or past `km` kilometres, mirroring the server's anchor. */
const waypointIndex = (km: number) => distance.findIndex((d) => d >= km * 1000);

/**
 * The stream activity plus caller-pinned waypoints (one of each kind), to
 * exercise the waypoint layer on the track, elevation strip, and legend.
 */
export const waypointedActivity: RouteMapData = {
  ...streamLoopActivity,
  id: "i1234567893",
  name: "Harbour Race Plan",
  annotations: {
    waypoints: [
      { index: waypointIndex(0.5), km: 0.5, label: "Gel 1", kind: "fuel" },
      {
        index: waypointIndex(1),
        km: 1,
        label: "Lookout climb +30m",
        kind: "climb",
      },
      {
        index: waypointIndex(1.5),
        km: 1.5,
        label: "Water fountain",
        kind: "water",
      },
      {
        index: waypointIndex(1.9),
        km: 1.9,
        label: "Regroup point",
        kind: "custom",
      },
    ],
  },
};

/**
 * Punches a `null` run into a copy of one metric stream, standing in for a
 * real sensor dropout (GPS loss, HR strap disconnect). Used by
 * `gappyStreamActivity` to verify the colored track and elevation strip
 * both break at the gap instead of drawing a fabricated color or dip.
 */
function withStreamGap(
  values: number[],
  fromIndex: number,
  toIndex: number,
): Array<number | null> {
  const copy: Array<number | null> = [...values];
  for (let i = fromIndex; i <= toIndex; i += 1) copy[i] = null;
  return copy;
}

/**
 * Task 2: null-safe rendering. Three streams each carry their own gap at a
 * different point along the track, so the colored line, elevation strip,
 * and scrub tooltip all have to tolerate a `null` sample without crashing
 * or fabricating a value.
 */
export const gappyStreamActivity: RouteMapData = {
  ...streamLoopActivity,
  id: "i1234567894",
  name: "Harbour Loop (sensor dropouts)",
  streams: {
    ...streamLoopActivity.streams,
    altitude: withStreamGap(altitude, 30, 40),
    heartrate: withStreamGap(heartrate, 60, 68),
    velocity_smooth: withStreamGap(velocity, 90, 95),
  },
};

/** An indoor activity with no GPS track, to exercise the empty state. */
export const noGeometryActivity: RouteMapData = {
  source: "activity",
  id: "i5555555555",
  name: "Treadmill Intervals",
  activityType: "Run",
  distance: 6000,
  elevationGain: 0,
  coordinates: [],
  start: null,
  end: null,
};
