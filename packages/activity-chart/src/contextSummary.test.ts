import { describe, expect, it } from "vitest";
import { buildChartContextSummary } from "./contextSummary";

describe("buildChartContextSummary", () => {
  it("returns null until the activity name and metrics are known", () => {
    expect(
      buildChartContextSummary({
        activityName: null,
        availableMetrics: [],
        hidden: new Set(),
        smooth: false,
      }),
    ).toBeNull();
  });

  it("lists shown and hidden metrics and smoothing state", () => {
    const text = buildChartContextSummary({
      activityName: "Tempo Run",
      availableMetrics: ["heartrate", "pace", "cadence"],
      hidden: new Set(["cadence"]),
      smooth: true,
    });
    expect(text).toBe(
      'Viewing activity "Tempo Run". Showing: heart rate, pace. Hidden: cadence. Smoothing: on.',
    );
  });

  it("appends dynamics averages when the activity recorded them", () => {
    const text = buildChartContextSummary({
      activityName: "Dynamics Pod Run",
      availableMetrics: ["heartrate", "stanceTime"],
      hidden: new Set(),
      smooth: false,
      dynamicsSummary: "Ground contact time averages 245 ms.",
    });
    expect(text).toBe(
      'Viewing activity "Dynamics Pod Run". Showing: heart rate, ground contact time. ' +
        "Smoothing: off. Ground contact time averages 245 ms.",
    );
  });

  it("omits dynamics text when the activity recorded none", () => {
    const text = buildChartContextSummary({
      activityName: "Tempo Run",
      availableMetrics: ["heartrate"],
      hidden: new Set(),
      smooth: false,
      dynamicsSummary: null,
    });
    expect(text).not.toContain("averages");
  });
});
