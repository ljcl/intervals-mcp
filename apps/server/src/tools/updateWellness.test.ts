import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CallCancelledError,
  type CallScope,
  runInCallScope,
} from "../callScope";
import { HttpError, RateLimitError, RequestTimeoutError } from "../fetchClient";
import {
  getWellnessDay,
  type IntervalsWellness,
  updateWellness as putWellness,
} from "../intervalsClient";
import { WellnessWriteOutputSchema } from "./outputs";
import { updateWellnessTool } from "./updateWellness";

vi.mock("../intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../intervalsClient")>();
  return {
    ...actual,
    getWellnessDay: vi.fn(),
    updateWellness: vi.fn(),
  };
});

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return {
    ...actual,
    getIntervalsApiKey: vi.fn(() => "test-token"),
    getTimeZone: vi.fn(() => "Australia/Sydney"),
  };
});

const mockedRead = vi.mocked(getWellnessDay);
const mockedPut = vi.mocked(putWellness);

const DATE = "2026-10-20";

function day(overrides: Partial<IntervalsWellness> = {}): IntervalsWellness {
  return {
    id: DATE,
    soreness: null,
    fatigue: null,
    stress: null,
    mood: null,
    motivation: null,
    injury: null,
    sleepQuality: null,
    comments: null,
    locked: null,
    hrvSDNN: 48,
    ...overrides,
  } as IntervalsWellness;
}

function run(input: Record<string, unknown>) {
  return updateWellnessTool.execute(input as never, "test-token");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
  return () => vi.useRealTimers();
});

describe("updateWellnessTool input schema", () => {
  const parse = (input: Record<string, unknown>) =>
    updateWellnessTool.inputSchema.safeParse(input).success;

  it("takes scores 1 to 4 or null", () => {
    expect(parse({ soreness: 1 })).toBe(true);
    expect(parse({ sleepQuality: 4 })).toBe(true);
    expect(parse({ injury: null })).toBe(true);
    expect(parse({ fatigue: 0 })).toBe(false);
    expect(parse({ fatigue: 5 })).toBe(false);
    expect(parse({ mood: 2.5 })).toBe(false);
  });

  it("rejects a bad date, commentsMode alone, and an empty append", () => {
    expect(parse({ date: "2026-02-30", soreness: 2 })).toBe(false);
    expect(parse({ commentsMode: "append" })).toBe(false);
    expect(parse({ comments: "  ", commentsMode: "append" })).toBe(false);
    expect(parse({ comments: "", commentsMode: "replace" })).toBe(true);
  });
});

describe("updateWellnessTool.execute", () => {
  it("refuses a call with nothing to change, without a request", async () => {
    const result = await run({ date: DATE });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^❌ Nothing to update/);
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it("refuses a date after today, without a request", async () => {
    const result = await run({ date: "2026-10-28", soreness: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("after today (2026-10-27)");
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it("writes today in the configured time zone when no date is given", async () => {
    mockedRead.mockResolvedValueOnce(day({ id: "2026-10-27" }));
    mockedPut.mockResolvedValueOnce(day());
    mockedRead.mockResolvedValueOnce(day({ id: "2026-10-27", fatigue: 3 }));

    const result = await run({ fatigue: 3 });

    expect(mockedRead).toHaveBeenNthCalledWith(1, "test-token", "2026-10-27", {
      skipCache: true,
    });
    expect(mockedPut).toHaveBeenCalledWith("test-token", "2026-10-27", {
      fatigue: 3,
    });
    expect(result.isError).toBeUndefined();
  });

  it("sends only the changed fields once, re-reads, and echoes before and after with labels", async () => {
    mockedRead.mockResolvedValueOnce(day({ fatigue: 2 }));
    mockedPut.mockResolvedValueOnce(day());
    mockedRead.mockResolvedValueOnce(
      day({ fatigue: 2, soreness: 3, injury: 2, comments: "left calf tight" }),
    );

    const result = await run({
      date: DATE,
      soreness: 3,
      fatigue: 2,
      injury: 2,
      comments: "left calf tight",
    });

    expect(mockedPut).toHaveBeenCalledTimes(1);
    expect(mockedPut).toHaveBeenCalledWith("test-token", DATE, {
      soreness: 3,
      injury: 2,
      comments: "left calf tight",
    });
    expect(mockedRead).toHaveBeenLastCalledWith("test-token", DATE, {
      skipCache: true,
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain(`Updated wellness for ${DATE}`);
    expect(text).toContain("soreness to 3 (High) (was nothing)");
    expect(text).toContain("injury to 2 (Niggle) (was nothing)");
    expect(text).toContain('comments to 15 chars ("left calf tight")');

    const structured = WellnessWriteOutputSchema.parse(
      result.structuredContent,
    );
    expect(structured.date).toBe(DATE);
    expect(structured.locked).toBe(false);
    expect(structured.day.soreness).toBe(3);
    expect(structured.day.injury).toBe(2);
    expect(structured.changes).toEqual([
      { field: "soreness", before: null, after: 3 },
      { field: "injury", before: null, after: 2 },
      { field: "comments", before: null, after: "left calf tight" },
    ]);
    expect(structured.warnings).toEqual([]);
  });

  it("never sends device fields", async () => {
    mockedRead.mockResolvedValueOnce(day());
    mockedPut.mockResolvedValueOnce(day());
    mockedRead.mockResolvedValueOnce(day({ mood: 1 }));

    await run({ date: DATE, mood: 1 });

    const patch = mockedPut.mock.calls[0]?.[2] ?? {};
    expect(Object.keys(patch)).toEqual(["mood"]);
  });

  it("clears a score with -1", async () => {
    mockedRead.mockResolvedValueOnce(day({ injury: 3 }));
    mockedPut.mockResolvedValueOnce(day());
    mockedRead.mockResolvedValueOnce(day());

    const result = await run({ date: DATE, injury: null });

    expect(mockedPut).toHaveBeenCalledWith("test-token", DATE, { injury: -1 });
    expect(result.content[0]?.text).toContain(
      "injury to nothing (was 3 (Poor))",
    );
  });

  it("reports no change, with no PUT, when the day already matches", async () => {
    mockedRead.mockResolvedValueOnce(day({ stress: 2 }));

    const result = await run({ date: DATE, stress: 2, mood: null });

    expect(mockedPut).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toBe(
      `No change: wellness for ${DATE} already matches the requested values.`,
    );
    expect(
      WellnessWriteOutputSchema.parse(result.structuredContent).changes,
    ).toEqual([]);
  });

  it("refuses comments that would overwrite the day's comments with no commentsMode", async () => {
    mockedRead.mockResolvedValueOnce(day({ comments: "slept badly" }));

    const result = await run({ date: DATE, comments: "legs heavy" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('"slept badly"');
    expect(result.content[0]?.text).toContain('"append"');
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it("appends comments below the day's comments", async () => {
    mockedRead.mockResolvedValueOnce(day({ comments: "slept badly" }));
    mockedPut.mockResolvedValueOnce(day());
    mockedRead.mockResolvedValueOnce(
      day({ comments: "slept badly\n\nlegs heavy" }),
    );

    const result = await run({
      date: DATE,
      comments: "legs heavy",
      commentsMode: "append",
    });

    expect(mockedPut).toHaveBeenCalledWith("test-token", DATE, {
      comments: "slept badly\n\nlegs heavy",
    });
    expect(result.content[0]?.text).not.toContain("Removed");
  });

  it("quotes the comments an explicit replace removed", async () => {
    mockedRead.mockResolvedValueOnce(day({ comments: "slept badly" }));
    mockedPut.mockResolvedValueOnce(day());
    mockedRead.mockResolvedValueOnce(day({ comments: "legs heavy" }));

    const result = await run({
      date: DATE,
      comments: "legs heavy",
      commentsMode: "replace",
    });

    expect(result.content[0]?.text).toContain(
      'Removed the previous comments: 11 chars ("slept badly").',
    );
  });

  it("warns, and names the lock, when a locked day does not take the write", async () => {
    mockedRead.mockResolvedValueOnce(day({ locked: true }));
    mockedPut.mockResolvedValueOnce(day({ locked: true }));
    mockedRead.mockResolvedValueOnce(day({ locked: true }));

    const result = await run({ date: DATE, soreness: 2 });

    const structured = WellnessWriteOutputSchema.parse(
      result.structuredContent,
    );
    expect(structured.locked).toBe(true);
    expect(structured.warnings[0]).toBe(
      "soreness was not applied: sent 2, the day now shows nothing.",
    );
    expect(result.content[0]?.text).toContain("The day is locked");
  });

  it("reports a possibly-applied write when the PUT times out", async () => {
    mockedRead.mockResolvedValueOnce(day());
    mockedPut.mockRejectedValueOnce(
      new RequestTimeoutError("https://intervals.icu/api/v1/x", 30000),
    );

    const scope: CallScope = {};
    const result = await runInCallScope(scope, () =>
      run({ date: DATE, soreness: 2 }),
    );

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("may already have been applied");
    expect(text).toContain("get-wellness");
    expect(scope.failure).toEqual({ error_class: "RequestTimeoutError" });
  });

  it("reports a possibly-applied write on a 503 from the PUT", async () => {
    mockedRead.mockResolvedValueOnce(day());
    mockedPut.mockRejectedValueOnce(
      new HttpError("503", { status: 503, statusText: "", data: "" }),
    );

    const result = await run({ date: DATE, soreness: 2 });

    expect(result.content[0]?.text).toContain("may already have been applied");
  });

  it.each([
    ["a cancel", new CallCancelledError("PUT")],
    [
      "a 422",
      new HttpError("422", { status: 422, statusText: "", data: "bad" }),
    ],
    [
      "a rate limit",
      new RateLimitError(
        "rate limited",
        { status: 429, statusText: "", data: "" },
        { observedAt: Date.now() },
        30,
      ),
    ],
  ])("reports a plain failure on %s from the PUT", async (_label, error) => {
    mockedRead.mockResolvedValueOnce(day());
    mockedPut.mockRejectedValueOnce(error);

    const result = await run({ date: DATE, soreness: 2 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain(
      "may already have been applied",
    );
  });

  it("reports a possibly-applied write when the confirming re-read fails", async () => {
    mockedRead.mockResolvedValueOnce(day());
    mockedPut.mockResolvedValueOnce(day());
    mockedRead.mockRejectedValueOnce(new Error("network reset"));

    const scope: CallScope = {};
    const result = await runInCallScope(scope, () =>
      run({ date: DATE, soreness: 2 }),
    );

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("was sent and may have been applied");
    expect(text).toContain("network reset");
    expect(text).toContain("get-wellness");
    expect(mockedPut).toHaveBeenCalledTimes(1);
    expect(scope.failure).toEqual({ error_class: "Error" });
  });

  it("reports a failed first read as a plain failure", async () => {
    mockedRead.mockRejectedValueOnce(
      new HttpError("500", { status: 500, statusText: "", data: "" }),
    );

    const result = await run({ date: DATE, soreness: 2 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(
      /^❌ Failed to update wellness for 2026-10-20/,
    );
    expect(mockedPut).not.toHaveBeenCalled();
  });
});
