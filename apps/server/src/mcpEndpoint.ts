import { AsyncLocalStorage } from "node:async_hooks";
import {
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  PROTOCOL_VERSION_META_KEY,
  type Server,
  TRACEPARENT_META_KEY,
} from "@modelcontextprotocol/server";
import { parseJsonWithLargeInts } from "./fetchClient";
import {
  parseTraceparent,
  type RejectedRequestRecord,
  recordRejectedRequest,
} from "./telemetry";

/** JSON-RPC error code used by the raw HTTP layer (before the SDK sees the body). */
const PARSE_ERROR = -32700;

/**
 * Interval of the SSE keep-alive comment on a streamed response (a tool call
 * that reports progress). The SDK's default, stated here because
 * `IDLE_TIMEOUT_SECONDS` in `httpServer.ts` must stay above it: a stream that
 * sends nothing for longer than Bun's idle timeout is closed mid-call (#51).
 */
export const SSE_KEEP_ALIVE_MS = 15_000;

function jsonRpcError(code: number, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * What the SDK's `onerror` reports during one exchange. The endpoint reads it
 * once the response is known and writes one line for the whole exchange.
 * `answered` flips when the response is back: a report after that, such as a
 * stream that fails mid-body, has no line to join and is printed as it comes.
 */
interface ExchangeReport {
  errors: Error[];
  answered: boolean;
}

/** The report of the exchange the running code belongs to. Unrelated to `callScope.ts`. */
const exchangeReports = new AsyncLocalStorage<ExchangeReport>();

export interface McpEndpoint {
  /** Route one HTTP request on the /mcp endpoint. */
  handleRequest(req: Request): Promise<Response>;
  /**
   * Abort in-flight exchanges. Shutdown calls this after the drain in
   * `httpServer.ts`, so it only cuts calls that outlived the grace period.
   */
  close(): Promise<void>;
}

/**
 * The /mcp endpoint. `createMcpHandler` serves the 2026-07-28 revision per
 * request (stateless, `_meta` envelope, `server/discover`) and nothing else:
 * `legacy: "reject"` answers any 2025-era request (no envelope claim, e.g. an
 * `initialize` handshake) with HTTP 400 and `-32022` UnsupportedProtocolVersion,
 * whose `data.supported` names 2026-07-28. Legacy notifications get 202 and
 * are dropped; GET/DELETE answer 405.
 *
 * Rejecting the old era also closes a downgrade path: only enveloped requests
 * go through the SDK's `Mcp-Method`/`Mcp-Name` header-vs-body check (`-32020`),
 * so a claim-less request served by a legacy fallback could carry any headers
 * it liked past a proxy rule keyed on them.
 *
 * POST bodies are parsed here with the large-int-preserving reviver and handed
 * to the SDK as `parsedBody`, never re-read from the request: a 64-bit
 * intervals.icu id sent as a JSON number (e.g. a route id above 2^53) would
 * otherwise be rounded by a plain `JSON.parse` before any tool schema could
 * see it. When the exact digits do reach us they survive as a string, which
 * the id schemas accept losslessly.
 *
 * Every answer of HTTP 400 or above, except a client-closed 499, writes one
 * `mcp_rejected` line (#69). Errors the SDK reports while it builds the answer
 * go into that line, not into a second one. The `Authorization` header is
 * never read here.
 */
export function createMcpEndpoint(createServer: () => Server): McpEndpoint {
  const handler = createMcpHandler(() => createServer(), {
    legacy: "reject",
    keepAliveMs: SSE_KEEP_ALIVE_MS,
    // Reporting only — the SDK already shaped the response by the time this
    // fires, so a throw here could not change what the client sees. During an
    // exchange the error goes to its report, which becomes the rejection line.
    onerror: (error) => {
      const report = exchangeReports.getStore();
      if (report && !report.answered) {
        report.errors.push(error);
        return;
      }
      console.error("MCP handler error:", error);
    },
  });

  return {
    async handleRequest(req: Request): Promise<Response> {
      const report: ExchangeReport = { errors: [], answered: false };
      let body: unknown;
      let response: Response;
      try {
        if (req.method !== "POST") {
          response = await exchangeReports.run(report, () =>
            handler.fetch(req),
          );
        } else {
          // A malformed body must surface as a JSON-RPC parse error. Letting
          // req.json() reject unhandled instead answers a bare 500, which tells
          // the client nothing about what it got wrong.
          let parsed = false;
          try {
            body = parseJsonWithLargeInts(await req.text());
            parsed = true;
          } catch {
            // Answered below.
          }
          response = parsed
            ? await exchangeReports.run(report, () =>
                handler.fetch(req, { parsedBody: body }),
              )
            : jsonRpcError(PARSE_ERROR, "Parse error: invalid JSON", 400);
        }
      } finally {
        report.answered = true;
      }
      await reportExchange(req, body, response, report.errors);
      return response;
    },
    close: () => handler.close(),
  };
}

/**
 * Write the exchange's log output. A refused request gets one `mcp_rejected`
 * line, with the first reported error as its reason and, for a 5xx, its
 * stack. Any other exchange prints the SDK's reports as before. A 499 is the
 * client leaving: the `tool_call` line says "cancelled" and the SDK does not
 * report it. Never throws.
 */
async function reportExchange(
  req: Request,
  body: unknown,
  response: Response,
  errors: Error[],
): Promise<void> {
  try {
    if (response.status < 400 || response.status === 499) {
      for (const error of errors) console.error("MCP handler error:", error);
      return;
    }
    const answer = await answeredRpcError(response);
    recordRejectedRequest({
      status: response.status,
      code: answer?.code,
      reason: errors[0]?.message ?? answer?.message,
      stack: response.status >= 500 ? errors[0]?.stack : undefined,
      http_method: req.method,
      mcp_method: req.headers.get("mcp-method") ?? undefined,
      ...describeRequestBody(body, req.headers),
    });
  } catch {
    // Logging never changes the answer.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The code and message of the JSON-RPC error in a JSON answer, if it has one. */
async function answeredRpcError(
  response: Response,
): Promise<{ code?: number; message?: string } | undefined> {
  try {
    if (!response.headers.get("content-type")?.includes("application/json")) {
      return undefined;
    }
    const parsed: unknown = await response.clone().json();
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const error = isRecord(first) ? first.error : undefined;
    if (!isRecord(error)) return undefined;
    return {
      code: typeof error.code === "number" ? error.code : undefined,
      message: typeof error.message === "string" ? error.message : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * The request fields a rejection line carries. A batch is described by its
 * first element. The envelope's values win; an `initialize` body and the
 * `Mcp-Protocol-Version` header fill in for a 2025-era client.
 */
function describeRequestBody(
  body: unknown,
  headers: Headers,
): Pick<
  RejectedRequestRecord,
  | "rpc_method"
  | "protocol_version"
  | "client_name"
  | "client_version"
  | "trace_id"
  | "parent_id"
> {
  const first = Array.isArray(body) ? body[0] : body;
  const message = isRecord(first) ? first : {};
  const params = isRecord(message.params) ? message.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const rpcMethod =
    typeof message.method === "string" ? message.method : undefined;
  const isInitialize = rpcMethod === "initialize";

  const metaVersion = meta[PROTOCOL_VERSION_META_KEY];
  const protocolVersion =
    typeof metaVersion === "string"
      ? metaVersion
      : isInitialize && typeof params.protocolVersion === "string"
        ? params.protocolVersion
        : (headers.get("mcp-protocol-version") ?? undefined);

  const info = isRecord(meta[CLIENT_INFO_META_KEY])
    ? meta[CLIENT_INFO_META_KEY]
    : isInitialize && isRecord(params.clientInfo)
      ? params.clientInfo
      : {};
  const trace = parseTraceparent(meta[TRACEPARENT_META_KEY]);
  return {
    rpc_method: rpcMethod,
    protocol_version: protocolVersion,
    client_name: typeof info.name === "string" ? info.name : undefined,
    client_version: typeof info.version === "string" ? info.version : undefined,
    trace_id: trace?.trace_id,
    parent_id: trace?.parent_id,
  };
}
