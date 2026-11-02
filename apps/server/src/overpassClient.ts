/**
 * Pedestrian crossings and traffic signals from OpenStreetMap (Overpass),
 * the "fewer road crossings" signal for route suggestions. Only an area's
 * bounding box leaves the server. Best effort: public instances are slow
 * (docs/api-notes.md), so any failure is null and the caller ranks by path
 * share instead.
 */
import { CallCancelledError } from "./callScope";
import { isAbortError, overpassApi } from "./fetchClient";
import { type LatLng, type RouteTrack } from "./mapAnchors";
import { SERVER_VERSION } from "./version";

/** Areas snap outward to this grid (about 2 km), so repeat calls share one cached query. */
export const CROSSING_GRID_DEG = 0.02;
/** A crossing node this close to a route segment is on the route. */
export const CROSSING_RADIUS_M = 12;

const METERS_PER_DEG_LAT = 110_540;
const METERS_PER_DEG_LNG_AT_EQUATOR = 111_320;

/** `[south, west, north, east]` around every point, snapped outward to the grid. */
export function snappedBounds(
  tracks: RouteTrack[],
): [number, number, number, number] | null {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const track of tracks) {
    for (const [lat, lng] of track.coordinates) {
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      west = Math.min(west, lng);
      east = Math.max(east, lng);
    }
  }
  if (south === Infinity) return null;
  // The epsilon keeps a value already on the grid from moving a cell out.
  const down = (v: number) =>
    Number(
      (Math.floor(v / CROSSING_GRID_DEG + 1e-9) * CROSSING_GRID_DEG).toFixed(2),
    );
  const up = (v: number) =>
    Number(
      (Math.ceil(v / CROSSING_GRID_DEG - 1e-9) * CROSSING_GRID_DEG).toFixed(2),
    );
  return [down(south), down(west), up(north), up(east)];
}

/** Crossing and signal nodes in the snapped area around `tracks`; null when Overpass did not answer usefully. */
export async function loadCrossings(
  tracks: RouteTrack[],
): Promise<LatLng[] | null> {
  const bounds = snappedBounds(tracks);
  if (!bounds) return [];
  const query = `[out:json][timeout:10];node[highway~"^(crossing|traffic_signals)$"](${bounds.join(",")});out skel qt;`;
  try {
    const { data } = await overpassApi.get<unknown>("/interpreter", {
      params: { data: query },
      headers: {
        "User-Agent": `intervals-mcp/${SERVER_VERSION} (+https://github.com/ljcl/intervals-mcp)`,
      },
      responseType: "text",
    });
    const parsed = JSON.parse(String(data)) as {
      elements?: Array<{ lat?: unknown; lon?: unknown }>;
    };
    return (parsed.elements ?? []).flatMap((e) =>
      typeof e.lat === "number" && typeof e.lon === "number"
        ? [[e.lat, e.lon] as LatLng]
        : [],
    );
  } catch (error) {
    if (isAbortError(error) || error instanceof CallCancelledError) throw error;
    return null;
  }
}

/** Distance (m) from `p` to segment a-b, on a flat projection around `p` (exact enough at this scale). */
function metersToSegment(p: LatLng, a: LatLng, b: LatLng): number {
  const kx = Math.cos((p[0] * Math.PI) / 180) * METERS_PER_DEG_LNG_AT_EQUATOR;
  const ax = (a[1] - p[1]) * kx;
  const ay = (a[0] - p[0]) * METERS_PER_DEG_LAT;
  const dx = (b[1] - p[1]) * kx - ax;
  const dy = (b[0] - p[0]) * METERS_PER_DEG_LAT - ay;
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0
      ? 0
      : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Crossing nodes within {@link CROSSING_RADIUS_M} of the track, per km. */
export function crossingsPerKm(track: RouteTrack, nodes: LatLng[]): number {
  const km = (track.distance.at(-1) ?? 0) / 1000;
  if (km <= 0 || track.coordinates.length < 2) return 0;
  const bounds = snappedBounds([track])!;
  const pad = CROSSING_RADIUS_M / METERS_PER_DEG_LAT;
  // A degree of longitude shrinks with latitude, so its padding grows.
  const lngPad =
    pad / Math.cos((((bounds[0] + bounds[2]) / 2) * Math.PI) / 180);
  const nearby = nodes.filter(
    ([lat, lng]) =>
      lat >= bounds[0] - pad &&
      lat <= bounds[2] + pad &&
      lng >= bounds[1] - lngPad &&
      lng <= bounds[3] + lngPad,
  );
  let count = 0;
  for (const node of nearby) {
    for (let i = 1; i < track.coordinates.length; i++) {
      if (
        metersToSegment(
          node,
          track.coordinates[i - 1]!,
          track.coordinates[i]!,
        ) <= CROSSING_RADIUS_M
      ) {
        count += 1;
        break;
      }
    }
  }
  return Math.round((count / km) * 10) / 10;
}
