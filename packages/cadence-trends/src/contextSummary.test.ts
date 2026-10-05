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
  it("names a window that is not whole weeks in days", () => {
    expect(
      buildCadenceContextSummary({
        days: 30,
        activeView: "trend",
        selectedRuns: [],
      }),
    ).toBe(
      "Cadence trends, last 30 days. View: trend timeline. No runs selected for comparison.",
    );
  });

  it("says 1 week for 7 days", () => {
    expect(
      buildCadenceContextSummary({
        days: 7,
        activeView: "trend",
        selectedRuns: [],
      }),
    ).toMatch(/^Cadence trends, last 1 week\. /);
  });

  it("notes when no runs are selected", () => {
    expect(
      buildCadenceContextSummary({
        days: 42,
        activeView: "trend",
        selectedRuns: [],
      }),
    ).toBe(
      "Cadence trends, last 6 weeks. View: trend timeline. No runs selected for comparison.",
    );
  });

  it("lists selected runs with rounded cadence", () => {
    const text = buildCadenceContextSummary({
      days: 42,
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
      days: 42,
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
      overlayStatus: new Map([
        ["1", "drawn"],
        ["2", "drawn"],
        ["3", "drawn"],
      ]),
    });
    expect(text).toBe(
      "Cadence trends, last 6 weeks. View: per-run overlay. Comparing: Long Run · 11 Jan 26 (168 spm), Long Run · 25 Jan 26 (170 spm), Tempo (172 spm).",
    );
  });

  it("reports the overlay x-axis while the overlay shows", () => {
    expect(
      buildCadenceContextSummary({
        days: 42,
        activeView: "overlay",
        selectedRuns: [
          run({ id: "1", name: "Tempo Run", averageCadence: 181 }),
        ],
        overlayAxis: "time",
        overlayStatus: new Map([["1", "drawn"]]),
      }),
    ).toBe(
      "Cadence trends, last 6 weeks. View: per-run overlay. Overlay x-axis: time. Comparing: Tempo Run (181 spm).",
    );
  });

  it("leaves the overlay x-axis out of every other view", () => {
    expect(
      buildCadenceContextSummary({
        days: 42,
        activeView: "scatter",
        selectedRuns: [],
        overlayAxis: "distance",
      }),
    ).not.toContain("x-axis");
  });

  it("mentions runs excluded for missing cadence", () => {
    const text = buildCadenceContextSummary({
      days: 42,
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
        days: 42,
        activeView: "trend",
        selectedRuns: [],
        excludedNoCadence: 1,
      }),
    ).toContain("1 run with no recorded cadence excluded.");

    expect(
      buildCadenceContextSummary({
        days: 42,
        activeView: "trend",
        selectedRuns: [],
        excludedNoCadence: 0,
      }),
    ).not.toContain("excluded");
  });

  it("mentions runs excluded from pace-based views for missing pace", () => {
    const text = buildCadenceContextSummary({
      days: 42,
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
        days: 42,
        activeView: "trend",
        selectedRuns: [],
        noPaceCount: 1,
      }),
    ).toContain("1 run with no recorded pace excluded from pace-based views.");

    expect(
      buildCadenceContextSummary({
        days: 42,
        activeView: "trend",
        selectedRuns: [],
        noPaceCount: 0,
      }),
    ).not.toContain("no recorded pace");
  });

  describe("in the overlay, only drawn runs are compared", () => {
    const selectedRuns = [
      run({ id: "1", name: "Tempo", averageCadence: 181 }),
      run({ id: "2", name: "Long Run", averageCadence: 170 }),
      run({ id: "3", name: "Treadmill", averageCadence: 176 }),
      run({ id: "4", name: "Hills", averageCadence: 174 }),
      run({ id: "5", name: "Easy", averageCadence: 168 }),
    ];

    it("names every run by what the overlay is doing with it", () => {
      expect(
        buildCadenceContextSummary({
          days: 42,
          activeView: "overlay",
          selectedRuns,
          overlayAxis: "distance",
          overlayStatus: new Map([
            ["1", "drawn"],
            ["2", "loading"],
            ["3", "noStreams"],
            ["4", "failed"],
            ["5", "hidden"],
          ]),
        }),
      ).toBe(
        "Cadence trends, last 6 weeks. View: per-run overlay. Overlay x-axis: distance. Comparing: Tempo (181 spm). Still loading: Long Run. No recorded streams: Treadmill. Failed to load: Hills. Hidden in the legend: Easy.",
      );
    });

    it("says no run is drawn, and counts a run with no state as loading", () => {
      expect(
        buildCadenceContextSummary({
          days: 42,
          activeView: "overlay",
          selectedRuns: selectedRuns.slice(0, 2),
          overlayStatus: new Map([["2", "noStreams"]]),
        }),
      ).toBe(
        "Cadence trends, last 6 weeks. View: per-run overlay. No run is drawn in the overlay. Still loading: Tempo. No recorded streams: Long Run.",
      );
    });

    it("keeps listing the selection in the other views", () => {
      expect(
        buildCadenceContextSummary({
          days: 42,
          activeView: "trend",
          selectedRuns: selectedRuns.slice(0, 2),
          overlayStatus: new Map([["2", "loading"]]),
        }),
      ).toBe(
        "Cadence trends, last 6 weeks. View: trend timeline. Comparing: Tempo (181 spm), Long Run (170 spm).",
      );
    });
  });
});
