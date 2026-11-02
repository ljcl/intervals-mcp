/**
 * Where the athlete starts runs (route suggestions): recent GPS runs as
 * tracks, grouped by start point. The heaviest cluster is the usual start;
 * a cluster's runs are the past-run candidates from that start.
 */
import { CallCancelledError } from "./callScope";
import { isAbortError } from "./fetchClient";
import { listActivities } from "./intervalsClient";
import { loadIntervalsStreams } from "./intervalsStreams";
import {
  cumulativeDistances,
  haversineMeters,
  type LatLng,
  type RouteTrack,
} from "./mapAnchors";
import { NO_PROGRESS, type ReportProgress } from "./progress";
import { addDays, daysBetween } from "./utils/localDate";

export const CLUSTER_RADIUS_M = 300;
export const RECENCY_HALF_LIFE_DAYS = 60;
export const HISTORY_DAYS = 180;
export const MAX_HISTORY_RUNS = 40;

/** Outdoor run types with a start worth clustering (no VirtualRun); also the planned runs that get routes. */
export const OUTDOOR_RUN_TYPES = new Set(["Run", "TrailRun"]);

export interface RunStart {
  id: string;
  /** YYYY-MM-DD, local. */
  date: string;
  name: string;
  distance_m: number;
  climb_m: number;
  track: RouteTrack;
}

export interface StartCluster {
  /** The start of the cluster's newest run. */
  center: LatLng;
  /** Sum of each run's recency weight. */
  weight: number;
  /** Newest first. */
  runs: RunStart[];
}

/** Groups runs (newest first) by start within {@link CLUSTER_RADIUS_M}, heaviest first. */
export function clusterStarts(runs: RunStart[], today: string): StartCluster[] {
  const clusters: StartCluster[] = [];
  for (const run of runs) {
    const start = run.track.coordinates[0];
    if (!start) continue;
    const weight =
      0.5 ** (daysBetween(run.date, today) / RECENCY_HALF_LIFE_DAYS);
    const home = clusters.find(
      (c) => haversineMeters(c.center, start) <= CLUSTER_RADIUS_M,
    );
    if (home) {
      home.runs.push(run);
      home.weight += weight;
    } else {
      clusters.push({ center: start, weight, runs: [run] });
    }
  }
  return clusters.sort((a, b) => b.weight - a.weight);
}

/** The cluster nearest `point`, if its center is within {@link CLUSTER_RADIUS_M}. */
export function nearestCluster(
  clusters: StartCluster[],
  point: LatLng,
): StartCluster | null {
  let best: { cluster: StartCluster; meters: number } | null = null;
  for (const cluster of clusters) {
    const meters = haversineMeters(cluster.center, point);
    if (meters <= CLUSTER_RADIUS_M && (!best || meters < best.meters))
      best = { cluster, meters };
  }
  return best?.cluster ?? null;
}

/**
 * Recent outdoor runs with GPS as tracks, newest first. One stream read per
 * run (cached by FetchClient). A run that cannot be read is left out and
 * counted, never fatal: the history is a hint, not the answer.
 */
export async function loadRunStarts(
  apiKey: string,
  today: string,
  progress: ReportProgress = NO_PROGRESS,
): Promise<{ runs: RunStart[]; skipped: number }> {
  const activities = await listActivities(apiKey, {
    oldest: addDays(today, -HISTORY_DAYS),
    newest: today,
  });
  const candidates = activities
    .filter((a) => OUTDOOR_RUN_TYPES.has(a.type ?? "") && (a.distance ?? 0) > 0)
    .slice(0, MAX_HISTORY_RUNS);

  const runs: RunStart[] = [];
  let skipped = 0;
  for (const [index, activity] of candidates.entries()) {
    progress(
      `Reading where recent runs started (${index + 1} of ${candidates.length})`,
    );
    let track: RouteTrack | null;
    try {
      const streams = await loadIntervalsStreams(apiKey, activity.id, [
        "latlng",
        "distance",
        "altitude",
      ]);
      track = trackFromStreams(
        streams.latlng,
        streams.distance,
        streams.altitude,
      );
    } catch (error) {
      // A cancelled call must stop, not read on and count every run skipped.
      if (error instanceof CallCancelledError || isAbortError(error))
        throw error;
      track = null;
    }
    if (!track) {
      skipped += 1;
      continue;
    }
    runs.push({
      id: activity.id,
      date: activity.start_date_local.slice(0, 10),
      name: activity.name ?? "Run",
      distance_m: activity.distance ?? 0,
      climb_m: activity.total_elevation_gain ?? 0,
      track,
    });
  }
  return { runs, skipped };
}

/** Aligned columns with null positions dropped; null when fewer than 2 points. */
function trackFromStreams(
  latlng: (LatLng | null)[] | undefined,
  distance: (number | null)[] | undefined,
  altitude: (number | null)[] | undefined,
): RouteTrack | null {
  if (!latlng) return null;
  const keep = latlng.flatMap((point, i) => (point ? [i] : []));
  if (keep.length < 2) return null;
  const coordinates = keep.map((i) => latlng[i] as LatLng);
  const recorded = distance ? keep.map((i) => distance[i] ?? null) : null;
  return {
    coordinates,
    distance: recorded?.every((d) => d !== null)
      ? (recorded as number[])
      : cumulativeDistances(coordinates),
    altitude: keep.map((i) => altitude?.[i] ?? null),
  };
}
