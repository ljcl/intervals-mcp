const RUNNING_TYPES = new Set([
  "Run",
  "VirtualRun",
  "TrailRun",
  "Walk",
  "Hike",
]);

/**
 * The run types: the only types that get a pace per km, in the text tools
 * and the MCP Apps alike. Walk and Hike are not here: they show km/h
 * everywhere (#172), while {@link isRunning} still counts them for their
 * step cadence. The one home for this set; the server re-exports it from
 * `utils/running.ts`.
 */
export const PACE_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  "Run",
  "TrailRun",
  "VirtualRun",
]);

const SWIMMING_TYPES = new Set(["Swim", "OpenWaterSwim"]);

export function isRunning(activityType: string): boolean {
  return RUNNING_TYPES.has(activityType);
}

export function isSwimming(activityType: string): boolean {
  return SWIMMING_TYPES.has(activityType);
}
