import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatDistance,
  formatDurationShort,
  formatPace,
  formatShortDate,
  formatSpeedAsKmh,
  formatSpeedAsPace,
  formatTime,
} from "./formatting";

describe("formatTime", () => {
  it("formats minutes and seconds under an hour", () => {
    expect(formatTime(0)).toBe("00:00");
    expect(formatTime(65)).toBe("01:05");
    expect(formatTime(3599)).toBe("59:59");
  });

  it("adds an hours segment at 3600s and beyond", () => {
    expect(formatTime(3600)).toBe("1:00:00");
    expect(formatTime(3725)).toBe("1:02:05");
    expect(formatTime(36_000)).toBe("10:00:00");
  });

  it("truncates fractional seconds", () => {
    expect(formatTime(59.9)).toBe("00:59");
  });
});

describe("formatClock", () => {
  it("leaves the leading minute unpadded under an hour", () => {
    expect(formatClock(24)).toBe("0:24");
    expect(formatClock(244)).toBe("4:04");
    expect(formatClock(770)).toBe("12:50");
  });

  it("pads minutes once an hours segment appears", () => {
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(3924)).toBe("1:05:24");
    expect(formatClock(3600)).toBe("1:00:00");
  });

  it("rounds fractional seconds rather than truncating", () => {
    // 119.6s truncates to 1:59, which reads as a different effort time.
    expect(formatClock(119.6)).toBe("2:00");
  });
});

describe("formatShortDate", () => {
  it("omits the year by default", () => {
    expect(formatShortDate("2026-03-29T06:51:00Z")).toBe("29 Mar");
  });

  it("appends a two-digit year on short", () => {
    expect(formatShortDate("2025-09-14T07:12:00Z", "short")).toBe("14 Sep 25");
  });

  it("appends a four-digit year on full", () => {
    expect(formatShortDate("2025-09-14T07:12:00Z", "full")).toBe("14 Sep 2025");
  });

  it("reads the date in UTC so the label never shifts by timezone", () => {
    // 23:30Z is the next day in UTC+11 and the previous day in UTC-5.
    expect(formatShortDate("2026-01-31T23:30:00Z")).toBe("31 Jan");
    // Date-only ISO strings parse as UTC midnight.
    expect(formatShortDate("2026-01-05")).toBe("5 Jan");
  });
});

describe("formatDurationShort", () => {
  it("renders minutes alone under an hour", () => {
    expect(formatDurationShort(180)).toBe("3m");
    expect(formatDurationShort(2700)).toBe("45m");
  });

  it("pads the minutes segment to two digits", () => {
    expect(formatDurationShort(3900)).toBe("1h 05m");
    expect(formatDurationShort(99_900)).toBe("27h 45m");
  });

  it("drops the minutes segment when it rounds to zero", () => {
    expect(formatDurationShort(3600)).toBe("1h");
    expect(formatDurationShort(10_800)).toBe("3h");
  });

  it("rounds to the nearest minute", () => {
    expect(formatDurationShort(7196)).toBe("2h");
    expect(formatDurationShort(29)).toBe("0m");
  });
});

describe("formatDistance", () => {
  it("rounds to whole metres", () => {
    expect(formatDistance(999.4)).toBe("999m");
    expect(formatDistance(999.5)).toBe("1000m");
  });
});

describe("formatPace", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(formatPace(5.5)).toBe(`5'30"`);
    expect(formatPace(4.05)).toBe(`4'03"`);
  });

  it("rolls 60 seconds over into the next minute", () => {
    // 4.9999 min → 4'60" without the rollover guard.
    expect(formatPace(4.9999)).toBe(`5'00"`);
  });
});

describe("formatSpeedAsPace", () => {
  it("converts metres per second to a per-kilometre pace", () => {
    expect(formatSpeedAsPace(4)).toBe(`4'10" /km`);
    expect(formatSpeedAsPace(3.125)).toBe(`5'20" /km`);
  });

  it("reads anything slower than a walk as paused", () => {
    // 0.2 m/s formats as 83'20" /km, which describes nothing.
    expect(formatSpeedAsPace(0.2)).toBe("—");
    expect(formatSpeedAsPace(0)).toBe("—");
  });
});

describe("formatSpeedAsKmh", () => {
  it("converts metres per second to km/h at one decimal", () => {
    expect(formatSpeedAsKmh(7.9)).toBe("28.4 km/h");
  });

  it("has no paused floor — zero is a true speed reading", () => {
    expect(formatSpeedAsKmh(0)).toBe("0.0 km/h");
  });
});
