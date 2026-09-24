import { afterEach, describe, expect, it } from "vitest";
import {
  basicAuthHeader,
  getIntervalsApiKey,
  getIntervalsAthleteId,
  getTimeZone,
  MissingApiKeyError,
} from "./config";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("getIntervalsApiKey", () => {
  it("returns the trimmed key", () => {
    process.env.INTERVALS_API_KEY = "  abc123 ";
    expect(getIntervalsApiKey()).toBe("abc123");
  });

  it("throws MissingApiKeyError naming the env var when unset", () => {
    delete process.env.INTERVALS_API_KEY;
    expect(() => getIntervalsApiKey()).toThrow(MissingApiKeyError);
    expect(() => getIntervalsApiKey()).toThrow(/INTERVALS_API_KEY/);
  });

  it("treats a whitespace-only key as missing", () => {
    process.env.INTERVALS_API_KEY = "   ";
    expect(() => getIntervalsApiKey()).toThrow(MissingApiKeyError);
  });
});

describe("getIntervalsAthleteId", () => {
  it("defaults to 0, meaning the key's own athlete", () => {
    delete process.env.INTERVALS_ATHLETE_ID;
    expect(getIntervalsAthleteId()).toBe("0");
  });

  it("uses the configured id", () => {
    process.env.INTERVALS_ATHLETE_ID = "i12345";
    expect(getIntervalsAthleteId()).toBe("i12345");
  });
});

describe("getTimeZone", () => {
  it("returns TZ when set", () => {
    process.env.TZ = "Australia/Sydney";
    expect(getTimeZone()).toBe("Australia/Sydney");
  });

  it("falls back to the process's resolved zone when unset", () => {
    delete process.env.TZ;
    expect(getTimeZone()).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  it("falls back to the process's resolved zone when blank", () => {
    process.env.TZ = "   ";
    expect(getTimeZone()).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });
});

describe("basicAuthHeader", () => {
  it("uses the literal API_KEY username", () => {
    expect(basicAuthHeader("abc")).toBe(
      `Basic ${Buffer.from("API_KEY:abc").toString("base64")}`,
    );
  });
});
