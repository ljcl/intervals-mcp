/**
 * A synthetic "Sunday route" for the stored-route tests: a 12.03 km loop
 * near Rozelle as intervals.icu streams (activity i195596014), with a 30 m
 * climb from km 7.8 to 9 (the "Anzac Bridge"), places to look up, and a
 * fake OpenRouteService that walks straight between waypoints. Shapes
 * match the real APIs; the geometry is made up.
 */
import { haversineMeters, type LatLng } from "../mapAnchors";
import { OrsApiError, type OrsRoute, type OrsRouteRequest } from "../orsClient";
import { moveToward, trackFromPoints } from "../routeGeometry";

export const SUNDAY_ID = "i195596014";
export const SUNDAY_START: LatLng = [-33.86, 151.17];
/** The loop: east 3 km, north 3 km, west 3 km, south 3.03 km. */
const LEGS: Array<[heading: number, metres: number]> = [
  [90, 3000],
  [0, 3000],
  [270, 3000],
  [180, 3030],
];
const STEP_M = 3;

function sundayPoints(): { points: LatLng[]; along: number[] } {
  const points: LatLng[] = [SUNDAY_START];
  const along: number[] = [0];
  let at = SUNDAY_START;
  let done = 0;
  for (const [heading, metres] of LEGS) {
    const leg = at;
    for (let d = STEP_M; d <= metres; d += STEP_M) {
      at = moveToward(leg, heading, d);
      points.push(at);
      along.push(done + d);
    }
    done += metres;
  }
  return { points, along };
}

/** Altitude: 10 m, rising 30 m from km 7.8 to 8.4 and down again by km 9. */
function altitudeAt(m: number): number {
  if (m < 7800 || m > 9000) return 10;
  return m <= 8400
    ? 10 + (30 * (m - 7800)) / 600
    : 40 - (30 * (m - 8400)) / 600;
}

/** The activity as intervals.icu returns it. */
export const SUNDAY_ACTIVITY = {
  id: SUNDAY_ID,
  name: "Sunday long run",
  type: "Run",
  start_date_local: "2026-11-01T07:00:00",
  distance: 12030,
  moving_time: 4200,
  elapsed_time: 4300,
  total_elevation_gain: 30,
};

/** The activity's streams as intervals.icu returns them. */
export function sundayStreams() {
  const { points, along } = sundayPoints();
  const distance = trackFromPoints(points).distance;
  const stream = (type: string, data: unknown[], data2?: unknown[]) => ({
    type,
    name: null,
    data,
    data2: data2 ?? null,
    valueType: "java.lang.Float",
    valueTypeIsArray: false,
    anomalies: null,
    custom: false,
    allNull: false,
  });
  return [
    stream(
      "time",
      points.map((_, i) => i),
    ),
    stream("distance", distance),
    stream(
      "altitude",
      along.map((m) => altitudeAt(m)),
    ),
    stream(
      "latlng",
      points.map((p) => p[0]),
      points.map((p) => p[1]),
    ),
  ];
}

/** The Sunday route's point at `km` along it. */
export function sundayPointAt(km: number): LatLng {
  const { points, along } = sundayPoints();
  const i = along.findIndex((m) => m >= km * 1000);
  return points[i < 0 ? points.length - 1 : i]!;
}

/** Places the fake geocoder knows. Iron Cove is 1.5 km west of the route's km 5.27. */
export const PLACES: Record<string, LatLng> = {
  "Iron Cove, Sydney": moveToward(sundayPointAt(5.27), 270, 1500),
  "Callan Park, Sydney": moveToward(sundayPointAt(1.5), 180, 400),
  "In the harbour": [-34.5, 151.3],
};

/** Every point a fake route passed through is within this of a waypoint chain. */
const FAKE_STEP_M = 10;

/**
 * A fake foot route: straight lines between the waypoints, a point every
 * 10 m, a 2 m rise per km, 60% on paths. A waypoint south of -34.4 is "in
 * the harbour": 404, as ORS answers for a point it cannot reach.
 */
export function fakeOrsRoute(_key: string, request: OrsRouteRequest): OrsRoute {
  if (request.waypoints.some(([lat]) => lat < -34.4))
    throw new OrsApiError("route between places: 404 no route", {
      status: 404,
      statusText: "Not Found",
      data: "{}",
    });
  const points: LatLng[] = [request.waypoints[0]!];
  for (let i = 1; i < request.waypoints.length; i++) {
    const from = request.waypoints[i - 1]!;
    const to = request.waypoints[i]!;
    const metres = haversineMeters(from, to);
    const steps = Math.max(1, Math.ceil(metres / FAKE_STEP_M));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      points.push([
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
      ]);
    }
  }
  const track = trackFromPoints(points);
  track.altitude = track.distance.map((d) => 20 + d / 500);
  const distance_m = track.distance.at(-1) ?? 0;
  return {
    track,
    distance_m,
    ascent_m: distance_m / 500,
    path_share: 0.6,
    ferry_m: 0,
    way_names: ["Victoria Road"],
    named_spans: [[0, track.coordinates.length - 1, "Victoria Road"]],
    waytype_spans: [],
  };
}

/** The fake geocoder: a known place, else none. */
export function fakeGeocode(_key: string, text: string) {
  const point = PLACES[text];
  return point ? { label: text, point } : null;
}
