import { describe, expect, it } from "vitest";
import { mockRuns } from "./__fixtures__/runs";
import { describeSetView, resolveSetView } from "./setView";

const runs = [
  { id: "i1", name: "Long Run", date: "2026-01-11", averageCadence: 170 },
  { id: "i2", name: "Tempo", date: "2026-01-13", averageCadence: 176 },
  { id: "i3", name: "Treadmill", date: "2026-01-14", averageCadence: 0 },
];

describe("resolveSetView", () => {
  it("replaces the selection and switches to overlay", () => {
    expect(resolveSetView({ runIds: ["i2", "i1"] }, runs, "trend")).toEqual({
      kind: "ok",
      view: "overlay",
      runIds: ["i2", "i1"],
      xAxis: undefined,
    });
  });

  it("keeps the requested view when given", () => {
    expect(resolveSetView({ view: "scatter" }, runs, "trend")).toMatchObject({
      kind: "ok",
      view: "scatter",
    });
  });

  it("keeps the requested view even when it is given with runs", () => {
    expect(
      resolveSetView({ view: "trend", runIds: ["i1"] }, runs, "overlay"),
    ).toMatchObject({ kind: "ok", view: "trend", runIds: ["i1"] });
  });

  it("switches to overlay for an axis alone, since that is where the axis shows", () => {
    expect(resolveSetView({ xAxis: "time" }, runs, "trend")).toMatchObject({
      kind: "ok",
      view: "overlay",
      xAxis: "time",
    });
  });

  it("keeps a requested view alongside an axis", () => {
    expect(
      resolveSetView({ view: "scatter", xAxis: "time" }, runs, "trend"),
    ).toMatchObject({ kind: "ok", view: "scatter", xAxis: "time" });
  });

  it("clears the selection for an empty list without leaving the view", () => {
    expect(resolveSetView({ runIds: [] }, runs, "trend")).toEqual({
      kind: "ok",
      view: "trend",
      runIds: [],
      xAxis: undefined,
    });
  });

  it("selects a run once however many times it is named", () => {
    expect(
      resolveSetView({ runIds: ["i1", "i2", "i1"] }, runs, "trend"),
    ).toMatchObject({ kind: "ok", runIds: ["i1", "i2"] });
  });

  it("rejects ids that are unknown or have no cadence", () => {
    const r = resolveSetView({ runIds: ["i9", "i3"] }, runs, "trend");
    expect(r).toMatchObject({ kind: "error" });
    expect((r as { text: string }).text).toContain("i9");
    expect((r as { text: string }).text).toContain("i3");
  });

  it("names only the ids that are wrong", () => {
    const r = resolveSetView({ runIds: ["i1", "i9"] }, runs, "trend");
    expect(r).toEqual({
      kind: "error",
      text: "These runs are not in this chart or have no cadence: i9.",
    });
  });

  it("needs at least one argument", () => {
    expect(resolveSetView({}, runs, "trend")).toEqual({
      kind: "error",
      text: "Pass view, runIds or xAxis.",
    });
  });
});

describe("describeSetView", () => {
  const nothingSelected = { selectedRunIds: [], xAxis: "distance" } as const;

  it("names the runs in the order they were given, and the axis", () => {
    expect(
      describeSetView(
        {
          kind: "ok",
          view: "overlay",
          runIds: ["i10004", "i10003"],
          xAxis: "distance",
        },
        mockRuns,
        nothingSelected,
      ),
    ).toBe("Showing the overlay of Long Run and Tempo Intervals by distance.");
  });

  it("dates runs that share a name, as the overlay legend does", () => {
    expect(
      describeSetView(
        { kind: "ok", view: "overlay", runIds: ["i10004", "i10009"] },
        mockRuns,
        nothingSelected,
      ),
    ).toBe(
      "Showing the overlay of Long Run · 11 Jan 26 and Long Run · 25 Jan 26 by distance.",
    );
  });

  it("lists three or more runs with commas", () => {
    expect(
      describeSetView(
        {
          kind: "ok",
          view: "overlay",
          runIds: ["i10003", "i10004", "i10006"],
        },
        mockRuns,
        nothingSelected,
      ),
    ).toBe(
      "Showing the overlay of Tempo Intervals, Long Run and Threshold Run by distance.",
    );
  });

  it("describes the overlay as it will be when only the axis changes", () => {
    expect(
      describeSetView(
        { kind: "ok", view: "overlay", xAxis: "time" },
        mockRuns,
        { selectedRunIds: ["i10003"], xAxis: "distance" },
      ),
    ).toBe("Showing the overlay of Tempo Intervals by time.");
  });

  it("falls back to the current selection and axis for what was not given", () => {
    expect(
      describeSetView({ kind: "ok", view: "overlay" }, mockRuns, {
        selectedRunIds: ["i10003", "i10013"],
        xAxis: "time",
      }),
    ).toBe(
      "Showing the overlay of Tempo Intervals and Intervals 5x1k by time.",
    );
  });

  it("says so when the overlay has no runs", () => {
    expect(
      describeSetView(
        { kind: "ok", view: "overlay" },
        mockRuns,
        nothingSelected,
      ),
    ).toBe("Showing the overlay by distance, with no runs selected.");
  });

  it.each([
    ["trend", "Showing the trend timeline."],
    ["scatter", "Showing the cadence vs pace scatter."],
    ["zones", "Showing the pace zones."],
  ] as const)("names the %s view", (view, text) => {
    expect(
      describeSetView({ kind: "ok", view }, mockRuns, nothingSelected),
    ).toBe(text);
  });

  it("reports a selection made while another view shows", () => {
    expect(
      describeSetView(
        { kind: "ok", view: "trend", runIds: ["i10003", "i10013"] },
        mockRuns,
        nothingSelected,
      ),
    ).toBe(
      "Showing the trend timeline. Selected Tempo Intervals and Intervals 5x1k for the overlay.",
    );
  });

  it("reports a cleared selection", () => {
    expect(
      describeSetView({ kind: "ok", view: "trend", runIds: [] }, mockRuns, {
        selectedRunIds: ["i10003"],
        xAxis: "distance",
      }),
    ).toBe("Showing the trend timeline. Cleared the overlay selection.");
  });

  it("reports an axis chosen while another view shows", () => {
    expect(
      describeSetView(
        { kind: "ok", view: "zones", xAxis: "time" },
        mockRuns,
        nothingSelected,
      ),
    ).toBe("Showing the pace zones. The overlay x-axis is now time.");
  });
});
