import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ChartRow } from "./normalize";
import { TrendTooltip } from "./TrendTooltip";

const forwardDay = {
  label: "Mon 3 Nov",
  planCtl: 50,
  planAtl: 40,
  planTsb: 10,
};

const render = (props: Parameters<typeof TrendTooltip>[0]) =>
  renderToStaticMarkup(
    <TrendTooltip
      active
      payload={[{ payload: forwardDay as Partial<ChartRow> }]}
      {...props}
    />,
  );

describe("TrendTooltip forward-day label", () => {
  it("says rest by default", () => {
    expect(render({})).toContain("Rest projection");
  });

  it("names the calendar plan when told", () => {
    const html = render({ projection: "Calendar plan projection" });
    expect(html).toContain("Calendar plan projection");
    expect(html).not.toContain("Rest projection");
  });

  it("says planned for a solved taper", () => {
    expect(render({ planned: true })).toContain("Planned");
  });
});
