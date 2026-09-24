import { describe, expect, it } from "vitest";
import { hrZoneSet, powerZoneSet } from "./__fixtures__/zones";
import { buildZonesA11y } from "./a11y";

describe("buildZonesA11y", () => {
  it("narrates the heart-rate distribution with every zone", () => {
    const a11y = buildZonesA11y(hrZoneSet, "Threshold Intervals");
    expect(a11y.title).toBe("Time in heart rate zones for Threshold Intervals");
    expect(a11y.desc).toContain("Most time in Z2 at 45%");
    expect(a11y.desc).toContain("Z1 (0–120 bpm) 15% (10 min)");
    expect(a11y.desc).toContain("Z5 (175–197 bpm)");
  });

  it("labels power sets as power", () => {
    const a11y = buildZonesA11y(powerZoneSet, "Ride");
    expect(a11y.title).toContain("power zones");
    expect(a11y.desc).toContain("Z6 (400+ W)");
  });
});
