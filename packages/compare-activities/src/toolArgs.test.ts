import { describe, expect, it } from "vitest";
import { parseToolArgs } from "./toolArgs";

describe("parseToolArgs", () => {
  it("reads activityId1 and activityId2", () => {
    expect(parseToolArgs({ activityId1: "i1", activityId2: "i2" })).toEqual({
      activityId1: "i1",
      activityId2: "i2",
    });
  });

  it("reads the legacy activity_id_1 and activity_id_2", () => {
    expect(
      parseToolArgs({ activity_id_1: "i1", activity_id_2: "latest" }),
    ).toEqual({ activityId1: "i1", activityId2: "latest" });
  });

  it("prefers the new names, slot by slot", () => {
    expect(
      parseToolArgs({
        activityId1: "i1",
        activity_id_1: "i9",
        activity_id_2: "i2",
      }),
    ).toEqual({ activityId1: "i1", activityId2: "i2" });
  });

  it("reads numeric ids as digit strings", () => {
    expect(parseToolArgs({ activityId1: 1, activityId2: 2 })).toEqual({
      activityId1: "1",
      activityId2: "2",
    });
  });

  it.each([
    undefined,
    {},
    { activityId1: "i1" },
    { activity_id_2: "i2" },
    { activityId1: "", activityId2: "i2" },
    // A bare id is not guessed into either slot, as on the server.
    { id: "i1", activityId2: "i2" },
  ])("is null without both ids: %j", (raw) => {
    expect(parseToolArgs(raw)).toBeNull();
  });
});
