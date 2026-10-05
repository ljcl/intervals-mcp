/**
 * Synthetic intervals.icu stream responses (`IntervalsStream[]`, the shape
 * `getActivityStreams` resolves to) for tool tests that need a course shape
 * the captured fixtures do not have.
 */
import { type IntervalsStream } from "../intervalsClient";

export interface SyntheticLeg {
  metres: number;
  /** Speed in m/s. */
  speed: number;
  gradePct?: number;
  hr?: number;
}

/**
 * 1 Hz streams over `legs`. `altitudeNoise(i)` adds metres to sample `i`'s
 * altitude, like a noisy barometer; grade_smooth is left out unless
 * `withGrade`, so tools derive grade from that altitude. `withAltitude:
 * false` drops altitude too, for a run with no elevation data.
 */
export function syntheticStreams(
  legs: SyntheticLeg[],
  options: {
    altitudeNoise?: (i: number) => number;
    withGrade?: boolean;
    withAltitude?: boolean;
  } = {},
): IntervalsStream[] {
  const time = [0];
  const distance = [0];
  const altitude = [100];
  const grade = [0];
  const heartrate = [legs[0]?.hr ?? 150];
  const velocity = [legs[0]?.speed ?? 0];
  let alt = 100;
  for (const leg of legs) {
    const seconds = Math.round(leg.metres / leg.speed);
    for (let s = 0; s < seconds; s++) {
      alt += (leg.speed * (leg.gradePct ?? 0)) / 100;
      time.push(time.length);
      distance.push(distance[distance.length - 1]! + leg.speed);
      altitude.push(alt + (options.altitudeNoise?.(time.length) ?? 0));
      grade.push(leg.gradePct ?? 0);
      heartrate.push(leg.hr ?? 150);
      velocity.push(leg.speed);
    }
  }
  const streams: IntervalsStream[] = [
    { type: "time", data: time },
    { type: "distance", data: distance },
    { type: "heartrate", data: heartrate },
    { type: "velocity_smooth", data: velocity },
  ];
  if (options.withAltitude !== false) {
    streams.push({ type: "altitude", data: altitude });
  }
  if (options.withGrade) {
    streams.push({ type: "grade_smooth", data: grade });
  }
  return streams;
}

/**
 * `seconds` of 1 Hz samples for every stream type `get-activity-streams`
 * can return, with realistic digit counts (a moving GPS track, fractional
 * altitude and speed), for response-size tests: a long run at maxPoints 2000
 * with all types is the largest response that tool can make.
 */
export function syntheticAllTypesStreams(seconds: number): IntervalsStream[] {
  const range = Array.from({ length: seconds }, (_, i) => i);
  const wave = (i: number, period: number) =>
    Math.sin((2 * Math.PI * i) / period);
  return [
    { type: "time", data: range },
    { type: "distance", data: range.map((i) => i * 3.21 + wave(i, 97)) },
    {
      type: "heartrate",
      data: range.map((i) => 150 + Math.round(10 * wave(i, 311))),
    },
    {
      type: "cadence",
      data: range.map((i) => 86 + Math.round(3 * wave(i, 53))),
    },
    {
      type: "velocity_smooth",
      data: range.map((i) => 3.21 + 0.37 * wave(i, 127)),
    },
    { type: "altitude", data: range.map((i) => 120.4 + 35.7 * wave(i, 1201)) },
    {
      type: "latlng",
      data: range.map((i) => -33.861234 + i * 0.0000213),
      data2: range.map((i) => 151.207654 + i * 0.0000187),
    },
    {
      type: "watts",
      data: range.map((i) => 260 + Math.round(40 * wave(i, 71))),
    },
    { type: "stance_time", data: range.map((i) => 241.3 + 12.1 * wave(i, 61)) },
    {
      type: "vertical_oscillation",
      data: range.map((i) => 84.6 + 6.2 * wave(i, 67)),
    },
    {
      type: "vertical_ratio",
      data: range.map((i) => 7.81 + 0.42 * wave(i, 73)),
    },
    {
      type: "step_length",
      data: range.map((i) => 1123 + Math.round(40 * wave(i, 79))),
    },
  ];
}
