import { describe, expect, it } from "vitest";
import { buildElevationProfile, nearestXIndex } from "./elevationProfile";

const OPTS = { width: 600, height: 60, padTop: 8 };

describe("buildElevationProfile", () => {
  it("returns null for fewer than two samples", () => {
    expect(buildElevationProfile([], undefined, OPTS)).toBeNull();
    expect(buildElevationProfile([10], undefined, OPTS)).toBeNull();
  });

  it("spaces x by cumulative distance when an aligned stream is given", () => {
    const profile = buildElevationProfile([10, 20, 30], [0, 750, 1000], OPTS)!;
    expect(profile.xs[0]).toBe(0);
    expect(profile.xs[1]).toBeCloseTo(450); // 750/1000 of the width
    expect(profile.xs[2]).toBe(600);
  });

  it("falls back to even index spacing without a distance stream", () => {
    const profile = buildElevationProfile([10, 20, 30], undefined, OPTS)!;
    expect(profile.xs).toEqual([0, 300, 600]);
  });

  it("falls back to index spacing when the distance stream is misaligned", () => {
    const profile = buildElevationProfile([10, 20, 30], [0, 100], OPTS)!;
    expect(profile.xs).toEqual([0, 300, 600]);
  });

  it("maps the highest sample to padTop and the lowest to the floor", () => {
    const profile = buildElevationProfile([5, 50], undefined, OPTS)!;
    expect(profile.ys[1]).toBe(OPTS.padTop);
    expect(profile.ys[0]).toBe(OPTS.height);
    expect(profile.min).toBe(5);
    expect(profile.max).toBe(50);
  });

  it("draws a flat profile on the midline instead of the floor", () => {
    const profile = buildElevationProfile([25, 25, 25], undefined, OPTS)!;
    for (const y of profile.ys) {
      expect(y).toBe(OPTS.height / 2);
    }
  });

  it("closes the area path down to the strip floor", () => {
    const profile = buildElevationProfile([10, 20, 30], undefined, OPTS)!;
    expect(profile.areaPath.startsWith(profile.linePath)).toBe(true);
    expect(profile.areaPath.endsWith("Z")).toBe(true);
    expect(profile.areaPath).toContain(` ${OPTS.height} `);
  });

  it("breaks the line at a null sample instead of connecting across it", () => {
    const profile = buildElevationProfile([10, null, 30], undefined, OPTS)!;
    // Two disjoint segments (one "M" each) rather than one continuous line.
    expect(profile.linePath.match(/M/g)?.length).toBe(2);
    expect(profile.linePath.match(/L/g)).toBeNull();
    // The gap sample is excluded from the altitude domain.
    expect(profile.min).toBe(10);
    expect(profile.max).toBe(30);
  });

  it("returns null when every sample is a gap", () => {
    expect(buildElevationProfile([null, null], undefined, OPTS)).toBeNull();
  });

  it("closes each contiguous segment of the area fill separately, with no bridge across a gap", () => {
    const profile = buildElevationProfile([10, null, 30, 40], undefined, OPTS)!;

    expect(profile.linePath).toBe("M0 60 M400 25.33 L600 8");
    expect(profile.areaPath).toBe(
      "M0 60 L0 60 L0 60 Z M400 25.33 L600 8 L600 60 L400 60 Z",
    );
    // Two independently closed subpaths, one per contiguous run of real
    // samples, instead of one fill spanning the whole strip and shading the
    // gap as if it were real data.
    expect(profile.areaPath.match(/Z/g)?.length).toBe(2);
    // The null sample's own x position (200) never appears: nothing fills
    // across it.
    expect(profile.areaPath).not.toContain("200");
  });
});

describe("nearestXIndex", () => {
  it("returns -1 for an empty list", () => {
    expect(nearestXIndex([], 10)).toBe(-1);
  });

  it("finds the closest sample, clamping past the ends", () => {
    const xs = [0, 100, 200, 300];
    expect(nearestXIndex(xs, -50)).toBe(0);
    expect(nearestXIndex(xs, 140)).toBe(1);
    expect(nearestXIndex(xs, 160)).toBe(2);
    expect(nearestXIndex(xs, 9999)).toBe(3);
  });
});
