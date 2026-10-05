export { isRunning, isSwimming } from "./activity-types";
export {
  formatClock,
  formatDistance,
  formatDurationShort,
  formatPace,
  formatShortDate,
  formatSpeedAsKmh,
  formatSpeedAsPace,
  formatTime,
  MIN_MOVING_SPEED_MPS,
  type ShortDateYear,
} from "./formatting";
export {
  colorForValue,
  normalizeValue,
  percentileDomain,
  percentileRange,
  RAMP_GRADIENT_CSS,
  rampColor,
} from "./ramp";
export {
  speedDisplay,
  speedDisplayForSport,
  speedSport,
  type SpeedDisplay,
  type SpeedSport,
} from "./speed";
export { smooth } from "./smoothing";
export { dominantBucket, type ZoneBucket, type ZoneSet } from "./zones";
