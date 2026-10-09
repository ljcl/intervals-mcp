import { describe, expect, it } from "vitest";
import {
  achievementLabel,
  achievementTypes,
  formatAchievement,
  mapAchievements,
} from "./achievements";

/** intervals.icu's LTHR_UP from a 1 h effort: `value` is the point's HR. */
const LTHR_UP_1H = {
  id: "lthr",
  type: "LTHR_UP",
  message: "1h at 172 bpm",
  secs: null,
  value: 172,
  distance: null,
  pace: null,
  watts: null,
  point: { start_index: 3038, end_index: 6638, secs: 3600, value: 172 },
};

/** LTHR_UP from a 20 min effort: `value` is 98% of the point's HR, rounded. */
const LTHR_UP_20M = {
  id: "lthr",
  type: "LTHR_UP",
  message: "98% of 20m at 176 bpm",
  secs: null,
  value: 172,
  distance: null,
  pace: null,
  watts: null,
  point: { start_index: 120, end_index: 1320, secs: 1200, value: 176 },
};

/** Synthetic: no BEST_PACE has been seen live, so this follows the OpenAPI shape. */
const BEST_PACE_5K = {
  id: "pace",
  type: "BEST_PACE",
  message: "5km in 25:00",
  secs: 1500,
  value: null,
  distance: 5000,
  pace: 3.333,
  watts: null,
  point: null,
};

/** Synthetic: no BEST_POWER has been seen live (no power meter), and this one has no message. */
const BEST_POWER_5M = {
  id: "power",
  type: "BEST_POWER",
  message: null,
  secs: 300,
  value: null,
  distance: null,
  pace: null,
  watts: 400,
  point: null,
};

describe("mapAchievements", () => {
  it("maps null or a missing list to an empty one", () => {
    expect(mapAchievements(null)).toEqual([]);
    expect(mapAchievements(undefined)).toEqual([]);
  });

  it("takes an LTHR_UP's effort length from its curve point", () => {
    expect(mapAchievements([LTHR_UP_1H, LTHR_UP_20M])).toEqual([
      {
        type: "LTHR_UP",
        message: "1h at 172 bpm",
        value: 172,
        duration_s: 3600,
        distance_m: null,
        watts: null,
        pace_mps: null,
      },
      {
        type: "LTHR_UP",
        message: "98% of 20m at 176 bpm",
        value: 172,
        duration_s: 1200,
        distance_m: null,
        watts: null,
        pace_mps: null,
      },
    ]);
  });

  it("prefers the entry's own secs and keeps its distance and pace", () => {
    expect(mapAchievements([BEST_PACE_5K])).toEqual([
      {
        type: "BEST_PACE",
        message: "5km in 25:00",
        value: null,
        duration_s: 1500,
        distance_m: 5000,
        watts: null,
        pace_mps: 3.333,
      },
    ]);
  });

  it("keeps a power best's watts", () => {
    expect(mapAchievements([BEST_POWER_5M])).toEqual([
      {
        type: "BEST_POWER",
        message: null,
        value: null,
        duration_s: 300,
        distance_m: null,
        watts: 400,
        pace_mps: null,
      },
    ]);
  });

  it("drops an entry with no type and blanks an empty message", () => {
    expect(
      mapAchievements([
        { message: "no type" },
        { type: "", message: "empty type" },
        { type: "FTP_UP", message: "  " },
      ]),
    ).toEqual([
      {
        type: "FTP_UP",
        message: null,
        value: null,
        duration_s: null,
        distance_m: null,
        watts: null,
        pace_mps: null,
      },
    ]);
  });
});

describe("achievementTypes", () => {
  it("lists each type once, in the order sent", () => {
    expect(
      achievementTypes([BEST_PACE_5K, LTHR_UP_1H, { ...BEST_PACE_5K }]),
    ).toEqual(["BEST_PACE", "LTHR_UP"]);
  });

  it("is empty for no achievements", () => {
    expect(achievementTypes(null)).toEqual([]);
  });
});

describe("achievementLabel", () => {
  it("names a best without the sport", () => {
    expect(achievementLabel("BEST_POWER", "Ride")).toBe("Best power");
    expect(achievementLabel("BEST_PACE", "Run")).toBe("Best pace");
  });

  it("names the activity type for a threshold, which is per sport", () => {
    expect(achievementLabel("LTHR_UP", "Swim")).toBe("Swim LTHR up");
    expect(achievementLabel("FTP_UP", "Ride")).toBe("Ride FTP up");
  });

  it("shows an unknown type as sent", () => {
    expect(achievementLabel("NEW_KIND", "Run")).toBe("NEW_KIND");
  });
});

describe("formatAchievement", () => {
  it("gives an LTHR_UP as an estimate for its sport, with intervals.icu's message", () => {
    const [a] = mapAchievements([LTHR_UP_1H]);
    expect(formatAchievement(a!, "Run")).toBe(
      "Run LTHR up: 172 bpm estimated (1h at 172 bpm)",
    );
    const [swim] = mapAchievements([LTHR_UP_20M]);
    expect(formatAchievement(swim!, "Swim")).toBe(
      "Swim LTHR up: 172 bpm estimated (98% of 20m at 176 bpm)",
    );
  });

  it("never says the LTHR went up to the value: the settings may not have changed", () => {
    const [a] = mapAchievements([LTHR_UP_1H]);
    expect(formatAchievement(a!, "Run")).not.toMatch(/up to|new LTHR/);
  });

  it("falls back to the label when an LTHR_UP has no value", () => {
    const [a] = mapAchievements([{ ...LTHR_UP_1H, value: null }]);
    expect(formatAchievement(a!, "Run")).toBe("Run LTHR up: 1h at 172 bpm");
  });

  it("gives the estimate alone when there is no message", () => {
    const [a] = mapAchievements([{ ...LTHR_UP_1H, message: null }]);
    expect(formatAchievement(a!, "Run")).toBe("Run LTHR up: 172 bpm estimated");
  });

  it("puts the label before intervals.icu's message for another type", () => {
    const [a] = mapAchievements([BEST_PACE_5K]);
    expect(formatAchievement(a!, "Run")).toBe("Best pace: 5km in 25:00");
  });

  it("gives the watts and the effort length when a best has no message", () => {
    const [a] = mapAchievements([BEST_POWER_5M]);
    expect(formatAchievement(a!, "Ride")).toBe("Best power: 400 W for 5:00");
  });

  it("gives the distance and the time when a pace best has no message", () => {
    const [a] = mapAchievements([{ ...BEST_PACE_5K, message: null }]);
    expect(formatAchievement(a!, "Run")).toBe("Best pace: 5000 m in 25:00");
  });

  it("shows an unknown type with no message or effort as sent", () => {
    const [a] = mapAchievements([{ type: "NEW_KIND", message: null }]);
    expect(formatAchievement(a!, "Run")).toBe("NEW_KIND");
  });
});
