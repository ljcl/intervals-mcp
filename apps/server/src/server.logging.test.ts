/**
 * The advertised `logging` capability and the per-call telemetry behind it
 * (#241), asserted over the real transport rather than against the in-memory
 * server object — a capability that does not serialize is not advertised.
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
  it("is advertised by server/discover", async () => {
    const { discover } = await connectTestClient("logging-test");

    const capabilities = discover.capabilities as Record<string, unknown>;
    expect(capabilities).toHaveProperty("logging");
    // The pre-existing three are untouched.
    expect(capabilities).toHaveProperty("tools");
    expect(capabilities).toHaveProperty("resources");
    expect(capabilities).toHaveProperty("prompts");
  });
});

describe("per-request log level (2026-07-28)", () => {
  it("delivers the tool-call record when the request asks via logLevel", async () => {
    const client = await connectTestClient("logging-test");

    const body = await client.sendRaw("tools/call", {
      name: "no-such-tool",
      arguments: {},
      _meta: { "io.modelcontextprotocol/logLevel": "debug" },
    });

    // The dispatcher's record reaches the caller on the same response
    // stream, exactly as the sessionful logging/setLevel sink used to.
    expect(body).toContain("notifications/message");
    expect(body).toContain("tool_call");
  });

  it("stays silent when the request does not ask", async () => {
    const client = await connectTestClient("logging-test");

    const body = await client.sendRaw("tools/call", {
      name: "no-such-tool",
      arguments: {},
    });

    // The spec's MUST: no notifications/message for a request that did not
    // carry the logLevel envelope key.
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

  it("hands the same record to the session sink it writes to stderr", async () => {
    const records: unknown[] = [];

    await dispatchToolCall(
      "no-such-tool",
      {},
      {
        onRecord: (record) => {
          records.push(record);
        },
      },
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
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
