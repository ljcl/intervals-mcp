/**
 * Era routing and HTTP behaviour of the dual-era /mcp endpoint (#115): a
 * legacy `initialize` is answered per request with no session to track, a
 * modern enveloped request is served on the 2026-07-28 path, malformed JSON
 * returns a JSON-RPC parse error instead of throwing out of `req.json()`,
 * and 64-bit ids survive the body parse in both eras.
 */
import { Server } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
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
  it("answers a legacy initialize per request, with no session to carry", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(post(INITIALIZE_BODY));

    expect(response.status).toBe(200);
    // The 2026-07-28 revision removed protocol sessions; the stateless
    // legacy fallback never mints one, which the 2025 spec allows (the
    // session header was always server-optional).
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const parsed = parseResponse(await response.text());
    expect(parsed?.result?.protocolVersion).toBe("2025-06-18");
  });

  it("serves a legacy request with no prior handshake — each stands alone", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    );

    expect(response.status).toBe(200);
    const parsed = parseResponse(await response.text());
    expect(parsed?.result?.tools).toEqual([]);
  });

  it("accepts a legacy notification with 202", async () => {
    const endpoint = makeEndpoint();

    const response = await endpoint.handleRequest(
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );

    expect(response.status).toBe(202);
  });

  it("routes an enveloped request to the modern era", async () => {
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
    // resultType is the modern wire's discriminator — proof this request was
    // not served by the legacy fallback.
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
    // Strava activity/segment-effort ids exceed 2^53. `req.json()` would
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

    for (const era of ["legacy", "modern"] as const) {
      received = undefined;
      const meta =
        era === "modern" ? `"_meta":${JSON.stringify(MODERN_META)},` : "";
      const response = await endpoint.handleRequest(
        post(
          `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{${meta}"name":"view-route-map","arguments":{"activity_id":3516039180561708486}}}`,
          era === "modern"
            ? { "Mcp-Method": "tools/call", "Mcp-Name": "view-route-map" }
            : {},
        ),
      );
      await response.body?.cancel();

      expect(received, `${era} era`).toBe("3516039180561708486");
    }
  });

  it("answers 405 for the 2025 session operations (GET and DELETE)", async () => {
    const endpoint = makeEndpoint();

    // Stateless serving has no session stream to open or session to delete;
    // the 2025 spec allows a server to answer both with 405.
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
