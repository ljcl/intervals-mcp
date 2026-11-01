import { describe, expect, it } from "vitest";
import {
  dominantBucket,
  hrZoneRangeText,
  intensitySplit,
  type ZoneSet,
} from "./zones";

function hrSet(times: number[]): ZoneSet {
  const total = times.reduce((sum, t) => sum + t, 0);
  return {
    type: "heartrate",
    unit: "bpm",
    sensorBased: true,
    totalSeconds: total,
    buckets: times.map((seconds, i) => ({
      zone: i + 1,
      min: i * 20,
      max: i === times.length - 1 ? null : (i + 1) * 20,
      seconds,
      pct: total > 0 ? Math.round((seconds / total) * 1000) / 10 : 0,
    })),
  };
}

describe("dominantBucket", () => {
  it("returns the bucket with the most time", () => {
    expect(dominantBucket(hrSet([600, 1800, 900, 500, 200])).zone).toBe(2);
  });

  it("prefers the earlier bucket on a tie", () => {
    expect(dominantBucket(hrSet([500, 500, 100, 0, 0])).zone).toBe(1);
  });
});

describe("hrZoneRangeText", () => {
  it("starts each zone above the previous upper bound, in whole bpm", () => {
    expect(hrZoneRangeText({ min: 0, max: 142 }, " bpm")).toBe("up to 142 bpm");
    expect(hrZoneRangeText({ min: 142, max: 154 }, " bpm")).toBe("143-154 bpm");
    expect(hrZoneRangeText({ min: 142, max: 154 })).toBe("143-154");
  });

  it("gives one value for a one-bpm zone and none for an empty zone", () => {
    // 150 is in zone 1, so zone 2 of [150, 150, 151] holds no heart rate.
    expect(hrZoneRangeText({ min: 150, max: 150 }, " bpm")).toBe("empty");
    expect(hrZoneRangeText({ min: 150, max: 151 }, " bpm")).toBe("151 bpm");
  });
});

describe("intensitySplit", () => {
  it("buckets zones into easy (1-2), moderate (3), hard (4+)", () => {
    expect(intensitySplit([600, 1800, 900, 500, 200])).toEqual({
      easyPct: 60,
      moderatePct: 22.5,
      hardPct: 17.5,
    });
  });

  it("counts every zone above 3 as hard for 6-zone sets", () => {
    const split = intensitySplit([100, 100, 100, 100, 100, 100]);
    expect(split.hardPct).toBe(50);
    expect(split.easyPct + split.moderatePct + split.hardPct).toBeCloseTo(
      100,
      1,
    );
  });

  it("reads 0 everywhere for no time, not NaN", () => {
    expect(intensitySplit([0, 0, 0, 0, 0])).toEqual({
      easyPct: 0,
      moderatePct: 0,
      hardPct: 0,
    });
  });
});
