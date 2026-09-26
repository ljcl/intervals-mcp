/**
 * The per-call telemetry (#241), and the `logging` capability it no longer
 * feeds (#72). The capability checks go over the real transport rather than
 * against the in-memory server object: what a host sees is what serializes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, getIntervalsApiKey: vi.fn(() => "test-token") };
});

const { dispatchToolCall } = await import("./server");
const { connectTestClient } = await import("./mcpTestClient");
const { resetToolCallStats, toolCallStats } = await import("./telemetry");

describe("logging capability", () => {
  it("is not advertised by server/discover", async () => {
    const { discover } = await connectTestClient("logging-test");

    const capabilities = discover.capabilities as Record<string, unknown>;
    // The 2026-07-28 revision deprecates it (SEP-2577).
    expect(capabilities).not.toHaveProperty("logging");
    // The other three are untouched.
    expect(capabilities).toHaveProperty("tools");
    expect(capabilities).toHaveProperty("resources");
    expect(capabilities).toHaveProperty("prompts");
  });

  it("sends no log notification, even when a request asks via logLevel", async () => {
    const client = await connectTestClient("logging-test");

    const body = await client.sendRaw("tools/call", {
      name: "no-such-tool",
      arguments: {},
      _meta: { "io.modelcontextprotocol/logLevel": "debug" },
    });

    // The call still gets its answer; the record stays in the stderr line.
    expect(body).toContain("Unknown tool");
    expect(body).not.toContain("notifications/message");
  });
});

describe("dispatch telemetry", () => {
  beforeEach(() => {
    resetToolCallStats();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records an unknown tool as an error", async () => {
    await dispatchToolCall("no-such-tool", {});

    expect(toolCallStats()["no-such-tool"]).toMatchObject({
      calls: 1,
      errors: 1,
    });
  });

  it("records a rejected argument set separately from a handler failure", async () => {
    await dispatchToolCall("get-activity-laps", { id: "not-an-id" });

    const stats = toolCallStats()["get-activity-laps"]!;
    expect(stats.calls).toBe(1);
    expect(stats.errors).toBe(1);
  });

  it("writes one JSON line per call to stderr", async () => {
    await dispatchToolCall("no-such-tool", {});

    const lines = vi
      .mocked(console.error)
      .mock.calls.map(([line]) => String(line))
      .filter((line) => line.startsWith("{"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "tool_call",
      tool: "no-such-tool",
      outcome: "error",
    });
  });

  it("times the call, including the work before the handler runs", async () => {
    await dispatchToolCall("get-activity-laps", { id: "not-an-id" });

    const stats = toolCallStats()["get-activity-laps"]!;
    expect(stats.total_ms).toBeGreaterThanOrEqual(0);
    expect(stats.last_called_at).not.toBe("");
  });
});
