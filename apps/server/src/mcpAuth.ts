import { timingSafeEqual } from "node:crypto";
import {
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { recordRejectedRequest } from "./telemetry";

/**
 * Optional bearer-token gate for the /mcp endpoint.
 *
 * The README instructs exposing port 3000 publicly (Tailscale Funnel,
 * Cloudflare Tunnel), and without a shared secret anyone who discovers the
 * URL can read all intervals.icu data and call the write tools. When
 * `MCP_AUTH_TOKEN` is set, /mcp requires `Authorization: Bearer <token>`;
 * when unset, behaviour is unchanged (open), with a startup warning if
 * `PUBLIC_URL` suggests the server is internet-facing.
 */

/** The JSON-RPC code of the 401 body and of its log line. */
const UNAUTHORIZED_CODE = -32001;

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** True when an MCP_AUTH_TOKEN secret is configured. */
export function authTokenConfigured(): boolean {
  return Boolean(process.env.MCP_AUTH_TOKEN);
}

/**
 * Checks the configured secret against a `Authorization: Bearer` header or,
 * for browser-driven routes like /health that cannot set headers, a
 * `?token=` query parameter. False when no secret is configured — callers
 * gate on authTokenConfigured() first.
 */
export function requestHasValidSecret(req: Request, url?: URL): boolean {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) return false;
  const header = req.headers.get("authorization");
  const presented =
    header?.match(/^Bearer\s+(.+)$/i)?.[1] ??
    url?.searchParams.get("token") ??
    undefined;
  return presented !== undefined && constantTimeEquals(presented, expected);
}

/**
 * Returns a 401 Response when the request must be rejected, or null when it
 * may proceed (either the token matches or no token is configured).
 * /mcp accepts the header only — MCP clients all support headers, and a
 * query-string secret would leak into request logs.
 */
export function unauthorizedMcpResponse(req: Request): Response | null {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) return null;

  const header = req.headers.get("authorization");
  const presented = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (presented && constantTimeEquals(presented, expected)) return null;

  // The header value is never logged, and the body of an unauthenticated
  // request is never parsed, so this line carries only header-derived fields.
  recordRejectedRequest({
    status: 401,
    code: UNAUTHORIZED_CODE,
    reason:
      header === null
        ? "no Authorization header"
        : presented === undefined
          ? "Authorization is not a Bearer token"
          : "bearer token does not match MCP_AUTH_TOKEN",
    http_method: req.method,
    mcp_method: req.headers.get("mcp-method") ?? undefined,
    protocol_version: req.headers.get("mcp-protocol-version") ?? undefined,
  });

  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: UNAUTHORIZED_CODE, message: "Unauthorized" },
      id: null,
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="mcp"',
      },
    },
  );
}

/**
 * Returns a 403 Response when a browser page from a foreign origin calls
 * /mcp, or null when it may proceed. Without this, a page using DNS
 * rebinding reaches a local server that runs with no MCP_AUTH_TOKEN. MCP
 * clients that are not browsers send no Origin and pass; localhost and the
 * PUBLIC_URL host are allowed.
 */
export function foreignOriginResponse(req: Request): Response | null {
  const allowed = localhostAllowedOrigins();
  try {
    if (process.env.PUBLIC_URL) {
      allowed.push(new URL(process.env.PUBLIC_URL).hostname);
    }
  } catch {
    // An unparsable PUBLIC_URL only feeds the startup warning; allow localhost.
  }
  const denied = originValidationResponse(req, allowed);
  if (!denied) return null;
  recordRejectedRequest({
    status: denied.status,
    reason: "Origin not allowed",
    http_method: req.method,
    mcp_method: req.headers.get("mcp-method") ?? undefined,
    protocol_version: req.headers.get("mcp-protocol-version") ?? undefined,
  });
  return denied;
}

/**
 * Startup nudge: a configured PUBLIC_URL implies the server is reachable
 * from the internet, where an unauthenticated /mcp exposes the athlete's
 * data and write scope to anyone who finds the URL.
 */
export function warnIfMcpUnprotected(): void {
  if (!process.env.MCP_AUTH_TOKEN && process.env.PUBLIC_URL) {
    console.error(
      "WARNING: PUBLIC_URL is set but MCP_AUTH_TOKEN is not. /mcp is " +
        "unauthenticated, so anyone who discovers the URL can read your " +
        "intervals.icu data and modify activities. Set MCP_AUTH_TOKEN and " +
        'add an "Authorization: Bearer <token>" header to your MCP client ' +
        "config.",
    );
  }
}
