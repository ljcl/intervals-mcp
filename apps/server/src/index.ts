import path from "node:path";
import * as dotenv from "dotenv";
import {
  handleAuthCallback,
  handleAuthStart,
  handleAuthStatus,
} from "./authRoutes";
import { handleHealth } from "./health";
import { unauthorizedMcpResponse, warnIfMcpUnprotected } from "./mcpAuth";
import { createMcpEndpoint } from "./mcpEndpoint";
import { createServer } from "./server";
import { ensureValidToken } from "./tokenManager";

// Load .env file from monorepo root
dotenv.config({
  path: path.resolve(import.meta.dirname, "..", "..", "..", ".env"),
});

const PORT = Number(process.env.PORT ?? 3000);
const HOST = "0.0.0.0";

const mcp = createMcpEndpoint(createServer);

// --- Server Startup ---

console.error("Starting Intervals Extra MCP server...");
warnIfMcpUnprotected();
console.error("Checking Strava token validity...");
await ensureValidToken();
console.error("Token validation complete.");

const httpServer = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/mcp") {
      const denied = unauthorizedMcpResponse(req);
      if (denied) return denied;
      return mcp.handleRequest(req);
    }

    if (url.pathname === "/health") {
      return handleHealth(req, url);
    }

    if (url.pathname === "/auth/start") {
      return handleAuthStart(req, url);
    }

    if (url.pathname === "/auth/callback") {
      return handleAuthCallback(url);
    }

    if (url.pathname === "/auth/status") {
      return handleAuthStatus(req, url);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.error(`Listening on http://${HOST}:${PORT}`);
console.error(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
console.error(`Health check: http://${HOST}:${PORT}/health`);

// Graceful shutdown. SIGINT covers Ctrl-C; SIGTERM is what `docker stop` and
// orchestrators send — without a handler the container is hard-killed after
// the grace period with exchanges left open.
async function shutdown(signal: string): Promise<void> {
  console.error(`Received ${signal}, shutting down...`);
  // Stop accepting new connections while draining in-flight exchanges.
  httpServer.stop();
  await mcp.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
