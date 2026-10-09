/**
 * HTTP behaviour of the 2026-07-28-only /mcp endpoint (#33): an enveloped
 * request is served, any 2025-era request is rejected with a typed
 * unsupported-version error naming the served revision, malformed JSON
 * returns a JSON-RPC parse error instead of throwing out of `req.json()`,
 * and 64-bit ids survive the body parse.
 */
import { Server } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpEndpoint, type McpEndpoint } from "./mcpEndpoint";
import { parseResponse } from "./mcpTestClient";

const MCP_URL = "http://localhost/mcp";

/** Minimal MCP server; the endpoint layer never dispatches Strava tools. */
function makeEndpoint(): McpEndpoint {
  return createMcpEndpoint(() => {
    const server = new Server(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    // A declared capability must be backed by a handler — the low-level
    // Server leaves that to its author.
    server.setRequestHandler("tools/list", async () => ({ tools: [] }));
    return server;
  });
}

function post(
  body: string | Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0" },
  },
} as const;

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
} as const;

describe("createMcpEndpoint", () => {
  it("rejects a 2025-era initialize, naming the supported revision", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(post(INITIALIZE_BODY));

    expect(response.status).toBe(400);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const body = await response.json();
    // -32022: UnsupportedProtocolVersion. `data.supported` is what tells an
    // old client which revision to speak instead.
    expect(body.error.code).toBe(-32022);
    expect(body.error.data).toEqual({
      supported: ["2026-07-28"],
      requested: "2025-06-18",
    });
  });

  it("rejects a request with no envelope, even without a prior handshake", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toEqual(["2026-07-28"]);
  });

  it("never serves a claim-less tools/call past a spoofed Mcp-Name", async () => {
    // A proxy rule keyed on Mcp-Name is only sound if every served request
    // went through the header-vs-body check. A legacy fallback skipped it:
    // this exact request was answered 200 under `legacy: "stateless"`.
    let called = false;
    const endpoint = createMcpEndpoint(() => {
      const server = new Server(
        { name: "test", version: "0.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler("tools/call", async () => {
        called = true;
        return { content: [] };
      });
      return server;
    });

    const response = await endpoint.handleRequest(
      post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "update-activity", arguments: {} },
        },
        { "Mcp-Method": "tools/call", "Mcp-Name": "get-wellness" },
      ),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32022);
    expect(called).toBe(false);
  });

  it("rejects an enveloped request whose Mcp-Name disagrees with the body", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(
      post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            _meta: MODERN_META,
            name: "update-activity",
            arguments: {},
          },
        },
        { "Mcp-Method": "tools/call", "Mcp-Name": "get-wellness" },
      ),
    );

    expect(response.status).toBe(400);
    // -32020: HeaderMismatch.
    expect((await response.json()).error.code).toBe(-32020);
  });

  it("acknowledges a 2025-era notification with 202 and drops it", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );

    expect(response.status).toBe(202);
  });

  it("serves an enveloped request on the 2026-07-28 path", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(
      post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: { _meta: MODERN_META },
        },
        { "Mcp-Method": "tools/list" },
      ),
    );

    expect(response.status).toBe(200);
    const parsed = parseResponse(await response.text());
    // resultType is the 2026-07-28 result discriminator.
    expect(parsed?.result?.resultType).toBe("complete");
    expect(parsed?.result?.tools).toEqual([]);
  });

  it("answers server/discover with the modern revision", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(
      post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: MODERN_META },
        },
        { "Mcp-Method": "server/discover" },
      ),
    );

    const parsed = parseResponse(await response.text());
    expect(parsed?.result?.supportedVersions).toContain("2026-07-28");
  });

  it("returns a JSON-RPC parse error (-32700) for malformed JSON", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(post("{not json"));

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32700);
    expect(body.id).toBeNull();
  });

  it("preserves a 64-bit id sent as a JSON number instead of rounding it", async () => {
    // Strava activity ids exceed 2^53. `req.json()` would
    // round 3516039180561708486 to ...500 before any tool schema could see
    // it, so the raw body is parsed with the large-int-preserving reviver
    // and the exact digits arrive as a string the id schemas accept.
    let received: unknown;
    const endpoint = createMcpEndpoint(() => {
      const server = new Server(
        { name: "test", version: "0.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler("tools/call", async (request) => {
        received = (
          request.params.arguments as Record<string, unknown> | undefined
        )?.activity_id;
        return { content: [] };
      });
      return server;
    });

    const response = await endpoint.handleRequest(
      post(
        `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"_meta":${JSON.stringify(MODERN_META)},"name":"view-route-map","arguments":{"activity_id":3516039180561708486}}}`,
        { "Mcp-Method": "tools/call", "Mcp-Name": "view-route-map" },
      ),
    );
    await response.body?.cancel();

    expect(received).toBe("3516039180561708486");
  });

  it("answers 405 for the 2025 session operations (GET and DELETE)", async () => {
    const endpoint = makeEndpoint();

    // There is no session stream to open or session to delete: the
    // 2026-07-28 revision removed both, and 405 tells an old client so.
    for (const method of ["GET", "DELETE"]) {
      const response = await endpoint.handleRequest(
        new Request(MCP_URL, { method }),
      );
      expect(response.status, method).toBe(405);
    }
  });

  it("answers 405 for unsupported methods", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(
      new Request(MCP_URL, { method: "PUT" }),
    );

    expect(response.status).toBe(405);
  });

  it("close resolves with nothing in flight (shutdown path)", async () => {
    const endpoint = makeEndpoint();
    await endpoint.handleRequest(post(INITIALIZE_BODY)).then((r) => r.text());

    await expect(endpoint.close()).resolves.toBeUndefined();
  });
});

describe("rejected requests (#69)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Every line written to stderr, parsed when it is JSON. */
  function lines(): Array<Record<string, unknown> | string> {
    return vi.mocked(console.error).mock.calls.map(([first]) => {
      const text = String(first);
      return text.startsWith("{")
        ? (JSON.parse(text) as Record<string, unknown>)
        : text;
    });
  }

  function rejected(): Array<Record<string, unknown>> {
    return lines().filter(
      (line): line is Record<string, unknown> =>
        typeof line !== "string" && line.event === "mcp_rejected",
    );
  }

  it("logs one line for a 2025-era initialize and no handler error", async () => {
    const response = await makeEndpoint().handleRequest(post(INITIALIZE_BODY));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32022);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(rejected()).toEqual([
      expect.objectContaining({
        status: 400,
        code: -32022,
        http_method: "POST",
        rpc_method: "initialize",
        protocol_version: "2025-06-18",
        client_name: "test-client",
        client_version: "1.0",
        reason: expect.stringContaining("modern-only-missing-envelope"),
      }),
    ]);
  });

  it("logs malformed JSON as -32700", async () => {
    await makeEndpoint().handleRequest(post("{not json"));

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(rejected()).toEqual([
      expect.objectContaining({ status: 400, code: -32700 }),
    ]);
  });

  it("logs a GET as 405", async () => {
    await makeEndpoint().handleRequest(new Request(MCP_URL, { method: "GET" }));

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(rejected()).toEqual([
      expect.objectContaining({ status: 405, http_method: "GET" }),
    ]);
  });

  it("logs an Mcp-Name mismatch with the envelope's client", async () => {
    await makeEndpoint().handleRequest(
      post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            _meta: MODERN_META,
            name: "update-activity",
            arguments: {},
          },
        },
        { "Mcp-Method": "tools/call", "Mcp-Name": "get-wellness" },
      ),
    );

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(rejected()).toEqual([
      expect.objectContaining({
        status: 400,
        code: -32020,
        mcp_method: "tools/call",
        rpc_method: "tools/call",
        protocol_version: "2026-07-28",
        client_name: "test-client",
        client_version: "1.0",
      }),
    ]);
  });

  it("carries the trace ids of a rejected enveloped request", async () => {
    await makeEndpoint().handleRequest(
      post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            _meta: {
              ...MODERN_META,
              traceparent:
                "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
            },
            name: "update-activity",
            arguments: {},
          },
        },
        { "Mcp-Method": "tools/call", "Mcp-Name": "get-wellness" },
      ),
    );

    expect(rejected()).toEqual([
      expect.objectContaining({
        trace_id: "0af7651916cd43dd8448eb211c80319c",
        parent_id: "b7ad6b7169203331",
      }),
    ]);
  });

  it("writes no mcp_rejected line for a served request", async () => {
    const response = await makeEndpoint().handleRequest(
      post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: { _meta: MODERN_META },
        },
        { "Mcp-Method": "tools/list" },
      ),
    );

    expect(response.status).toBe(200);
    expect(rejected()).toEqual([]);
  });

  it("never logs the Authorization header", async () => {
    await makeEndpoint().handleRequest(
      post(INITIALIZE_BODY, { Authorization: "Bearer secret-value" }),
    );

    expect(rejected()).toHaveLength(1);
    const text = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(text).not.toContain("secret-value");
    expect(text.toLowerCase()).not.toContain("authorization");
  });

  it("folds a factory failure into one 500 line with its stack", async () => {
    const endpoint = createMcpEndpoint(() => {
      throw new Error("boom");
    });

    const response = await endpoint.handleRequest(
      post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: { _meta: MODERN_META },
        },
        { "Mcp-Method": "tools/list" },
      ),
    );

    expect(response.status).toBe(500);
    expect(console.error).toHaveBeenCalledTimes(1);
    const [line] = rejected();
    expect(line).toMatchObject({ status: 500, reason: "boom" });
    expect(String(line?.stack)).toContain("boom");
  });

  it("keeps each parallel rejection's own reason and client", async () => {
    const endpoint = makeEndpoint();
    const withClient = (name: string) => ({
      ...INITIALIZE_BODY,
      params: { ...INITIALIZE_BODY.params, clientInfo: { name, version: "1" } },
    });

    await Promise.all([
      endpoint.handleRequest(post(withClient("client-a"))),
      endpoint.handleRequest(post(withClient("client-b"))),
    ]);

    const seen = rejected();
    expect(seen).toHaveLength(2);
    expect(seen.map((line) => line.client_name).sort()).toEqual([
      "client-a",
      "client-b",
    ]);
    for (const line of seen) {
      expect(line.reason).toEqual(
        expect.stringContaining("modern-only-missing-envelope"),
      );
    }
  });
});
