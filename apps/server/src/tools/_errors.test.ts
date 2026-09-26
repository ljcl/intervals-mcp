import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handledNotFound,
  handledRateLimit,
  handledSubscriptionRequired,
} from "../__fixtures__";
import { HttpError } from "../fetchClient";
import { IntervalsApiError } from "../intervalsClient";
import { prefixedErrorText, toolErrorText } from "./_errors";

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
