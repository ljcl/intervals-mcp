/**
 * Regression for ljcl/strava-mcp#134: the tooltip filtered on falsy values, so legitimate
 * zero readings (0 W coasting, 0% grade, cadence 0) vanished while their
 * lines still rendered.
 */
import { speedDisplay } from "@intervals-mcp/data";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChartTooltip } from "./ActivityChart";
import { type ActivityMeta } from "./types";

const rideMeta: ActivityMeta = {
  name: "Coasting Ride",
  activityType: "Ride",
  isRunning: false,
  isSwimming: false,
  speed: speedDisplay("Ride"),
};

// A coasting moment: freewheeling downhill on flat-average terrain.
const coastingPayload = [
  { name: "Heart Rate", dataKey: "heartrate", value: 141, color: "#e11" },
  { name: "Power", dataKey: "power", value: 0, color: "#1e1" },
  { name: "Grade", dataKey: "grade", value: 0, color: "#11e" },
  { name: "Cadence", dataKey: "cadence", value: 0, color: "#ee1" },
];

describe("ChartTooltip", () => {
  it("keeps legitimate zero values visible", () => {
    const markup = renderToStaticMarkup(
      <ChartTooltip
        active
        payload={coastingPayload}
        label={1200}
        meta={rideMeta}
      />,
    );

    expect(markup).toContain("W Power");
    expect(markup).toContain("% Grade");
    expect(markup).toContain("rpm Cadence");
    // All three zero entries render a 0.0 value.
    expect(markup.match(/>0\.0</g)).toHaveLength(3);
  });

  it("still drops entries with no reading at this point", () => {
    const markup = renderToStaticMarkup(
      <ChartTooltip
        active
        payload={[
          {
            name: "Heart Rate",
            dataKey: "heartrate",
            value: 141,
            color: "#e11",
          },
          { name: "Power", dataKey: "power", value: null, color: "#1e1" },
        ]}
        label={1200}
        meta={rideMeta}
      />,
    );

    expect(markup).toContain("bpm Heart Rate");
    expect(markup).not.toContain("Power");
  });

  it("renders nothing when every entry lacks a reading", () => {
    const markup = renderToStaticMarkup(
      <ChartTooltip
        active
        payload={[
          { name: "Power", dataKey: "power", value: null, color: "#1e1" },
        ]}
        label={0}
        meta={rideMeta}
      />,
    );

    expect(markup).toBe("");
  });

  it("shows the altitude entry (old Area-name guard removed)", () => {
    const markup = renderToStaticMarkup(
      <ChartTooltip
        active
        payload={[
          { name: "Altitude", dataKey: "altitude", value: 12.4, color: "#aaa" },
        ]}
        label={60}
        meta={rideMeta}
      />,
    );

    expect(markup).toContain("m Altitude");
    expect(markup).toContain(">12.4<");
  });

  it("shows running-dynamics entries with their units (ms/mm/%/mm)", () => {
    const runMeta: ActivityMeta = {
      name: "Dynamics Pod Run",
      activityType: "Run",
      isRunning: true,
      isSwimming: false,
      speed: speedDisplay("Run"),
    };
    const markup = renderToStaticMarkup(
      <ChartTooltip
        active
        payload={[
          {
            name: "Ground Contact Time",
            dataKey: "stanceTime",
            value: 248,
            color: "#0d9488",
          },
          {
            name: "Vertical Oscillation",
            dataKey: "verticalOscillation",
            value: 8.1,
            color: "#db2777",
          },
          {
            name: "Vertical Ratio",
            dataKey: "verticalRatio",
            value: 6.9,
            color: "#ca8a04",
          },
          {
            name: "Step Length",
            dataKey: "stepLength",
            value: 1210,
            color: "#4f46e5",
          },
        ]}
        label={60}
        meta={runMeta}
      />,
    );

    expect(markup).toContain("ms Ground Contact Time");
    expect(markup).toContain("mm Vertical Oscillation");
    expect(markup).toContain("% Vertical Ratio");
    expect(markup).toContain("mm Step Length");
  });

  describe("pace entry", () => {
    const meta = (activityType: string): ActivityMeta => ({
      name: "Pace test",
      activityType,
      isRunning: activityType === "Run",
      isSwimming: activityType === "Swim",
      speed: speedDisplay(activityType),
    });
    const paceMarkup = (activityType: string, name: string, value: number) =>
      renderToStaticMarkup(
        <ChartTooltip
          active
          payload={[{ name, dataKey: "pace", value, color: "#58f" }]}
          label={60}
          meta={meta(activityType)}
        />,
      );

    it("reads a run as m'ss min/km", () => {
      const markup = paceMarkup("Run", "Pace", 5.5);
      expect(markup).toContain("5&#x27;30&quot;");
      expect(markup).toContain("min/km Pace");
    });

    it("reads a walk's slow pace as pace, not a capped value", () => {
      const markup = paceMarkup("Walk", "Pace", 20);
      expect(markup).toContain("20&#x27;00&quot;");
      expect(markup).toContain("min/km Pace");
    });

    it("reads a swim as m'ss /100m", () => {
      const markup = paceMarkup("Swim", "Pace", 1 + 40 / 60);
      expect(markup).toContain("1&#x27;40&quot;");
      expect(markup).toContain("/100m Pace");
    });

    it("reads a ride as km/h, finding the entry by dataKey not by name", () => {
      const markup = paceMarkup("Ride", "Speed", 28.44);
      expect(markup).toContain(">28.4<");
      expect(markup).toContain("km/h Speed");
    });
  });
});
