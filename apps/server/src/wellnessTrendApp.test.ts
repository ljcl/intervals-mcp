import { describe, expect, it } from "vitest";
import { mapWellnessDay, type WellnessResponse } from "./tools/getWellness";
import { buildWellnessTrendData } from "./wellnessTrendApp";

const response = (
  overrides: Partial<WellnessResponse> = {},
): WellnessResponse => ({
  oldest: "2026-11-01",
  newest: "2026-11-04",
  count: 0,
  units: {
    hrv: "ms",
    resting_hr: "bpm",
    sleep: "hours",
    weight: "kg",
    spo2: "%",
    respiration: "breaths/min",
  },
  hrv_note: "",
  days: [],
  ...overrides,
});

describe("buildWellnessTrendData", () => {
  it("lays the days oldest first on every calendar day, nulls for a missing one", () => {
    const days = [
      mapWellnessDay({ id: "2026-11-04", hrv: 55, restingHR: 50 }),
      mapWellnessDay({ id: "2026-11-01", hrv: 52, sleepSecs: 27000 }),
    ];
    const data = buildWellnessTrendData(response({ days, count: 2 }));
    expect(data.points).toEqual([
      { date: "2026-11-01", hrv: 52, restingHr: null, sleepHours: 7.5 },
      { date: "2026-11-02", hrv: null, restingHr: null, sleepHours: null },
      { date: "2026-11-03", hrv: null, restingHr: null, sleepHours: null },
      { date: "2026-11-04", hrv: 55, restingHr: 50, sleepHours: null },
    ]);
    expect(data.granularity).toBe("daily");
    expect(data.hrvMeasure).toBe("rmssd");
  });

  it("plots SDNN when more days carry it, and no HRV when none do", () => {
    const sdnn = [
      mapWellnessDay({ id: "2026-11-01", hrvSDNN: 40 }),
      mapWellnessDay({ id: "2026-11-02", hrvSDNN: 41, hrv: 60 }),
      mapWellnessDay({ id: "2026-11-03", hrvSDNN: 42 }),
    ];
    const data = buildWellnessTrendData(response({ days: sdnn }));
    expect(data.hrvMeasure).toBe("sdnn");
    expect(data.points.map((p) => p.hrv)).toEqual([40, 41, 42, null]);

    const none = buildWellnessTrendData(
      response({ days: [mapWellnessDay({ id: "2026-11-01", restingHR: 50 })] }),
    );
    expect(none.hrvMeasure).toBeNull();
    expect(none.points.every((p) => p.hrv === null)).toBe(true);
  });

  it("lays weekly means on every Monday from the oldest day's week", () => {
    const data = buildWellnessTrendData(
      response({
        oldest: "2026-10-01",
        newest: "2026-10-20",
        granularity: "weekly",
        weeks: [
          {
            week_start: "2026-10-19",
            days: 2,
            hrv_sdnn_ms: null,
            hrv_rmssd_ms: 50,
            resting_hr: 49,
            sleep_hours: 7,
            weight_kg: null,
            vo2max: null,
            steps: null,
            readiness: null,
            soreness: null,
            fatigue: null,
            stress: null,
            mood: null,
            motivation: null,
            injury: null,
            sleep_quality: null,
          },
        ],
      }),
    );
    expect(data.granularity).toBe("weekly");
    expect(data.points.map((p) => [p.date, p.days, p.hrv])).toEqual([
      ["2026-09-28", 0, null],
      ["2026-10-05", 0, null],
      ["2026-10-12", 0, null],
      ["2026-10-19", 2, 50],
    ]);
  });
});
