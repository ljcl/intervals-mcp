import { createMcpHandler, type Server } from "@modelcontextprotocol/server";
import { parseJsonWithLargeInts } from "./fetchClient";

/** JSON-RPC error code used by the raw HTTP layer (before the SDK sees the body). */
const PARSE_ERROR = -32700;

function jsonRpcError(code: number, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

export interface McpEndpoint {
  /** Route one HTTP request on the /mcp endpoint. */
  handleRequest(req: Request): Promise<Response>;
  /** Abort in-flight exchanges, e.g. on SIGTERM before exit. */
  close(): Promise<void>;
}

/**
 * The dual-era /mcp endpoint. `createMcpHandler` serves the 2026-07-28
 * revision per request (stateless, `_meta` envelope, `server/discover`) and
 * falls back to the established stateless idiom for 2025-era clients
 * (`legacy: "stateless"`), so one `createServer` factory backs both eras and
 * they can never drift apart.
 *
 * There are no protocol sessions in either era: the 2026-07-28 revision
 * removed them and the `Mcp-Session-Id` header outright, and the legacy
 * fallback answers each old-era request with a fresh instance rather than
 * pinning one to a session (GET/DELETE session operations answer 405, which
 * the 2025 spec allows).
 *
 * POST bodies are parsed here with the large-int-preserving reviver and handed
 * to the SDK as `parsedBody`, never re-read from the request: a 64-bit
 * intervals.icu id sent as a JSON number (e.g. a route id above 2^53) would
 * otherwise be rounded by a plain `JSON.parse` before any tool schema could
 * see it. When the exact digits do reach us they survive as a string, which
 * the id schemas accept losslessly.
 */
export function createMcpEndpoint(createServer: () => Server): McpEndpoint {
  const handler = createMcpHandler(() => createServer(), {
    legacy: "stateless",
    // Reporting only — the SDK already shaped the response by the time this
    // fires, so a throw here could not change what the client sees.
    onerror: (error) => console.error("MCP handler error:", error),
  });

  return {
    async handleRequest(req: Request): Promise<Response> {
      if (req.method !== "POST") return handler.fetch(req);

      // A malformed body must surface as a JSON-RPC parse error. Letting
      // req.json() reject unhandled instead answers a bare 500, which tells
      // the client nothing about what it got wrong.
      let body: unknown;
      try {
        body = parseJsonWithLargeInts(await req.text());
      } catch {
        return jsonRpcError(PARSE_ERROR, "Parse error: invalid JSON", 400);
      }
      return handler.fetch(req, { parsedBody: body });
    },
    close: () => handler.close(),
  };
}
