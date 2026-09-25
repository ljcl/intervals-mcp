import { describe, expect, it } from "vitest";
import {
  addDays,
  dateInputSchema,
  daysBetween,
  isValidCalendarDate,
  startOfWeekMonday,
  todayLocal,
  validateRange,
} from "./localDate";

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

describe("startOfWeekMonday", () => {
  it("returns the same date for a Monday", () => {
    expect(startOfWeekMonday("2026-09-21")).toBe("2026-09-21");
  });

  it("returns the preceding Monday for a Thursday", () => {
    expect(startOfWeekMonday("2026-09-24")).toBe("2026-09-21");
  });

  it("returns the preceding Monday for a Sunday", () => {
    expect(startOfWeekMonday("2026-09-20")).toBe("2026-09-14");
  });

  it("crosses a month boundary correctly", () => {
    expect(startOfWeekMonday("2026-10-01")).toBe("2026-09-28");
  });
});

describe("isValidCalendarDate", () => {
  it("accepts a real date", () => {
    expect(isValidCalendarDate("2026-09-24")).toBe(true);
  });

  it("accepts the last day of February in a leap year", () => {
    expect(isValidCalendarDate("2028-02-29")).toBe(true);
  });

  it("rejects a day that rolled over (2026-02-30)", () => {
    // Date.UTC silently rolls this into 2026-03-02; the calendar check must
    // catch that rather than accept the shape.
    expect(isValidCalendarDate("2026-02-30")).toBe(false);
  });

  it("rejects February 29 in a non-leap year", () => {
    expect(isValidCalendarDate("2026-02-29")).toBe(false);
  });

  it("rejects a month out of range", () => {
    expect(isValidCalendarDate("2026-13-01")).toBe(false);
  });

  it("rejects a string that isn't YYYY-MM-DD shaped", () => {
    expect(isValidCalendarDate("2026-9-24")).toBe(false);
    expect(isValidCalendarDate("not-a-date")).toBe(false);
  });
});

describe("dateInputSchema", () => {
  it("accepts a real calendar date", () => {
    expect(dateInputSchema.safeParse("2026-09-24").success).toBe(true);
  });

  it("rejects 2026-02-30", () => {
    const result = dateInputSchema.safeParse("2026-02-30");
    expect(result.success).toBe(false);
  });

  it("rejects a malformed string", () => {
    expect(dateInputSchema.safeParse("2026/09/24").success).toBe(false);
  });
});

describe("validateRange", () => {
  it("returns null for a valid, in-bounds range", () => {
    expect(validateRange("2026-09-01", "2026-09-24", 90)).toBeNull();
  });

  it("returns null for the same date both ways (a 1-day range)", () => {
    expect(validateRange("2026-09-24", "2026-09-24", 90)).toBeNull();
  });

  it("flags oldest after newest", () => {
    const result = validateRange("2026-09-24", "2026-09-01", 90);
    expect(result?.message).toContain("after newest");
  });

  it("treats maxDays as a calendar-inclusive count: maxDays consecutive days is in bounds", () => {
    // addDays(oldest, maxDays - 1) is maxDays calendar days inclusive.
    const oldest = "2026-01-01";
    const newest = addDays(oldest, 89);
    expect(validateRange(oldest, newest, 90)).toBeNull();
  });

  it("rejects one calendar day past maxDays", () => {
    const oldest = "2026-01-01";
    const newest = addDays(oldest, 90);
    const result = validateRange(oldest, newest, 90);
    expect(result?.message).toContain("91 days");
    expect(result?.message).toContain("max range is 90 days");
  });
});
