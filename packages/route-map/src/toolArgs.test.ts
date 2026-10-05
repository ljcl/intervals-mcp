import { describe, expect, it } from "vitest";
import { parseToolArgs } from "./toolArgs";

describe("parseToolArgs", () => {
  it("reads id", () => {
    expect(parseToolArgs({ id: "i189807578" })).toEqual({ id: "i189807578" });
  });

  // Every id spelling is tested once, with parseIdToolArgs in packages/ui.
  it("reads an id alias", () => {
    expect(parseToolArgs({ activity_id: "latest" })).toEqual({ id: "latest" });
  });

  it("passes waypoints through", () => {
    const waypoints = [{ km: 21.1, label: "Halfway", kind: "custom" }];
    expect(parseToolArgs({ id: "i1", waypoints })).toEqual({
      id: "i1",
      waypoints,
    });
  });

  it("drops waypoints that are not a list", () => {
    expect(parseToolArgs({ id: "i1", waypoints: "none" })).toEqual({
      id: "i1",
    });
  });

  it.each([undefined, {}, { id: "" }, { waypoints: [] }])(
    "is null without an id: %j",
    (raw) => {
      expect(parseToolArgs(raw)).toBeNull();
    },
  );
});
