import { describe, expect, it } from "vitest";
import { hrZoneSet, paceZoneSet, powerZoneSet } from "./__fixtures__/zones";
import { buildZonesA11y } from "./a11y";

describe("buildZonesA11y", () => {
  it("narrates the heart-rate distribution with every zone", () => {
    const a11y = buildZonesA11y(hrZoneSet, "Threshold Intervals", "Run");
    expect(a11y.title).toBe("Time in heart rate zones for Threshold Intervals");
    expect(a11y.desc).toContain("Most time in Z2 at 45%");
    expect(a11y.desc).toContain("Z1 (up to 120 bpm) 15% (10 min)");
    expect(a11y.desc).toContain("Z5 (176-197 bpm)");
  });

  it("labels power sets as power", () => {
    const a11y = buildZonesA11y(powerZoneSet, "Ride", "Ride");
    expect(a11y.title).toContain("power zones");
    expect(a11y.desc).toContain("Z6 (400+ W)");
  });

  it("narrates a pace set with its basis and every pace range", () => {
    const a11y = buildZonesA11y(paceZoneSet, "Easy Run", "Run");
    expect(a11y.title).toBe("Time in pace zones for Easy Run");
    expect(a11y.desc).toContain("time by grade-adjusted pace (GAP)");
    expect(a11y.desc).toContain("Most time in Z2 at 41%");
    expect(a11y.desc).toContain(`Z1 (slower than 6'01" /km) 10.3%`);
    expect(a11y.desc).toContain(`Z7 (faster than 4'11" /km) 3.1%`);
  });
});
