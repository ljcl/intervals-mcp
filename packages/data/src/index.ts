export {
  type CadenceLabel,
  cadenceLabel,
  isRunning,
  isSwimming,
  PACE_ACTIVITY_TYPES,
} from "./activity-types";
export {
  type CadencePaceRun,
  cadencePaceRegression,
  computeZoneStats,
  linearRegression,
  PACE_ZONES,
  type PaceZone,
  type ZoneStat,
} from "./cadence";
export { fitnessSourceLabel, formatSignedTsb } from "./fitness";
export {
  formatDistance,
  formatDurationShort,
  formatPace,
  formatShortDate,
  formatTime,
  isPastWindow,
  lookbackLabel,
  MIN_MOVING_SPEED_MPS,
  type ShortDateYear,
  windowLabel,
  windowShortLabel,
} from "./formatting";
export {
  colorForValue,
  normalizeValue,
  percentileDomain,
  percentileRange,
  RAMP_GRADIENT_CSS,
  rampColor,
} from "./ramp";
export { smooth } from "./smoothing";
export {
  type SpeedDisplay,
  type SpeedSport,
  speedDisplay,
  speedDisplayForSport,
  speedSport,
} from "./speed";
export {
  dominantBucket,
  hrZoneRangeText,
  type IntensitySplit,
  intensitySplit,
  type ZoneBucket,
  type ZoneSet,
} from "./zones";
