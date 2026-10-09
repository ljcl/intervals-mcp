import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  basicAuthHeader,
  checkConfig,
  getIntervalsApiKey,
  getIntervalsAthleteId,
  getPort,
  getTimeZone,
  MissingApiKeyError,
  setAthleteTimeZone,
  timeZoneNeedsAthlete,
  timeZoneSetting,
} from "./config";
import { isValidTimeZone } from "./utils/localDate";

const ORIGINAL = { ...process.env };

/**
 * Restores the live process.env in place. Replacing it with a plain object
 * (`process.env = { ...ORIGINAL }`) would cut later TZ writes off from
 * Node's Intl. Never assign undefined: process.env stores it as the string
 * "undefined".
 */
function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL);
}

afterEach(() => {
  restoreEnv();
  setAthleteTimeZone(null);
});

/** Sets TZ on the live env, or deletes it for undefined. */
function setTz(raw: string | undefined): void {
  if (raw === undefined) delete process.env.TZ;
  else process.env.TZ = raw;
}

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
  it("returns TZ when set, with source env", () => {
    process.env.TZ = "Australia/Sydney";
    expect(getTimeZone()).toBe("Australia/Sydney");
    expect(timeZoneSetting()).toEqual({
      zone: "Australia/Sydney",
      source: "env",
    });
  });

  // Under Node, Intl names no usable zone for a blank TZ ("Etc/Unknown" or
  // undefined), so the fallback must still give a zone Intl accepts.
  it.each([undefined, "", "   "])(
    "falls back to a valid process zone for TZ=%j with no athlete zone",
    (raw) => {
      setTz(raw);
      const setting = timeZoneSetting();
      expect(setting.source).toBe("fallback");
      expect(isValidTimeZone(setting.zone)).toBe(true);
      expect(getTimeZone()).toBe(setting.zone);
    },
  );

  it.each(["", "   "])("resolves a blank TZ=%j to UTC", (raw) => {
    setTz(raw);
    expect(getTimeZone()).toBe("UTC");
  });

  it.each(["UTC", " UTC "])(
    "treats TZ=%j as unset and follows the athlete",
    (raw) => {
      setTz(raw);
      setAthleteTimeZone("Australia/Sydney");
      expect(timeZoneSetting()).toEqual({
        zone: "Australia/Sydney",
        source: "intervals.icu",
      });
    },
  );

  it("follows the athlete when TZ is unset", () => {
    setTz(undefined);
    setAthleteTimeZone("Australia/Sydney");
    expect(getTimeZone()).toBe("Australia/Sydney");
  });

  it.each(["Etc/UTC", "GMT", "utc"])(
    "pins TZ=%j over the athlete's zone",
    (raw) => {
      setTz(raw);
      setAthleteTimeZone("Australia/Sydney");
      expect(timeZoneSetting()).toEqual({ zone: raw, source: "env" });
    },
  );

  it("prefers an explicit TZ over the athlete's zone", () => {
    setTz("Australia/Brisbane");
    setAthleteTimeZone("Australia/Sydney");
    expect(timeZoneSetting()).toEqual({
      zone: "Australia/Brisbane",
      source: "env",
    });
  });

  // checkConfig stops startup for an unknown TZ; this covers a caller that
  // skipped it.
  it("never returns an unknown TZ", () => {
    setTz("Australia/Sydny");
    const fallback = timeZoneSetting();
    expect(fallback.source).toBe("fallback");
    expect(isValidTimeZone(fallback.zone)).toBe(true);

    setAthleteTimeZone("Australia/Perth");
    expect(timeZoneSetting()).toEqual({
      zone: "Australia/Perth",
      source: "intervals.icu",
    });
  });
});

describe("setAthleteTimeZone", () => {
  beforeEach(() => setTz(undefined));

  it.each(["GMT+10", ""])("refuses %j and keeps the current zone", (zone) => {
    setAthleteTimeZone("Australia/Sydney");
    expect(setAthleteTimeZone(zone)).toBe(false);
    expect(getTimeZone()).toBe("Australia/Sydney");
  });

  it("trims the zone", () => {
    expect(setAthleteTimeZone(" Australia/Perth ")).toBe(true);
    expect(getTimeZone()).toBe("Australia/Perth");
  });

  it("clears the zone for null", () => {
    setAthleteTimeZone("Australia/Perth");
    expect(setAthleteTimeZone(null)).toBe(true);
    expect(timeZoneSetting().source).toBe("fallback");
  });
});

describe("timeZoneNeedsAthlete", () => {
  it.each([undefined, "", "   ", "UTC", "Australia/Sydny"])(
    "is true for TZ=%j",
    (raw) => {
      setTz(raw);
      expect(timeZoneNeedsAthlete()).toBe(true);
    },
  );

  it.each(["Etc/UTC", "Australia/Sydney"])("is false for TZ=%j", (raw) => {
    setTz(raw);
    expect(timeZoneNeedsAthlete()).toBe(false);
  });
});

describe("getPort", () => {
  it.each([
    [undefined, 3000],
    ["", 3000],
    [" 8080 ", 8080],
    ["65535", 65535],
  ])("PORT=%j listens on %i", (raw, expected) => {
    if (raw === undefined) delete process.env.PORT;
    else process.env.PORT = raw;
    expect(getPort()).toBe(expected);
  });

  it.each(["0", "65536", "abc", "80.5", "-1", "1e3"])(
    "throws naming PORT for %j",
    (raw) => {
      process.env.PORT = raw;
      expect(() => getPort()).toThrow(/PORT/);
    },
  );
});

describe("checkConfig", () => {
  /** A valid environment; each test then changes one or more variables. */
  function setValidEnv(): void {
    process.env.INTERVALS_API_KEY = "k-secret-value";
    process.env.TZ = "Australia/Sydney";
    process.env.PORT = "3000";
    process.env.INTERVALS_ATHLETE_ID = "i12345";
    process.env.MCP_AUTH_TOKEN = "t".repeat(64);
  }

  it("passes a valid environment", () => {
    setValidEnv();
    expect(checkConfig()).toEqual({ errors: [], warnings: [] });
  });

  it("reports a missing API key once, naming the variable", () => {
    setValidEnv();
    delete process.env.INTERVALS_API_KEY;
    const { errors } = checkConfig();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/INTERVALS_API_KEY/);
  });

  it("reports an unknown time zone, quoting it", () => {
    setValidEnv();
    process.env.TZ = "Australia/Sydny";
    const { errors } = checkConfig();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^TZ is "Australia\/Sydny"/);
    expect(errors[0]).toContain("athlete's time zone from intervals.icu");
  });

  it.each([undefined, "", "   ", " Australia/Sydney "])(
    "accepts TZ=%j",
    (raw) => {
      setValidEnv();
      if (raw === undefined) delete process.env.TZ;
      else process.env.TZ = raw;
      expect(checkConfig().errors).toEqual([]);
    },
  );

  it("accepts a blank PORT as the default", () => {
    setValidEnv();
    process.env.PORT = "";
    expect(checkConfig().errors).toEqual([]);
  });

  it.each(["abc", "0", "70000"])("reports PORT=%j", (raw) => {
    setValidEnv();
    process.env.PORT = raw;
    const { errors } = checkConfig();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^PORT is /);
  });

  it.each(["", "0", "123", "i123", " i123 "])(
    "accepts INTERVALS_ATHLETE_ID=%j",
    (raw) => {
      setValidEnv();
      process.env.INTERVALS_ATHLETE_ID = raw;
      expect(checkConfig().errors).toEqual([]);
    },
  );

  it.each(["abc", "i12x", "12 34", "I123"])(
    "reports INTERVALS_ATHLETE_ID=%j",
    (raw) => {
      setValidEnv();
      process.env.INTERVALS_ATHLETE_ID = raw;
      const { errors } = checkConfig();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^INTERVALS_ATHLETE_ID is /);
    },
  );

  it("reports every bad variable, not just the first", () => {
    setValidEnv();
    process.env.TZ = "Australia/Sydny";
    process.env.PORT = "abc";
    process.env.INTERVALS_ATHLETE_ID = "abc";
    const { errors } = checkConfig();
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/^TZ /);
    expect(errors[1]).toMatch(/^PORT /);
    expect(errors[2]).toMatch(/^INTERVALS_ATHLETE_ID /);
  });

  it("cuts a long value to 64 characters in the message", () => {
    setValidEnv();
    process.env.TZ = `Australia/${"x".repeat(100)}`;
    const [error] = checkConfig().errors;
    expect(error).toContain(`"Australia/${"x".repeat(54)}"…`);
    expect(error).not.toContain("x".repeat(55));
  });

  it("warns about a short token without quoting it", () => {
    setValidEnv();
    process.env.MCP_AUTH_TOKEN = "s3cret";
    const { errors, warnings } = checkConfig();
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MCP_AUTH_TOKEN");
    expect(warnings[0]).toContain("6 characters");
    expect(warnings[0]).not.toContain("s3cret");
  });

  it("stops on a whitespace-padded token, without a length warning", () => {
    setValidEnv();
    // Shorter than 32 characters, so the whitespace error must replace the length warning.
    process.env.MCP_AUTH_TOKEN = " s3cret";
    const { errors, warnings } = checkConfig();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^MCP_AUTH_TOKEN /);
    expect(errors[0]).not.toContain("s3cret");
    expect(warnings).toEqual([]);
  });

  it("does not warn about a 64-character token or an unset one", () => {
    setValidEnv();
    expect(checkConfig().warnings).toEqual([]);
    delete process.env.MCP_AUTH_TOKEN;
    expect(checkConfig().warnings).toEqual([]);
  });

  it("never puts the API key in a message", () => {
    setValidEnv();
    process.env.TZ = "Australia/Sydny";
    process.env.PORT = "abc";
    process.env.INTERVALS_ATHLETE_ID = "abc";
    process.env.MCP_AUTH_TOKEN = "short";
    const { errors, warnings } = checkConfig();
    expect(errors.length + warnings.length).toBe(4);
    for (const message of [...errors, ...warnings]) {
      expect(message).not.toContain("k-secret-value");
    }
  });
});

describe("basicAuthHeader", () => {
  it("uses the literal API_KEY username", () => {
    expect(basicAuthHeader("abc")).toBe(
      `Basic ${Buffer.from("API_KEY:abc").toString("base64")}`,
    );
  });
});
