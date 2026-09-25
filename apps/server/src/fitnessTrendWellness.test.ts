import { describe, expect, it, vi } from "vitest";
import {
  FITNESS_TREND_WELLNESS_FIELDS,
  loadWellnessFitnessSeries,
} from "./fitnessTrendWellness";
import { getWellness, type IntervalsWellness } from "./intervalsClient";

vi.mock("./intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("./intervalsClient")>(
      "./intervalsClient",
    );
  return { ...actual, getWellness: vi.fn() };
});

const mockedWellness = vi.mocked(getWellness);

function row(
  date: string,
  values: Partial<IntervalsWellness> = {},
): IntervalsWellness {
  return {
    id: date,
    ctl: 40,
    atl: 40,
    ctlLoad: 0,
    atlLoad: 0,
    ...values,
  } as IntervalsWellness;
}

describe("loadWellnessFitnessSeries", () => {
  it("reads ctl/atl directly rather than recomputing them", async () => {
    // No recurrence could produce this exact jump from these loads; only a
    // direct read reproduces it.
    mockedWellness.mockResolvedValueOnce([
      row("2026-06-27", { ctl: 20, atl: 90, ctlLoad: 10, atlLoad: 500 }),
      row("2026-06-28", { ctl: 77.3, atl: 12.1, ctlLoad: 500, atlLoad: 10 }),
    ]);

    const result = await loadWellnessFitnessSeries("key", {
      oldest: "2026-06-27",
      newest: "2026-06-28",
    });

    expect(result.series).toEqual([
      { date: "2026-06-27", load: 500, ctl: 20, atl: 90, tsb: -70 },
      { date: "2026-06-28", load: 10, ctl: 77.3, atl: 12.1, tsb: 65.2 },
    ]);
    expect(result.seed).toEqual({ ctl: 77.3, atl: 12.1 });
    expect(result.asOfDate).toBe("2026-06-28");
    expect(result.gapDates).toEqual([]);
    expect(mockedWellness).toHaveBeenCalledWith(
      "key",
      { oldest: "2026-06-27", newest: "2026-06-28" },
      { fields: FITNESS_TREND_WELLNESS_FIELDS },
    );
  });

  it("treats a missing or null-ctl/atl day as a gap, not a zero-load day", async () => {
    mockedWellness.mockResolvedValueOnce([
      row("2026-06-26", { ctl: 40, atl: 45 }),
      row("2026-06-27", { ctl: null, atl: null }), // partial-day wellness row
      // 2026-06-28 missing from the response entirely.
    ]);

    const result = await loadWellnessFitnessSeries("key", {
      oldest: "2026-06-26",
      newest: "2026-06-28",
    });

    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.date).toBe("2026-06-26");
    expect(result.seed).toEqual({ ctl: 40, atl: 45 });
    expect(result.asOfDate).toBe("2026-06-26");
    expect(result.gapDates).toEqual(["2026-06-27", "2026-06-28"]);
  });

  it("returns a null seed/as-of for a window with no usable wellness at all", async () => {
    mockedWellness.mockResolvedValueOnce([]);

    const result = await loadWellnessFitnessSeries("key", {
      oldest: "2026-06-26",
      newest: "2026-06-28",
    });

    expect(result.series).toEqual([]);
    expect(result.seed).toBeNull();
    expect(result.asOfDate).toBeNull();
    expect(result.gapDates).toEqual(["2026-06-26", "2026-06-27", "2026-06-28"]);
  });
});
