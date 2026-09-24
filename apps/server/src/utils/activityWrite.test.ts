import { describe, expect, it } from "vitest";
import { buildUpdateActivityBody, composeDescription } from "./activityWrite";

describe("composeDescription", () => {
  it("replaces when mode is replace", () => {
    expect(composeDescription("old notes", "new", "replace")).toBe("new");
  });

  it("appends with a blank-line separator", () => {
    expect(composeDescription("old notes", "new", "append")).toBe(
      "old notes\n\nnew",
    );
  });

  it("returns incoming alone when existing is null", () => {
    expect(composeDescription(null, "new", "append")).toBe("new");
  });

  it("returns incoming alone when existing is whitespace only", () => {
    expect(composeDescription("   ", "new", "append")).toBe("new");
  });
});

describe("buildUpdateActivityBody", () => {
  it("maps provided fields to snake_case", () => {
    const body = buildUpdateActivityBody({
      name: "Run",
      description: "desc",
      sportType: "TrailRun" as const,
      gearId: "g1",
      commute: true,
      trainer: false,
      hideFromHome: true,
    });
    expect(body).toEqual({
      name: "Run",
      description: "desc",
      sport_type: "TrailRun",
      gear_id: "g1",
      commute: true,
      trainer: false,
      hide_from_home: true,
    });
  });

  it("omits fields that are undefined", () => {
    expect(buildUpdateActivityBody({ name: "Run" })).toEqual({ name: "Run" });
  });

  it("keeps explicit false values", () => {
    expect(buildUpdateActivityBody({ commute: false })).toEqual({
      commute: false,
    });
  });
});
