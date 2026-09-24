import { describe, expect, it } from "vitest";
import { hrZoneSet, mockZonesData, powerZoneSet } from "./__fixtures__/zones";
import {
  buildSummaryStats,
  buildZoneRows,
  buildZonesSubtitle,
  formatZoneRange,
  intensitySplit,
} from "./normalize";

describe("formatZoneRange", () => {
  it("formats bounded and open-ended ranges", () => {
    expect(formatZoneRange(hrZoneSet.buckets[0]!, "bpm")).toBe("0–120 bpm");
    expect(formatZoneRange(hrZoneSet.buckets[4]!, "bpm")).toBe("175–197 bpm");
    // Power's top bucket still models an open-ended sentinel.
    expect(formatZoneRange(powerZoneSet.buckets[5]!, "W")).toBe("400+ W");
  });
});

describe("buildZoneRows", () => {
  it("labels zones and converts seconds to minutes", () => {
    const rows = buildZoneRows(hrZoneSet);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      label: "Z1",
      range: "0–120 bpm",
      minutes: 10,
      seconds: 600,
      pct: 15,
    });
    expect(rows[1]!.minutes).toBe(30);
  });
});

describe("intensitySplit", () => {
  it("buckets zones into easy (1-2), moderate (3), hard (4+)", () => {
    const split = intensitySplit(hrZoneSet);
    expect(split.easyPct).toBe(60);
    expect(split.moderatePct).toBe(22.5);
    expect(split.hardPct).toBe(17.5);
  });

  it("counts every zone above 3 as hard for 6-zone power sets", () => {
    const split = intensitySplit(powerZoneSet);
    expect(split.hardPct).toBe(15);
    expect(split.easyPct + split.moderatePct + split.hardPct).toBeCloseTo(
      100,
      1,
    );
  });
});

describe("buildSummaryStats", () => {
  it("summarises time, dominant zone, and the split", () => {
    const stats = buildSummaryStats(hrZoneSet);
    expect(stats.map((s) => s.label)).toEqual([
      "Time",
      "Mostly",
      "Easy Z1–2",
      "Hard Z4+",
    ]);
    expect(stats[0]!.value).toBe("1h 07m");
    expect(stats[1]!.value).toBe("Z2");
    expect(stats[2]!.value).toBe("60%");
  });
});

describe("buildZonesSubtitle", () => {
  it("names the sport, date, and the set being charted", () => {
    expect(buildZonesSubtitle(mockZonesData, hrZoneSet)).toBe(
      "Run · 10 Jul · Heart rate zones",
    );
  });

  it("names the power set when power is active", () => {
    expect(buildZonesSubtitle(mockZonesData, powerZoneSet)).toBe(
      "Run · 10 Jul · Power zones",
    );
  });
});
