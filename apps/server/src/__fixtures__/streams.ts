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
