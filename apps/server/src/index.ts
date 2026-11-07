import { initAthleteTimeZone } from "./athleteTimeZone";
import {
  checkConfig,
  getIntervalsAthleteId,
  getPort,
  timeZoneSetting,
} from "./config";
import { createShutdown, serveOptions } from "./httpServer";
import { warnIfMcpUnprotected } from "./mcpAuth";
import { createMcpEndpoint } from "./mcpEndpoint";
import { startOsmIndexRefresh } from "./osmIndexRefresh";
import { routeStoreInfo } from "./routeStore";
import { createServer } from "./server";

// Every bad variable gets its own line, then the process stops.
const { errors, warnings } = checkConfig();
for (const warning of warnings) console.error(`WARNING: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

// TZ unset, blank or exactly UTC: follow the athlete's intervals.icu zone.
// Waits at most TIME_ZONE_STARTUP_WAIT_MS (athleteTimeZone.ts).
await initAthleteTimeZone();
const timeZone = timeZoneSetting();
console.error(
  `intervals.icu athlete ${getIntervalsAthleteId()}, time zone ${timeZone.zone} (${timeZone.source})`,
);

const store = await routeStoreInfo();
console.error(
  `Route store ${store.dir}: ${store.routes} stored route${store.routes === 1 ? "" : "s"}`,
);
// Containers run on Linux; on a Mac every local directory shares the root's device.
if (store.onRootFs && process.platform === "linux")
  console.error(
    `WARNING: ${store.dir} is not a mounted volume, so stored routes are lost when the container is recreated. Mount a volume or a directory writable by UID 65534 there (docker-compose.yml mounts route-data).`,
  );

// Builds or refreshes the OpenStreetMap index in the background (osmIndexRefresh.ts).
startOsmIndexRefresh();

const PORT = getPort();
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
