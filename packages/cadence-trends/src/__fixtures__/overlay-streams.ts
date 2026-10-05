import {
  type OverlayPoint,
  type OverlayStreamData,
  type RunStreamState,
  type RunSummary,
} from "../types";
import { mockRuns } from "./runs";

function generateOverlayPoints(
  distanceKm: number,
  baseCadence: number,
  basePace: number,
  count: number,
): OverlayPoint[] {
  const points: OverlayPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const frac = i / (count - 1);
    // Add some realistic variation
    const cadenceNoise = Math.sin(frac * 12) * 4 + Math.cos(frac * 7) * 2;
    points.push({
      distance: frac * distanceKm,
      time: frac * distanceKm * basePace,
      cadence: Math.round(baseCadence + cadenceNoise),
    });
  }
  return points;
}

/**
 * Same shape as `generateOverlayPoints`, but a stretch in the middle has no
 * cadence reading (a lost footpod segment): those points stay real gaps
 * (`cadence` left undefined) rather than fabricated zeros, so the overlay
 * line must visibly break instead of bridging them.
 */
function generateOverlayPointsWithGap(
  distanceKm: number,
  baseCadence: number,
  basePace: number,
  count: number,
  gapStartFrac: number,
  gapEndFrac: number,
): OverlayPoint[] {
  return generateOverlayPoints(distanceKm, baseCadence, basePace, count).map(
    (p, i) => {
      const frac = i / (count - 1);
      if (frac >= gapStartFrac && frac <= gapEndFrac) {
        return { distance: p.distance, time: p.time };
      }
      return p;
    },
  );
}

const run10003 = mockRuns.find((r) => r.id === "i10003")!;
const run10004 = mockRuns.find((r) => r.id === "i10004")!;
const run10009 = mockRuns.find((r) => r.id === "i10009")!;
const run10013 = mockRuns.find((r) => r.id === "i10013")!;

const loaded = (run: RunSummary, points: OverlayPoint[]): RunStreamState => ({
  run,
  points,
  loading: false,
  error: null,
  progress: null,
});

/** Both runs loaded: Tempo Intervals (10003) and Intervals 5x1k (10013). */
export const mockStreams = new Map<string, RunStreamState>([
  [
    "i10003",
    loaded(run10003, generateOverlayPoints(run10003.distance, 172, 4.5, 50)),
  ],
  [
    "i10013",
    loaded(run10013, generateOverlayPoints(run10013.distance, 178, 4.0, 50)),
  ],
]);

/**
 * The `get-activity-streams-raw` payload for a run `mockStreams` draws, for a
 * story whose fake app answers the keyed fetcher the way the server does:
 * time in seconds, distance in metres, and cadence as strides per minute,
 * which the app doubles for a run.
 */
export function rawStreamsPayload(runId: string): OverlayStreamData {
  const state = mockStreams.get(runId);
  if (!state?.points) throw new Error(`no overlay stream for ${runId}`);
  const withCadence = state.points.filter((p) => p.cadence !== undefined);
  return {
    activityId: runId,
    activityType: state.run.type,
    name: state.run.name,
    streams: {
      time: withCadence.map((p) => Math.round(p.time * 60)),
      distance: withCadence.map((p) => Math.round(p.distance * 1000)),
      cadence: withCadence.map((p) => p.cadence! / 2),
    },
  };
}

/**
 * Two runs both named "Long Run" (10004 on 11 Jan, 10009 on 25 Jan): the
 * tooltip, mobile legend and context summary must tell them apart by date.
 */
export const duplicateNameStreams = new Map<string, RunStreamState>([
  [
    "i10004",
    loaded(run10004, generateOverlayPoints(run10004.distance, 168, 5.67, 50)),
  ],
  [
    "i10009",
    loaded(run10009, generateOverlayPoints(run10009.distance, 170, 5.67, 50)),
  ],
]);

/** One run drawn, the second still in flight. */
export const partiallyLoadedStreams = new Map<string, RunStreamState>([
  ["i10003", mockStreams.get("i10003")!],
  [
    "i10013",
    { run: run10013, points: null, loading: true, error: null, progress: null },
  ],
]);

/**
 * Nothing drawn yet: both runs are in flight, and only the second has sent a
 * progress message.
 */
export const progressStreams = new Map<string, RunStreamState>([
  [
    "i10003",
    { run: run10003, points: null, loading: true, error: null, progress: null },
  ],
  [
    "i10013",
    {
      run: run10013,
      points: null,
      loading: true,
      error: null,
      progress: "Reading streams for Intervals 5x1k",
    },
  ],
]);

/** One run drawn, the second failed — it must say so, not just vanish. */
export const partiallyFailedStreams = new Map<string, RunStreamState>([
  ["i10003", mockStreams.get("i10003")!],
  [
    "i10013",
    {
      run: run10013,
      points: null,
      loading: false,
      error: "Error: stream fetch failed",
      progress: null,
    },
  ],
]);

/**
 * One run has a mid-run gap in cadence/pace (both null there), the other is
 * whole: the overlay line for the gappy run must break, not interpolate or
 * dip to zero, while the intact run keeps drawing normally.
 */
export const gappyStreams = new Map<string, RunStreamState>([
  [
    "i10003",
    loaded(
      run10003,
      generateOverlayPointsWithGap(run10003.distance, 172, 4.5, 50, 0.35, 0.55),
    ),
  ],
  ["i10013", mockStreams.get("i10013")!],
]);

/** Every selected run failed, so there is nothing to draw at all. */
export const allFailedStreams = new Map<string, RunStreamState>([
  [
    "i10003",
    {
      run: run10003,
      points: null,
      loading: false,
      error: "Error: stream fetch failed",
      progress: null,
    },
  ],
  ["i10013", partiallyFailedStreams.get("i10013")!],
]);

/**
 * A run that loaded but has no streams (a manual entry): the server's
 * `noStreams` payload, so `points` is empty rather than null and `error` is
 * unset. It must be named, not drawn, and offer no retry.
 */
const noStreamsRun = (run: RunSummary): RunStreamState => ({
  run,
  points: [],
  loading: false,
  error: null,
  progress: null,
  noStreams: true,
});

/** One run drawn, the other recorded no streams. */
export const oneRunWithoutStreams = new Map<string, RunStreamState>([
  ["i10003", mockStreams.get("i10003")!],
  ["i10013", noStreamsRun(run10013)],
]);

/** Every selected run recorded no streams, so there is nothing to draw. */
export const allRunsWithoutStreams = new Map<string, RunStreamState>([
  ["i10003", noStreamsRun(run10003)],
  ["i10013", noStreamsRun(run10013)],
]);
