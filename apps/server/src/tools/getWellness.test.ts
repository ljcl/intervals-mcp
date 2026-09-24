import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import wellnessFixture from "../__fixtures__/intervals/wellness.json";
import { getWellness, type IntervalsWellness } from "../intervalsClient";
import {
  formatWellnessText,
  getWellnessTool,
  mapWellnessDay,
} from "./getWellness";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, getWellness: vi.fn() };
});
vi.mock("../config", async () => {
  const actual = await vi.importActual<typeof import("../config")>("../config");
  return { ...actual, getTimeZone: vi.fn(() => "UTC") };
});

const mockedGetWellness = vi.mocked(getWellness);

const fixture = wellnessFixture as unknown as IntervalsWellness[];
const byId = (id: string): IntervalsWellness => {
  const found = fixture.find((w) => w.id === id);
  if (!found) throw new Error(`fixture missing ${id}`);
  return found;
};

describe("mapWellnessDay", () => {
  it("maps the Task 1 fixture (2026-09-10): HRV SDNN set, rMSSD null, sleep hours from secs", () => {
    const day = mapWellnessDay(byId("2026-09-10"));

    expect(day.date).toBe("2026-09-10");
    expect(day.hrv_sdnn_ms).toBeCloseTo(41.17);
    expect(day.hrv_rmssd_ms).toBeNull();
    expect(day.resting_hr).toBe(52);
    // 22194 s / 3600 = 6.165, rounds to 6.2 h
    expect(day.sleep_hours).toBe(6.2);
    expect(day.weight_kg).toBe(70);
    expect(day.ctl).toBeCloseTo(41.02);
    expect(day.atl).toBeCloseTo(30.94);
    expect(day.ramp_rate).toBeCloseTo(-3.81258);
    expect(day.sleep_score).toBeNull();
    expect(day.readiness).toBeNull();
    expect(day.spo2).toBe(97);
    expect(day.comments).toBeNull();
  });

  it("computes tsb as ctl minus atl, 1 dp", () => {
    const day = mapWellnessDay({
      id: "2026-01-01",
      ctl: 50,
      atl: 42.34,
    } as IntervalsWellness);

    expect(day.tsb).toBe(7.7);
  });

  it("leaves tsb null when either ctl or atl is missing", () => {
    expect(
      mapWellnessDay({ id: "2026-01-01", ctl: 50 } as IntervalsWellness).tsb,
    ).toBeNull();
    expect(
      mapWellnessDay({ id: "2026-01-01", atl: 40 } as IntervalsWellness).tsb,
    ).toBeNull();
    expect(
      mapWellnessDay({ id: "2026-01-01" } as IntervalsWellness).tsb,
    ).toBeNull();
  });

  it("maps all subjective/misc fields when present", () => {
    const day = mapWellnessDay({
      id: "2026-01-01",
      sleepScore: 82,
      readiness: 75,
      soreness: 3,
      fatigue: 2,
      stress: 1,
      mood: 4,
      motivation: 5,
      spO2: 96,
      respiration: 14,
      comments: "Felt good",
    } as IntervalsWellness);

    expect(day.sleep_score).toBe(82);
    expect(day.readiness).toBe(75);
    expect(day.soreness).toBe(3);
    expect(day.fatigue).toBe(2);
    expect(day.stress).toBe(1);
    expect(day.mood).toBe(4);
    expect(day.motivation).toBe(5);
    expect(day.spo2).toBe(96);
    expect(day.respiration).toBe(14);
    expect(day.comments).toBe("Felt good");
  });

  it("leaves sleep_hours null when sleepSecs is absent", () => {
    const day = mapWellnessDay({ id: "2026-01-01" } as IntervalsWellness);
    expect(day.sleep_hours).toBeNull();
  });
});

describe("formatWellnessText", () => {
  it("renders a single compact block for a single day", () => {
    const day = mapWellnessDay(byId("2026-09-10"));
    const text = formatWellnessText({
      oldest: "2026-09-10",
      newest: "2026-09-10",
      count: 1,
      units: {
        hrv: "ms",
        resting_hr: "bpm",
        sleep: "hours",
        weight: "kg",
        spo2: "%",
        respiration: "breaths/min",
      },
      hrv_note: "note",
      days: [day],
    });

    expect(text).toContain("Wellness 2026-09-10");
    expect(text).toContain("HRV SDNN 41.2 ms");
    expect(text).toContain("resting HR 52");
    expect(text).toContain("sleep 6.2 h");
    expect(text.split("\n").length).toBeGreaterThan(1);
  });

  it("reports no-data text for a single day with no record", () => {
    const text = formatWellnessText({
      oldest: "2026-09-10",
      newest: "2026-09-10",
      count: 0,
      units: {
        hrv: "ms",
        resting_hr: "bpm",
        sleep: "hours",
        weight: "kg",
        spo2: "%",
        respiration: "breaths/min",
      },
      hrv_note: "note",
      days: [],
    });
    expect(text).toBe("No wellness data for 2026-09-10.");
  });

  it("renders one line per day, newest first, plus averages for a range", () => {
    const days = [byId("2026-09-10"), byId("2026-09-11"), byId("2026-09-12")]
      .map(mapWellnessDay)
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    const text = formatWellnessText({
      oldest: "2026-09-10",
      newest: "2026-09-12",
      count: 3,
      units: {
        hrv: "ms",
        resting_hr: "bpm",
        sleep: "hours",
        weight: "kg",
        spo2: "%",
        respiration: "breaths/min",
      },
      hrv_note: "note",
      days,
    });

    const lines = text.split("\n");
    expect(lines[0]).toBe("Wellness 2026-09-10 to 2026-09-12: 3 days");
    expect(lines[1]?.startsWith("2026-09-12:")).toBe(true);
    expect(lines[1]).toContain("HRV SDNN");
    expect(lines[2]?.startsWith("2026-09-11:")).toBe(true);
    expect(lines[3]?.startsWith("2026-09-10:")).toBe(true);
    expect(lines.at(-1)).toContain("Averages:");
    expect(lines.at(-1)).toContain("HRV SDNN");
    expect(lines.at(-1)).toContain("resting HR");
    expect(lines.at(-1)).toContain("sleep");
  });
});

describe("getWellnessTool.execute", () => {
  beforeEach(() => {
    mockedGetWellness.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to today (in the injected time zone) when nothing is supplied", async () => {
    mockedGetWellness.mockResolvedValueOnce([]);

    const result = await getWellnessTool.execute({}, "key");

    expect(mockedGetWellness).toHaveBeenCalledWith("key", {
      oldest: "2026-09-24",
      newest: "2026-09-24",
    });
    expect(result.structuredContent?.oldest).toBe("2026-09-24");
    expect(result.structuredContent?.newest).toBe("2026-09-24");
    expect(result.isError).toBeUndefined();
  });

  it("includes hrv_note and units in structuredContent", async () => {
    mockedGetWellness.mockResolvedValueOnce([byId("2026-09-24")]);

    const result = await getWellnessTool.execute({}, "key");

    expect(result.structuredContent?.hrv_note).toBe(
      "Apple Watch reports HRV as SDNN (hrv_sdnn_ms); rMSSD (hrv_rmssd_ms) is usually null for this athlete. Do not compare SDNN values with rMSSD norms.",
    );
    expect(result.structuredContent?.units).toEqual({
      hrv: "ms",
      resting_hr: "bpm",
      sleep: "hours",
      weight: "kg",
      spo2: "%",
      respiration: "breaths/min",
    });
  });

  it("fetches a range when oldest/newest are supplied", async () => {
    mockedGetWellness.mockResolvedValueOnce(fixture);

    const result = await getWellnessTool.execute(
      { oldest: "2026-09-10", newest: "2026-09-24" },
      "key",
    );

    expect(mockedGetWellness).toHaveBeenCalledWith("key", {
      oldest: "2026-09-10",
      newest: "2026-09-24",
    });
    expect(result.structuredContent?.count).toBe(fixture.length);
  });

  it("rejects date combined with oldest/newest", async () => {
    const result = await getWellnessTool.execute(
      { date: "2026-09-24", oldest: "2026-09-01" },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("❌");
    expect(mockedGetWellness).not.toHaveBeenCalled();
  });

  it("rejects oldest after newest", async () => {
    const result = await getWellnessTool.execute(
      { oldest: "2026-09-24", newest: "2026-09-01" },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("after newest");
  });

  it("rejects a range longer than 90 days", async () => {
    const result = await getWellnessTool.execute(
      { oldest: "2026-01-01", newest: "2026-09-24" },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("max range is 90 days");
    expect(mockedGetWellness).not.toHaveBeenCalled();
  });

  it("accepts a range of exactly 90 calendar days (both endpoints inclusive)", async () => {
    mockedGetWellness.mockResolvedValueOnce([]);

    const result = await getWellnessTool.execute(
      { oldest: "2026-06-27", newest: "2026-09-24" },
      "key",
    );

    expect(result.isError).toBeUndefined();
  });

  it("rejects a non-calendar date (2026-02-30) at the schema level", () => {
    const result = getWellnessTool.inputSchema.safeParse({
      date: "2026-02-30",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a range one day past 90 calendar days", async () => {
    // 2026-06-26 to 2026-09-24 is 91 calendar days inclusive; daysBetween
    // alone (a difference, not a count) would read this as 90 and wrongly
    // accept it.
    const result = await getWellnessTool.execute(
      { oldest: "2026-06-26", newest: "2026-09-24" },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("max range is 90 days");
    expect(mockedGetWellness).not.toHaveBeenCalled();
  });

  it("uses date as both oldest and newest for a single-day query", async () => {
    mockedGetWellness.mockResolvedValueOnce([byId("2026-09-24")]);

    const result = await getWellnessTool.execute({ date: "2026-09-24" }, "key");

    expect(mockedGetWellness).toHaveBeenCalledWith("key", {
      oldest: "2026-09-24",
      newest: "2026-09-24",
    });
    expect(result.structuredContent?.count).toBe(1);
  });
});
