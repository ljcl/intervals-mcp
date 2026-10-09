/**
 * Telemetry record shape and the rolling counters behind /health (ljcl/strava-mcp#241).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { intervalsApi } from "./fetchClient";
import {
  parseTraceparent,
  recordRejectedRequest,
  recordToolCall,
  resetToolCallStats,
  toolCallStats,
} from "./telemetry";

vi.mock("./fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchClient")>();
  return {
    ...actual,
    intervalsApi: { getRateLimitSnapshot: vi.fn() },
  };
});

const mockedSnapshot = vi.mocked(intervalsApi.getRateLimitSnapshot);

describe("recordToolCall", () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetToolCallStats();
    mockedSnapshot.mockReset();
    mockedSnapshot.mockReturnValue(null);
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  /** The JSON line the most recent call wrote. */
  function lastRecord(): Record<string, unknown> {
    const [line] = stderr.mock.calls[stderr.mock.calls.length - 1] ?? [];
    return JSON.parse(String(line));
  }

  it("emits one structured line per call, not free text", () => {
    recordToolCall({
      tool: "get-best-efforts",
      duration_ms: 4200,
      outcome: "ok",
    });

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(lastRecord()).toMatchObject({
      event: "tool_call",
      tool: "get-best-efforts",
      duration_ms: 4200,
      outcome: "ok",
    });
  });

  it("writes the cancelled outcome on the line", () => {
    recordToolCall({
      tool: "get-activity",
      duration_ms: 3,
      outcome: "cancelled",
    });

    expect(lastRecord().outcome).toBe("cancelled");
  });

  it("carries the error class so failures can be grouped", () => {
    recordToolCall({
      tool: "get-best-efforts",
      duration_ms: 12,
      outcome: "error",
      error_class: "RateLimitError",
    });

    expect(lastRecord().error_class).toBe("RateLimitError");
  });

  it("records whether the client renders MCP Apps and what it calls itself", () => {
    recordToolCall({
      tool: "view-training-load",
      duration_ms: 7,
      outcome: "ok",
      client_apps: true,
      client_name: "claude-ai",
    });

    expect(lastRecord()).toMatchObject({
      client_apps: true,
      client_name: "claude-ai",
    });
  });

  it("serialises client_apps: false rather than dropping it", () => {
    recordToolCall({
      tool: "view-training-load",
      duration_ms: 7,
      outcome: "ok",
      client_apps: false,
    });

    const record = lastRecord();
    expect(record.client_apps).toBe(false);
    expect(record).not.toHaveProperty("client_name");
  });

  it("stamps the finish time, and last_called_at is the same instant", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-10-08T01:02:03.004Z");
      recordToolCall({ tool: "get-activity", duration_ms: 1, outcome: "ok" });

      expect(lastRecord().ts).toBe("2026-10-08T01:02:03.004Z");
      expect(toolCallStats()["get-activity"]?.last_called_at).toBe(
        "2026-10-08T01:02:03.004Z",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("serialises the failure class, status and trace ids, in a fixed key order", () => {
    recordToolCall({
      tool: "get-activity",
      duration_ms: 9,
      outcome: "error",
      error_class: "HttpError",
      http_status: 404,
      client_apps: false,
      client_name: "claude-ai",
      client_version: "1.0",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      parent_id: "00f067aa0ba902b7",
    });

    expect(lastRecord()).toMatchObject({
      http_status: 404,
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      parent_id: "00f067aa0ba902b7",
    });
    expect(Object.keys(lastRecord())).toEqual([
      "event",
      "ts",
      "tool",
      "duration_ms",
      "outcome",
      "error_class",
      "http_status",
      "rate_limit",
      "client_apps",
      "client_name",
      "client_version",
      "trace_id",
      "parent_id",
    ]);
  });

  it("leaves out the fields a call did not set", () => {
    recordToolCall({
      tool: "get-activity",
      duration_ms: 1,
      outcome: "ok",
      error_class: undefined,
      http_status: undefined,
    });

    const record = lastRecord();
    for (const key of [
      "error_class",
      "http_status",
      "client_name",
      "client_version",
      "trace_id",
      "parent_id",
    ]) {
      expect(record).not.toHaveProperty(key);
    }
  });

  describe("client strings", () => {
    /** The `client_name` the line carries for `name`. */
    function loggedName(name: unknown): unknown {
      recordToolCall({
        tool: "get-activity",
        duration_ms: 1,
        outcome: "ok",
        client_name: name as string,
      });
      return lastRecord().client_name;
    }

    it("trims whitespace", () => {
      expect(loggedName("  claude-ai  ")).toBe("claude-ai");
    });

    it("removes control, format and separator characters", () => {
      expect(loggedName("cl\naude\u0000-\u0085ai\u202e\u2028")).toBe(
        "claude-ai",
      );
    });

    it("cuts a long name to 64 code points ending in an ellipsis", () => {
      const name = loggedName("x".repeat(500)) as string;
      expect(Array.from(name)).toHaveLength(64);
      expect(name.endsWith("\u2026")).toBe(true);
    });

    it("cuts an astral name without leaving a lone surrogate", () => {
      const name = loggedName("\u{1F600}".repeat(100)) as string;
      expect(Array.from(name)).toHaveLength(64);
      expect(name.isWellFormed()).toBe(true);
    });

    it("keeps a pair the pre-slice cut in two out of the line", () => {
      const name = loggedName("\u0001".repeat(251) + "\u{1F600}".repeat(10));
      expect(name).toBe("\u{1F600}\u{1F600}");
    });

    it("replaces a lone surrogate the sender put in", () => {
      const name = loggedName("ab\uD800cd") as string;
      expect(name.isWellFormed()).toBe(true);
      expect(name).toContain("ab");
      expect(name).toContain("cd");
    });

    it("omits a name that is blank or not a string", () => {
      expect(loggedName("   ")).toBeUndefined();
      expect(loggedName("\u0000\u202e")).toBeUndefined();
      expect(loggedName(42)).toBeUndefined();
      expect(loggedName(null)).toBeUndefined();
    });

    it("bounds client_version the same way", () => {
      recordToolCall({
        tool: "get-activity",
        duration_ms: 1,
        outcome: "ok",
        client_version: ` 1.2\n${"9".repeat(200)}`,
      });

      const version = lastRecord().client_version as string;
      expect(version.startsWith("1.2999")).toBe(true);
      expect(Array.from(version)).toHaveLength(64);
    });
  });

  it("still returns and counts the call when console.error throws", () => {
    stderr.mockImplementation(() => {
      throw new Error("stderr closed");
    });

    const line = recordToolCall({
      tool: "get-activity",
      duration_ms: 4,
      outcome: "ok",
    });

    expect(line.tool).toBe("get-activity");
    expect(toolCallStats()["get-activity"]?.calls).toBe(1);
  });

  it("attaches the rate-limit snapshot without spending a request", () => {
    recordToolCall({ tool: "get-best-efforts", duration_ms: 5, outcome: "ok" });

    // Present as a key even when nothing has been fetched yet, so a log
    // consumer can rely on the field existing.
    expect(lastRecord()).toHaveProperty("rate_limit");
  });

  it("reads the rate-limit snapshot from intervalsApi, not the retired Strava client", () => {
    mockedSnapshot.mockReturnValue({
      shortTerm: { usage: 1, limit: 100 },
      daily: { usage: 2, limit: 1000 },
      observedAt: 1_752_300_000_000,
    } as ReturnType<typeof intervalsApi.getRateLimitSnapshot>);

    recordToolCall({ tool: "get-best-efforts", duration_ms: 5, outcome: "ok" });

    expect(mockedSnapshot).toHaveBeenCalled();
    expect(lastRecord().rate_limit).toMatchObject({
      shortTerm: { usage: 1, limit: 100 },
    });
  });
});

describe("toolCallStats", () => {
  beforeEach(() => {
    resetToolCallStats();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accumulates calls, errors, and a mean duration per tool", () => {
    recordToolCall({
      tool: "get-best-efforts",
      duration_ms: 100,
      outcome: "ok",
    });
    recordToolCall({
      tool: "get-best-efforts",
      duration_ms: 300,
      outcome: "error",
    });

    const stats = toolCallStats()["get-best-efforts"]!;
    expect(stats).toMatchObject({ calls: 2, errors: 1, total_ms: 400 });
    expect(stats.mean_ms).toBe(200);
    expect(stats.last_called_at).not.toBe("");
  });

  it("counts every non-ok outcome as an error, including a refused call", () => {
    recordToolCall({
      tool: "get-activity-laps",
      duration_ms: 1,
      outcome: "not_connected",
    });
    recordToolCall({
      tool: "get-activity-laps",
      duration_ms: 1,
      outcome: "invalid_args",
    });

    expect(toolCallStats()["get-activity-laps"]).toMatchObject({
      calls: 2,
      errors: 2,
    });
  });

  it("counts a cancelled call as a call and as cancelled, not as an error", () => {
    recordToolCall({ tool: "get-activity", duration_ms: 10, outcome: "ok" });
    recordToolCall({
      tool: "get-activity",
      duration_ms: 20,
      outcome: "cancelled",
    });

    expect(toolCallStats()["get-activity"]).toMatchObject({
      calls: 2,
      errors: 0,
      cancelled: 1,
      total_ms: 30,
    });
  });

  it("leaves cancelled at 0 for an error", () => {
    recordToolCall({ tool: "get-activity", duration_ms: 1, outcome: "error" });

    expect(toolCallStats()["get-activity"]).toMatchObject({
      errors: 1,
      cancelled: 0,
    });
  });

  it("orders busiest first, so the quota burner is at the top", () => {
    recordToolCall({ tool: "quiet", duration_ms: 1, outcome: "ok" });
    for (let i = 0; i < 3; i++) {
      recordToolCall({ tool: "busy", duration_ms: 1, outcome: "ok" });
    }

    expect(Object.keys(toolCallStats())).toEqual(["busy", "quiet"]);
  });

  it("holds only tools that were actually dispatched", () => {
    expect(toolCallStats()).toEqual({});
    recordToolCall({ tool: "get-best-efforts", duration_ms: 1, outcome: "ok" });
    expect(Object.keys(toolCallStats())).toEqual(["get-best-efforts"]);
  });
});

describe("parseTraceparent", () => {
  const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
  const PARENT = "00f067aa0ba902b7";

  it("reads the ids of a valid version 00 value", () => {
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-01`)).toEqual({
      trace_id: TRACE,
      parent_id: PARENT,
    });
  });

  it("accepts a later version with extra fields", () => {
    expect(parseTraceparent(`01-${TRACE}-${PARENT}-01-xyz`)).toEqual({
      trace_id: TRACE,
      parent_id: PARENT,
    });
  });

  it.each([
    ["uppercase hex", `00-${TRACE.toUpperCase()}-${PARENT}-01`],
    ["an all-zero trace id", `00-${"0".repeat(32)}-${PARENT}-01`],
    ["an all-zero parent id", `00-${TRACE}-${"0".repeat(16)}-01`],
    ["version ff", `ff-${TRACE}-${PARENT}-01`],
    ["version 00 with a trailing field", `00-${TRACE}-${PARENT}-01-xyz`],
    ["a short trace id", `00-${TRACE.slice(1)}-${PARENT}-01`],
    ["a long parent id", `00-${TRACE}-${PARENT}0-01`],
    ["a missing flags field", `00-${TRACE}-${PARENT}`],
    [
      "a value over 256 characters",
      `01-${TRACE}-${PARENT}-01-${"a".repeat(300)}`,
    ],
    ["an empty string", ""],
  ])("rejects %s", (_name, value) => {
    expect(parseTraceparent(value)).toBeUndefined();
  });

  it.each([undefined, null, 42, {}, [`00-${TRACE}-${PARENT}-01`]])(
    "rejects the non-string %j",
    (value) => {
      expect(parseTraceparent(value)).toBeUndefined();
    },
  );
});

describe("recordRejectedRequest", () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetToolCallStats();
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  function lastRecord(): Record<string, unknown> {
    const [line] = stderr.mock.calls[stderr.mock.calls.length - 1] ?? [];
    return JSON.parse(String(line));
  }

  it("writes one JSON line with the event and a timestamp", () => {
    recordRejectedRequest({
      status: 400,
      code: -32022,
      reason: "unsupported",
      http_method: "POST",
      rpc_method: "initialize",
      client_name: "test-client",
    });

    expect(stderr).toHaveBeenCalledTimes(1);
    const line = lastRecord();
    expect(line).toMatchObject({
      event: "mcp_rejected",
      status: 400,
      code: -32022,
      reason: "unsupported",
      http_method: "POST",
      rpc_method: "initialize",
      client_name: "test-client",
    });
    expect(new Date(String(line.ts)).toISOString()).toBe(line.ts);
  });

  it("bounds its fields and keeps the newlines of a stack", () => {
    recordRejectedRequest({
      status: 500,
      reason: "r".repeat(500),
      stack: `Error: boom\n    at x (y.ts:1:1)\n${"s".repeat(5000)}`,
      http_method: "POST",
      client_name: "c".repeat(500),
    });

    const line = lastRecord();
    expect(Array.from(String(line.reason))).toHaveLength(200);
    expect(String(line.stack).length).toBe(4000);
    expect(String(line.stack)).toContain("Error: boom\n    at x");
    expect(Array.from(String(line.client_name))).toHaveLength(64);
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("strips control and format characters from a stack", () => {
    recordRejectedRequest({
      status: 500,
      stack: "a\u0007b\u202Ec\r\nd",
      http_method: "POST",
    });

    expect(lastRecord().stack).toBe("abc\nd");
  });

  it("omits fields that are not set", () => {
    recordRejectedRequest({ status: 405, http_method: "GET" });

    expect(Object.keys(lastRecord())).toEqual([
      "event",
      "ts",
      "status",
      "http_method",
    ]);
  });

  it("does not throw when writing the line throws", () => {
    stderr.mockImplementation(() => {
      throw new Error("stderr closed");
    });

    expect(() =>
      recordRejectedRequest({ status: 400, http_method: "POST" }),
    ).not.toThrow();
  });

  it("leaves the per-tool counters unchanged", () => {
    recordRejectedRequest({ status: 401, http_method: "POST" });

    expect(toolCallStats()).toEqual({});
  });
});
