import { describe, expect, it } from "vitest";
import { toolArgId, toolArgRecord } from "./toolArgs";

describe("toolArgRecord", () => {
  it("passes an object through", () => {
    const args = { id: "i1" };
    expect(toolArgRecord(args)).toBe(args);
  });

  it.each([undefined, null, "i1", 5, ["i1"]])(
    "reads %j as no arguments",
    (raw) => {
      expect(toolArgRecord(raw)).toEqual({});
    },
  );
});

describe("toolArgId", () => {
  it("prefers the first key that holds an id", () => {
    expect(
      toolArgId({ id: "i1", activity_id: "i2" }, "id", "activity_id"),
    ).toBe("i1");
  });

  it("falls back to a legacy spelling", () => {
    expect(toolArgId({ activity_id: "i2" }, "id", "activity_id")).toBe("i2");
  });

  it("keeps latest as the word", () => {
    expect(toolArgId({ id: "latest" }, "id")).toBe("latest");
  });

  it("reads a safe-integer number as its digit string", () => {
    expect(toolArgId({ id: 189807578 }, "id")).toBe("189807578");
  });

  it.each([
    ["missing", {}],
    ["empty", { id: "" }],
    ["blank", { id: "  " }],
    ["null", { id: null }],
    ["unsafe", { id: 2 ** 60 }],
    ["fractional", { id: 1.5 }],
    ["an object", { id: { value: "i1" } }],
  ])("is null when the id is %s", (_label, args) => {
    expect(toolArgId(args, "id")).toBeNull();
  });
});
