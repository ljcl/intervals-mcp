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
    "is the suggestion map without an id: %j",
    (raw) => {
      expect(parseToolArgs(raw)).toEqual({ kind: "suggestion", args: {} });
    },
  );

  it("passes suggestion arguments through", () => {
    expect(
      parseToolArgs({
        start: "Embarcadero, San Francisco",
        terrain: "flat",
        other: 1,
      }),
    ).toEqual({
      kind: "suggestion",
      args: { start: "Embarcadero, San Francisco", terrain: "flat" },
    });
  });

  describe("route mode", () => {
    it("reads a route_id with its versions and waypoints", () => {
      const waypoints = [{ km: 7.8, end_km: 9, label: "Climb", kind: "climb" }];
      expect(
        parseToolArgs({
          route_id: "r7k2m9qx4a",
          version: 3,
          compare_to_version: 2,
          waypoints,
          waypoints_version: 1,
        }),
      ).toEqual({
        kind: "route",
        route_id: "r7k2m9qx4a",
        version: 3,
        compare_to_version: 2,
        waypoints,
        waypoints_version: 1,
      });
    });

    it("prefers route_id when an id is there too", () => {
      expect(parseToolArgs({ route_id: "r1", id: "i5" })).toEqual({
        kind: "route",
        route_id: "r1",
      });
    });

    it("drops version fields that are not positive whole numbers", () => {
      expect(
        parseToolArgs({
          route_id: " r1 ",
          version: 0,
          compare_to_version: 1.5,
          waypoints_version: "2",
        }),
      ).toEqual({ kind: "route", route_id: "r1" });
    });

    it("is not route mode with an empty route_id", () => {
      expect(parseToolArgs({ route_id: " ", id: "i5" })).toEqual({ id: "i5" });
    });
  });
});
