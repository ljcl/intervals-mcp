const RUNNING_TYPES = new Set([
  "Run",
  "VirtualRun",
  "TrailRun",
  "Walk",
  "Hike",
]);

const SWIMMING_TYPES = new Set(["Swim", "OpenWaterSwim"]);

export function isRunning(activityType: string): boolean {
  return RUNNING_TYPES.has(activityType);
}

export function isSwimming(activityType: string): boolean {
  return SWIMMING_TYPES.has(activityType);
}
