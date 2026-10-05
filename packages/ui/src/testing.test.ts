/**
 * The view-tool contract helper, tested against declarations that break it.
 * A contract that has never been seen to fail proves nothing, and each break
 * below is one a real declaration could make without anything else noticing.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  advertisedViewTools,
  expectViewToolContract,
  viewToolFields,
} from "./testing";
import { type ViewToolDefinition } from "./viewTools";

function declare(fields: z.ZodRawShape, strict = true): ViewToolDefinition {
  const object = z.object(fields);
  return {
    name: "set-thing",
    title: "Set the thing",
    description: "Move the thing.",
    inputSchema: strict ? object.strict() : object,
  };
}

const CONFORMING = declare({
  fromKm: z.number().min(0).nullish().describe("Start, km."),
  reset: z.boolean().nullish().describe("Show it all."),
});

describe("expectViewToolContract", () => {
  it("accepts a strict object whose fields are all nullish", async () => {
    await expect(expectViewToolContract([CONFORMING])).resolves.toBeUndefined();
  });

  it("fails a field that does not accept null", async () => {
    // The SDK would throw on a model's null here, so the tool would reject
    // the very call the schema invites.
    const definition = declare({
      fromKm: z.number().min(0).optional().describe("Start, km."),
    });

    await expect(expectViewToolContract([definition])).rejects.toThrow(
      /fromKm should accept null/,
    );
  });

  it("fails an object that is not strict", async () => {
    // Unrecognised keys would be stripped, so a mistyped argument would look
    // like a call that worked.
    const definition = declare(
      { fromKm: z.number().nullish().describe("Start, km.") },
      false,
    );

    await expect(expectViewToolContract([definition])).rejects.toThrow(
      /additionalProperties/,
    );
  });

  it("fails a required field", async () => {
    const definition = declare({
      fromKm: z.number().describe("Start, km."),
    });

    await expect(expectViewToolContract([definition])).rejects.toThrow(
      /required/,
    );
  });

  it("fails a declaration with no fields to drive", async () => {
    await expect(expectViewToolContract([declare({})])).rejects.toThrow(
      /has properties/,
    );
  });

  it("fails an empty list rather than passing vacuously", async () => {
    await expect(expectViewToolContract([])).rejects.toThrow(
      /at least one view tool/,
    );
  });
});

describe("advertisedViewTools and viewToolFields", () => {
  it("lists the tool the way a host receives it", async () => {
    const [tool] = await advertisedViewTools([CONFORMING]);

    expect(tool).toMatchObject({
      name: "set-thing",
      title: "Set the thing",
      description: "Move the thing.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { type: "object", additionalProperties: false },
    });
  });

  it("takes the null alternative off each field", async () => {
    const [tool] = await advertisedViewTools([CONFORMING]);

    expect(viewToolFields(tool!)).toEqual({
      fromKm: { type: "number", minimum: 0, description: "Start, km." },
      reset: { type: "boolean", description: "Show it all." },
    });
  });

  it("keeps an enum and a bounded array readable", async () => {
    const [tool] = await advertisedViewTools([
      declare({
        metric: z.enum(["pace", "hr"]).nullish().describe("Which series."),
        splits: z.array(z.string()).max(4).nullish().describe("Up to four."),
      }),
    ]);

    expect(viewToolFields(tool!)).toEqual({
      metric: {
        type: "string",
        enum: ["pace", "hr"],
        description: "Which series.",
      },
      splits: {
        type: "array",
        items: { type: "string" },
        maxItems: 4,
        description: "Up to four.",
      },
    });
  });
});
