/**
 * Wire precision for intervals.icu stream values: the one table that
 * `get-activity-streams` and the chart and route-map app payloads round
 * with (#71). A bucket mean such as `144.66666666666666` carries no more
 * information than `144.67`, but it more than doubles the JSON. Callers
 * round last, after downsampling and after any index lookup.
 */
import { round } from "./formatters";
import { type IntervalsStreamType } from "./intervalsStreams";

type ScalarStreamType = Exclude<IntervalsStreamType, "latlng">;

/**
 * Decimal places for each scalar stream, in the unit the reader sees. No
 * value is above 2. `get-activity-streams` converts cadence to spm before it
 * rounds. The `Record` type makes a new stream type declare its precision.
 */
export const STREAM_DECIMALS: Readonly<Record<ScalarStreamType, number>> = {
  altitude: 1,
  cadence: 0,
  distance: 1,
  grade_smooth: 1,
  heartrate: 0,
  stance_time: 1,
  step_length: 0,
  time: 0,
  velocity_smooth: 2,
  vertical_oscillation: 1,
  vertical_ratio: 2,
  watts: 0,
};

/** Decimal places for a latitude or longitude: about 1.1 m. */
export const LATLNG_DECIMALS = 5;

/**
 * Decimal places for a stream in intervals.icu's own unit. The app payloads
 * send cadence as strides/min, which an app doubles for step-cadence types,
 * so cadence keeps one more decimal than the spm table value.
 */
export function rawUnitDecimals(type: ScalarStreamType): number {
  return type === "cadence"
    ? STREAM_DECIMALS.cadence + 1
    : STREAM_DECIMALS[type];
}

/**
 * Rounds every number in `values` to `decimals` places and keeps each
 * `null`. Returns a new array and never changes `values`:
 * `downsampleColumns` returns its input by reference for a short activity,
 * so that input can be the caller's own stream.
 */
export function roundColumn<T extends number | null>(
  values: readonly T[],
  decimals: number,
): T[] {
  return values.map((v) => (v == null ? v : round(v, decimals))) as T[];
}
