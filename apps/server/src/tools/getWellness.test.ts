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
    expect(day.hrv_sdnn_ms).toBeCloseTo(40.37);
    expect(day.hrv_rmssd_ms).toBeNull();
    expect(day.resting_hr).toBe(54);
    // 26934 s / 3600 = 7.4817, rounds to 7.5 h
    expect(day.sleep_hours).toBe(7.5);
    expect(day.weight_kg).toBe(70);
    // ctl 41.02, atl 30.94 and rampRate -2.65 round to 1 dp, like tsb.
    expect(day.ctl).toBe(41);
    expect(day.atl).toBe(30.9);
    expect(day.ramp_rate).toBe(-2.6);
    expect(day.sleep_score).toBeNull();
    expect(day.readiness).toBeNull();
    expect(day.spo2).toBe(98);
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
      injury: 2,
      sleepQuality: 1,
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
    expect(day.injury).toBe(2);
    expect(day.sleep_quality).toBe(1);
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
    expect(text).toContain("HRV SDNN 40.4 ms");
    expect(text).toContain("resting HR 54");
    expect(text).toContain("sleep 7.5 h");
    expect(text.split("\n").length).toBeGreaterThan(1);
  });

  it("labels each 1 to 4 score as the web app does", () => {
    const day = mapWellnessDay({
      id: "2026-09-10",
      soreness: 3,
      mood: 1,
      injury: 2,
      sleepQuality: 4,
      motivation: 5,
    } as IntervalsWellness);
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

    expect(text).toContain(
      "soreness 3 (High), mood 1 (Great), motivation 5, injury 2 (Niggle), sleep quality 4 (Poor)",
    );
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

describe("formatWellnessText range lines", () => {
  const units = {
    hrv: "ms",
    resting_hr: "bpm",
    sleep: "hours",
    weight: "kg",
    spo2: "%",
    respiration: "breaths/min",
  } as const;

  it("shows each logged score with its label and the comments, cut to 80 characters", () => {
    const day = mapWellnessDay({
      id: "2026-10-29",
      hrvSDNN: 60,
      readiness: 6,
      soreness: 3,
      injury: 2,
      comments: `left calf tight\nafter ${"x".repeat(100)}`,
    } as IntervalsWellness);

    const text = formatWellnessText({
      oldest: "2026-10-28",
      newest: "2026-10-29",
      count: 1,
      units,
      hrv_note: "note",
      days: [day],
    });

    const line = text.split("\n")[1] ?? "";
    expect(line).toContain("readiness 6");
    expect(line).toContain("soreness 3 (High)");
    expect(line).toContain("injury 2");
    expect(line).toContain(
      `comments "left calf tight after ${"x".repeat(58)}..."`,
    );
  });

  it("says how many days it kept and names the call for the rest; averages cover every day", () => {
    const all = [
      { id: "2026-10-03", restingHR: 50 },
      { id: "2026-10-02", restingHR: 52 },
      { id: "2026-10-01", restingHR: 60 },
    ].map((w) => mapWellnessDay(w as IntervalsWellness));

    const text = formatWellnessText(
      {
        oldest: "2026-09-30",
        newest: "2026-10-03",
        count: 3,
        units,
        hrv_note: "note",
        days: all.slice(0, 2),
      },
      all,
    );

    expect(text).toContain(
      "Showing the newest 2 of 3 days, to stay under the response size limit. For the rest, call get-wellness with oldest 2026-09-30 and newest 2026-10-01.",
    );
    expect(text).toContain("resting HR 54.0");
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

    // The fixture athlete's HRV is SDNN only.
    expect(result.structuredContent?.hrv_note).toBe(
      "HRV is SDNN (hrv_sdnn_ms), not rMSSD (hrv_rmssd_ms is null). Do not compare SDNN values with rMSSD norms.",
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

  it("refuses a date after today, naming get-fitness-trend, without a request", async () => {
    const result = await getWellnessTool.execute({ date: "2026-09-25" }, "key");

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("date 2026-09-25 is after today");
    expect(result.content[0]?.text).toContain("get-fitness-trend");
    expect(mockedGetWellness).not.toHaveBeenCalled();
  });

  it("refuses a newest after today, naming get-fitness-trend, without a request", async () => {
    const result = await getWellnessTool.execute(
      { oldest: "2026-09-20", newest: "2026-09-30" },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "newest 2026-09-30 is after today",
    );
    expect(result.content[0]?.text).toContain("get-fitness-trend");
    expect(mockedGetWellness).not.toHaveBeenCalled();
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

  it("rejects a range longer than 366 days", async () => {
    const result = await getWellnessTool.execute(
      { oldest: "2025-09-23", newest: "2026-09-24" },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("max range is 366 days");
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

  it("accepts 366 calendar days and rejects 367", async () => {
    mockedGetWellness.mockResolvedValueOnce([]);
    const ok = await getWellnessTool.execute(
      { oldest: "2025-09-24", newest: "2026-09-24" },
      "key",
    );
    expect(ok.isError).toBeUndefined();

    const tooLong = await getWellnessTool.execute(
      { oldest: "2025-09-23", newest: "2026-09-24" },
      "key",
    );
    expect(tooLong.isError).toBe(true);
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

  it("rounds ctl, atl and ramp_rate to 1 dp in structuredContent and the text", async () => {
    // intervals.icu sends these unrounded.
    mockedGetWellness.mockResolvedValueOnce([
      {
        id: "2026-09-24",
        ctl: 41.0412345,
        atl: 30.9587654,
        rampRate: -2.6512345,
      } as IntervalsWellness,
    ]);

    const result = await getWellnessTool.execute({ date: "2026-09-24" }, "key");

    // tsb comes from the unrounded values: 10.08 rounds to 10.1, where the
    // rounded 41.0 - 31.0 would give 10.0.
    expect(result.structuredContent?.days[0]).toMatchObject({
      ctl: 41,
      atl: 31,
      tsb: 10.1,
      ramp_rate: -2.7,
    });
    expect(result.content[0]?.text).toBe(
      "Wellness 2026-09-24\nCTL 41.0, ATL 31.0, TSB 10.1, ramp -2.7",
    );
  });
});

describe("getWellnessTool.execute HRV by measure", () => {
  beforeEach(() => {
    mockedGetWellness.mockReset();
  });

  /** Runs the tool over `records` and returns its text and hrv_note. */
  async function run(
    records: IntervalsWellness[],
    oldest: string,
    newest = oldest,
  ) {
    mockedGetWellness.mockResolvedValueOnce(records);
    const result = await getWellnessTool.execute({ oldest, newest }, "key");
    return {
      text: result.content[0]?.text,
      note: result.structuredContent?.hrv_note,
    };
  }

  it("keeps an SDNN-only athlete's day and range text as before", async () => {
    const day = await run([byId("2026-09-24")], "2026-09-24");
    expect(day.text).toBe(
      [
        "Wellness 2026-09-24",
        "HRV SDNN 38.1 ms, resting HR 58, sleep 7.1 h, weight 70 kg",
        "CTL 41.4, ATL 34.9, TSB 6.5, ramp -2.1",
        "SpO2 95%",
      ].join("\n"),
    );

    const range = await run(
      [byId("2026-09-23"), byId("2026-09-24")],
      "2026-09-23",
      "2026-09-24",
    );
    expect(range.text).toBe(
      [
        "Wellness 2026-09-23 to 2026-09-24: 2 days",
        "2026-09-24: HRV SDNN 38.1, RHR 58, sleep 7.1h, wt 70kg, CTL/ATL 41.4/34.9, TSB 6.5",
        "2026-09-23: HRV SDNN 47.9, RHR 55, sleep 6.7h, wt 70kg, CTL/ATL 41.4/35.4, TSB 5.9",
        "Averages: HRV SDNN 43.0 ms, resting HR 56.5, sleep 6.9 h",
      ].join("\n"),
    );
  });

  it("labels an rMSSD-only athlete's HRV as rMSSD, with a note that names no device", async () => {
    const day = await run(
      [
        {
          id: "2026-09-24",
          hrv: 48,
          hrvSDNN: null,
          restingHR: 50,
          sleepSecs: 27000,
        } as IntervalsWellness,
      ],
      "2026-09-24",
    );
    expect(day.text).toBe(
      "Wellness 2026-09-24\nHRV rMSSD 48.0 ms, resting HR 50, sleep 7.5 h",
    );

    const range = await run(
      [
        { id: "2026-09-22", hrv: 52.3, hrvSDNN: null, restingHR: 48 },
        { id: "2026-09-23", hrv: 47.1, hrvSDNN: null, restingHR: 50 },
        { id: "2026-09-24", hrv: 44.9, hrvSDNN: null, restingHR: 51 },
      ] as IntervalsWellness[],
      "2026-09-22",
      "2026-09-24",
    );
    expect(range.text).toBe(
      [
        "Wellness 2026-09-22 to 2026-09-24: 3 days",
        "2026-09-24: HRV rMSSD 44.9, RHR 51",
        "2026-09-23: HRV rMSSD 47.1, RHR 50",
        "2026-09-22: HRV rMSSD 52.3, RHR 48",
        "Averages: HRV rMSSD 48.1 ms, resting HR 49.7",
      ].join("\n"),
    );
    expect(range.note).toBe(
      "HRV is rMSSD (hrv_rmssd_ms). SDNN (hrv_sdnn_ms) is null.",
    );
  });

  it("prints both measures on a day that has both, and averages each separately", async () => {
    const day = await run(
      [{ id: "2026-09-24", hrv: 48.2, hrvSDNN: 41.5 } as IntervalsWellness],
      "2026-09-24",
    );
    expect(day.text).toBe(
      "Wellness 2026-09-24\nHRV rMSSD 48.2 ms, HRV SDNN 41.5 ms",
    );

    const range = await run(
      [
        { id: "2026-09-22", hrv: 50, hrvSDNN: 40 },
        { id: "2026-09-23", hrv: 46, hrvSDNN: 44 },
        { id: "2026-09-24", hrv: null, hrvSDNN: 42 },
      ] as IntervalsWellness[],
      "2026-09-22",
      "2026-09-24",
    );
    // Pooled, the five values would average 44.4 ms, which is neither
    // measure's own average.
    expect(range.text).toBe(
      [
        "Wellness 2026-09-22 to 2026-09-24: 3 days",
        "2026-09-24: HRV SDNN 42.0",
        "2026-09-23: HRV rMSSD 46.0, HRV SDNN 44.0",
        "2026-09-22: HRV rMSSD 50.0, HRV SDNN 40.0",
        "Averages: HRV rMSSD 48.0 ms, HRV SDNN 42.0 ms",
      ].join("\n"),
    );
    expect(range.note).toBe(
      "HRV has both rMSSD (hrv_rmssd_ms) and SDNN (hrv_sdnn_ms). They are different measures, so compare each only with its own norms.",
    );
  });

  it("says no HRV was recorded when no day has any", async () => {
    const quiet = await run(
      [{ id: "2026-09-24", restingHR: 50 } as IntervalsWellness],
      "2026-09-24",
    );
    expect(quiet.note).toBe("No HRV recorded.");

    const empty = await run([], "2026-09-24");
    expect(empty.note).toBe("No HRV recorded.");
  });
});

describe("getWellnessTool.execute weekly averages past 90 days", () => {
  beforeEach(() => {
    mockedGetWellness.mockReset();
  });

  it("keeps daily rows and adds no weekly keys at exactly 90 days", async () => {
    mockedGetWellness.mockResolvedValueOnce([byId("2026-09-24")]);
    const result = await getWellnessTool.execute(
      { oldest: "2026-06-27", newest: "2026-09-24" },
      "key",
    );
    expect(result.structuredContent?.days).toHaveLength(1);
    expect(result.structuredContent).not.toHaveProperty("weeks");
    expect(result.structuredContent).not.toHaveProperty("granularity");
  });

  it("returns Monday-start weekly means with a day count, newest first", async () => {
    // 2026-09-21 is a Monday: Sun 09-20 belongs to the week of 09-14.
    mockedGetWellness.mockResolvedValueOnce([
      { id: "2026-09-20", restingHR: 50, weight: 70, soreness: 1 },
      { id: "2026-09-21", restingHR: 52, weight: 70.4, soreness: 2 },
      { id: "2026-09-23", restingHR: 55, soreness: 3, sleepSecs: 7.5 * 3600 },
    ] as IntervalsWellness[]);

    const result = await getWellnessTool.execute(
      { oldest: "2026-01-01", newest: "2026-09-24" },
      "key",
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.granularity).toBe("weekly");
    expect(result.structuredContent?.days).toEqual([]);
    expect(result.structuredContent?.count).toBe(3);
    expect(result.structuredContent?.weeks).toEqual([
      expect.objectContaining({
        week_start: "2026-09-21",
        days: 2,
        resting_hr: 53.5,
        weight_kg: 70.4,
        sleep_hours: 7.5,
        soreness: 2.5,
        fatigue: null,
      }),
      expect.objectContaining({
        week_start: "2026-09-14",
        days: 1,
        resting_hr: 50,
        soreness: 1,
      }),
    ]);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("weekly averages (Monday start");
    expect(text).toContain("2026-09-21 (2 d): RHR 53.5");
  });

  it("averages rMSSD and SDNN separately, never together", async () => {
    mockedGetWellness.mockResolvedValueOnce([
      { id: "2026-09-21", hrv: 60, hrvSDNN: 40 },
      { id: "2026-09-22", hrv: 70 },
      { id: "2026-09-23", hrvSDNN: 50 },
    ] as IntervalsWellness[]);

    const result = await getWellnessTool.execute(
      { oldest: "2026-01-01", newest: "2026-09-24" },
      "key",
    );

    expect(result.structuredContent?.weeks?.[0]).toMatchObject({
      hrv_rmssd_ms: 65,
      hrv_sdnn_ms: 45,
    });
    expect(result.structuredContent?.hrv_note).toContain("both rMSSD");
    expect(result.content[0]?.text).toContain("HRV rMSSD 65, HRV SDNN 45");
  });

  it("says so when there is no data", async () => {
    mockedGetWellness.mockResolvedValueOnce([]);
    const result = await getWellnessTool.execute(
      { oldest: "2026-01-01", newest: "2026-09-24" },
      "key",
    );
    expect(result.content[0]?.text).toBe(
      "No wellness data 2026-01-01 to 2026-09-24.",
    );
    expect(result.structuredContent?.weeks).toEqual([]);
  });
});
