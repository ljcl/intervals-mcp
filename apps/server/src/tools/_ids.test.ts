import { describe, expect, it } from "vitest";
import { z } from "zod";
import { idJsonSchemaOverride, intervalsActivityIdInput } from "./_ids";

describe("intervalsActivityIdInput", () => {
  const schema = intervalsActivityIdInput("The id.");

  it("accepts an i-prefixed activity id unchanged", () => {
    expect(schema.parse("i189807578")).toBe("i189807578");
  });

  it("accepts bare digits unchanged", () => {
    expect(schema.parse("189807578")).toBe("189807578");
  });

  it("accepts a bare safe-integer number and coerces it to a digit string", () => {
    expect(schema.parse(189807578)).toBe("189807578");
  });

  it("rejects a number that is not a safe integer", () => {
    expect(() => schema.parse(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("rejects non-integer and negative numbers", () => {
    expect(() => schema.parse(12.5)).toThrow();
    expect(() => schema.parse(-5)).toThrow();
  });

  it("rejects malformed strings", () => {
    expect(() => schema.parse("abc")).toThrow();
    expect(() => schema.parse("")).toThrow();
    expect(() => schema.parse("i")).toThrow();
  });

  describe("error messages", () => {
    /** The prettified message a host sees, for one bad id value. */
    function messageFor(value: unknown): string {
      const result = z.object({ activity_id: schema }).safeParse({
        activity_id: value,
      });
      expect(result.success).toBe(false);
      return result.success ? "" : z.prettifyError(result.error);
    }

    it("reports a rounded oversized id once, naming the value and the fix", () => {
      const message = messageFor(JSON.parse("3516039180561708486"));

      expect(message).toContain("3516039180561708500");
      expect(message).toContain("quoted as a string of digits");
      expect(message).not.toContain("whole number");
      expect(message.split("✖")).toHaveLength(2);
    });

    it("reports a fractional or negative id as a single whole-number issue", () => {
      expect(messageFor(12.5)).toContain(
        "id must be a non-negative whole number",
      );
      expect(messageFor(-5)).toContain(
        "id must be a non-negative whole number",
      );
    });

    it("reports a malformed string id as a digits issue", () => {
      expect(messageFor("abc")).toContain("id must be a string of digits");
    });
  });

  describe("advertised JSON schema", () => {
    /** How the server projects a tool's input schema (see `toInputSchema`). */
    function advertise(input: z.ZodType): Record<string, unknown> {
      return z.toJSONSchema(input, {
        io: "input",
        override: idJsonSchemaOverride,
      }) as Record<string, unknown>;
    }

    it("advertises the string form with the i-optional pattern", () => {
      const json = advertise(schema);

      expect(json.type).toBe("string");
      expect(json.pattern).toBe("^i?\\d+$");
      expect(json.anyOf).toBeUndefined();
      expect(json.description).toBe(
        'The id. Pass the intervals.icu activity id as a quoted string exactly as shown in list-activities (e.g. "i189807578").',
      );
    });

    it("does not disturb another intervalsActivityIdInput schema's own advertised pattern", () => {
      const otherJson = advertise(intervalsActivityIdInput("Other id."));

      expect(otherJson.pattern).toBe("^i?\\d+$");
    });

    it("leaves schemas that are not intervals.icu ids alone", () => {
      const json = advertise(z.union([z.string(), z.number()]));

      expect(json.type).toEqual(["string", "number"]);
      expect(json.pattern).toBeUndefined();
    });

    it("narrows a nested field to exactly type, pattern, description", () => {
      const json = advertise(z.object({ activity_id: schema })) as {
        properties: Record<string, Record<string, unknown>>;
      };

      expect(json.properties.activity_id).toEqual({
        type: "string",
        pattern: "^i?\\d+$",
        description:
          'The id. Pass the intervals.icu activity id as a quoted string exactly as shown in list-activities (e.g. "i189807578").',
      });
    });
  });
});
