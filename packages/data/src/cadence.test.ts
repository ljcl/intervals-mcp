import { describe, expect, it } from "vitest";
import {
  cadencePaceRegression,
  computeZoneStats,
  linearRegression,
} from "./cadence";

const run = (averagePace: number | null, averageCadence: number) => ({
  averagePace,
  averageCadence,
});

describe("computeZoneStats", () => {
  it("buckets runs by pace zone with mean/min/max per zone", () => {
    const stats = computeZoneStats([
      run(3.8, 185), // Threshold (<4)
      run(4.2, 180), // Tempo (4–4.5)
      run(4.4, 176), // Tempo
      run(6.0, 165), // Easy (5.5–20)
      run(6.0, 0), // dropout, excluded
    ]);

    const byLabel = new Map(stats.map((s) => [s.zone.label, s]));
    expect(byLabel.get("Threshold")?.count).toBe(1);
    expect(byLabel.get("Tempo")?.mean).toBe(178);
    expect(byLabel.get("Tempo")?.min).toBe(176);
    expect(byLabel.get("Tempo")?.max).toBe(180);
    expect(byLabel.get("Easy")?.count).toBe(1);
    expect(byLabel.get("Moderate")?.count).toBe(0);
  });

  it("excludes a run with no recorded pace instead of coercing null into a zone", () => {
    const stats = computeZoneStats([run(4.2, 180), run(null, 175)]);

    const byLabel = new Map(stats.map((s) => [s.zone.label, s]));
    expect(byLabel.get("Tempo")?.count).toBe(1);
    expect(stats.reduce((sum, s) => sum + s.count, 0)).toBe(1);
  });
});

describe("linearRegression", () => {
  it("fits a perfect line exactly", () => {
    const fit = linearRegression([
      { x: 1, y: 3 },
      { x: 2, y: 5 },
      { x: 3, y: 7 },
    ]);

    expect(fit?.slope).toBeCloseTo(2);
    expect(fit?.intercept).toBeCloseTo(1);
  });

  it("returns null for degenerate inputs", () => {
    expect(linearRegression([{ x: 1, y: 1 }])).toBeNull();
    // All x equal → zero denominator.
    expect(
      linearRegression([
        { x: 2, y: 1 },
        { x: 2, y: 9 },
      ]),
    ).toBeNull();
  });
});

describe("cadencePaceRegression", () => {
  it("fits cadence against pace over the runs that have both", () => {
    const fit = cadencePaceRegression([
      run(4, 180),
      run(5, 170),
      run(6, 160),
      run(null, 150),
      run(5.5, 0),
    ]);
    expect(fit?.slope).toBeCloseTo(-10);
    expect(fit?.runs).toBe(3);
  });

  it("is null with fewer than two such runs", () => {
    expect(cadencePaceRegression([run(5, 170), run(null, 165)])).toBeNull();
  });
});
