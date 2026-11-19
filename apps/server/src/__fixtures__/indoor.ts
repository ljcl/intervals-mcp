/**
 * An indoor (treadmill) run as intervals.icu sends it (#513, #517,
 * docs/api-notes.md "Indoor and treadmill runs"): `trainer: true`, no
 * elevation fields, no `gap`, and streams with no `altitude`,
 * `fixed_altitude`, `latlng`, `grade_smooth` or `ga_velocity`. The record
 * still has intervals.icu's weather, which is the weather outdoors.
 */
import {
  type IntervalsActivity,
  type IntervalsStream,
} from "../intervalsClient";

/** `base` (a recorded outdoor run) turned into the indoor record. */
export function indoorActivity(base: IntervalsActivity): IntervalsActivity {
  return {
    ...base,
    name: "Treadmill",
    trainer: true,
    use_elevation_correction: false,
    total_elevation_gain: null,
    gap: null,
    decoupling: null,
    icu_efficiency_factor: null,
    average_weather_temp: 18.4,
    average_feels_like: 17.9,
    has_weather: true,
    stream_types: [
      "time",
      "cadence",
      "heartrate",
      "distance",
      "velocity_smooth",
    ],
  } as IntervalsActivity;
}

/**
 * 12 minutes at 3 m/s with one 30 s stop after 8 minutes: the short stop
 * that get-interval-analysis calls a traffic light on an outdoor run.
 */
export function indoorStreams(): IntervalsStream[] {
  const time: number[] = [];
  const distance: number[] = [];
  const velocity: number[] = [];
  const heartrate: number[] = [];
  const cadence: number[] = [];
  let metres = 0;
  for (let s = 0; s <= 720; s++) {
    const stopped = s > 480 && s <= 510;
    if (s > 0 && !stopped) metres += 3;
    time.push(s);
    distance.push(metres);
    velocity.push(stopped ? 0 : 3);
    heartrate.push(stopped ? 130 : 150);
    cadence.push(stopped ? 0 : 84);
  }
  return [
    { type: "time", data: time },
    { type: "distance", data: distance },
    { type: "velocity_smooth", data: velocity },
    { type: "heartrate", data: heartrate },
    { type: "cadence", data: cadence },
  ] as IntervalsStream[];
}
