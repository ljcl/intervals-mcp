import { describe, expect, it } from "vitest";
import {
  LATLNG_DECIMALS,
  rawUnitDecimals,
  roundColumn,
  STREAM_DECIMALS,
} from "./streamPrecision";

describe("STREAM_DECIMALS", () => {
  it("gives no stream more than 2 decimals", () => {
    for (const decimals of Object.values(STREAM_DECIMALS)) {
      expect(decimals).toBeLessThanOrEqual(2);
    }
  });

  it("rounds coordinates to 5 decimals (about 1.1 m)", () => {
    expect(LATLNG_DECIMALS).toBe(5);
  });
});

describe("rawUnitDecimals", () => {
  it("gives cadence one more decimal, because the payloads send strides/min", () => {
    expect(rawUnitDecimals("cadence")).toBe(STREAM_DECIMALS.cadence + 1);
  });

  it("matches STREAM_DECIMALS for every other type", () => {
    for (const [type, decimals] of Object.entries(STREAM_DECIMALS)) {
      if (type === "cadence") continue;
      expect(rawUnitDecimals(type as keyof typeof STREAM_DECIMALS)).toBe(
        decimals,
      );
    }
  });
});

describe("roundColumn", () => {
  it("rounds each number and keeps each null", () => {
    expect(roundColumn([144.66666666666666, null, 7.12345], 2)).toEqual([
      144.67,
      null,
      7.12,
    ]);
  });

  it("returns a new array and leaves its input unchanged", () => {
    const input = [1.23456, null, 2.5];
    const output = roundColumn(input, 0);

    expect(output).not.toBe(input);
    expect(output).toEqual([1, null, 3]);
    expect(input).toEqual([1.23456, null, 2.5]);
  });
});
