import { describe, expect, it } from "vitest";
import { buildCadenceContextSummary } from "./contextSummary";
import { type RunSummary } from "./types";

const run = (over: Partial<RunSummary>): RunSummary => ({
  id: "1",
  name: "Run",
  date: "2026-05-01",
  distance: 10000,
  duration: 3000,
  averageCadence: 180,
  averagePace: 300,
  type: "Run",
  ...over,
});

describe("buildCadenceContextSummary", () => {
  it("notes when no runs are selected", () => {
    expect(
      buildCadenceContextSummary({
        weeks: 6,
        activeView: "trend",
        selectedRuns: [],
      }),
    ).toBe(
      "Cadence trends, last 6 weeks. View: trend timeline. No runs selected for comparison.",
    );
  });

  it("lists selected runs with rounded cadence", () => {
    const text = buildCadenceContextSummary({
      weeks: 6,
      activeView: "scatter",
      selectedRuns: [
        run({ id: "1", name: "Tempo Run", averageCadence: 181.6 }),
        run({ id: "2", name: "Long Run", averageCadence: 175.9 }),
      ],
    });
    expect(text).toBe(
      "Cadence trends, last 6 weeks. View: cadence vs pace scatter. Comparing: Tempo Run (182 spm), Long Run (176 spm).",
    );
  });
});
