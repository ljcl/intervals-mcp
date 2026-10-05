import { describe, expect, it } from "vitest";
import {
  hasLatestId,
  pinResolvedArgs,
  RESOLVED_ARGS_META_KEY,
  resolvedArgsOf,
} from "./latestPin";

describe("RESOLVED_ARGS_META_KEY", () => {
  it("is the string the server writes (apps/server/src/latestActivity.ts)", () => {
    expect(RESOLVED_ARGS_META_KEY).toBe("intervals-mcp/resolvedArgs");
  });
});

describe("resolvedArgsOf", () => {
  it("reads the resolved ids from a tool result's _meta", () => {
    expect(
      resolvedArgsOf({
        _meta: { [RESOLVED_ARGS_META_KEY]: { id: "i9" } },
      }),
    ).toEqual({ id: "i9" });
  });

  it.each([
    ["no _meta", {}],
    ["_meta without the key", { _meta: { other: 1 } }],
    ["a non-object value", { _meta: { [RESOLVED_ARGS_META_KEY]: "i9" } }],
    ["a null value", { _meta: { [RESOLVED_ARGS_META_KEY]: null } }],
    ["an array value", { _meta: { [RESOLVED_ARGS_META_KEY]: ["i9"] } }],
  ])("is null for %s", (_label, result) => {
    expect(resolvedArgsOf(result)).toBeNull();
  });
});

describe("pinResolvedArgs", () => {
  it('replaces "latest" with the resolved id', () => {
    expect(pinResolvedArgs({ id: "latest" }, { id: "i9" })).toEqual({
      id: "i9",
    });
  });

  it("pins each compare slot the server resolved", () => {
    expect(
      pinResolvedArgs(
        { activityId1: "latest", activityId2: "i2" },
        { activityId1: "i1" },
      ),
    ).toEqual({ activityId1: "i1", activityId2: "i2" });
  });

  it('never overwrites an id that was not "latest"', () => {
    expect(pinResolvedArgs({ id: "i5" }, { id: "i9" })).toEqual({ id: "i5" });
  });

  it("ignores a resolved key the args do not have", () => {
    expect(pinResolvedArgs({ days: 42 }, { id: "i9" })).toEqual({ days: 42 });
  });

  it("returns the args themselves when nothing changes", () => {
    const args = { id: "i5" };
    expect(pinResolvedArgs(args, { id: "i9" })).toBe(args);
  });
});

describe("hasLatestId", () => {
  it.each([
    [{ id: "latest" }, true],
    [{ activityId1: "i1", activityId2: "latest" }, true],
    [{ id: "i9" }, false],
    [{ days: 42 }, false],
    // Only id arguments say "latest"; the server resolves nothing else.
    [{ label: "latest" }, false],
  ])("%j is %s", (args, expected) => {
    expect(hasLatestId(args)).toBe(expected);
  });

  it("is false for args that are not an object", () => {
    expect(hasLatestId(null)).toBe(false);
    expect(hasLatestId("latest")).toBe(false);
  });
});
