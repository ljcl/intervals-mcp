import { describe, expect, it } from "vitest";
import {
  buildOverlayA11y,
  buildScatterA11y,
  buildTrendA11y,
  buildZonesA11y,
} from "./a11y";
import { type RunSummary } from "./types";

function run(overrides: Partial<RunSummary>): RunSummary {
  return {
    id: "1",
    name: "Morning Run",
    date: "2026-03-02T07:00:00Z",
    distance: 8,
    duration: 2700,
    averageCadence: 170,
    averagePace: 5.4,
    type: "Run",
    ...overrides,
  };
}

const runs: RunSummary[] = [
  run({
    id: "1",
    date: "2026-03-02T07:00:00Z",
    averageCadence: 164,
    averagePace: 6.1,
  }),
  run({
    id: "2",
    date: "2026-04-18T07:00:00Z",
    averageCadence: 178,
    averagePace: 4.5,
  }),
];

describe("buildTrendA11y", () => {
  it("narrates the date span, cadence range, and encodings", () => {
    const { title, desc } = buildTrendA11y(runs);
    expect(title).toBe("Cadence trend timeline");
    expect(desc).toBe(
      "2 runs from 2 Mar 2026 to 18 Apr 2026. " +
        "Average cadence ranges from 164 to 178 spm; " +
        "a line shows the 5-run rolling average. " +
        "Dot size reflects run distance. Pace dots are plotted on a secondary axis.",
    );
  });

  it("handles an empty period", () => {
    expect(buildTrendA11y([]).desc).toBe("No runs to display.");
  });
});

describe("buildScatterA11y", () => {
  it("narrates both axis ranges and the regression direction", () => {
    const { title, desc } = buildScatterA11y(runs, -1.2);
    expect(title).toBe("Cadence versus pace scatter plot");
    expect(desc).toContain(
      "2 runs plotted by average cadence against average pace.",
    );
    expect(desc).toContain("Cadence ranges from 164 to 178 spm;");
    expect(desc).toContain("pace between 4'30\" and 6'06\" min/km.");
    expect(desc).toContain("cadence increasing at faster paces");
  });

  it("flips the trend sentence for a positive slope and drops it without one", () => {
    expect(buildScatterA11y(runs, 0.8).desc).toContain(
      "cadence decreasing at faster paces",
    );
    expect(buildScatterA11y(runs, null).desc).not.toContain("trend line");
  });

  it("skips a null pace in the pace range instead of narrating a fake 0 min/km", () => {
    const withNullPace = [
      ...runs,
      run({ id: "3", averageCadence: 172, averagePace: null }),
    ];
    const { desc } = buildScatterA11y(withNullPace, null);
    // Range stays bounded by the real values; a null would otherwise widen
    // it toward 0.
    expect(desc).toContain("pace between 4'30\" and 6'06\" min/km.");
  });
});

describe("buildZonesA11y", () => {
  it("narrates each zone bar with its count and range", () => {
    const { title, desc } = buildZonesA11y([
      { zone: "Easy", mean: 165.4, min: 158, max: 172, count: 12 },
      { zone: "Tempo", mean: 174, min: 170, max: 179, count: 1 },
    ]);
    expect(title).toBe("Average cadence by pace zone");
    expect(desc).toContain(
      "Easy: 165 spm average across 12 runs (158 to 172).",
    );
    expect(desc).toContain("Tempo: 174 spm average across 1 run (170 to 179).");
  });
});

describe("buildOverlayA11y", () => {
  it("names the compared runs and the x-axis mode", () => {
    const { desc } = buildOverlayA11y(
      [
        { name: "Tempo Tuesday", date: "2026-03-02T07:00:00Z" },
        { name: "Long Run", date: "2026-04-18T07:00:00Z" },
      ],
      "distance",
    );
    expect(desc).toBe(
      "Cadence in spm compared by distance in km for 2 runs: " +
        '"Tempo Tuesday" (2 Mar 2026), "Long Run" (18 Apr 2026).',
    );
  });

  it("describes the time axis and the empty state", () => {
    expect(
      buildOverlayA11y([{ name: "A", date: "2026-01-05T00:00:00Z" }], "time")
        .desc,
    ).toContain("over elapsed time in minutes for 1 run:");
    expect(buildOverlayA11y([], "distance").desc).toBe("No runs selected.");
  });
});
