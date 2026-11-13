import {
  advertisedViewTools,
  expectViewToolContract,
  viewToolFields,
} from "@intervals-mcp/ui/testing";
import { describe, expect, it } from "vitest";
import { VIEW_TOOLS } from "./viewToolDeclarations";

describe("activity zones view tools", () => {
  it("keep the contract every view tool has", async () => {
    await expectViewToolContract(VIEW_TOOLS);
  });

  it("advertise set-zone-type with the fields the model has been given", async () => {
    const tools = await advertisedViewTools(VIEW_TOOLS);

    expect(tools.map((tool) => tool.name)).toEqual(["set-zone-type"]);
    const [tool] = tools;
    expect(tool).toMatchObject({
      title: "Change the zone set shown",
      description:
        "Switch the activity zones card between heart rate and pace zones. Only sets the activity has are available.",
    });
    expect(viewToolFields(tool!)).toEqual({
      type: {
        type: "string",
        enum: ["heartrate", "pace"],
        description: "Zone set to show.",
      },
    });
  });
});
