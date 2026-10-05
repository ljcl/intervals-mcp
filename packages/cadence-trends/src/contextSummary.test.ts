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

  it("dates runs that share a name so they can be told apart", () => {
    const text = buildCadenceContextSummary({
      weeks: 6,
      activeView: "overlay",
      selectedRuns: [
        run({
          id: "1",
          name: "Long Run",
          date: "2026-01-11",
          averageCadence: 168,
        }),
        run({
          id: "2",
          name: "Long Run",
          date: "2026-01-25",
          averageCadence: 170,
        }),
        run({
          id: "3",
          name: "Tempo",
          date: "2026-01-09",
          averageCadence: 172,
        }),
      ],
    });
    expect(text).toBe(
      "Cadence trends, last 6 weeks. View: per-run overlay. Comparing: Long Run · 11 Jan 26 (168 spm), Long Run · 25 Jan 26 (170 spm), Tempo (172 spm).",
    );
  });

  it("reports the overlay x-axis while the overlay shows", () => {
    expect(
      buildCadenceContextSummary({
        weeks: 6,
        activeView: "overlay",
        selectedRuns: [
          run({ id: "1", name: "Tempo Run", averageCadence: 181 }),
        ],
        overlayAxis: "time",
      }),
    ).toBe(
      "Cadence trends, last 6 weeks. View: per-run overlay. Overlay x-axis: time. Comparing: Tempo Run (181 spm).",
    );
  });

  it("leaves the overlay x-axis out of every other view", () => {
    expect(
      buildCadenceContextSummary({
        weeks: 6,
        activeView: "scatter",
        selectedRuns: [],
        overlayAxis: "distance",
      }),
    ).not.toContain("x-axis");
  });

  it("mentions runs excluded for missing cadence", () => {
    const text = buildCadenceContextSummary({
      weeks: 6,
      activeView: "trend",
      selectedRuns: [],
      excludedNoCadence: 3,
    });
    expect(text).toBe(
      "Cadence trends, last 6 weeks. View: trend timeline. No runs selected for comparison. 3 runs with no recorded cadence excluded.",
    );
  });

  it("uses the singular form for one exclusion and omits it entirely for zero", () => {
    expect(
      buildCadenceContextSummary({
        weeks: 6,
        activeView: "trend",
        selectedRuns: [],
        excludedNoCadence: 1,
      }),
    ).toContain("1 run with no recorded cadence excluded.");

    expect(
      buildCadenceContextSummary({
        weeks: 6,
        activeView: "trend",
        selectedRuns: [],
        excludedNoCadence: 0,
      }),
    ).not.toContain("excluded");
  });

  it("mentions runs excluded from pace-based views for missing pace", () => {
    const text = buildCadenceContextSummary({
      weeks: 6,
      activeView: "scatter",
      selectedRuns: [],
      noPaceCount: 2,
    });
    expect(text).toBe(
      "Cadence trends, last 6 weeks. View: cadence vs pace scatter. No runs selected for comparison. 2 runs with no recorded pace excluded from pace-based views.",
    );
  });

  it("uses the singular form for one no-pace run and omits it entirely for zero", () => {
    expect(
      buildCadenceContextSummary({
        weeks: 6,
        activeView: "trend",
        selectedRuns: [],
        noPaceCount: 1,
      }),
    ).toContain("1 run with no recorded pace excluded from pace-based views.");

    expect(
      buildCadenceContextSummary({
        weeks: 6,
        activeView: "trend",
        selectedRuns: [],
        noPaceCount: 0,
      }),
    ).not.toContain("no recorded pace");
  });
});
