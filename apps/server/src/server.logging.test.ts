/**
 * The per-call telemetry (ljcl/strava-mcp#241), and the `logging` capability it no longer
 * feeds (#72). The capability checks go over the real transport rather than
 * against the in-memory server object: what a host sees is what serializes.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  TRACEPARENT_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "./__fixtures__";

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, getIntervalsApiKey: vi.fn(() => "test-token") };
});

// The tools below the dispatcher reach intervals.icu through these. The
// sport-settings read get-activity fires beside the activity would otherwise
// be a live, paced request.
vi.mock("./intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./intervalsClient")>();
  return {
    ...actual,
    getActivity: vi.fn(),
    getActivityStreams: vi.fn(),
    getSportSettings: vi.fn(async () => null),
  };
});

const { dispatchToolCall } = await import("./server");
const { getActivity, getActivityStreams } = await import("./intervalsClient");
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

    // Every unknown name shares one counter, so a client cannot grow the map.
    expect(toolCallStats()).toEqual({
      unknown: expect.objectContaining({ calls: 1, errors: 1 }),
    });
  });

  it("bounds the name of an unknown tool in the line and the counters", async () => {
    const name = `\u202e${"x".repeat(500)}`;

    await dispatchToolCall(name, {});

    const [record] = loggedRecords();
    const tool = record?.tool as string;
    expect(Array.from(tool)).toHaveLength(64);
    expect(tool.startsWith("xxx")).toBe(true);
    expect(tool).not.toContain("\u202e");
    expect(Object.keys(toolCallStats())).toEqual(["unknown"]);
  });

  it("logs a tool name with nothing left after bounding as unknown", async () => {
    await dispatchToolCall("\u202e\u2028", {});

    expect(loggedRecords()).toEqual([
      expect.objectContaining({ tool: "unknown", outcome: "error" }),
    ]);
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

  /** The `tool_call` records written to stderr so far. */
  function loggedRecords(): Array<Record<string, unknown>> {
    return vi
      .mocked(console.error)
      .mock.calls.map(([line]) => String(line))
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.event === "tool_call");
  }

  it("records that the client renders MCP Apps, and its name, when told", async () => {
    await dispatchToolCall(
      "no-such-tool",
      {},
      { client: { rendersApps: true, name: "claude-ai" } },
    );

    expect(loggedRecords()).toEqual([
      expect.objectContaining({ client_apps: true, client_name: "claude-ai" }),
    ]);
  });

  it("records client_apps: false and no name when the client is not known", async () => {
    await dispatchToolCall("no-such-tool", {});

    const [record] = loggedRecords();
    expect(record?.client_apps).toBe(false);
    expect(record).not.toHaveProperty("client_name");
  });

  it("records the client on every outcome, not only a successful call", async () => {
    await dispatchToolCall(
      "get-activity-laps",
      { id: "not-an-id" },
      { client: { rendersApps: true, name: "claude-ai" } },
    );

    expect(loggedRecords()).toEqual([
      expect.objectContaining({
        outcome: "invalid_args",
        client_apps: true,
        client_name: "claude-ai",
      }),
    ]);
  });

  it("takes both from the request envelope over the wire", async () => {
    const withApps = await connectTestClient("claude-ai");
    await withApps.send("tools/call", {
      name: "no-such-tool",
      arguments: {},
      _meta: {
        [CLIENT_CAPABILITIES_META_KEY]: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app"],
            },
          },
        },
      },
    });
    const plain = await connectTestClient("plain-host");
    await plain.send("tools/call", { name: "no-such-tool", arguments: {} });

    expect(loggedRecords()).toEqual([
      expect.objectContaining({ client_apps: true, client_name: "claude-ai" }),
      expect.objectContaining({
        client_apps: false,
        client_name: "plain-host",
      }),
    ]);
  });

  it("times the call, including the work before the handler runs", async () => {
    await dispatchToolCall("get-activity-laps", { id: "not-an-id" });

    const stats = toolCallStats()["get-activity-laps"]!;
    expect(stats.total_ms).toBeGreaterThanOrEqual(0);
    expect(stats.last_called_at).not.toBe("");
  });

  it("stamps each line with the time the call finished", async () => {
    await dispatchToolCall("no-such-tool", {});

    const [record] = loggedRecords();
    expect(new Date(String(record?.ts)).toISOString()).toBe(record?.ts);
  });

  describe("failure class and status", () => {
    // restoreAllMocks leaves a vi.fn() implementation in place; the
    // concurrency case sets a persistent one.
    afterEach(() => {
      vi.mocked(getActivity).mockReset();
    });

    it("logs a 404 with its status", async () => {
      vi.mocked(getActivity).mockRejectedValueOnce(
        handledNotFound("getActivity"),
      );

      await dispatchToolCall("get-activity", { id: "i1" });

      expect(loggedRecords()).toEqual([
        expect.objectContaining({
          tool: "get-activity",
          outcome: "error",
          error_class: "HttpError",
          http_status: 404,
        }),
      ]);
    });

    it("logs a rate limit with its status", async () => {
      vi.mocked(getActivity).mockRejectedValueOnce(
        handledRateLimit("getActivity"),
      );

      await dispatchToolCall("get-activity", { id: "i1" });

      expect(loggedRecords()).toEqual([
        expect.objectContaining({
          error_class: "RateLimitError",
          http_status: 429,
        }),
      ]);
    });

    it("logs the status of an error the dispatcher's final catch translates", async () => {
      vi.mocked(getActivity).mockRejectedValueOnce(
        handledNotFound("getActivity"),
      );

      await dispatchToolCall("get-activity-streams-raw", { id: "i1" });

      expect(loggedRecords()).toEqual([
        expect.objectContaining({
          tool: "get-activity-streams-raw",
          error_class: "HttpError",
          http_status: 404,
        }),
      ]);
    });

    it("logs the stream tool's own degrade branch without a status", async () => {
      vi.mocked(getActivity).mockResolvedValueOnce({
        id: "i1",
        type: "Run",
        name: "Morning Run",
      } as Awaited<ReturnType<typeof getActivity>>);
      vi.mocked(getActivityStreams).mockResolvedValueOnce([]);

      const result = await dispatchToolCall("get-hill-analysis", {
        id: "i1",
      });

      expect(result.isError).toBe(true);
      const [record] = loggedRecords();
      expect(record).toMatchObject({
        outcome: "error",
        error_class: "IntervalsStreamsUnavailableError",
      });
      expect(record).not.toHaveProperty("http_status");
    });

    it("logs the stream failure of get-best-efforts in activity mode", async () => {
      vi.mocked(getActivity).mockResolvedValueOnce({
        id: "i1",
        type: "Run",
        name: "Morning Run",
      } as Awaited<ReturnType<typeof getActivity>>);
      vi.mocked(getActivityStreams).mockResolvedValueOnce([]);

      const result = await dispatchToolCall("get-best-efforts", { id: "i1" });

      expect(result.isError).toBe(true);
      const [record] = loggedRecords();
      expect(record).toMatchObject({
        outcome: "error",
        error_class: "IntervalsStreamsUnavailableError",
      });
    });

    it("logs ToolErrorResult for a refusal that has no exception", async () => {
      const result = await dispatchToolCall("get-wellness", {
        date: "2026-10-01",
        oldest: "2026-09-01",
      });

      expect(result.isError).toBe(true);
      const [record] = loggedRecords();
      expect(record).toMatchObject({
        outcome: "error",
        error_class: "ToolErrorResult",
      });
      expect(record).not.toHaveProperty("http_status");
    });

    it("logs neither field for a successful call", async () => {
      vi.mocked(getActivity).mockResolvedValueOnce({
        id: "i1",
        type: "Run",
        name: "Morning Run",
        start_date_local: "2026-09-20T07:00:00",
      } as Awaited<ReturnType<typeof getActivity>>);

      const result = await dispatchToolCall("get-activity", { id: "i1" });

      expect(result.isError).toBeFalsy();
      const [record] = loggedRecords();
      expect(record).toMatchObject({ outcome: "ok" });
      expect(record).not.toHaveProperty("error_class");
      expect(record).not.toHaveProperty("http_status");
    });

    it("keeps the class and status of a call that was cancelled", async () => {
      const controller = new AbortController();
      vi.mocked(getActivity).mockImplementationOnce(async () => {
        controller.abort();
        throw handledNotFound("getActivity");
      });

      await dispatchToolCall(
        "get-activity",
        { id: "i1" },
        { signal: controller.signal },
      );

      expect(loggedRecords()).toEqual([
        expect.objectContaining({
          outcome: "cancelled",
          error_class: "HttpError",
          http_status: 404,
        }),
      ]);
    });

    it("keeps the failures of two concurrent calls apart", async () => {
      vi.mocked(getActivity).mockImplementation(async (_key, id) => {
        if (id === "i1") {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw handledNotFound("getActivity");
        }
        throw handledRateLimit("getActivity");
      });

      await Promise.all([
        dispatchToolCall("get-activity", { id: "i1" }),
        dispatchToolCall("get-activity", { id: "i2" }),
      ]);

      const statuses = loggedRecords().map((record) => record.http_status);
      expect(statuses).toEqual([429, 404]);
    });
  });
});

describe("dispatch telemetry over the wire", () => {
  beforeEach(() => {
    resetToolCallStats();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function loggedRecords(): Array<Record<string, unknown>> {
    return vi
      .mocked(console.error)
      .mock.calls.map(([line]) => String(line))
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.event === "tool_call");
  }

  it("records clientInfo.version", async () => {
    const client = await connectTestClient("claude-ai");
    await client.send("tools/call", { name: "no-such-tool", arguments: {} });

    expect(loggedRecords()).toEqual([
      expect.objectContaining({
        client_name: "claude-ai",
        client_version: "1.0",
      }),
    ]);
  });

  it("records the ids of a valid traceparent, and none for an invalid one", async () => {
    const client = await connectTestClient("claude-ai");
    await client.send("tools/call", {
      name: "no-such-tool",
      arguments: {},
      _meta: {
        [TRACEPARENT_META_KEY]:
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    });
    await client.send("tools/call", {
      name: "no-such-tool",
      arguments: {},
      _meta: { [TRACEPARENT_META_KEY]: "not-a-traceparent" },
    });

    const [traced, untraced] = loggedRecords();
    expect(traced).toMatchObject({
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      parent_id: "00f067aa0ba902b7",
    });
    expect(untraced).not.toHaveProperty("trace_id");
    expect(untraced).not.toHaveProperty("parent_id");
  });

  it("bounds a long, padded client name", async () => {
    const client = await connectTestClient(`  ${"x".repeat(500)}`);
    await client.send("tools/call", { name: "no-such-tool", arguments: {} });

    const [record] = loggedRecords();
    expect(Array.from(String(record?.client_name))).toHaveLength(64);
  });
});

describe("a call without an API key", () => {
  beforeEach(() => {
    resetToolCallStats();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs MissingApiKeyError", async () => {
    const { getIntervalsApiKey } = await import("./config");
    const { MissingApiKeyError } = await import("./config");
    vi.mocked(getIntervalsApiKey).mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    await dispatchToolCall("get-activity", { id: "i1" });

    const [record] = vi
      .mocked(console.error)
      .mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(record).toMatchObject({
      outcome: "not_connected",
      error_class: "MissingApiKeyError",
    });
  });
});
