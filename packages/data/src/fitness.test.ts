import { describe, expect, it } from "vitest";
import { fitnessSourceLabel, formatSignedTsb } from "./fitness";

describe("formatSignedTsb", () => {
  it("signs a positive value and leaves a negative one alone", () => {
    expect(formatSignedTsb(12)).toBe("+12");
    expect(formatSignedTsb(-8.4)).toBe("-8.4");
  });

  it("prints zero without a sign", () => {
    expect(formatSignedTsb(0)).toBe("0");
  });

  it("rounds to one decimal", () => {
    expect(formatSignedTsb(4.06)).toBe("+4.1");
    expect(formatSignedTsb(4.2)).toBe("+4.2");
    expect(formatSignedTsb(-3.6)).toBe("-3.6");
  });
});

describe("fitnessSourceLabel", () => {
  it("says so when the numbers were computed locally", () => {
    expect(fitnessSourceLabel("computed")).toBe("Computed locally");
  });

  it("names intervals.icu for its own wellness", () => {
    expect(fitnessSourceLabel("intervals.icu")).toBe("From intervals.icu");
  });

  it("defaults to intervals.icu when the source is unknown", () => {
    expect(fitnessSourceLabel(null)).toBe("From intervals.icu");
    expect(fitnessSourceLabel(undefined)).toBe("From intervals.icu");
  });
});
