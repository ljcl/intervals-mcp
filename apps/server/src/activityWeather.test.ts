import { describe, expect, it } from "vitest";
import {
  buildActivityWeather,
  dewPointC,
  formatWeatherLine,
  weatherDifference,
  weatherNote,
} from "./activityWeather";

describe("dewPointC", () => {
  it.each([
    // Reference values from the Magnus formula tables (±0.1 °C).
    [18, 87, 15.8],
    [20, 50, 9.3],
    [30, 70, 23.9],
    [0, 100, 0],
  ])("%s °C at %s%% is %s °C", (temperature, humidity, expected) => {
    expect(dewPointC(temperature, humidity)).toBeCloseTo(expected, 1);
  });
});

describe("buildActivityWeather", () => {
  const fit = {
    humidityPct: 87,
    temperatureC: 18,
    source: "session developer field" as const,
  };

  it("takes the temperature and dew point from the file's humidity pair", () => {
    expect(
      buildActivityWeather(
        { average_temp: 18, average_weather_temp: 21, average_feels_like: 22 },
        fit,
      ),
    ).toEqual({
      temperature_c: 18,
      temperature_source: "file",
      feels_like_c: 22,
      humidity_pct: 87,
      dew_point_c: 15.8,
    });
  });

  it("prefers intervals.icu's weather service over the file's temperature when the file has no humidity", () => {
    expect(
      buildActivityWeather(
        { average_temp: 30, average_weather_temp: 19.46 },
        null,
      ),
    ).toEqual({
      temperature_c: 19.5,
      temperature_source: "intervals.icu",
      feels_like_c: null,
      humidity_pct: null,
      dew_point_c: null,
    });
  });

  it("falls back to the file's average temperature", () => {
    expect(buildActivityWeather({ average_temp: 22 }, null)).toMatchObject({
      temperature_c: 22,
      temperature_source: "file",
      dew_point_c: null,
    });
  });

  it("uses the activity's file temperature for the dew point when the pair has none", () => {
    expect(
      buildActivityWeather(
        { average_temp: 18 },
        { ...fit, temperatureC: null },
      ),
    ).toMatchObject({ temperature_c: 18, dew_point_c: 15.8 });
  });

  it("is null when there is no weather at all", () => {
    expect(buildActivityWeather({}, null)).toBeNull();
  });
});

describe("formatWeatherLine", () => {
  it("names each value and the source", () => {
    expect(
      formatWeatherLine({
        temperature_c: 18,
        temperature_source: "file",
        feels_like_c: null,
        humidity_pct: 87,
        dew_point_c: 15.8,
      }),
    ).toBe("Weather: 18 °C, humidity 87%, dew point 15.8 °C (activity file)");
    expect(formatWeatherLine(null)).toBeNull();
  });
});

describe("weatherNote", () => {
  const weather = (temperature: number, dewPoint: number | null) => ({
    temperature_c: temperature,
    temperature_source: "file" as const,
    feels_like_c: null,
    humidity_pct: dewPoint == null ? null : 70,
    dew_point_c: dewPoint,
  });

  it("notes a dew point gap above 5 °C, signed activity 2 minus activity 1", () => {
    const difference = weatherDifference(weather(12, 6.2), weather(24, 17.5));
    expect(difference).toEqual({
      temperature_c: 12,
      humidity_pct: 0,
      dew_point_c: 11.3,
    });
    expect(weatherNote(difference)).toMatch(
      /^The dew point differs by \+11\.3 °C \(activity 2 minus activity 1\): warmer, more humid air raises heart rate/,
    );
  });

  it("says nothing at 5 °C or less, even with a larger temperature gap", () => {
    expect(
      weatherNote(weatherDifference(weather(10, 8), weather(20, 13))),
    ).toBeNull();
  });

  it("falls back to the temperature when either side has no dew point", () => {
    expect(
      weatherNote(weatherDifference(weather(25, null), weather(14, 9))),
    ).toMatch(/^The temperature differs by -11.0 °C/);
    expect(
      weatherNote(weatherDifference(weather(18, null), weather(20, null))),
    ).toBeNull();
    expect(weatherNote(weatherDifference(null, weather(20, 10)))).toBeNull();
  });
});
