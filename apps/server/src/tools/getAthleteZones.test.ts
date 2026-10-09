import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import hrCurvesFixture from "../__fixtures__/intervals/hr-curves.json";
import sportSettingsFixture from "../__fixtures__/intervals/sport-settings.json";
import { type AthleteZonesResponse } from "../athleteZones";
import {
  getAthleteHrCurves,
  type IntervalsAthleteHrCurves,
  type IntervalsSportSettings,
  listSportSettings,
} from "../intervalsClient";
import { formatAthleteZonesText, getAthleteZonesTool } from "./getAthleteZones";
import { AthleteZonesOutputSchema } from "./outputs";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return {
    ...actual,
    listSportSettings: vi.fn(),
    getAthleteHrCurves: vi.fn(),
  };
});

const mockedSettings = vi.mocked(listSportSettings);
const mockedCurves = vi.mocked(getAthleteHrCurves);

const groups = sportSettingsFixture as unknown as IntervalsSportSettings[];
const curves = hrCurvesFixture as unknown as IntervalsAthleteHrCurves;

const { inputSchema } = getAthleteZonesTool;

/** Runs the tool the way the dispatcher does: input through the schema. */
function run(args: Record<string, unknown> = {}) {
  return getAthleteZonesTool.execute(inputSchema.parse(args), "key");
}

const textOf = (result: { content: Array<{ text: string }> }) =>
  result.content[0]!.text;

beforeEach(() => {
  mockedSettings.mockReset();
  mockedCurves.mockReset();
  mockedSettings.mockResolvedValue(groups);
  mockedCurves.mockResolvedValue(curves);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("get-athlete-zones", () => {
  it("returns the Run zones, thresholds and checks by default", async () => {
    const result = await run();

    expect(mockedSettings).toHaveBeenCalledTimes(1);
    expect(mockedCurves).toHaveBeenCalledWith("key", {
      type: "Run",
      curves: ["90d", "1y"],
    });
    expect(result.isError).toBeUndefined();
    expect(() =>
      AthleteZonesOutputSchema.parse(result.structuredContent),
    ).not.toThrow();

    const text = textOf(result);
    expect(text.split("\n")[0]).toBe(
      "Run zones and thresholds (settings group: Run, VirtualRun, TrailRun)",
    );
    expect(text).toContain("LTHR 172 bpm, max HR 190 bpm.");
    expect(text).toContain("  Z1 Very Easy: up to 142 bpm");
    expect(text).toContain("  Z2 Easy: 143-154 bpm");
    expect(text).toContain("Threshold pace 4:40 /km (3.571 m/s).");
    expect(text).toContain("  Z1 Zone 1: slower than 6:01 /km (under 77.5%)");
    expect(text).toContain("  Z2 Zone 2: 6:01-5:19 /km (77.5-87.7%)");
    expect(text).toContain("  Z7 Zone 5c: faster than 4:11 /km (over 111.5%)");
    expect(text).toContain(
      "Heart rate bests: last 90 days 20 min 178 bpm, 30 min 175 bpm, 60 min 171 bpm; last year 60 s 188 bpm.",
    );
    expect(text).toContain(
      "LTHR check: LTHR estimate 174 bpm: 98% of your best 20-minute heart rate in the last 90 days",
    );
    expect(text).toContain(
      "Max HR check: Your best 60-second heart rate in the last year is 188 bpm",
    );
    expect(text).toContain(
      "Other settings groups: Ride, VirtualRide, MountainBikeRide, GravelRide, TrackRide, Cyclocross; Swim, OpenWaterSwim; Other.",
    );
    expect(text).not.toContain("FTP");
  });

  it("reads the curve for the group's own spelling of the sport", async () => {
    const result = await run({ sport: "trail run" });
    expect(result.structuredContent?.sport).toBe("TrailRun");
    expect(mockedCurves).toHaveBeenCalledWith("key", {
      type: "TrailRun",
      curves: ["90d", "1y"],
    });
  });

  it("does not read curves for the default Other group, and says so", async () => {
    const result = await run({ sport: "Rowing" });
    expect(mockedCurves).not.toHaveBeenCalled();
    const lines = textOf(result).split("\n");
    expect(lines[0]).toBe(
      "Rowing zones and thresholds (intervals.icu's default Other group)",
    );
    expect(lines[1]).toBe(
      "No settings group lists Rowing, so these are intervals.icu's default Other settings.",
    );
    expect(result.structuredContent?.threshold_checks.lthr.status).toBe(
      "unknown",
    );
    expect(result.structuredContent?.threshold_checks.max_hr.status).toBe(
      "unknown",
    );
  });

  it("keeps the zones and warns when the curve read hits the rate limit", async () => {
    mockedCurves.mockRejectedValue(handledRateLimit("getAthleteHrCurves"));
    const result = await run();
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.hr_zones).toHaveLength(5);
    expect(result.structuredContent?.warnings).toEqual([
      "Heart rate curves not read: the intervals.icu rate limit was reached. LTHR and max HR were not checked.",
    ]);
    expect(result.structuredContent?.threshold_checks.lthr.status).toBe(
      "unknown",
    );
    expect(textOf(result).split("\n")[1]).toBe(
      "Heart rate curves not read: the intervals.icu rate limit was reached. LTHR and max HR were not checked.",
    );
  });

  it("names the status when the curve read answers an HTTP error", async () => {
    mockedCurves.mockRejectedValue(handledNotFound("getAthleteHrCurves"));
    const result = await run();
    expect(result.structuredContent?.warnings[0]).toBe(
      "Heart rate curves not read: intervals.icu answered HTTP 404. LTHR and max HR were not checked.",
    );
  });

  it("keeps the raw message of a failed curve read out of the reply", async () => {
    mockedCurves.mockRejectedValue(new Error("socket closed by Run 7"));
    const result = await run();
    const text = textOf(result);
    expect(text).toContain("Heart rate curves not read: the request failed.");
    expect(text).not.toContain("socket closed");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("socket closed"),
    );
  });

  it("fails on a rate-limited settings read", async () => {
    mockedSettings.mockRejectedValue(handledRateLimit("listSportSettings"));
    const result = await run();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(
      /^❌ Rate limit reached while trying to fetch sport settings\./,
    );
  });

  it("fails on a settings read that answers 404", async () => {
    mockedSettings.mockRejectedValue(handledNotFound("listSportSettings"));
    const result = await run();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "❌ No sport settings were found for this athlete.",
    );
  });

  it("fails when no group covers the sport and there is no Other group", async () => {
    mockedSettings.mockResolvedValue(groups.filter((g) => g.other !== true));
    const result = await run({ sport: "Rowing" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(
      /^❌ No intervals\.icu settings group covers Rowing, and there is no default Other group\./,
    );
    expect(textOf(result)).toContain("Run, VirtualRun, TrailRun");
  });

  it("fails for a word that is not an activity type instead of using the Other group", async () => {
    for (const sport of ["Running", "Cycling"]) {
      const result = await run({ sport });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(
        new RegExp(`^❌ ${sport} is not an intervals\\.icu activity type\\.`),
      );
    }
  });

  it("fails when the athlete has no settings groups", async () => {
    mockedSettings.mockResolvedValue([]);
    const result = await run();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "❌ No sport settings were found for this athlete.",
    );
  });

  it("says when a group has no thresholds or zones", async () => {
    const empty: IntervalsSportSettings = {
      types: ["Run", "VirtualRun", "TrailRun"],
      lthr: null,
      max_hr: null,
      hr_zones: null,
      threshold_pace: null,
      pace_zones: null,
      ftp: null,
    };
    mockedSettings.mockResolvedValue([empty]);
    const result = await run();
    const text = textOf(result);
    expect(text).toContain(
      "No thresholds or zones are set for this sport in intervals.icu.",
    );
    expect(text).not.toContain("LTHR 172");
    expect(text).toContain("LTHR check: No LTHR is set for this sport.");
  });

  it("gives a swim group's threshold pace per 100 m", async () => {
    const result = await run({ sport: "swim" });
    const text = textOf(result);
    expect(text).toContain("Threshold pace 2:05 /100m (0.8 m/s).");
    expect(text).not.toContain("Pace zones");
    expect(result.structuredContent?.pace_units).toBe("SECS_100M");
    expect(result.structuredContent?.threshold_pace_min_per_km).toBe("20:50");
    expect(result.structuredContent?.threshold_pace_min_per_100m).toBe("2:05");
  });

  it("reports FTP for the ride group", async () => {
    const result = await run({ sport: "Ride" });
    expect(textOf(result)).toContain("FTP 200 W.");
  });
});

describe("inputSchema", () => {
  it("defaults to Run, trims, and accepts letters and spaces only", () => {
    expect(inputSchema.parse({}).sport).toBe("Run");
    expect(inputSchema.parse({ sport: "  Ride " }).sport).toBe("Ride");
    expect(inputSchema.safeParse({ sport: "R2D2" }).success).toBe(false);
    expect(inputSchema.safeParse({ sport: "Run/../x" }).success).toBe(false);
    expect(inputSchema.safeParse({ sport: "" }).success).toBe(false);
  });
});

describe("formatAthleteZonesText", () => {
  /** A minimal payload with only the parts a case needs. */
  function response(
    overrides: Partial<AthleteZonesResponse> = {},
  ): AthleteZonesResponse {
    const unknown = {
      status: "unknown" as const,
      setting_bpm: null,
      estimate_bpm: null,
      basis: null,
      message: "Not checked.",
    };
    return {
      sport: "Run",
      settings_types: ["Run"],
      default_group: false,
      lthr_bpm: null,
      max_hr_bpm: null,
      hr_zones: [],
      threshold_speed_mps: null,
      threshold_pace_min_per_km: null,
      threshold_pace_min_per_100m: null,
      pace_units: null,
      pace_zones: [],
      ftp_watts: null,
      hr_bests: [],
      threshold_checks: { lthr: unknown, max_hr: unknown },
      other_groups: [],
      warnings: [],
      units: {
        hr: "bpm",
        time: "s",
        pace: "min/km",
        swim_pace: "min/100m",
        power: "W",
        pace_zones: "% of threshold speed",
      },
      ...overrides,
    };
  }

  it("prints one value for a one-bpm zone and an empty label for an empty zone", () => {
    const text = formatAthleteZonesText(
      response({
        hr_zones: [
          { zone: 1, name: null, min_bpm: 0, max_bpm: 150 },
          { zone: 2, name: null, min_bpm: 150, max_bpm: 150 },
          { zone: 3, name: null, min_bpm: 150, max_bpm: 151 },
        ],
      }),
    );
    expect(text).toContain("  Z1: up to 150 bpm\n  Z2: empty\n  Z3: 151 bpm");
  });

  it("prints percentages only when no threshold pace is set", () => {
    const text = formatAthleteZonesText(
      response({
        pace_zones: [
          {
            zone: 1,
            name: null,
            min_pct: 0,
            max_pct: 80,
            slowest_min_per_km: null,
            fastest_min_per_km: null,
            slowest_min_per_100m: null,
            fastest_min_per_100m: null,
          },
          {
            zone: 2,
            name: "Top",
            min_pct: 80,
            max_pct: null,
            slowest_min_per_km: null,
            fastest_min_per_km: null,
            slowest_min_per_100m: null,
            fastest_min_per_100m: null,
          },
        ],
      }),
    );
    expect(text).toContain(
      "Pace zones (% of threshold speed; no threshold pace is set):\n  Z1: under 80%\n  Z2 Top: over 80%",
    );
  });

  it("prints a swim group's pace zones per 100 m", () => {
    const text = formatAthleteZonesText(
      response({
        settings_types: ["Swim", "OpenWaterSwim"],
        threshold_speed_mps: 0.8,
        threshold_pace_min_per_km: "20:50",
        threshold_pace_min_per_100m: "2:05",
        pace_zones: [
          {
            zone: 1,
            name: null,
            min_pct: 0,
            max_pct: 100,
            slowest_min_per_km: null,
            fastest_min_per_km: "20:50",
            slowest_min_per_100m: null,
            fastest_min_per_100m: "2:05",
          },
          {
            zone: 2,
            name: null,
            min_pct: 100,
            max_pct: 110,
            slowest_min_per_km: "20:50",
            fastest_min_per_km: "18:56",
            slowest_min_per_100m: "2:05",
            fastest_min_per_100m: "1:54",
          },
        ],
      }),
    );
    expect(text).toContain("Threshold pace 2:05 /100m (0.8 m/s).");
    expect(text).toContain("  Z1: slower than 2:05 /100m (under 100%)");
    expect(text).toContain("  Z2: 2:05-1:54 /100m (100-110%)");
    expect(text).not.toContain("/km");
  });

  it("prints a missing LTHR or max HR as not set", () => {
    expect(formatAthleteZonesText(response({ max_hr_bpm: 190 }))).toContain(
      "LTHR not set, max HR 190 bpm.",
    );
  });
});
