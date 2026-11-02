import { describe, expect, it } from "vitest";
import { compareData, compareDataWalks } from "./__fixtures__/runs";
import { buildDeltaTiles } from "./CompareActivities";
import { type CompareData } from "./types";

const tile = (compare: CompareData, key: string) =>
  buildDeltaTiles(compare).find((t) => t.key === key);

describe("buildDeltaTiles speed for non-run pairs (#315)", () => {
  it("gives two walks a Speed tile in the text's km/h, with no delta", () => {
    expect(tile(compareDataWalks, "pace")).toBeUndefined();
    expect(tile(compareDataWalks, "speed")).toEqual({
      key: "speed",
      label: "Speed",
      a: "5.2km/h",
      b: "5.0km/h",
      delta: "",
    });
  });

  it("gives two swims a /100m Pace tile", () => {
    const swims: CompareData = {
      ...compareDataWalks,
      activity_1: {
        ...compareDataWalks.activity_1,
        type: "Swim",
        speed_kmh: null,
        pace_min_per_100m: "1:52",
      },
      activity_2: {
        ...compareDataWalks.activity_2,
        type: "Swim",
        speed_kmh: null,
        pace_min_per_100m: "1:48",
      },
    };
    expect(tile(swims, "speed")).toMatchObject({
      label: "Pace",
      a: "1:52/100m",
      b: "1:48/100m",
      delta: "",
    });
  });

  it("gives a run against a walk km/h on both sides, the run's from distance over time", () => {
    const mixed: CompareData = {
      ...compareDataWalks,
      activity_1: compareData.activity_1,
    };
    // 9.98 km in 3150 s is 11.4 km/h.
    expect(tile(mixed, "speed")).toMatchObject({
      label: "Speed",
      a: "11.4km/h",
      b: "5.0km/h",
    });
  });

  it("keeps two runs on the pace tile alone", () => {
    expect(tile(compareData, "pace")).toBeDefined();
    expect(tile(compareData, "speed")).toBeUndefined();
  });
});
