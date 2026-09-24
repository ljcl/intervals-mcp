import { describe, expect, it } from "vitest";
import {
  type Columns,
  downsampleColumns,
  lastValuePerBucket,
} from "./streamDownsample";

describe("downsampleColumns", () => {
  it("buckets a hand-computed input: last value for time/distance, mean elsewhere", () => {
    // 10 samples -> 3 buckets: [0,3), [3,6), [6,10).
    const columns: Columns = {
      time: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      distance: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90],
      heartrate: [100, 110, 120, 130, 140, 150, 160, 170, 180, 190],
    };

    const result = downsampleColumns(columns, 3);

    // time/distance take the last sample of each bucket.
    expect(result.time).toEqual([2, 5, 9]);
    expect(result.distance).toEqual([20, 50, 90]);
    // heartrate is the mean of each bucket: (100+110+120)/3, (130+140+150)/3, (160+170+180+190)/4.
    expect(result.heartrate).toEqual([110, 140, 175]);
  });

  it("treats a null as absent from the mean, and an all-null bucket as null", () => {
    // 10 samples -> 3 buckets: [0,3) all null, [3,6), [6,10).
    const columns: Columns = {
      cadence: [null, null, null, 5, null, 7, 8, 9, 10, 11],
    };

    const result = downsampleColumns(columns, 3);

    expect(result.cadence).toEqual([null, 6, 9.5]);
  });

  it("returns the input unchanged, by reference, when length equals maxPoints", () => {
    const columns: Columns = { heartrate: [1, 2, 3, 4, 5] };
    expect(downsampleColumns(columns, 5)).toBe(columns);
  });

  it("returns the input unchanged, by reference, when maxPoints exceeds the input length", () => {
    const columns: Columns = { heartrate: [1, 2, 3] };
    expect(downsampleColumns(columns, 200)).toBe(columns);
  });

  it("returns an empty columns object unchanged", () => {
    const columns: Columns = {};
    expect(downsampleColumns(columns, 100)).toBe(columns);
  });

  it("null time/distance samples at a bucket boundary stay null rather than falling back to a neighbour", () => {
    const columns: Columns = {
      time: [0, 1, null, 3, 4, null],
    };
    // 6 samples -> 2 buckets: [0,3), [3,6); last sample of each is null.
    const result = downsampleColumns(columns, 2);
    expect(result.time).toEqual([null, null]);
  });
});

describe("lastValuePerBucket", () => {
  it("applies the same last-of-bucket rule as time/distance", () => {
    const data = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    expect(lastValuePerBucket(data, 3)).toEqual([12, 15, 19]);
  });

  it("returns data unchanged, by reference, when it already fits maxPoints", () => {
    const data = [1, 2, 3];
    expect(lastValuePerBucket(data, 10)).toBe(data);
  });

  it("propagates a null last sample", () => {
    // 6 samples -> 3 buckets: [0,2), [2,4), [4,6); the last bucket's last sample is null.
    const data = [1, 2, null, 4, 5, null];
    expect(lastValuePerBucket(data, 3)).toEqual([2, 4, null]);
  });
});
