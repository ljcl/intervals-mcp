import { handleHealth } from "./health";
import { unauthorizedMcpResponse } from "./mcpAuth";
import { type McpEndpoint } from "./mcpEndpoint";

/**
 * Seconds a connection may send nothing before `Bun.serve` closes it.
 *
 * Bun's default is 10. A tool call that reports progress answers as an SSE
 * stream, and its keep-alive comment comes only every 15 s
 * (`SSE_KEEP_ALIVE_MS`, `mcpEndpoint.ts`), so a call that sent one progress
 * message and then waited more than 10 s on intervals.icu (a run-only
 * lookback is 17 requests in a row; one retried request can take longer) was
 * cut with a connection reset (#51). The value must stay above that
 * keep-alive interval; Bun's maximum is 255. A plain JSON reply that is slow
 * to start is not cut either way (verified on Bun 1.4.2), so this only
 * matters once a response streams.
 */
export const IDLE_TIMEOUT_SECONDS = 120;

/**
 * How long shutdown waits for in-flight requests before it aborts them. It
 * must stay below the time the container runtime gives the process between
 * SIGTERM and SIGKILL: `stop_grace_period` in docker-compose.yml, and
 * Docker's default of 10 s when that is not set.
 */
export const SHUTDOWN_GRACE_MS = 8_000;

/** Routes one request: `/mcp` behind the optional bearer secret, `/health`, else 404. */
export function routeRequest(
  mcp: Pick<McpEndpoint, "handleRequest">,
  req: Request,
): Response | Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/mcp") {
    const denied = unauthorizedMcpResponse(req);
    if (denied) return denied;
    return mcp.handleRequest(req);
  }

  if (url.pathname === "/health") {
    return handleHealth(req, url);
  }

  return new Response("Not found", { status: 404 });
}

/** The options `index.ts` passes to `Bun.serve`. */
export function serveOptions(
  mcp: Pick<McpEndpoint, "handleRequest">,
  listen: { port: number; hostname: string },
) {
  return {
    ...listen,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    fetch: (req: Request) => routeRequest(mcp, req),
  };
}

export interface ShutdownOptions {
  /** The running server. Bun's `stop()` refuses new connections at once and
   * resolves when every in-flight request has finished. */
  server: { stop(): Promise<void> };
  mcp: Pick<McpEndpoint, "close">;
  exit: (code: number) => void;
  graceMs?: number;
  log?: (message: string) => void;
}

/**
 * Builds the SIGINT/SIGTERM handler.
 *
 * The first signal drains: new connections are refused, and requests already
 * running get up to `graceMs` to finish before `mcp.close()` aborts what is
 * left. Before #51 the handler did not wait for `stop()`, so `docker stop`
 * or an image update cut every running call. For `update-activity` that
 * meant a dropped connection in place of the "may already have been
 * applied" answer, and a model that retried an append added the note twice.
 *
 * A second signal exits at once, so a second Ctrl-C does not wait out the
 * grace period.
 */
export function createShutdown({
  server,
  mcp,
  exit,
  graceMs = SHUTDOWN_GRACE_MS,
  log = console.error,
}: ShutdownOptions): (signal: string) => Promise<void> {
  let shuttingDown = false;

  return async (signal) => {
    if (shuttingDown) {
      log(`Received ${signal} again, exiting without waiting.`);
      exit(1);
      return;
    }
    shuttingDown = true;
    log(`Received ${signal}, shutting down...`);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceElapsed = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), graceMs);
    });
    let code = 0;
    try {
      const outcome = await Promise.race([
        server.stop().then(() => "drained" as const),
        graceElapsed,
      ]);
      if (outcome === "timeout") {
        log(
          `Requests still running after ${graceMs} ms; aborting them and exiting.`,
        );
      }
      await mcp.close();
    } catch (error) {
      log(`Shutdown failed: ${String(error)}`);
      code = 1;
    } finally {
      clearTimeout(timer);
    }
    exit(code);
  };
}
