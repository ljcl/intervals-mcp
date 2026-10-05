import { describe, expect, it } from "vitest";
import { describeSetMetric, resolveSetMetric } from "./setMetric";
import { type AxisKey, type MetricKey } from "./types";

describe("resolveSetMetric", () => {
  const metrics: MetricKey[] = ["pace", "heartrate"];
  const axes: AxisKey[] = ["distance", "time"];

  it("accepts a shared metric and axis", () => {
    expect(
      resolveSetMetric({ metric: "heartrate", axis: "time" }, metrics, axes),
    ).toEqual({
      kind: "ok",
      metric: "heartrate",
      axis: "time",
    });
  });

  it("leaves out what was not given, so the view keeps it", () => {
    expect(resolveSetMetric({ metric: "pace" }, metrics, axes)).toEqual({
      kind: "ok",
      metric: "pace",
      axis: undefined,
    });
    expect(resolveSetMetric({ axis: "distance" }, metrics, axes)).toEqual({
      kind: "ok",
      metric: undefined,
      axis: "distance",
    });
  });

  it("rejects a metric one side did not record, listing what is available", () => {
    const r = resolveSetMetric({ metric: "power" }, metrics, axes);
    expect(r).toMatchObject({ kind: "error" });
    expect((r as { text: string }).text).toContain("pace, heartrate");
  });

  it("lists the values it accepts, noting the label the view shows where it differs", () => {
    const labels: Record<MetricKey, string> = {
      pace: "Speed",
      heartrate: "Heart Rate",
      power: "Power",
      cadence: "Cadence",
      altitude: "Altitude",
    };
    expect(
      resolveSetMetric(
        { metric: "power" },
        [...metrics, "cadence"],
        axes,
        (metric) => labels[metric],
      ),
    ).toEqual({
      kind: "error",
      text: "These activities did not both record power. Available metrics: pace (shown as speed), heartrate (shown as heart rate), cadence.",
    });
  });

  it("names a requested metric by its value, with the label beside it where it differs", () => {
    expect(
      resolveSetMetric({ metric: "pace" }, ["heartrate"], axes, (metric) =>
        metric === "pace" ? "Speed" : "Heart Rate",
      ),
    ).toEqual({
      kind: "error",
      text: "These activities did not both record pace (speed). Available metrics: heartrate (shown as heart rate).",
    });
  });

  it("adds no note where the label is the value in other case", () => {
    const shown: Partial<Record<MetricKey, string>> = {
      pace: "Pace",
      power: "Power",
      cadence: "Cadence",
    };
    expect(
      resolveSetMetric(
        { metric: "power" },
        ["pace", "cadence"],
        axes,
        (metric) => shown[metric] ?? metric,
      ),
    ).toEqual({
      kind: "error",
      text: "These activities did not both record power. Available metrics: pace, cadence.",
    });
  });

  it("rejects an unshared axis, listing what is available", () => {
    expect(resolveSetMetric({ axis: "distance" }, metrics, ["time"])).toEqual({
      kind: "error",
      text: "These activities cannot be compared by distance. Available axes: time.",
    });
  });

  it("reports a bad metric and a bad axis together", () => {
    const r = resolveSetMetric({ metric: "power", axis: "distance" }, metrics, [
      "time",
    ]);
    expect(r).toMatchObject({ kind: "error" });
    const { text } = r as { text: string };
    expect(text).toContain("did not both record power");
    expect(text).toContain("cannot be compared by distance");
  });

  it("changes nothing when one part is bad, even if the other is fine", () => {
    expect(
      resolveSetMetric({ metric: "pace", axis: "distance" }, metrics, ["time"]),
    ).toMatchObject({ kind: "error" });
  });

  it("needs an argument", () => {
    expect(resolveSetMetric({}, metrics, axes)).toEqual({
      kind: "error",
      text: "Pass metric or axis.",
    });
  });

  it("says there is nothing to choose when a side recorded no streams", () => {
    const nothing = {
      kind: "error",
      text: "These activities have no overlapping streams, so there is no metric or axis to choose.",
    };
    expect(resolveSetMetric({ metric: "pace" }, [], [])).toEqual(nothing);
    expect(resolveSetMetric({ axis: "time" }, [], [])).toEqual(nothing);
    expect(resolveSetMetric({}, [], [])).toEqual(nothing);
  });

  it("says so when the activities share a time axis but no metric", () => {
    expect(resolveSetMetric({ axis: "time" }, [], ["time"])).toMatchObject({
      kind: "error",
      text: expect.stringContaining("no overlapping streams"),
    });
  });
});

describe("describeSetMetric", () => {
  const labelOf = (metric: MetricKey) =>
    metric === "heartrate" ? "Heart Rate" : "Pace";

  it("names the metric in lower case and the axis", () => {
    expect(describeSetMetric("heartrate", "time", labelOf)).toBe(
      "Comparing heart rate by time.",
    );
  });

  it("uses the label the view shows, so a mixed pair reads speed", () => {
    expect(describeSetMetric("pace", "distance", () => "Speed")).toBe(
      "Comparing speed by distance.",
    );
    expect(describeSetMetric("pace", "distance", labelOf)).toBe(
      "Comparing pace by distance.",
    );
  });
});
