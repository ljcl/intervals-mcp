import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stravaIdInput, stravaIdJsonSchemaOverride } from "./_ids";

describe("stravaIdInput", () => {
  const schema = stravaIdInput("The id.");

  it("accepts a digit string", () => {
    expect(schema.parse("12345")).toBe("12345");
  });

  it("accepts an id above 2^53 as a string (lossless)", () => {
    const big = "3512771082082480078";
    expect(schema.parse(big)).toBe(big);
  });

  it("accepts a bare safe-integer number and coerces it to a digit string", () => {
    // Most activity ids sit well below 2^53, so a host or model sending
    // `activity_id: 12345` must not be trapped in the string-only failure path.
    expect(schema.parse(12345)).toBe("12345");
  });

  it("rejects a number that is not a safe integer so oversized ids cannot be silently corrupted", () => {
    // Such a value has already been rounded by the host's JSON.parse before
    // validation runs; failing loudly steers the caller to the string form.
    expect(() => schema.parse(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("rejects non-integer and negative numbers", () => {
    expect(() => schema.parse(12.5)).toThrow();
    expect(() => schema.parse(-5)).toThrow();
  });

  it("rejects non-digit strings", () => {
    expect(() => schema.parse("12ab")).toThrow();
    expect(() => schema.parse("")).toThrow();
    expect(() => schema.parse("-5")).toThrow();
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
      // Regression: an activity id copied out of a Strava URL and sent
      // unquoted (3516039180561708486) arrives already rounded. The old schema layered
      // `.int()` over a safe-integer refine and emitted two issues, the first
      // of which ("id must be a whole number") was plainly false of the
      // rounded value the host could see.
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
      expect(messageFor("12ab")).toContain("id must be a string of digits");
    });
  });

  describe("advertised JSON schema", () => {
    /** How the server projects a tool's input schema (see `toInputSchema`). */
    function advertise(input: z.ZodType): Record<string, unknown> {
      return z.toJSONSchema(input, {
        io: "input",
        override: stravaIdJsonSchemaOverride,
      }) as Record<string, unknown>;
    }

    it("advertises the string form only, so a host cannot generate a lossy number", () => {
      const json = advertise(schema);

      expect(json.type).toBe("string");
      expect(json.pattern).toBe("^\\d+$");
      expect(json.anyOf).toBeUndefined();
      expect(json.description).toContain("quoted string of digits");
    });

    it("narrows ids nested inside an object schema", () => {
      const json = advertise(
        z.object({
          activity_id: stravaIdInput(
            "The Strava activity ID to map.",
          ).optional(),
          waypoints: z.array(z.string()).optional(),
        }),
      ) as { properties: Record<string, Record<string, unknown>> };

      expect(json.properties.activity_id?.type).toBe("string");
      expect(json.properties.activity_id?.anyOf).toBeUndefined();
      // Non-id members are untouched by the override.
      expect(json.properties.waypoints?.type).toBe("array");
    });

    it("leaves schemas that are not Strava ids alone", () => {
      const json = advertise(z.union([z.string(), z.number()])) as Record<
        string,
        unknown
      >;

      expect(json.anyOf).toBeDefined();
    });
  });
});
