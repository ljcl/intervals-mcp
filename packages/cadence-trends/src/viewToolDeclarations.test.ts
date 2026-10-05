import {
  advertisedViewTools,
  expectViewToolContract,
  viewToolFields,
} from "@intervals-mcp/ui/testing";
import { describe, expect, it } from "vitest";
import { VIEW_TOOLS } from "./viewToolDeclarations";

describe("cadence trends view tools", () => {
  it("keep the contract every view tool has", async () => {
    await expectViewToolContract(VIEW_TOOLS);
  });

  it("advertise set-view with the fields the model has been given", async () => {
    const tools = await advertisedViewTools(VIEW_TOOLS);

    expect(tools.map((tool) => tool.name)).toEqual(["set-view"]);
    const [tool] = tools;
    expect(tool).toMatchObject({
      title: "Change the cadence view",
      description:
        'Switch the cadence chart between trend, scatter, zones and overlay, choose up to 4 runs to overlay, and pick the overlay x-axis. runIds are activity ids from list-activities (for example "i189807578") for runs within the chart\'s weeks, and replace the current selection.',
    });
    expect(viewToolFields(tool!)).toEqual({
      view: {
        type: "string",
        enum: ["trend", "scatter", "zones", "overlay"],
        description: "Which view to show.",
      },
      runIds: {
        type: "array",
        items: { type: "string" },
        maxItems: 4,
        description:
          "Activity ids from list-activities to overlay, up to 4; replaces the selection.",
      },
      xAxis: {
        type: "string",
        enum: ["distance", "time"],
        description: "Overlay x-axis.",
      },
    });
  });
});
