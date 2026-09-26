/**
 * The MCP client for the tests that assert what a host actually receives.
 *
 * Several suites need the same thing: a real exchange through
 * `createMcpEndpoint(createServer)`, driven over the transport rather than
 * against the in-memory server object. That distinction is the whole point —
 * an annotation, capability, or schema that does not serialize cannot
 * influence a host, and a table in memory proves nothing about the wire.
 *
 * The endpoint serves only the 2026-07-28 revision: no handshake at all; every
 * request carries the `io.modelcontextprotocol/*` envelope keys in
 * `params._meta` plus the `Mcp-Method` (and, where the body names one,
 * `Mcp-Name`) header, and capabilities come from `server/discover`.
 *
 * Every protocol-surface suite drives the endpoint through this client, so a
 * protocol change is fixed once, here — never by re-bootstrapping in a new
 * suite.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { createMcpEndpoint } from "./mcpEndpoint";
import { createServer } from "./server";

/** The 2026-07-28 revision every request names in its envelope. */
export const PROTOCOL_VERSION = "2026-07-28";

/** A JSON-RPC response as it came off the wire. */
export interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface McpTestClient {
  /**
   * The `server/discover` result (`capabilities`, `supportedVersions`,
   * `serverInfo`), fetched once on connect.
   */
  discover: Record<string, unknown>;
  /** Send a request and return the parsed JSON-RPC response. */
  send(method: string, params?: unknown): Promise<JsonRpcResponse>;
  /** Send a request and return the raw body, for asserting on notifications. */
  sendRaw(method: string, params?: unknown): Promise<string>;
  /** Abort anything in flight; the endpoint holds no sessions to drain. */
  close(): Promise<void>;
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Every JSON payload in a response body. An exchange answers with a bare JSON
 * document unless the handler emitted notifications first (progress upgrades
 * it to SSE). So the parser accepts both shapes and returns each `data:` line (or the one
 * document) in order.
 */
export function parseBodyPayloads(raw: string): JsonRpcResponse[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return [JSON.parse(trimmed) as JsonRpcResponse];
  }
  return trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length)) as JsonRpcResponse);
}

/**
 * The JSON-RPC *response* in a body that may also carry notifications —
 * a progress line arriving before the result must not be mistaken for it.
 */
export function parseResponse(raw: string): JsonRpcResponse | null {
  return (
    parseBodyPayloads(raw).find(
      (payload) =>
        payload.id !== undefined &&
        (payload.result !== undefined || payload.error !== undefined),
    ) ?? null
  );
}

/** The reserved envelope keys a 2026-07-28 request carries in `params._meta`. */
function envelope(clientName: string): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
    [CLIENT_INFO_META_KEY]: { name: clientName, version: "1.0" },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };
}

/** Connect a client bound to a fresh endpoint and run `server/discover`. */
export async function connectTestClient(
  clientName = "integration-test",
): Promise<McpTestClient> {
  const endpoint = createMcpEndpoint(createServer);
  let nextId = 1;

  const sendRaw = async (method: string, params: unknown = {}) => {
    const merged = params as Record<string, unknown>;
    const body = {
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: {
        ...merged,
        // Caller-supplied keys win, so a test can override an envelope claim
        // (e.g. name an unsupported revision on purpose).
        _meta: {
          ...envelope(clientName),
          ...(merged._meta as Record<string, unknown> | undefined),
        },
      },
    };
    const headers: Record<string, string> = { "Mcp-Method": method };
    // SEP-2243: when the body names a tool, prompt, or resource uri, the
    // Mcp-Name header must carry the same value — the endpoint rejects a
    // mismatch or an absence with -32020.
    const name = merged.name ?? merged.uri;
    if (typeof name === "string") headers["Mcp-Name"] = name;
    const response = await endpoint.handleRequest(post(body, headers));
    return await response.text();
  };

  const send = async (method: string, params: unknown = {}) => {
    const raw = await sendRaw(method, params);
    const parsed = parseResponse(raw);
    if (!parsed) throw new Error(`no JSON-RPC response in ${method}: ${raw}`);
    return parsed;
  };

  // No handshake in this revision; `server/discover` is the optional probe
  // that replaced initialize's advertisement.
  const discover = (await send("server/discover")).result ?? {};

  return {
    discover,
    send,
    sendRaw,
    close: () => endpoint.close(),
  };
}
