import { describe, expect, it } from "vitest";
import {
  buildFitFile,
  FIT_TYPES,
  type FitMessage,
  fitFieldDescription,
} from "./__fixtures__/fitFile";
import { readFitWeather } from "./fitWeather";

const SESSION = 18;
const WEATHER = 128;

/** A session with HealthFit's humidity developer field, as on its files. */
function healthFitSession(humidityRaw: number, temperature = 18): FitMessage[] {
  return [
    fitFieldDescription(0, 3, "SESSION WEATHER HUMIDITY", FIT_TYPES.uint16),
    {
      global: SESSION,
      fields: [
        { num: 57, type: FIT_TYPES.sint8, value: temperature },
        { num: 5, type: FIT_TYPES.uint8, value: 1 },
      ],
      devFields: [
        { num: 3, devIndex: 0, type: FIT_TYPES.uint16, value: humidityRaw },
      ],
    },
  ];
}

function weatherReport(temperature: number, humidity: number): FitMessage {
  return {
    global: WEATHER,
    fields: [
      { num: 1, type: FIT_TYPES.sint8, value: temperature },
      { num: 7, type: FIT_TYPES.uint8, value: humidity },
    ],
  };
}

describe("readFitWeather", () => {
  it("reads HealthFit's session humidity in hundredths of a percent, with the session temperature", () => {
    expect(readFitWeather(buildFitFile(healthFitSession(8700)))).toEqual({
      humidityPct: 87,
      temperatureC: 18,
      source: "session developer field",
    });
  });

  it("applies a developer field's own scale when its description has one", () => {
    const file = buildFitFile([
      fitFieldDescription(1, 4, "humidity", FIT_TYPES.uint16, 10),
      {
        global: SESSION,
        fields: [{ num: 57, type: FIT_TYPES.sint8, value: 25 }],
        devFields: [
          { num: 4, devIndex: 1, type: FIT_TYPES.uint16, value: 655 },
        ],
      },
    ]);
    expect(readFitWeather(file)?.humidityPct).toBe(65.5);
  });

  it("averages the weather reports, and prefers them over a session field", () => {
    const file = buildFitFile([
      weatherReport(20, 70),
      weatherReport(22, 60),
      ...healthFitSession(9000, 30),
    ]);
    expect(readFitWeather(file)).toEqual({
      humidityPct: 65,
      temperatureC: 21,
      source: "weather_conditions",
    });
  });

  it("reads a big-endian definition and a compressed-timestamp data message", () => {
    const file = buildFitFile([
      { ...weatherReport(15, 80), bigEndian: true, compressedHeader: true },
    ]);
    expect(readFitWeather(file)).toMatchObject({
      humidityPct: 80,
      temperatureC: 15,
    });
  });

  it("leaves the temperature null when the session has none", () => {
    const file = buildFitFile([
      fitFieldDescription(0, 3, "SESSION WEATHER HUMIDITY", FIT_TYPES.uint16),
      {
        global: SESSION,
        // 0x7f is sint8's invalid value: no temperature recorded.
        fields: [{ num: 57, type: FIT_TYPES.sint8, value: 0x7f }],
        devFields: [
          { num: 3, devIndex: 0, type: FIT_TYPES.uint16, value: 5500 },
        ],
      },
    ]);
    expect(readFitWeather(file)).toMatchObject({
      humidityPct: 55,
      temperatureC: null,
    });
  });

  it("is null for a file with no humidity, or a developer field of another name", () => {
    expect(
      readFitWeather(
        buildFitFile([
          {
            global: SESSION,
            fields: [{ num: 57, type: FIT_TYPES.sint8, value: 18 }],
          },
        ]),
      ),
    ).toBeNull();
    expect(
      readFitWeather(
        buildFitFile([
          fitFieldDescription(0, 3, "AVG METs", FIT_TYPES.uint16),
          {
            global: SESSION,
            fields: [{ num: 57, type: FIT_TYPES.sint8, value: 18 }],
            devFields: [
              { num: 3, devIndex: 0, type: FIT_TYPES.uint16, value: 1232 },
            ],
          },
        ]),
      ),
    ).toBeNull();
  });

  it("ignores a humidity outside 0 to 100%", () => {
    expect(readFitWeather(buildFitFile(healthFitSession(65000)))).toBeNull();
    expect(readFitWeather(buildFitFile([weatherReport(20, 0)]))).toBeNull();
  });

  it("is null, without throwing, for bytes that are not a FIT file or are cut short", () => {
    expect(readFitWeather(new TextEncoder().encode("<gpx></gpx>"))).toBeNull();
    expect(readFitWeather(new Uint8Array([]))).toBeNull();
    const full = buildFitFile(healthFitSession(8700));
    // The header still claims the full size; the data ends mid-message.
    expect(readFitWeather(full.subarray(0, full.length - 8))).toBeNull();
  });
});
