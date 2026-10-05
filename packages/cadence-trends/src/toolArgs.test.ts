import { describe, expect, it } from "vitest";
import { DEFAULT_DAYS, parseToolArgs } from "./toolArgs";

describe("parseToolArgs", () => {
  it("reads days", () => {
    expect(parseToolArgs({ days: 30 })).toEqual({ days: 30 });
  });

  it("reads the legacy weeks as days", () => {
    expect(parseToolArgs({ weeks: 8 })).toEqual({ days: 56 });
  });

  it("reads a numeric string, as the server's alias does", () => {
    expect(parseToolArgs({ weeks: "4" })).toEqual({ days: 28 });
  });

  it("prefers days over weeks", () => {
    expect(parseToolArgs({ days: 30, weeks: 8 })).toEqual({ days: 30 });
  });

  it.each([undefined, null, {}, { days: "soon" }, { weeks: "" }])(
    "defaults to 42 days for %j",
    (raw) => {
      expect(DEFAULT_DAYS).toBe(42);
      expect(parseToolArgs(raw)).toEqual({ days: 42 });
    },
  );
});
