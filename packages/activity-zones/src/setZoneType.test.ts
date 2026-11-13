import { describe, expect, it } from "vitest";
import {
  emptyZonesData,
  hrAndPaceData,
  hrOnlyData,
  hrZoneMismatchData,
  paceWithHrZoneWarningData,
  paceZoneSet,
} from "./__fixtures__/zones";
import {
  describeSetZoneType,
  NO_ZONE_SETS,
  resolveSetZoneType,
} from "./setZoneType";

describe("resolveSetZoneType", () => {
  it("accepts a set the activity has", () => {
    expect(resolveSetZoneType({ type: "pace" }, hrAndPaceData)).toEqual({
      kind: "ok",
      set: paceZoneSet,
    });
  });

  it("asks for a type when none is given", () => {
    expect(resolveSetZoneType({}, hrAndPaceData)).toEqual({
      kind: "error",
      text: "Pass type.",
    });
  });

  it("refuses a set the activity lacks, listing the values it can send", () => {
    expect(resolveSetZoneType({ type: "pace" }, hrOnlyData)).toEqual({
      kind: "error",
      text: "This activity has no pace zones. Available: heartrate (heart rate). Nothing was changed.",
    });
  });

  it("gives the server's reason when heart rate zones were dropped", () => {
    expect(
      resolveSetZoneType({ type: "heartrate" }, paceWithHrZoneWarningData),
    ).toEqual({
      kind: "error",
      text: `This activity has no heart rate zones. ${paceWithHrZoneWarningData.hrZoneWarning} Available: pace. Nothing was changed.`,
    });
  });

  it("has nothing to switch with no set, giving the reason it knows", () => {
    expect(resolveSetZoneType({ type: "pace" }, emptyZonesData)).toEqual({
      kind: "error",
      text: NO_ZONE_SETS,
    });
    expect(
      resolveSetZoneType({ type: "heartrate" }, hrZoneMismatchData),
    ).toEqual({
      kind: "error",
      text: `${NO_ZONE_SETS} ${hrZoneMismatchData.hrZoneWarning}`,
    });
  });
});

describe("describeSetZoneType", () => {
  it("names the set as the subtitle does", () => {
    expect(describeSetZoneType(paceZoneSet)).toBe("Showing Pace zones (GAP).");
    expect(describeSetZoneType(hrOnlyData.zoneSets[0]!)).toBe(
      "Showing Heart rate zones.",
    );
  });
});
