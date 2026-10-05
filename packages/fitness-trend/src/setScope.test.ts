import { describe, expect, it } from "vitest";
import {
  mockFitnessTrendData,
  mockRestProjectionData,
} from "./__fixtures__/trend";
import {
  describeSetScope,
  hiddenSeriesNames,
  planInfo,
  resolveSetScope,
  type SeriesVisibility,
} from "./setScope";

const allShown: SeriesVisibility = {
  fitness: true,
  fatigue: true,
  form: true,
  plan: true,
};

describe("resolveSetScope", () => {
  it("switches scope and applies show/hide", () => {
    expect(
      resolveSetScope(
        { scope: "runOnly", hide: ["fatigue"] },
        { hasPlan: true },
      ),
    ).toEqual({
      kind: "ok",
      scope: "runOnly",
      visible: { fatigue: false },
    });
  });

  it("shows what show names and hides what hide names, leaving the rest", () => {
    expect(
      resolveSetScope(
        { show: ["fitness", "plan"], hide: ["form"] },
        { hasPlan: true },
      ),
    ).toEqual({
      kind: "ok",
      scope: undefined,
      visible: { fitness: true, plan: true, form: false },
    });
  });

  it("accepts a series list on its own, leaving the scope alone", () => {
    const result = resolveSetScope({ hide: ["fatigue"] }, { hasPlan: true });
    expect(result).toMatchObject({ kind: "ok", visible: { fatigue: false } });
    expect((result as { scope?: string }).scope).toBeUndefined();
  });

  it("accepts the scope on its own", () => {
    expect(resolveSetScope({ scope: "wholeBody" }, { hasPlan: true })).toEqual({
      kind: "ok",
      scope: "wholeBody",
      visible: {},
    });
  });

  it("rejects a series both shown and hidden, naming it by its value", () => {
    expect(
      resolveSetScope({ show: ["form"], hide: ["form"] }, { hasPlan: true }),
    ).toEqual({ kind: "error", text: "Cannot both show and hide form." });
  });

  it("names every series that is both shown and hidden", () => {
    expect(
      resolveSetScope(
        { show: ["fitness", "form", "fatigue"], hide: ["fatigue", "fitness"] },
        { hasPlan: true },
      ),
    ).toEqual({
      kind: "error",
      text: "Cannot both show and hide fitness, fatigue.",
    });
  });

  it("changes nothing when one part is bad, even if the scope is fine", () => {
    expect(
      resolveSetScope(
        { scope: "runOnly", show: ["form"], hide: ["form"] },
        { hasPlan: true },
      ),
    ).toMatchObject({ kind: "error" });
  });

  it("rejects the plan when there is none, whether shown or hidden", () => {
    const text =
      "This chart has no plan (neither a taper plan nor a rest projection) to show or hide.";
    expect(resolveSetScope({ show: ["plan"] }, { hasPlan: false })).toEqual({
      kind: "error",
      text,
    });
    expect(resolveSetScope({ hide: ["plan"] }, { hasPlan: false })).toEqual({
      kind: "error",
      text,
    });
  });

  it("accepts the other series when there is no plan", () => {
    expect(
      resolveSetScope({ hide: ["fatigue", "form"] }, { hasPlan: false }),
    ).toMatchObject({ kind: "ok" });
  });

  it("reports a conflict and a missing plan together", () => {
    const r = resolveSetScope(
      { show: ["form", "plan"], hide: ["form"] },
      { hasPlan: false },
    );
    expect(r).toMatchObject({ kind: "error" });
    const { text } = r as { text: string };
    expect(text).toContain("Cannot both show and hide form.");
    expect(text).toContain("no plan");
  });

  it("needs an argument, naming the values it accepts", () => {
    const expected = {
      kind: "error",
      text: "Pass scope (wholeBody or runOnly), or name series (fitness, fatigue, form, plan) in show or hide.",
    };
    expect(resolveSetScope({}, { hasPlan: true })).toEqual(expected);
    // Empty lists name nothing, so they are no more an instruction.
    expect(resolveSetScope({ show: [], hide: [] }, { hasPlan: true })).toEqual(
      expected,
    );
  });
});

describe("hiddenSeriesNames", () => {
  it("lists the hidden series in chart order by the value the tool accepts", () => {
    expect(
      hiddenSeriesNames(
        { fitness: true, fatigue: false, form: false, plan: true },
        { hasPlan: true },
      ),
    ).toEqual(["fatigue", "form"]);
  });

  it("is empty when nothing is hidden", () => {
    expect(hiddenSeriesNames(allShown, { hasPlan: true })).toEqual([]);
  });

  it("notes what the legend calls the plan, as it differs from the value", () => {
    expect(
      hiddenSeriesNames(
        { ...allShown, plan: false },
        { hasPlan: true, label: "rest projection" },
      ),
    ).toEqual(["plan (rest projection)"]);
  });

  it("does not list a plan that does not exist", () => {
    expect(
      hiddenSeriesNames({ ...allShown, plan: false }, { hasPlan: false }),
    ).toEqual([]);
  });
});

describe("planInfo", () => {
  it("calls a solved taper the taper plan", () => {
    expect(planInfo(mockFitnessTrendData)).toEqual({
      hasPlan: true,
      label: "taper plan",
    });
  });

  it("calls an unsolved forward half the rest projection", () => {
    expect(planInfo(mockRestProjectionData)).toEqual({
      hasPlan: true,
      label: "rest projection",
    });
  });

  it("finds no plan when neither forward half has rows", () => {
    expect(
      planInfo({ ...mockRestProjectionData, projection: [], taper: null }),
    ).toEqual({ hasPlan: false });
  });

  it("cannot rule a plan out for data that has not loaded", () => {
    expect(planInfo(null)).toEqual({ hasPlan: true });
  });
});

describe("describeSetScope", () => {
  it("names the scope and what is hidden", () => {
    expect(
      describeSetScope(
        "runOnly",
        { ...allShown, fatigue: false },
        { hasPlan: true },
      ),
    ).toBe("Showing runs only. Hidden: fatigue.");
  });

  it("says nothing is hidden when every series shows", () => {
    expect(describeSetScope("wholeBody", allShown, { hasPlan: true })).toBe(
      "Showing whole body. Nothing hidden.",
    );
  });

  it("lists several hidden series, noting the plan's legend name", () => {
    expect(
      describeSetScope(
        "wholeBody",
        { fitness: true, fatigue: false, form: false, plan: false },
        { hasPlan: true, label: "taper plan" },
      ),
    ).toBe("Showing whole body. Hidden: fatigue, form, plan (taper plan).");
  });

  it("does not report a hidden plan that the chart does not have", () => {
    expect(
      describeSetScope(
        "runOnly",
        { ...allShown, plan: false },
        { hasPlan: false },
      ),
    ).toBe("Showing runs only. Nothing hidden.");
  });
});
