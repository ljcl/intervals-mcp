import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handledNotFound,
  handledRateLimit,
  handledSubscriptionRequired,
} from "../__fixtures__";
import { HttpError } from "../fetchClient";
import { toolErrorText } from "./_errors";

describe("toolErrorText", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the rate-limit window on a RateLimitError", () => {
    const text = toolErrorText(handledRateLimit("getSegmentById for ID 789"), {
      context: "fetch segment 789",
    });

    expect(text.startsWith("❌ ")).toBe(true);
    expect(text).toContain("rate limit");
    expect(text).toContain("fetch segment 789");
    expect(text).toContain("15-minute rate limit reached (100/100 requests).");
    expect(text).toContain("Retry after the window resets.");
    // The client function's name is internal detail, not athlete guidance.
    expect(text).not.toContain("getSegmentById");
  });

  it("maps a 404 to the caller's not-found sentence", () => {
    const text = toolErrorText(handledNotFound("getSegmentById"), {
      context: "fetch segment 789",
      notFound: "Segment with ID 789 not found.",
    });

    expect(text).toBe("❌ Segment with ID 789 not found.");
  });

  it("falls back to a generic not-found sentence", () => {
    const text = toolErrorText(handledNotFound("getSegmentById"), {
      context: "fetch segment 789",
    });

    expect(text).toBe("❌ Not found.");
  });

  it("maps a 402 to the subscription sentence, by status not message", () => {
    const withDefault = toolErrorText(
      handledSubscriptionRequired("listSegmentEfforts"),
      { context: "list efforts for segment 789" },
    );
    expect(withDefault).toContain(
      "❌ This feature requires a Strava subscription.",
    );

    // A plain Error carrying the prefix is not a 402; only the status counts.
    const spoofed = toolErrorText(
      new Error("SUBSCRIPTION_REQUIRED: payment needed"),
      { context: "list efforts for segment 789" },
    );
    expect(spoofed).toBe(
      "❌ Failed to list efforts for segment 789: SUBSCRIPTION_REQUIRED: payment needed",
    );
  });

  it("does not read a 404 out of a message that merely mentions it", () => {
    const text = toolErrorText(new Error("Segment 404 renamed"), {
      context: "fetch segment 404",
      notFound: "Segment with ID 404 not found.",
    });

    expect(text).toBe("❌ Failed to fetch segment 404: Segment 404 renamed");
  });

  it("reports other HTTP statuses with the message", () => {
    const text = toolErrorText(
      new HttpError("Strava API Error in getSegmentById (500): boom", {
        status: 500,
        statusText: "Internal Server Error",
        data: "",
      }),
      { context: "fetch segment 789" },
    );

    expect(text).toBe(
      "❌ Failed to fetch segment 789: Strava API Error in getSegmentById (500): boom",
    );
  });

  it("never throws on a non-Error input", () => {
    expect(toolErrorText(undefined, { context: "fetch segment 789" })).toBe(
      "❌ Failed to fetch segment 789: undefined",
    );
    expect(toolErrorText(null, { context: "fetch segment 789" })).toBe(
      "❌ Failed to fetch segment 789: null",
    );
    expect(
      toolErrorText("string failure", { context: "fetch segment 789" }),
    ).toBe("❌ Failed to fetch segment 789: string failure");
  });

  it("keeps the detail in operator logs", () => {
    toolErrorText(new Error("Bad Gateway"), { context: "fetch segment 789" });

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("fetch segment 789"),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Bad Gateway"),
    );
  });
});
