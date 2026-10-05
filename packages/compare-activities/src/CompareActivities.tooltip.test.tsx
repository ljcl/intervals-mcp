import { type SpeedSport } from "@intervals-mcp/data";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompareTooltip } from "./CompareActivities";

const paceEntries = (a: number, b: number) => [
  { dataKey: "aPace", name: "Morning", value: a, color: "#58f" },
  { dataKey: "bPace", name: "Evening", value: b, color: "#f85" },
];

const render = (category: SpeedSport, a: number, b: number) =>
  renderToStaticMarkup(
    <CompareTooltip
      active
      payload={paceEntries(a, b)}
      label={600}
      metric="pace"
      category={category}
      bothRunning={category === "run"}
      axis="time"
    />,
  );

describe("CompareTooltip pace delta", () => {
  it("reads a run delta in s/km, never 's min/km'", () => {
    const markup = render("run", 5, 5.2);
    expect(markup).toContain("+12");
    expect(markup).toContain("s/km");
    expect(markup).not.toContain("s min/km");
    expect(markup).toContain("5&#x27;00&quot;");
  });

  it("reads a swim delta in s/100m", () => {
    const markup = render("swim", 1.5, 1.75);
    expect(markup).toContain("+15");
    expect(markup).toContain("s/100m");
    expect(markup).not.toContain("s /100m");
    expect(markup).toContain("1&#x27;30&quot;");
  });

  it("reads a mixed pair as km/h with a one-decimal delta", () => {
    const markup = render("other", 20, 22.5);
    expect(markup).toContain("+2.5");
    expect(markup).toContain("km/h");
    expect(markup).toContain(">20.0<");
  });
});
