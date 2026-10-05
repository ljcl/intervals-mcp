import { describe, expect, it } from "vitest";
import {
  colorForValue,
  normalizeValue,
  percentileDomain,
  percentileRange,
  rampColor,
} from "./ramp";

describe("rampColor", () => {
  it("returns the cold end at 0 and the hot end at 1", () => {
    expect(rampColor(0)).toBe("rgb(37, 99, 235)");
    expect(rampColor(1)).toBe("rgb(220, 38, 38)");
  });

  it("clamps out-of-range input", () => {
    expect(rampColor(-3)).toBe(rampColor(0));
    expect(rampColor(7)).toBe(rampColor(1));
  });

  it("interpolates between stops", () => {
    // 1/3 lands exactly on the second stop (green).
    expect(rampColor(1 / 3)).toBe("rgb(22, 163, 74)");
  });
});

describe("percentileDomain", () => {
  it("clamps outliers outside the 5th..95th percentiles", () => {
    const values = [...Array.from({ length: 98 }, (_, i) => i + 1), -500, 500];
    const { min, max } = percentileDomain(values);
    expect(min).toBeGreaterThan(-500);
    expect(max).toBeLessThan(500);
  });

  it("handles a constant series", () => {
    expect(percentileDomain([5, 5, 5])).toEqual({ min: 5, max: 5 });
  });
});

describe("normalizeValue", () => {
  it("scales a value into 0..1 within the domain", () => {
    expect(normalizeValue(50, 0, 100)).toBe(0.5);
    expect(normalizeValue(0, 0, 100)).toBe(0);
    expect(normalizeValue(100, 0, 100)).toBe(1);
  });

  it("clamps out-of-range values", () => {
    expect(normalizeValue(-10, 0, 100)).toBe(0);
    expect(normalizeValue(200, 0, 100)).toBe(1);
  });

  it("returns 0.5 for a zero-width domain", () => {
    expect(normalizeValue(5, 5, 5)).toBe(0.5);
  });
});

describe("colorForValue", () => {
  it("maps the domain ends to the ramp ends", () => {
    const domain = { min: 100, max: 180 };
    expect(colorForValue(domain, 100)).toBe(rampColor(0));
    expect(colorForValue(domain, 180)).toBe(rampColor(1));
  });

  it("returns the ramp midpoint for a collapsed domain", () => {
    expect(colorForValue({ min: 5, max: 5 }, 5)).toBe(rampColor(0.5));
  });
});

describe("percentileRange", () => {
  const ramp = Array.from({ length: 100 }, (_, i) => i + 1);
  it("returns the 2nd to 98th percentile, ignoring null and non-finite", () => {
    expect(percentileRange([null, undefined, Number.NaN, ...ramp])).toEqual([
      3, 98,
    ]);
  });
  it("honours custom percentiles", () => {
    expect(percentileRange(ramp, 0, 100)).toEqual([1, 100]);
  });
  it("widens a single value so the axis is not degenerate", () => {
    expect(percentileRange([5, 5, 5])).toEqual([4.5, 5.5]);
  });
  it("returns null without finite values", () => {
    expect(percentileRange([])).toBeNull();
    expect(percentileRange([null, Number.POSITIVE_INFINITY])).toBeNull();
  });
});
