/**
 * Telemetry record shape and the rolling counters behind /health (#241).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordToolCall, resetToolCallStats, toolCallStats } from "./telemetry";

describe("recordToolCall", () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetToolCallStats();
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

  it("carries the error class so failures can be grouped", () => {
    recordToolCall({
      tool: "get-best-efforts",
      duration_ms: 12,
      outcome: "error",
      error_class: "RateLimitError",
    });

    expect(lastRecord().error_class).toBe("RateLimitError");
  });

  it("attaches the rate-limit snapshot without spending a request", () => {
    recordToolCall({ tool: "get-best-efforts", duration_ms: 5, outcome: "ok" });

    // Present as a key even when nothing has been fetched yet, so a log
    // consumer can rely on the field existing.
    expect(lastRecord()).toHaveProperty("rate_limit");
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
