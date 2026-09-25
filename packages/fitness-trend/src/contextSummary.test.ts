import { describe, expect, it } from "vitest";
import {
  mockFitnessTrendData,
  mockRestProjectionData,
} from "./__fixtures__/trend";
import { buildFitnessTrendContextSummary } from "./contextSummary";

describe("buildFitnessTrendContextSummary", () => {
  it("states the window, today's values, and the plan", () => {
    const summary = buildFitnessTrendContextSummary(mockFitnessTrendData)!;
    const current = mockFitnessTrendData.current!;
    const taper = mockFitnessTrendData.taper!;

    expect(summary).toContain("Fitness trend, last 90 days.");
    expect(summary).toContain(`On ${current.date}:`);
    expect(summary).toContain(`fitness (CTL) ${current.ctl}`);
    expect(summary).toContain(`Taper plan of ${taper.weeks.length} weeks`);
    expect(summary).toContain(`to ${taper.targetDate}`);
    expect(summary).toContain("landing on +12");
  });

  it("passes the flags through so the model can talk about them", () => {
    const summary = buildFitnessTrendContextSummary(mockFitnessTrendData)!;
    expect(summary).toContain(mockFitnessTrendData.flags[0]!);
  });

  it("reports the rest projection and fresh date instead when untapered", () => {
    const summary = buildFitnessTrendContextSummary(mockRestProjectionData)!;
    expect(summary).toContain("Rest projection to");
    expect(summary).toContain(
      `form turns positive on ${mockRestProjectionData.tsbPositiveDate}`,
    );
    expect(summary).not.toContain("Taper plan");
  });

  it("names the landing form when rest never turns form positive", () => {
    const summary = buildFitnessTrendContextSummary({
      ...mockRestProjectionData,
      tsbPositiveDate: null,
    })!;
    expect(summary).toContain("reaching form");
  });

  it("carries an infeasible plan's note", () => {
    const summary = buildFitnessTrendContextSummary({
      ...mockFitnessTrendData,
      taper: {
        ...mockFitnessTrendData.taper!,
        feasible: false,
        note: "Even complete rest only reaches TSB +2.",
      },
    })!;
    expect(summary).toContain("Even complete rest only reaches TSB +2.");
  });

  it("mentions activities that contributed no load", () => {
    const summary = buildFitnessTrendContextSummary({
      ...mockFitnessTrendData,
      activitiesMissingLoad: 4,
    })!;
    expect(summary).toContain("4 of");
    expect(summary).toContain("no training load recorded");
  });

  it("says nothing without a current day", () => {
    expect(
      buildFitnessTrendContextSummary({
        ...mockFitnessTrendData,
        current: null,
      }),
    ).toBeNull();
  });

  it("notes the absence of flags", () => {
    const summary = buildFitnessTrendContextSummary({
      ...mockFitnessTrendData,
      flags: [],
    })!;
    expect(summary).toContain("No fatigue or ramp flags.");
  });

  it("passes warnings through so the model can talk about them", () => {
    const summary = buildFitnessTrendContextSummary({
      ...mockFitnessTrendData,
      warnings: [
        "plannedLoads is ignored: a targetDate taper plan is solved instead.",
      ],
    })!;
    expect(summary).toContain(
      "Notes: plannedLoads is ignored: a targetDate taper plan is solved instead.",
    );
  });

  it("says nothing about warnings when there are none", () => {
    const summary = buildFitnessTrendContextSummary({
      ...mockFitnessTrendData,
      warnings: [],
    })!;
    expect(summary).not.toContain("Notes:");
  });
});
