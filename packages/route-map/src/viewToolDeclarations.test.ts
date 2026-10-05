import {
  advertisedViewTools,
  expectViewToolContract,
  viewToolFields,
} from "@intervals-mcp/ui/testing";
import { describe, expect, it } from "vitest";
import { VIEW_TOOLS } from "./viewToolDeclarations";

describe("route map view tools", () => {
  it("keep the contract every view tool has", async () => {
    await expectViewToolContract(VIEW_TOOLS);
  });

  it("advertise set-viewport with the fields the model has been given", async () => {
    const tools = await advertisedViewTools(VIEW_TOOLS);

    expect(tools.map((tool) => tool.name)).toEqual(["set-viewport"]);
    const [tool] = tools;
    expect(tool).toMatchObject({
      title: "Frame part of the route",
      description:
        "Zoom the route map to a stretch of the course, given in kilometres from the start. Use it to show the user where on the route something happens — a climb, a split, a segment — instead of only describing it. Omit both bounds and pass reset to show the whole route again.",
    });
    expect(viewToolFields(tool!)).toEqual({
      fromKm: {
        type: "number",
        minimum: 0,
        description:
          "Start of the stretch, in km from the start. Defaults to the start of the route.",
      },
      toKm: {
        type: "number",
        minimum: 0,
        description:
          "End of the stretch, in km from the start. Defaults to the end of the route.",
      },
      reset: {
        type: "boolean",
        description: "Zoom back out to the whole route.",
      },
    });
  });
});
