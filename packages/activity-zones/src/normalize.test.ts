import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyZonesData,
  hrZoneMismatchData,
  hrZoneSet,
  mockZonesData,
  paceZoneSet,
  powerZoneSet,
} from "./__fixtures__/zones";
import {
  buildEmptyMessage,
  buildSummaryStats,
  buildZoneRows,
  buildZonesSubtitle,
  formatZoneRange,
} from "./normalize";

describe("formatZoneRange", () => {
  it("reads HR ranges as get-activity-zones does: upper bound inclusive, whole bpm", () => {
    expect(formatZoneRange(hrZoneSet.buckets[0]!, hrZoneSet, "Run")).toBe(
      "up to 120 bpm",
    );
    expect(formatZoneRange(hrZoneSet.buckets[4]!, hrZoneSet, "Run")).toBe(
      "176-197 bpm",
    );
  });

  it("formats an open-ended power range", () => {
    // Power's top bucket still models an open-ended sentinel.
    expect(
      formatZoneRange(powerZoneSet.buckets[5]!, powerZoneSet, "Ride"),
    ).toBe("400+ W");
  });

  it("reads pace ranges fastest limit first, with open ends at both extremes", () => {
    const range = (i: number) =>
      formatZoneRange(paceZoneSet.buckets[i]!, paceZoneSet, "Run");
    expect(range(0)).toBe(`slower than 6'01" /km`);
    expect(range(3)).toBe(`4'40"-4'57" /km`);
    expect(range(6)).toBe(`faster than 4'11" /km`);
  });
});

describe("buildZoneRows", () => {
  it("labels zones and converts seconds to minutes", () => {
    const rows = buildZoneRows(hrZoneSet, "Run");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      label: "Z1",
      range: "up to 120 bpm",
      minutes: 10,
      seconds: 600,
      pct: 15,
    });
    expect(rows[1]!.minutes).toBe(30);
  });

  it("gives a pace set one row per zone with the same seconds and percentages", () => {
    const rows = buildZoneRows(paceZoneSet, "Run");
    expect(rows.map((r) => r.seconds)).toEqual([
      177, 704, 347, 281, 82, 71, 54,
    ]);
    expect(rows.map((r) => r.pct)).toEqual([
      10.3, 41, 20.2, 16.4, 4.8, 4.1, 3.1,
    ]);
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

  it("names the pace set and its basis", () => {
    expect(buildZonesSubtitle(mockZonesData, paceZoneSet)).toBe(
      "Run · 10 Jul · Pace zones (GAP)",
    );
    expect(
      buildZonesSubtitle(mockZonesData, { ...paceZoneSet, basis: "pace" }),
    ).toBe("Run · 10 Jul · Pace zones (pace)");
  });

  it("names the power set when power is active", () => {
    expect(buildZonesSubtitle(mockZonesData, powerZoneSet)).toBe(
      "Run · 10 Jul · Power zones",
    );
  });

  describe("in a time zone other than UTC", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    // The date is start_date_local, with no offset, so the day must not
    // move with the viewer's time zone.
    it.each([
      // A morning run in Sydney (UTC+10): 06:12 on 10 Jul is 9 Jul in UTC.
      ["Australia/Sydney", mockZonesData],
      // An evening run in Los Angeles (UTC-7): 19:30 is 11 Jul in UTC.
      [
        "America/Los_Angeles",
        { ...mockZonesData, date: "2026-07-10T19:30:00" },
      ],
    ])("shows the activity's local day in %s", (tz, data) => {
      vi.stubEnv("TZ", tz);
      // Proves the zone applies: parsed as a Date, the day moves.
      expect(new Date(data.date).getUTCDate()).not.toBe(10);
      expect(buildZonesSubtitle(data, hrZoneSet)).toBe(
        "Run · 10 Jul · Heart rate zones",
      );
    });
  });
});

describe("buildEmptyMessage", () => {
  it("gives the server's own reason when heart rate zones were dropped", () => {
    expect(buildEmptyMessage(hrZoneMismatchData)).toBe(
      `No zone data to show for this activity. ${hrZoneMismatchData.hrZoneWarning}`,
    );
  });

  it("claims no reason the payload does not carry", () => {
    // Power zones are always dropped for now, so a missing sensor is not
    // something the app can know.
    expect(buildEmptyMessage(emptyZonesData)).toBe(
      "No zone data to show for this activity.",
    );
  });
});
