import {
  advertisedViewTools,
  expectViewToolContract,
  viewToolFields,
} from "@intervals-mcp/ui/testing";
import { describe, expect, it } from "vitest";
import { VIEW_TOOLS } from "./viewToolDeclarations";

describe("fitness trend view tools", () => {
  it("keep the contract every view tool has", async () => {
    await expectViewToolContract(VIEW_TOOLS);
  });

  it("advertise set-scope with the fields the model has been given", async () => {
    const tools = await advertisedViewTools(VIEW_TOOLS);

    expect(tools.map((tool) => tool.name)).toEqual(["set-scope"]);
    const [tool] = tools;
    expect(tool).toMatchObject({
      title: "Change the fitness view",
      description:
        "Switch the fitness chart between whole-body load and runs only, and show or hide the fitness, fatigue, form and plan series.",
    });
    expect(viewToolFields(tool!)).toEqual({
      scope: {
        type: "string",
        enum: ["wholeBody", "runOnly"],
        description: "Load scope.",
      },
      show: {
        type: "array",
        items: {
          type: "string",
          enum: ["fitness", "fatigue", "form", "plan"],
        },
        description: "Series to show.",
      },
      hide: {
        type: "array",
        items: {
          type: "string",
          enum: ["fitness", "fatigue", "form", "plan"],
        },
        description: "Series to hide.",
      },
    });
  });
});
