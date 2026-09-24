import { describe, expect, it } from "vitest";
import { addDays, daysBetween, todayLocal } from "./localDate";

describe("todayLocal", () => {
  it("formats an injected clock as YYYY-MM-DD in the given zone", () => {
    const now = new Date("2026-09-24T16:25:25Z");
    expect(todayLocal("UTC", now)).toBe("2026-09-24");
  });

  it("crosses the date line ahead of UTC", () => {
    // 16:25 UTC is already the next local day in Sydney.
    const now = new Date("2026-09-24T16:25:25Z");
    expect(todayLocal("Australia/Sydney", now)).toBe("2026-09-25");
  });

  it("crosses the date line behind UTC", () => {
    // 02:25 UTC is still the previous local day in New York.
    const now = new Date("2026-09-24T02:25:25Z");
    expect(todayLocal("America/New_York", now)).toBe("2026-09-23");
  });
});

describe("addDays", () => {
  it("adds days within a month", () => {
    expect(addDays("2026-09-01", 5)).toBe("2026-09-06");
  });

  it("subtracts days across a month boundary", () => {
    expect(addDays("2026-09-05", -10)).toBe("2026-08-26");
  });

  it("subtracts days across a year boundary", () => {
    expect(addDays("2026-01-02", -5)).toBe("2025-12-28");
  });

  it("returns the same date for n = 0", () => {
    expect(addDays("2026-09-24", 0)).toBe("2026-09-24");
  });
});

describe("daysBetween", () => {
  it("returns 0 for the same date", () => {
    expect(daysBetween("2026-09-24", "2026-09-24")).toBe(0);
  });

  it("counts whole days within a month", () => {
    expect(daysBetween("2026-09-01", "2026-09-24")).toBe(23);
  });

  it("counts across a month boundary", () => {
    expect(daysBetween("2026-08-28", "2026-09-24")).toBe(27);
  });

  it("counts across a year boundary", () => {
    expect(daysBetween("2025-12-28", "2026-01-02")).toBe(5);
  });

  it("matches addDays: daysBetween(d, addDays(d, n)) === n", () => {
    expect(daysBetween("2026-06-26", addDays("2026-06-26", 90))).toBe(90);
  });
});
