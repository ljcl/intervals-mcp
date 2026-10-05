import {
  advertisedViewTools,
  expectViewToolContract,
  viewToolFields,
} from "@intervals-mcp/ui/testing";
import { describe, expect, it } from "vitest";
import { VIEW_TOOLS } from "./viewToolDeclarations";

describe("compare activities view tools", () => {
  it("keep the contract every view tool has", async () => {
    await expectViewToolContract(VIEW_TOOLS);
  });

  it("advertise set-metric with the fields the model has been given", async () => {
    const tools = await advertisedViewTools(VIEW_TOOLS);

    expect(tools.map((tool) => tool.name)).toEqual(["set-metric"]);
    const [tool] = tools;
    expect(tool).toMatchObject({
      title: "Change the compared metric",
      description:
        "Choose which metric the comparison overlays and whether its x-axis is distance or time. Only metrics both activities recorded are available.",
    });
    expect(viewToolFields(tool!)).toEqual({
      metric: {
        type: "string",
        enum: ["pace", "heartrate", "power", "cadence", "altitude"],
        description: "Metric to overlay.",
      },
      axis: {
        type: "string",
        enum: ["distance", "time"],
        description: "Overlay x-axis.",
      },
    });
  });
});
