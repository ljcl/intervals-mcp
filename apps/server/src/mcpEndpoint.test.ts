/**
 * HTTP behaviour of the /mcp endpoint (#33): an enveloped 2026-07-28 request
 * is served, a 2025-era request is served statelessly and tells the server
 * factory its era (so the server can refuse writes on that path), an envelope
 * naming an unserved revision is rejected with a typed unsupported-version
 * error, malformed JSON returns a JSON-RPC parse error instead of throwing
 * out of `req.json()`, and 64-bit ids survive the body parse.
 */
import { gunzipSync } from "node:zlib";
import { Server } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMcpEndpoint,
  MAX_REQUEST_BODY_BYTES,
  type McpEndpoint,
} from "./mcpEndpoint";
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

/** SEP-2243: an enveloped request also names its revision in a header. */
const MODERN_HEADERS = { "MCP-Protocol-Version": "2026-07-28" } as const;

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
} as const;

describe("createMcpEndpoint", () => {
  it("serves a 2025-era initialize statelessly, with no session", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(post(INITIALIZE_BODY));

    // claude.ai loads MCP Apps with a 2025-era client, so this era is served.
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const parsed = parseResponse(await response.text());
    expect(parsed?.result?.protocolVersion).toBe("2025-06-18");
  });

  it("serves a request with no envelope, even without a prior handshake", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    );

    expect(response.status).toBe(200);
    expect(parseResponse(await response.text())?.result?.tools).toEqual([]);
  });

  it("tells the server factory each request's era, whatever its headers say", async () => {
    // A 2025-era request skips the SDK's Mcp-Method/Mcp-Name check, so a
    // spoofed Mcp-Name passes. The era is how createServer knows to refuse
    // writes on that path.
    const eras: string[] = [];
    const endpoint = createMcpEndpoint(({ era }) => {
      eras.push(era);
      const server = new Server(
        { name: "test", version: "0.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler("tools/list", async () => ({ tools: [] }));
      return server;
    });

    await endpoint.handleRequest(
      post(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { "Mcp-Method": "tools/list", "Mcp-Name": "get-wellness" },
      ),
    );
    await endpoint.handleRequest(
      post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: { _meta: MODERN_META },
        },
        { ...MODERN_HEADERS, "Mcp-Method": "tools/list" },
      ),
    );

    expect(eras).toEqual(["legacy", "modern"]);
  });

  it("rejects an envelope naming a revision it does not serve", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(
      post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {
            _meta: {
              ...MODERN_META,
              "io.modelcontextprotocol/protocolVersion": "2099-01-01",
            },
          },
        },
        { "MCP-Protocol-Version": "2099-01-01", "Mcp-Method": "tools/list" },
      ),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    // -32022: UnsupportedProtocolVersion. `data.supported` is what tells the
    // client which revision to speak instead.
    expect(body.error.code).toBe(-32022);
    expect(body.error.data).toEqual({
      supported: ["2026-07-28"],
      requested: "2099-01-01",
    });
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
        {
          ...MODERN_HEADERS,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "get-wellness",
        },
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
        { ...MODERN_HEADERS, "Mcp-Method": "tools/list" },
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
        { ...MODERN_HEADERS, "Mcp-Method": "server/discover" },
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
        {
          ...MODERN_HEADERS,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "view-route-map",
        },
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

describe("gzip (#415)", () => {
  /** Larger than GZIP_MIN_BYTES in every answer below. */
  const BIG = "<html>".concat("chart ".repeat(20_000), "</html>");
  const URI = "ui://test/app.html";

  /** A server whose app resource and tool result are both large. */
  function makeBigEndpoint(): McpEndpoint {
    return createMcpEndpoint(() => {
      const server = new Server(
        { name: "test", version: "0.0.0" },
        { capabilities: { tools: {}, resources: {} } },
      );
      server.setRequestHandler("tools/list", async () => ({ tools: [] }));
      server.setRequestHandler("tools/call", async () => ({
        content: [{ type: "text", text: BIG }],
      }));
      server.setRequestHandler("resources/list", async () => ({
        resources: [],
      }));
      server.setRequestHandler("resources/read", async ({ params }) => ({
        contents: [{ uri: params.uri, mimeType: "text/html", text: BIG }],
      }));
      return server;
    });
  }

  const gunzip = async (response: Response) =>
    gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");

  const modernRead = (headers: Record<string, string> = {}) =>
    post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: URI, _meta: MODERN_META },
      },
      {
        ...MODERN_HEADERS,
        "Mcp-Method": "resources/read",
        "Mcp-Name": URI,
        ...headers,
      },
    );

  const legacy = (
    method: string,
    params: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    post(
      { jsonrpc: "2.0", id: 1, method, params },
      { "MCP-Protocol-Version": "2025-11-25", ...headers },
    );

  it("gzips a 2026-07-28 resources/read, which decodes byte-equal", async () => {
    const endpoint = makeBigEndpoint();
    const plain = await endpoint.handleRequest(modernRead());
    const zipped = await endpoint.handleRequest(
      modernRead({ "Accept-Encoding": "gzip, deflate" }),
    );

    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(zipped.headers.get("content-type")).toContain("application/json");
    expect(await gunzip(zipped)).toBe(await plain.text());
  });

  it("gzips a 2025-era resources/read, which that path answers as SSE", async () => {
    // claude.ai loads its chart cards over this path.
    const endpoint = makeBigEndpoint();
    const params = { uri: URI };
    const plain = await endpoint.handleRequest(
      legacy("resources/read", params),
    );
    const zipped = await endpoint.handleRequest(
      legacy("resources/read", params, { "Accept-Encoding": "gzip" }),
    );

    expect(plain.headers.get("content-type")).toBe("text/event-stream");
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    const text = await gunzip(zipped);
    expect(text).toBe(await plain.text());
    expect(parseResponse(text)?.result?.contents).toEqual([
      { uri: URI, mimeType: "text/html", text: BIG },
    ]);
  });

  it("never gzips a tools/call stream, which can carry progress", async () => {
    const endpoint = makeBigEndpoint();
    const response = await endpoint.handleRequest(
      legacy(
        "tools/call",
        { name: "anything", arguments: {} },
        { "Accept-Encoding": "gzip" },
      ),
    );

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(parseResponse(await response.text())?.result?.content).toEqual([
      { type: "text", text: BIG },
    ]);
  });

  it("never gzips a batch that holds a tools/call", async () => {
    const endpoint = makeBigEndpoint();
    const response = await endpoint.handleRequest(
      post(
        JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 1,
            method: "resources/read",
            params: { uri: URI },
          },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "anything", arguments: {} },
          },
        ]),
        { "MCP-Protocol-Version": "2025-11-25", "Accept-Encoding": "gzip" },
      ),
    );

    expect(response.headers.get("content-encoding")).toBeNull();
    await response.text();
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

  /** A tools/list whose envelope names a revision the endpoint does not serve. */
  function unservedRevision(
    clientName = "test-client",
    headers: Record<string, string> = {},
  ): Request {
    return post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {
          _meta: {
            ...MODERN_META,
            "io.modelcontextprotocol/protocolVersion": "2099-01-01",
            "io.modelcontextprotocol/clientInfo": {
              name: clientName,
              version: "1.0",
            },
          },
        },
      },
      {
        "MCP-Protocol-Version": "2099-01-01",
        "Mcp-Method": "tools/list",
        ...headers,
      },
    );
  }

  it("writes no line for a served 2025-era initialize", async () => {
    const response = await makeEndpoint().handleRequest(post(INITIALIZE_BODY));

    expect(response.status).toBe(200);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs one line for an unserved revision and no handler error", async () => {
    const response = await makeEndpoint().handleRequest(unservedRevision());

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32022);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(rejected()).toEqual([
      expect.objectContaining({
        status: 400,
        code: -32022,
        http_method: "POST",
        mcp_method: "tools/list",
        rpc_method: "tools/list",
        protocol_version: "2099-01-01",
        client_name: "test-client",
        client_version: "1.0",
        reason: "Unsupported protocol version: 2099-01-01",
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

  it("writes no line for the 405 to a GET or DELETE (#325)", async () => {
    // claude.ai's 2025-era app loader sends one GET per chart card.
    for (const method of ["GET", "DELETE"]) {
      const response = await makeEndpoint().handleRequest(
        new Request(MCP_URL, { method }),
      );
      expect(response.status, method).toBe(405);
    }

    expect(console.error).not.toHaveBeenCalled();
  });

  it("still logs a 405 to another method", async () => {
    await makeEndpoint().handleRequest(new Request(MCP_URL, { method: "PUT" }));

    expect(rejected()).toEqual([
      expect.objectContaining({ status: 405, http_method: "PUT" }),
    ]);
  });

  describe("an oversized body (#325)", () => {
    const oversized = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);

    /** A body with no Content-Length, sent in 64 KiB chunks. */
    function chunked(text: string): ReadableStream<Uint8Array> {
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      return new ReadableStream({
        pull(controller) {
          if (offset >= bytes.length) return controller.close();
          controller.enqueue(bytes.subarray(offset, offset + 65_536));
          offset += 65_536;
        },
      });
    }

    async function expectTooLarge(request: Request): Promise<void> {
      const response = await makeEndpoint().handleRequest(request);

      expect(response.status).toBe(413);
      expect((await response.json()).error.code).toBe(-32000);
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(rejected()).toEqual([
        expect.objectContaining({
          status: 413,
          code: -32000,
          http_method: "POST",
          reason: expect.stringContaining("Payload Too Large"),
        }),
      ]);
    }

    it("answers a sized body 413 before reading it", async () => {
      const pull = vi.fn();
      await expectTooLarge(
        new Request(MCP_URL, {
          method: "POST",
          headers: { "content-length": String(oversized.length) },
          // highWaterMark 0: the stream pulls only when something reads it.
          body: new ReadableStream({ pull }, { highWaterMark: 0 }),
          duplex: "half",
        } as RequestInit),
      );
      expect(pull).not.toHaveBeenCalled();
    });

    it("answers a chunked body 413 once it passes the limit", async () => {
      await expectTooLarge(
        new Request(MCP_URL, {
          method: "POST",
          body: chunked(oversized),
          duplex: "half",
        } as RequestInit),
      );
    });

    it("answers 413 when the body stream fails (Bun's own limit)", async () => {
      await expectTooLarge(
        new Request(MCP_URL, {
          method: "POST",
          body: new ReadableStream({
            pull(controller) {
              controller.error(new Error("body too large"));
            },
          }),
          duplex: "half",
        } as RequestInit),
      );
    });
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
        {
          ...MODERN_HEADERS,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "get-wellness",
        },
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
        {
          ...MODERN_HEADERS,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "get-wellness",
        },
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
        { ...MODERN_HEADERS, "Mcp-Method": "tools/list" },
      ),
    );

    expect(response.status).toBe(200);
    expect(rejected()).toEqual([]);
  });

  it("never logs the Authorization header", async () => {
    await makeEndpoint().handleRequest(
      unservedRevision("test-client", { Authorization: "Bearer secret-value" }),
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
        { ...MODERN_HEADERS, "Mcp-Method": "tools/list" },
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

    await Promise.all([
      endpoint.handleRequest(unservedRevision("client-a")),
      endpoint.handleRequest(unservedRevision("client-b")),
    ]);

    const seen = rejected();
    expect(seen).toHaveLength(2);
    expect(seen.map((line) => line.client_name).sort()).toEqual([
      "client-a",
      "client-b",
    ]);
    for (const line of seen) {
      expect(line.reason).toBe("Unsupported protocol version: 2099-01-01");
    }
  });
});
