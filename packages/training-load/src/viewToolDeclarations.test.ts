import {
  advertisedViewTools,
  expectViewToolContract,
  viewToolFields,
} from "@intervals-mcp/ui/testing";
import { describe, expect, it } from "vitest";
import { VIEW_TOOLS } from "./viewToolDeclarations";

describe("training load view tools", () => {
  it("keep the contract every view tool has", async () => {
    await expectViewToolContract(VIEW_TOOLS);
  });

  it("advertise set-scope with the fields the model has been given", async () => {
    const tools = await advertisedViewTools(VIEW_TOOLS);

    expect(tools.map((tool) => tool.name)).toEqual(["set-scope"]);
    const [tool] = tools;
    expect(tool).toMatchObject({
      title: "Change the training load view",
      description:
        "Switch the training load card between whole-body load and runs only, and show or hide the trend line, the load line and the volume-spike warning highlights.",
    });
    expect(viewToolFields(tool!)).toEqual({
      scope: {
        type: "string",
        enum: ["wholeBody", "runOnly"],
        description: "Load scope.",
      },
      show: {
        type: "array",
        items: { type: "string", enum: ["trend", "load", "warnings"] },
        description: "Series to show.",
      },
      hide: {
        type: "array",
        items: { type: "string", enum: ["trend", "load", "warnings"] },
        description: "Series to hide.",
      },
    });
  });
});
