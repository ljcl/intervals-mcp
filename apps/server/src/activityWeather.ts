/**
 * The weather of one activity, the one home for it: get-activity,
 * get-running-summary and compare-activities all build it here.
 *
 * intervals.icu's activity record has its own weather service's temperature
 * (`average_weather_temp`, null unless the athlete's settings fetch it) and
 * the file's average temperature (`average_temp`), but never humidity. The
 * humidity, and so the dew point, comes from the original FIT file
 * (`fitWeather.ts`). Heat and humidity raise heart rate at the same pace, so
 * two runs compared without them can read conditions as fitness.
 */

import { type FitWeather, readFitWeather } from "./fitWeather";
import { formatSigned, round } from "./formatters";
import { getActivityFile, type IntervalsActivity } from "./intervalsClient";

export interface ActivityWeather {
  /** °C. */
  temperature_c: number | null;
  /**
   * intervals.icu: its weather service; file: the uploaded file (the
   * weather an exporter such as HealthFit wrote, or a watch's own sensor,
   * which a wrist warms). Null when there is no temperature.
   */
  temperature_source: "intervals.icu" | "file" | null;
  /** intervals.icu weather service only. */
  feels_like_c: number | null;
  /** Relative humidity, %, from the FIT file. */
  humidity_pct: number | null;
  /** °C, from the file's own temperature and humidity (Magnus formula). */
  dew_point_c: number | null;
}

/**
 * Dew point in °C from air temperature (°C) and relative humidity (%), by
 * the Magnus formula with the Alduchov and Eskridge (1996) constants: within
 * about 0.4 °C from -40 to 50 °C.
 */
export function dewPointC(temperatureC: number, humidityPct: number): number {
  const a = 17.625;
  const b = 243.04;
  const gamma =
    Math.log(humidityPct / 100) + (a * temperatureC) / (b + temperatureC);
  return (b * gamma) / (a - gamma);
}

/**
 * The weather from the activity record and, when it was read, the FIT file.
 * The file's humidity comes with its own temperature, so when it has one,
 * that pair gives the temperature and the dew point: a dew point from one
 * source's temperature and another's humidity would mean nothing. Otherwise
 * intervals.icu's weather service comes before the file's average. Null when
 * there is no weather at all.
 */
export function buildActivityWeather(
  activity: Pick<
    IntervalsActivity,
    "average_weather_temp" | "average_feels_like" | "average_temp"
  >,
  fit: FitWeather | null,
): ActivityWeather | null {
  const fileTemperature = fit?.temperatureC ?? activity.average_temp ?? null;
  const humidity = fit?.humidityPct ?? null;
  let temperature: number | null;
  let source: ActivityWeather["temperature_source"];
  if (humidity != null && fileTemperature != null) {
    temperature = fileTemperature;
    source = "file";
  } else if (activity.average_weather_temp != null) {
    temperature = activity.average_weather_temp;
    source = "intervals.icu";
  } else {
    temperature = activity.average_temp ?? null;
    source = temperature == null ? null : "file";
  }
  const weather: ActivityWeather = {
    temperature_c: temperature == null ? null : round(temperature, 1),
    temperature_source: source,
    feels_like_c:
      activity.average_feels_like == null
        ? null
        : round(activity.average_feels_like, 1),
    humidity_pct: humidity == null ? null : round(humidity),
    dew_point_c:
      humidity != null && fileTemperature != null
        ? round(dewPointC(fileTemperature, humidity), 1)
        : null,
  };
  return Object.values(weather).every((v) => v == null) ? null : weather;
}

/** True when intervals.icu holds a FIT file for the activity. */
function hasFitFile(activity: IntervalsActivity): boolean {
  return (
    activity.file_type?.toLowerCase() === "fit" && activity.source !== "STRAVA"
  );
}

/**
 * The activity's weather, reading its FIT file for the humidity. One extra
 * request (`GET /activity/{id}/file`, cached 10 minutes), only for a FIT
 * upload. `id` is the caller's id, so the URL matches its other reads. A
 * failed read is logged and leaves the humidity out: the weather never
 * fails the call it adds to, like get-activity's gear name.
 */
export async function loadActivityWeather(
  apiKey: string,
  id: string,
  activity: IntervalsActivity,
): Promise<ActivityWeather | null> {
  let fit: FitWeather | null = null;
  if (hasFitFile(activity)) {
    try {
      fit = readFitWeather(await getActivityFile(apiKey, id));
    } catch (error) {
      console.error(
        `Weather file for activity ${activity.id} not read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return buildActivityWeather(activity, fit);
}

const SOURCE_TEXT = {
  "intervals.icu": "intervals.icu weather",
  file: "activity file",
} as const;

/** The text line for one activity's weather, or null when it has none. */
export function formatWeatherLine(
  weather: ActivityWeather | null,
): string | null {
  if (!weather) return null;
  const parts: string[] = [];
  if (weather.temperature_c != null) parts.push(`${weather.temperature_c} °C`);
  if (weather.feels_like_c != null)
    parts.push(`feels like ${weather.feels_like_c} °C`);
  if (weather.humidity_pct != null)
    parts.push(`humidity ${weather.humidity_pct}%`);
  if (weather.dew_point_c != null)
    parts.push(`dew point ${weather.dew_point_c} °C`);
  const source = weather.temperature_source
    ? ` (${SOURCE_TEXT[weather.temperature_source]})`
    : "";
  return `Weather: ${parts.join(", ")}${source}`;
}

/** Activity 2 minus activity 1, for each weather value both sides have. */
export interface WeatherDifference {
  temperature_c: number | null;
  humidity_pct: number | null;
  dew_point_c: number | null;
}

/**
 * A dew point or temperature gap above this many °C changes heart rate at
 * the same pace enough to matter in a comparison.
 */
export const WEATHER_NOTE_THRESHOLD_C = 5;

const diff = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null ? null : round(b - a, 1);

export function weatherDifference(
  weather1: ActivityWeather | null,
  weather2: ActivityWeather | null,
): WeatherDifference {
  return {
    temperature_c: diff(weather1?.temperature_c, weather2?.temperature_c),
    humidity_pct: diff(weather1?.humidity_pct, weather2?.humidity_pct),
    dew_point_c: diff(weather1?.dew_point_c, weather2?.dew_point_c),
  };
}

/**
 * A note when the conditions differ enough to explain part of a heart rate
 * difference: the dew point by more than 5 °C, or, when either side has no
 * dew point, the temperature by more than 5 °C. Null otherwise.
 */
export function weatherNote(difference: WeatherDifference): string | null {
  const effect =
    "warmer, more humid air raises heart rate at the same pace (often by 5 to 10 bpm), so part of the HR and efficiency difference can be the weather, not fitness";
  if (difference.dew_point_c != null) {
    if (Math.abs(difference.dew_point_c) <= WEATHER_NOTE_THRESHOLD_C)
      return null;
    return `The dew point differs by ${formatSigned(difference.dew_point_c, 1)} °C (activity 2 minus activity 1): ${effect}.`;
  }
  if (
    difference.temperature_c != null &&
    Math.abs(difference.temperature_c) > WEATHER_NOTE_THRESHOLD_C
  )
    return `The temperature differs by ${formatSigned(difference.temperature_c, 1)} °C (activity 2 minus activity 1; no dew point on both sides): ${effect}.`;
  return null;
}
