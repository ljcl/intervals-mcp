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
        paceLabel: "pace",
      }),
    ).toBeNull();
  });

  it("lists shown and hidden metrics and smoothing state", () => {
    const text = buildChartContextSummary({
      activityName: "Tempo Run",
      availableMetrics: ["heartrate", "pace", "cadence"],
      hidden: new Set(["cadence"]),
      smooth: true,
      paceLabel: "pace",
    });
    expect(text).toBe(
      'Viewing activity "Tempo Run". Showing: heart rate, pace. Hidden: cadence. Smoothing: on.',
    );
  });

  it("names the pace metric by the label the caller passes", () => {
    const text = buildChartContextSummary({
      activityName: "Sunday Spin",
      availableMetrics: ["heartrate", "pace"],
      hidden: new Set(["heartrate"]),
      smooth: false,
      paceLabel: "speed",
    });
    expect(text).toBe(
      'Viewing activity "Sunday Spin". Showing: speed. Hidden: heart rate. Smoothing: off.',
    );
  });

  it("appends dynamics averages when the activity recorded them", () => {
    const text = buildChartContextSummary({
      activityName: "Dynamics Pod Run",
      availableMetrics: ["heartrate", "stanceTime"],
      hidden: new Set(),
      smooth: false,
      paceLabel: "pace",
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
      paceLabel: "pace",
      dynamicsSummary: null,
    });
    expect(text).not.toContain("averages");
  });
});
