import { describe, expect, it } from "vitest";
import { mockRuns } from "./__fixtures__/runs";
import { describeSetView, resolveSetView } from "./setView";
import { type OverlayRunStatus } from "./types";

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

  it("accepts an id with or without the i prefix, as the server does", () => {
    expect(
      resolveSetView({ runIds: ["2", "i1"] }, runs, "trend"),
    ).toMatchObject({ kind: "ok", runIds: ["i2", "i1"] });
  });

  it("selects a run once whichever way its id is spelled", () => {
    expect(
      resolveSetView({ runIds: ["i1", "1"] }, runs, "trend"),
    ).toMatchObject({ kind: "ok", runIds: ["i1"] });
  });

  it("tells unknown ids from runs with no cadence, each named once", () => {
    expect(
      resolveSetView({ runIds: ["i9", "9", "i3", "i9", "3"] }, runs, "trend"),
    ).toEqual({
      kind: "error",
      text: 'Not runs in this chart: i9. Run ids come from list-activities (for example "i189807578") and must fall within the chart\'s weeks. No recorded cadence, so nothing to overlay: i3. Nothing was changed.',
    });
  });

  it("names only the ids that are wrong", () => {
    const r = resolveSetView({ runIds: ["i1", "i9"] }, runs, "trend");
    expect(r).toEqual({
      kind: "error",
      text: 'Not runs in this chart: i9. Run ids come from list-activities (for example "i189807578") and must fall within the chart\'s weeks. Nothing was changed.',
    });
  });

  it("reports a run with no cadence on its own", () => {
    expect(resolveSetView({ runIds: ["i3"] }, runs, "trend")).toEqual({
      kind: "error",
      text: "No recorded cadence, so nothing to overlay: i3. Nothing was changed.",
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
  const drawn = (): OverlayRunStatus => "drawn";
  const nothingSelected = {
    selectedRunIds: [],
    xAxis: "distance",
    runStatus: drawn,
  } as const;
  /** Every run drawn except the ones given. */
  const statuses =
    (byId: Record<string, OverlayRunStatus>) =>
    (id: string): OverlayRunStatus =>
      byId[id] ?? "drawn";

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
        { selectedRunIds: ["i10003"], xAxis: "distance", runStatus: drawn },
      ),
    ).toBe("Showing the overlay of Tempo Intervals by time.");
  });

  it("falls back to the current selection and axis for what was not given", () => {
    expect(
      describeSetView({ kind: "ok", view: "overlay" }, mockRuns, {
        selectedRunIds: ["i10003", "i10013"],
        xAxis: "time",
        runStatus: drawn,
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
        runStatus: drawn,
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
  const overlayOf = (runIds: string[]) =>
    ({ kind: "ok", view: "overlay", runIds }) as const;

  it("claims only the drawn runs and names the ones still loading", () => {
    expect(
      describeSetView(overlayOf(["i10004", "i10003"]), mockRuns, {
        ...nothingSelected,
        runStatus: statuses({ i10003: "loading" }),
      }),
    ).toBe(
      "Showing the overlay of Long Run by distance. Tempo Intervals is still loading.",
    );
  });

  it("says nothing is drawn while every run is loading", () => {
    expect(
      describeSetView(overlayOf(["i10004", "i10003"]), mockRuns, {
        ...nothingSelected,
        runStatus: () => "loading",
      }),
    ).toBe(
      "Showing the overlay by distance, with no run drawn. Long Run and Tempo Intervals are still loading.",
    );
  });

  it("names a run with no recorded streams", () => {
    expect(
      describeSetView(overlayOf(["i10004", "i10003"]), mockRuns, {
        ...nothingSelected,
        runStatus: statuses({ i10003: "noStreams" }),
      }),
    ).toBe(
      "Showing the overlay of Long Run by distance. Tempo Intervals has no recorded streams.",
    );
  });

  it("names a run that failed to load", () => {
    expect(
      describeSetView(overlayOf(["i10004", "i10003"]), mockRuns, {
        ...nothingSelected,
        runStatus: statuses({ i10004: "failed" }),
      }),
    ).toBe(
      "Showing the overlay of Tempo Intervals by distance. Long Run failed to load.",
    );
  });

  it("names a run the legend hides", () => {
    expect(
      describeSetView(
        { kind: "ok", view: "overlay", xAxis: "time" },
        mockRuns,
        {
          selectedRunIds: ["i10004", "i10003"],
          xAxis: "distance",
          runStatus: statuses({ i10003: "hidden" }),
        },
      ),
    ).toBe(
      "Showing the overlay of Long Run by time. Tempo Intervals is hidden in the legend.",
    );
  });

  it("groups several runs per state, in selection order", () => {
    expect(
      describeSetView(
        overlayOf(["i10003", "i10004", "i10006", "i10013"]),
        mockRuns,
        {
          ...nothingSelected,
          runStatus: statuses({
            i10003: "noStreams",
            i10004: "loading",
            i10006: "noStreams",
            i10013: "loading",
          }),
        },
      ),
    ).toBe(
      "Showing the overlay by distance, with no run drawn. Long Run and Intervals 5x1k are still loading. Tempo Intervals and Threshold Run have no recorded streams.",
    );
  });
});
