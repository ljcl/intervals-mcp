import { describe, expect, it } from "vitest";
import { smooth } from "./smoothing";

interface Point {
  time: number;
  value?: number | null;
  label?: string;
}

const points = (values: Array<number | null | undefined>): Point[] =>
  values.map((value, time) => ({ time, value, label: `p${time}` }));

describe("smooth", () => {
  it("averages each point over the centred window", () => {
    const result = smooth(points([0, 10, 20, 30, 40]), ["value"], 3);

    // Interior points average themselves with one neighbour on each side.
    expect(result[2]?.value).toBeCloseTo((10 + 20 + 30) / 3);
  });

  it("shrinks the window at the boundaries instead of dropping data", () => {
    const result = smooth(points([0, 10, 20, 30, 40]), ["value"], 3);

    expect(result).toHaveLength(5);
    expect(result[0]?.value).toBeCloseTo((0 + 10) / 2);
    expect(result[4]?.value).toBeCloseTo((30 + 40) / 2);
  });

  it("skips undefined values in the window and leaves undefined points alone", () => {
    const result = smooth(points([0, undefined, 20]), ["value"], 3);

    // The undefined point stays undefined...
    expect(result[1]?.value).toBeUndefined();
    // ...and its neighbours average only the defined values in range.
    expect(result[0]?.value).toBeCloseTo(0 / 1);
    expect(result[2]?.value).toBeCloseTo(20 / 1);
  });

  it("copies non-smoothed fields untouched", () => {
    const result = smooth(points([0, 10, 20]), ["value"], 3);

    expect(result[1]?.label).toBe("p1");
    expect(result[1]?.time).toBe(1);
  });

  it("returns short series unchanged (fewer than 3 points)", () => {
    const input = points([5, 15]);

    expect(smooth(input, ["value"], 5)).toBe(input);
  });

  it("excludes null samples from the window average", () => {
    // A single dropout between two real readings: the window average for
    // the real points on either side should ignore the null, not treat it
    // as zero.
    const result = smooth(points([10, null, 30, 40, 50]), ["value"], 3);

    expect(result[0]?.value).toBeCloseTo(10 / 1);
    expect(result[3]?.value).toBeCloseTo((30 + 40 + 50) / 3);
  });

  it("fills a null point with the mean of its non-null neighbours", () => {
    const result = smooth(points([10, null, 30]), ["value"], 3);

    expect(result[1]?.value).toBeCloseTo((10 + 30) / 2);
  });

  it("keeps a null point null when its whole window is null", () => {
    const result = smooth(points([null, null, null, 10, 20]), ["value"], 3);

    expect(result[0]?.value).toBeNull();
    expect(result[1]?.value).toBeNull();
  });

  it("leaves a genuinely absent (undefined) key untouched", () => {
    const result = smooth(points([0, undefined, 20]), ["value"], 3);

    expect(result[1]?.value).toBeUndefined();
  });
});
