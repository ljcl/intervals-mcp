import { describe, expect, it } from "vitest";
import {
  ACTIVITY_ID1_ARG_KEYS,
  ACTIVITY_ID2_ARG_KEYS,
  ID_ARG_KEYS,
  parseIdToolArgs,
  toolArgId,
  toolArgRecord,
} from "./toolArgs";

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

describe("parseIdToolArgs", () => {
  it("reads id", () => {
    expect(parseIdToolArgs({ id: "i189807578" })).toEqual({ id: "i189807578" });
  });

  it.each([[{ activity_id: "i1" }], [{ activityId: "i1" }]])(
    "reads the alias %j as id",
    (raw) => {
      expect(parseIdToolArgs(raw)).toEqual({ id: "i1" });
    },
  );

  it("prefers id over its aliases", () => {
    expect(parseIdToolArgs({ id: "i1", activity_id: "i2" })).toEqual({
      id: "i1",
    });
  });

  it("keeps latest for the root to pin", () => {
    expect(parseIdToolArgs({ id: "latest" })).toEqual({ id: "latest" });
  });

  it("reads a numeric id as its digit string", () => {
    expect(parseIdToolArgs({ activity_id: 189807578 })).toEqual({
      id: "189807578",
    });
  });

  it.each([
    undefined,
    {},
    { id: "" },
    { id: null },
    { activity_id: null },
    // A pair slot is not guessed into the single id, as on the server.
    { activityId1: "i1" },
  ])("is null without an id: %j", (raw) => {
    expect(parseIdToolArgs(raw)).toBeNull();
  });
});

describe("activity-id spellings", () => {
  // The same groups as ALIAS_GROUPS in apps/server/src/argAliases.ts.
  it("mirror the server's alias groups, the tool's own name first", () => {
    expect(ID_ARG_KEYS).toEqual(["id", "activity_id", "activityId"]);
    expect(ACTIVITY_ID1_ARG_KEYS).toEqual([
      "activityId1",
      "activity_id_1",
      "activity_id1",
      "activityId_1",
      "id1",
    ]);
    expect(ACTIVITY_ID2_ARG_KEYS).toEqual([
      "activityId2",
      "activity_id_2",
      "activity_id2",
      "activityId_2",
      "id2",
    ]);
  });
});
