import { describe, expect, it } from "vitest";
import { speedDisplayForSport } from "./speed";
import {
  dominantBucket,
  hrZoneRangeText,
  intensitySplit,
  paceBasisLabel,
  paceBasisNote,
  paceZoneRangeText,
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

describe("paceZoneRangeText", () => {
  const run = speedDisplayForSport("run");

  it("reads fastest limit first, open at the slow end of zone 1 and the fast end of the top zone", () => {
    expect(paceZoneRangeText({ min: 0, max: 2.768 }, run)).toBe(
      `slower than 6'01" /km`,
    );
    expect(paceZoneRangeText({ min: 3.368, max: 3.571 }, run)).toBe(
      `4'40"-4'57" /km`,
    );
    expect(paceZoneRangeText({ min: 3.982, max: null }, run)).toBe(
      `faster than 4'11" /km`,
    );
  });

  it("takes the caller's formatter for the text tools' m:ss", () => {
    const mmss = (v: number) => `${Math.floor(v)}:${Math.round((v % 1) * 60)}`;
    expect(paceZoneRangeText({ min: 3.368, max: 3.571 }, run, mmss)).toBe(
      "4:40-4:57 /km",
    );
  });

  it("reads a speed sport slow to fast", () => {
    const other = speedDisplayForSport("other");
    expect(paceZoneRangeText({ min: 0, max: 2.5 }, other)).toBe(
      "up to 9.0 km/h",
    );
    expect(paceZoneRangeText({ min: 2.5, max: null }, other)).toBe("9.0+ km/h");
  });
});

describe("pace basis words", () => {
  it("names GAP and plain pace", () => {
    expect(paceBasisLabel("gap")).toBe("GAP");
    expect(paceBasisLabel("pace")).toBe("pace");
    expect(paceBasisNote("gap")).toContain("grade-adjusted");
    expect(paceBasisNote("pace")).toContain("not grade-adjusted");
  });
});
