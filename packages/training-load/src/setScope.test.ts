import { describe, expect, it } from "vitest";
import {
  mockRunOnlyTrainingLoadData,
  mockTrainingLoadData,
} from "./__fixtures__/weeks";
import {
  describeSetScope,
  hasWarningWeeks,
  hiddenSeriesNames,
  type Landing,
  landingFor,
  resolveSetScope,
  type Scope,
  type SeriesVisibility,
} from "./setScope";
import { type TrainingLoadData } from "./types";

const allShown: SeriesVisibility = {
  trend: true,
  load: true,
  warnings: true,
};

const drawn = (scope: Scope): Landing => ({ scope, status: "drawn" });
const loading = (scope: Scope): Landing => ({ scope, status: "loading" });
const empty = (scope: Scope): Landing => ({ scope, status: "empty" });

const noRuns: TrainingLoadData = { ...mockTrainingLoadData, weeks: [] };
const noWarnings: TrainingLoadData = {
  ...mockTrainingLoadData,
  weeks: mockTrainingLoadData.weeks.map((week) => ({
    ...week,
    warning: false,
    warningReasons: [],
  })),
};

describe("resolveSetScope", () => {
  it("switches scope and applies show/hide", () => {
    expect(resolveSetScope({ scope: "runOnly", hide: ["load"] }, true)).toEqual(
      { kind: "ok", scope: "runOnly", visible: { load: false } },
    );
  });

  it("shows what show names and hides what hide names, leaving the rest", () => {
    expect(
      resolveSetScope({ show: ["trend", "warnings"], hide: ["load"] }, true),
    ).toEqual({
      kind: "ok",
      scope: undefined,
      visible: { trend: true, warnings: true, load: false },
    });
  });

  it("accepts a series list on its own, leaving the scope alone", () => {
    const result = resolveSetScope({ hide: ["trend"] }, true);
    expect(result).toMatchObject({ kind: "ok", visible: { trend: false } });
    expect((result as { scope?: string }).scope).toBeUndefined();
  });

  it("accepts the scope on its own", () => {
    expect(resolveSetScope({ scope: "wholeBody" }, true)).toEqual({
      kind: "ok",
      scope: "wholeBody",
      visible: {},
    });
  });

  it("names a series repeated in one list once", () => {
    expect(resolveSetScope({ hide: ["load", "load"] }, true)).toEqual({
      kind: "ok",
      scope: undefined,
      visible: { load: false },
    });
  });

  it("rejects a series both shown and hidden, naming it by its value", () => {
    expect(resolveSetScope({ show: ["load"], hide: ["load"] }, true)).toEqual({
      kind: "error",
      text: "Cannot both show and hide load.",
    });
  });

  it("names every series that is both shown and hidden, in legend order", () => {
    expect(
      resolveSetScope(
        { show: ["warnings", "trend", "load"], hide: ["load", "trend"] },
        true,
      ),
    ).toEqual({
      kind: "error",
      text: "Cannot both show and hide trend, load.",
    });
  });

  it("changes nothing when one part is bad, even if the scope is fine", () => {
    expect(
      resolveSetScope(
        { scope: "runOnly", show: ["trend"], hide: ["trend"] },
        true,
      ),
    ).toMatchObject({ kind: "error" });
  });

  it("rejects warnings when no week is flagged, whether shown or hidden", () => {
    const text =
      "No week in this window is flagged as a volume spike, so there are no warnings to show or hide.";
    expect(resolveSetScope({ show: ["warnings"] }, false)).toEqual({
      kind: "error",
      text,
    });
    expect(resolveSetScope({ hide: ["warnings"] }, false)).toEqual({
      kind: "error",
      text,
    });
  });

  it("accepts the other series when no week is flagged", () => {
    expect(resolveSetScope({ hide: ["trend", "load"] }, false)).toMatchObject({
      kind: "ok",
    });
  });

  it("reports a conflict and missing warnings together", () => {
    const r = resolveSetScope(
      { show: ["load", "warnings"], hide: ["load"] },
      false,
    );
    expect(r).toMatchObject({ kind: "error" });
    const { text } = r as { text: string };
    expect(text).toContain("Cannot both show and hide load.");
    expect(text).toContain("no warnings to show or hide");
  });

  it("needs an argument, naming the values it accepts", () => {
    const expected = {
      kind: "error",
      text: "Pass scope (wholeBody or runOnly), or name series (trend, load, warnings) in show or hide.",
    };
    expect(resolveSetScope({}, true)).toEqual(expected);
    // Empty lists name nothing, so they are no more an instruction.
    expect(resolveSetScope({ show: [], hide: [] }, true)).toEqual(expected);
  });

  describe("against what the landing scope is rendering", () => {
    const text =
      "Runs only has no runs in this period, so there is no chart to show or hide series on. Nothing was changed.";

    it("refuses a series change when the landing scope has no chart", () => {
      expect(
        resolveSetScope({ show: ["trend"] }, true, empty("runOnly")),
      ).toEqual({ kind: "error", text });
    });

    it("refuses the whole call, scope included, naming the landing scope", () => {
      expect(
        resolveSetScope(
          { scope: "runOnly", hide: ["load"] },
          true,
          empty("runOnly"),
        ),
      ).toEqual({ kind: "error", text });
      expect(
        resolveSetScope({ hide: ["load"] }, true, empty("wholeBody")),
      ).toMatchObject({ text: expect.stringMatching(/^Whole body has no/) });
    });

    it("accepts a scope on its own, since the tiles still change with it", () => {
      expect(
        resolveSetScope({ scope: "runOnly" }, true, empty("runOnly")),
      ).toEqual({ kind: "ok", scope: "runOnly", visible: {} });
    });

    it("asks for an argument before it reports a missing chart", () => {
      expect(resolveSetScope({}, true, empty("wholeBody"))).toMatchObject({
        text: expect.stringContaining("Pass scope"),
      });
    });

    it("applies a change to a scope that is still loading, or failed to load", () => {
      expect(
        resolveSetScope(
          { scope: "runOnly", hide: ["load"] },
          true,
          loading("runOnly"),
        ),
      ).toEqual({ kind: "ok", scope: "runOnly", visible: { load: false } });
      expect(
        resolveSetScope({ hide: ["load"] }, true, {
          scope: "runOnly",
          status: "failed",
          error: "timed out",
        }),
      ).toMatchObject({ kind: "ok" });
    });
  });
});

describe("hiddenSeriesNames", () => {
  it("lists the hidden series in legend order by the value the tool accepts", () => {
    expect(
      hiddenSeriesNames({ trend: false, load: true, warnings: false }, true),
    ).toEqual(["trend", "warnings"]);
  });

  it("is empty when nothing is hidden", () => {
    expect(hiddenSeriesNames(allShown, true)).toEqual([]);
  });

  it("does not list warnings the chart has none of", () => {
    expect(hiddenSeriesNames({ ...allShown, warnings: false }, false)).toEqual(
      [],
    );
  });
});

describe("hasWarningWeeks", () => {
  it("finds the flagged week in the fixture", () => {
    expect(hasWarningWeeks(mockTrainingLoadData)).toBe(true);
  });

  it("finds none when no week is flagged", () => {
    expect(hasWarningWeeks(noWarnings)).toBe(false);
  });

  it("cannot rule warnings out for data that has not loaded", () => {
    expect(hasWarningWeeks(null)).toBe(true);
  });
});

describe("landingFor", () => {
  it("draws loaded data that has weeks", () => {
    expect(landingFor("wholeBody", mockTrainingLoadData, null)).toEqual({
      scope: "wholeBody",
      status: "drawn",
    });
    expect(landingFor("runOnly", mockRunOnlyTrainingLoadData, null)).toEqual({
      scope: "runOnly",
      status: "drawn",
    });
  });

  it("finds no chart when the period has no runs", () => {
    expect(landingFor("wholeBody", noRuns, null)).toEqual({
      scope: "wholeBody",
      status: "empty",
    });
  });

  it("is loading while there is neither data nor an error", () => {
    expect(landingFor("runOnly", null, null)).toEqual({
      scope: "runOnly",
      status: "loading",
    });
  });

  it("is failed once the fetch has an error, carrying it", () => {
    expect(landingFor("runOnly", null, "Error: timed out")).toEqual({
      scope: "runOnly",
      status: "failed",
      error: "Error: timed out",
    });
  });
});

describe("describeSetScope", () => {
  it("names the scope and what is hidden", () => {
    expect(
      describeSetScope(drawn("runOnly"), { ...allShown, load: false }, true),
    ).toBe("Showing runs only. Hidden: load.");
  });

  it("says nothing is hidden when every series shows", () => {
    expect(describeSetScope(drawn("wholeBody"), allShown, true)).toBe(
      "Showing whole body. Nothing hidden.",
    );
  });

  it("lists several hidden series in legend order", () => {
    expect(
      describeSetScope(
        drawn("wholeBody"),
        { trend: false, load: false, warnings: false },
        true,
      ),
    ).toBe("Showing whole body. Hidden: trend, load, warnings.");
  });

  it("does not report hidden warnings that the chart does not have", () => {
    expect(
      describeSetScope(
        drawn("runOnly"),
        { ...allShown, warnings: false },
        false,
      ),
    ).toBe("Showing runs only. Nothing hidden.");
  });

  it("says there is no chart for a scope with no runs, and no legend to report", () => {
    expect(
      describeSetScope(empty("runOnly"), { ...allShown, load: false }, true),
    ).toBe(
      "Showing runs only: no runs in this period, so no chart is drawn, only the totals and fitness tiles.",
    );
  });

  it("does not claim to be showing a scope that is still loading", () => {
    expect(
      describeSetScope(loading("runOnly"), { ...allShown, load: false }, true),
    ).toBe("Switching to runs only; it is still loading. Hidden: load.");
    expect(describeSetScope(loading("wholeBody"), allShown, true)).toBe(
      "Switching to whole body; it is still loading. Nothing hidden.",
    );
  });

  it("says a scope failed to load, with the error the card shows", () => {
    expect(
      describeSetScope(
        {
          scope: "runOnly",
          status: "failed",
          error: "Error: MCP error -32001: Request timed out",
        },
        { ...allShown, trend: false },
        true,
      ),
    ).toBe(
      "Runs only failed to load: MCP error -32001: Request timed out. The card shows the error with a retry. Hidden: trend.",
    );
  });

  it("does not double the full stop an error already ends with", () => {
    expect(
      describeSetScope(
        { scope: "wholeBody", status: "failed", error: "Not connected." },
        allShown,
        true,
      ),
    ).toBe(
      "Whole body failed to load: Not connected. The card shows the error with a retry. Nothing hidden.",
    );
  });
});
