import {
  type OverlayPoint,
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
    const paceNoise = Math.sin(frac * 8) * 0.3 + Math.cos(frac * 5) * 0.15;
    points.push({
      distance: frac * distanceKm,
      time: frac * distanceKm * basePace,
      cadence: Math.round(baseCadence + cadenceNoise),
      pace: Math.round((basePace + paceNoise) * 100) / 100,
    });
  }
  return points;
}

const run10003 = mockRuns.find((r) => r.id === "i10003")!;
const run10013 = mockRuns.find((r) => r.id === "i10013")!;

const loaded = (run: RunSummary, points: OverlayPoint[]): RunStreamState => ({
  run,
  points,
  loading: false,
  error: null,
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

/** One run drawn, the second still in flight. */
export const partiallyLoadedStreams = new Map<string, RunStreamState>([
  ["i10003", mockStreams.get("i10003")!],
  ["i10013", { run: run10013, points: null, loading: true, error: null }],
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
    },
  ],
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
    },
  ],
  ["i10013", partiallyFailedStreams.get("i10013")!],
]);
