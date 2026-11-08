/** What list-corridors and manage-corridors report for one saved corridor. */
import { coveringRuns } from "../corridors";
import { haversineMeters, type LatLng } from "../mapAnchors";
import { routeOsmStats } from "../osmIndex";
import { versionTrack } from "../routeBuilder";
import { trackLength } from "../routeGeometry";
import { latestVersion, type StoredRoute } from "../routeStore";

export function corridorEntry(
  route: StoredRoute,
  followers: Parameters<typeof coveringRuns>[1] | null,
  near: LatLng | null,
) {
  const track = versionTrack(route, latestVersion(route));
  const stats = routeOsmStats(track);
  return {
    route_id: route.route_id,
    name: route.name,
    length_m: Math.round(trackLength(track)),
    path_share: stats ? Math.round(stats.path_share * 100) / 100 : null,
    one_way: route.one_way ?? false,
    runs: followers ? coveringRuns(track, followers) : null,
    distance_m: near
      ? Math.round(
          Math.min(...track.coordinates.map((p) => haversineMeters(p, near))),
        )
      : null,
    created_at: route.created_at,
  };
}

export type CorridorEntry = ReturnType<typeof corridorEntry>;

const km = (m: number) => (m / 1000).toFixed(1);

/** One text line for a saved corridor. */
export function corridorLine(c: CorridorEntry): string {
  const parts = [`${km(c.length_m)} km`];
  if (c.path_share !== null)
    parts.push(`${Math.round(c.path_share * 100)}% paths`);
  if (c.runs !== null) parts.push(`${c.runs} runs`);
  if (c.distance_m !== null) parts.push(`${km(c.distance_m)} km away`);
  if (c.one_way) parts.push("one-way");
  return `${c.name} (${c.route_id}): ${parts.join(", ")}`;
}
