import { describe, expect, it } from "vitest";
import { parseToolArgs } from "./toolArgs";

describe("parseToolArgs", () => {
  it("reads id", () => {
    expect(parseToolArgs({ id: "i189807578" })).toEqual({ id: "i189807578" });
  });

  it("reads the legacy activity_id as id", () => {
    expect(parseToolArgs({ activity_id: "i1" })).toEqual({ id: "i1" });
  });

  it("prefers id over activity_id", () => {
    expect(parseToolArgs({ id: "i1", activity_id: "i2" })).toEqual({
      id: "i1",
    });
  });

  it("keeps latest for the root to pin", () => {
    expect(parseToolArgs({ id: "latest" })).toEqual({ id: "latest" });
  });

  it("reads a numeric id as its digit string", () => {
    expect(parseToolArgs({ activity_id: 189807578 })).toEqual({
      id: "189807578",
    });
  });

  it.each([undefined, {}, { id: "" }, { activityId: null }])(
    "is null without an id: %j",
    (raw) => {
      expect(parseToolArgs(raw)).toBeNull();
    },
  );
});
