import {
  advertisedViewTools,
  expectViewToolContract,
  viewToolFields,
} from "@intervals-mcp/ui/testing";
import { describe, expect, it } from "vitest";
import { VIEW_TOOLS } from "./viewToolDeclarations";

describe("activity chart view tools", () => {
  it("keep the contract every view tool has", async () => {
    await expectViewToolContract(VIEW_TOOLS);
  });

  it("advertise set-brush-window with the fields the model has been given", async () => {
    const tools = await advertisedViewTools(VIEW_TOOLS);

    expect(tools.map((tool) => tool.name)).toEqual(["set-brush-window"]);
    const [tool] = tools;
    expect(tool).toMatchObject({
      title: "Zoom the chart",
      description:
        "Zoom the activity chart's x-axis to one window of the activity, given either in kilometres from the start or in seconds of elapsed time. Use it to put the part of the run being discussed on screen — a surge, a climb, an interval — rather than describing where to look. Pass reset to show the whole activity again.",
    });
    expect(viewToolFields(tool!)).toEqual({
      fromKm: {
        type: "number",
        minimum: 0,
        description:
          "Start of the window, in km from the start. Use with toKm for a distance window.",
      },
      toKm: {
        type: "number",
        minimum: 0,
        description: "End of the window, in km from the start.",
      },
      fromSeconds: {
        type: "number",
        minimum: 0,
        description:
          "Start of the window, in seconds of elapsed time. Use with toSeconds for a time window.",
      },
      toSeconds: {
        type: "number",
        minimum: 0,
        description: "End of the window, in seconds of elapsed time.",
      },
      reset: {
        type: "boolean",
        description: "Zoom back out to the whole activity.",
      },
    });
  });
});
