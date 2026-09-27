import path from "node:path";
import * as dotenv from "dotenv";
import {
  apiKeyConfigured,
  getIntervalsAthleteId,
  getTimeZone,
  MissingApiKeyError,
} from "./config";
import { createShutdown, serveOptions } from "./httpServer";
import { warnIfMcpUnprotected } from "./mcpAuth";
import { createMcpEndpoint } from "./mcpEndpoint";
import { createServer } from "./server";

// Load .env file from monorepo root
dotenv.config({
  path: path.resolve(import.meta.dirname, "..", "..", "..", ".env"),
  quiet: true,
});

if (!apiKeyConfigured()) {
  console.error(new MissingApiKeyError().message);
  process.exit(1);
}
console.error(
  `intervals.icu athlete ${getIntervalsAthleteId()}, time zone ${getTimeZone()}`,
);

const PORT = Number(process.env.PORT ?? 3000);
const HOST = "0.0.0.0";

const mcp = createMcpEndpoint(createServer);

// --- Server Startup ---

console.error("Starting Intervals Extra MCP server...");
warnIfMcpUnprotected();

const httpServer = Bun.serve(serveOptions(mcp, { port: PORT, hostname: HOST }));

console.error(`Listening on http://${HOST}:${PORT}`);
console.error(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
console.error(`Health check: http://${HOST}:${PORT}/health`);

// Graceful shutdown. SIGINT covers Ctrl-C; SIGTERM is what `docker stop` and
// orchestrators send. The first signal drains in-flight calls for up to
// SHUTDOWN_GRACE_MS; a second one exits at once (httpServer.ts).
const shutdown = createShutdown({
  server: httpServer,
  mcp,
  exit: (code) => process.exit(code),
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
