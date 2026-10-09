import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handledNotFound,
  handledRateLimit,
  handledSubscriptionRequired,
} from "../__fixtures__";
import { type CallScope, runInCallScope } from "../callScope";
import { HttpError, RequestTimeoutError } from "../fetchClient";
import { IntervalsApiError } from "../intervalsClient";
import {
  noteToolFailure,
  prefixedErrorText,
  toolErrorText,
  toolFailureOf,
  unavailableReason,
} from "./_errors";

describe("toolErrorText", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the rate-limit window on a RateLimitError", () => {
    const text = toolErrorText(handledRateLimit("getActivityById for ID 789"), {
      context: "fetch activity 789",
    });

    expect(text.startsWith("❌ ")).toBe(true);
    expect(text).toBe(
      "❌ Rate limit reached while trying to fetch activity 789. 15-minute rate limit reached (100/100 requests). Retry after the window resets.",
    );
    // The client function's name is internal detail, not athlete guidance.
    expect(text).not.toContain("getActivityById");
    // Provider-neutral: no Strava-specific wording.
    expect(text).not.toContain("Strava");
  });

  it("maps a 404 to the caller's not-found sentence", () => {
    const text = toolErrorText(handledNotFound("getActivityById"), {
      context: "fetch activity 789",
      notFound: "Activity with ID 789 not found.",
    });

    expect(text).toBe("❌ Activity with ID 789 not found.");
  });

  it("falls back to a generic not-found sentence", () => {
    const text = toolErrorText(handledNotFound("getActivityById"), {
      context: "fetch activity 789",
    });

    expect(text).toBe("❌ Not found.");
  });

  it("maps a 402 to the subscription sentence, by status not message", () => {
    const withDefault = toolErrorText(
      handledSubscriptionRequired("getActivities"),
      { context: "list recent activities" },
    );
    expect(withDefault).toContain(
      "❌ This feature requires a paid subscription.",
    );

    // A plain Error carrying the prefix is not a 402; only the status counts.
    const spoofed = toolErrorText(
      new Error("SUBSCRIPTION_REQUIRED: payment needed"),
      { context: "list recent activities" },
    );
    expect(spoofed).toBe(
      "❌ Failed to list recent activities: SUBSCRIPTION_REQUIRED: payment needed",
    );
  });

  it("does not read a 404 out of a message that merely mentions it", () => {
    const text = toolErrorText(new Error("Activity 404 renamed"), {
      context: "fetch activity 404",
      notFound: "Activity with ID 404 not found.",
    });

    expect(text).toBe("❌ Failed to fetch activity 404: Activity 404 renamed");
  });

  it("maps a 401 or 403 to a message naming INTERVALS_API_KEY", () => {
    const unauthorized = toolErrorText(
      new HttpError("HTTP 401: Unauthorized", {
        status: 401,
        statusText: "Unauthorized",
        data: "",
      }),
      { context: "list recent activities" },
    );
    expect(unauthorized).toBe(
      "❌ intervals.icu rejected the API key (HTTP 401). Check INTERVALS_API_KEY.",
    );

    const forbidden = toolErrorText(
      new HttpError("HTTP 403: Forbidden", {
        status: 403,
        statusText: "Forbidden",
        data: "",
      }),
      { context: "list recent activities" },
    );
    expect(forbidden).toBe(
      "❌ intervals.icu rejected the API key (HTTP 403). Check INTERVALS_API_KEY.",
    );
  });

  it("reports a Cloudflare challenge as a challenge, not a rejected API key", () => {
    const text = toolErrorText(
      new HttpError('HTTP 403: HTML error page "Just a moment..."', {
        status: 403,
        statusText: "Forbidden",
        data: "<!DOCTYPE html><html><head><title>Just a moment...</title>",
        contentType: "text/html; charset=UTF-8",
        cloudflareChallenge: true,
      }),
      { context: "list recent activities" },
    );

    expect(text).toBe(
      "❌ Cloudflare, in front of intervals.icu, answered with a challenge (HTTP 403) while trying to list recent activities. The request did not reach intervals.icu, so the API key was not checked. Wait a few minutes, then try again.",
    );
    expect(text).not.toContain("INTERVALS_API_KEY");
  });

  it("reports other HTTP statuses with the message", () => {
    const text = toolErrorText(
      new HttpError("intervals.icu API Error in getActivity (500): boom", {
        status: 500,
        statusText: "Internal Server Error",
        data: "",
      }),
      { context: "fetch activity 789" },
    );

    expect(text).toBe(
      "❌ Failed to fetch activity 789: intervals.icu API Error in getActivity (500): boom",
    );
  });

  it("never throws on a non-Error input", () => {
    expect(toolErrorText(undefined, { context: "fetch activity 789" })).toBe(
      "❌ Failed to fetch activity 789: undefined",
    );
    expect(toolErrorText(null, { context: "fetch activity 789" })).toBe(
      "❌ Failed to fetch activity 789: null",
    );
    expect(
      toolErrorText("string failure", { context: "fetch activity 789" }),
    ).toBe("❌ Failed to fetch activity 789: string failure");
  });

  it("names INTERVALS_API_KEY for an IntervalsApiError 401", () => {
    const text = toolErrorText(
      new IntervalsApiError("getActivity for ID i1: 401 Unauthorized", {
        status: 401,
        statusText: "Unauthorized",
        data: "",
      }),
      { context: "fetch activity i1" },
    );

    expect(text).toBe(
      "❌ intervals.icu rejected the API key (HTTP 401). Check INTERVALS_API_KEY.",
    );
  });

  it("keeps the detail in operator logs", () => {
    toolErrorText(new Error("Bad Gateway"), { context: "fetch activity 789" });

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("fetch activity 789"),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Bad Gateway"),
    );
  });
});

describe("prefixedErrorText", () => {
  it("puts the same prefix in front of a plain message", () => {
    expect(prefixedErrorText("Unknown tool: not-a-tool")).toBe(
      "❌ Unknown tool: not-a-tool",
    );
  });
});

describe("the failure noted for the call log", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The failure `toolErrorText` leaves in a fresh call scope for `error`. */
  function notedFor(error: unknown): CallScope["failure"] {
    const scope: CallScope = {};
    runInCallScope(scope, () => toolErrorText(error, { context: "do it" }));
    return scope.failure;
  }

  it("notes the class and status of a rate limit", () => {
    expect(notedFor(handledRateLimit("getActivity"))).toEqual({
      error_class: "RateLimitError",
      http_status: 429,
    });
  });

  it("notes the class and status of a 404", () => {
    expect(notedFor(handledNotFound("getActivity"))).toEqual({
      error_class: "HttpError",
      http_status: 404,
    });
  });

  it("notes a real IntervalsApiError with its status", () => {
    expect(
      notedFor(
        new IntervalsApiError("getActivity: 503", {
          status: 503,
          statusText: "Service Unavailable",
          data: "",
        }),
      ),
    ).toEqual({ error_class: "IntervalsApiError", http_status: 503 });
  });

  it("notes the class only for an error with no status", () => {
    expect(
      notedFor(new RequestTimeoutError("https://x.test/a", 20_000)),
    ).toEqual({ error_class: "RequestTimeoutError" });
  });

  it.each([null, undefined, "failure"])(
    "notes NonError for %j and still returns the text",
    (value) => {
      const scope: CallScope = {};
      const text = runInCallScope(scope, () =>
        toolErrorText(value, { context: "do it" }),
      );
      expect(text.startsWith("❌ ")).toBe(true);
      expect(scope.failure).toEqual({ error_class: "NonError" });
    },
  );

  it("leaves the texts alone and does not throw outside a scope", () => {
    expect(() =>
      toolErrorText(handledNotFound("getActivity"), { context: "do it" }),
    ).not.toThrow();
    expect(
      toolErrorText(handledNotFound("getActivity"), { context: "do it" }),
    ).toBe("❌ Not found.");
  });
});

describe("toolFailureOf", () => {
  it.each([
    ["a plain Error", new Error("x"), { error_class: "Error" }],
    ["a TypeError", new TypeError("x"), { error_class: "TypeError" }],
    [
      "an HttpError",
      new HttpError("x", { status: 500, statusText: "", data: "" }),
      { error_class: "HttpError", http_status: 500 },
    ],
    ["a string", "x", { error_class: "NonError" }],
    ["null", null, { error_class: "NonError" }],
    ["an object", { status: 404 }, { error_class: "NonError" }],
  ])("maps %s", (_name, error, expected) => {
    expect(toolFailureOf(error)).toEqual(expected);
  });

  it("falls back to Error for an error class with no name", () => {
    const Anonymous = (() => class extends Error {})();
    Object.defineProperty(Anonymous, "name", { value: "" });
    expect(toolFailureOf(new Anonymous("x"))).toEqual({ error_class: "Error" });
  });

  it("never throws, even when reading the value throws", () => {
    const hostile = new Proxy(new Error("x"), {
      get(target, key, receiver) {
        if (key === "constructor") throw new Error("boom");
        return Reflect.get(target, key, receiver);
      },
    });
    expect(toolFailureOf(hostile)).toEqual({ error_class: "NonError" });
    expect(() => noteToolFailure(hostile)).not.toThrow();
  });
});

describe("unavailableReason", () => {
  it("names the rate limit on a RateLimitError, before its HttpError status", () => {
    expect(unavailableReason(handledRateLimit("getAthleteHrCurves"))).toBe(
      "the intervals.icu rate limit was reached",
    );
  });

  it("names the HTTP status of any other HttpError", () => {
    expect(unavailableReason(handledNotFound("getAthleteHrCurves"))).toBe(
      "intervals.icu answered HTTP 404",
    );
    expect(
      unavailableReason(
        new HttpError("HTTP 503", { status: 503, statusText: "", data: "" }),
      ),
    ).toBe("intervals.icu answered HTTP 503");
  });

  it("names a Cloudflare challenge rather than its 403", () => {
    expect(
      unavailableReason(
        new HttpError("HTTP 403", {
          status: 403,
          statusText: "Forbidden",
          data: "",
          cloudflareChallenge: true,
        }),
      ),
    ).toBe("Cloudflare, in front of intervals.icu, answered with a challenge");
  });

  it("names a timeout", () => {
    expect(
      unavailableReason(new RequestTimeoutError("https://x/y", 20_000)),
    ).toBe("intervals.icu did not answer in time");
  });

  it("falls back to a generic clause and never throws", () => {
    expect(unavailableReason(new Error("socket hang up"))).toBe(
      "the request failed",
    );
    expect(unavailableReason(null)).toBe("the request failed");
    expect(unavailableReason("boom")).toBe("the request failed");
  });
});
