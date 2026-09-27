import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShutdown,
  IDLE_TIMEOUT_SECONDS,
  routeRequest,
  SHUTDOWN_GRACE_MS,
  serveOptions,
} from "./httpServer";
import { SSE_KEEP_ALIVE_MS } from "./mcpEndpoint";

const COMPOSE_URL = new URL("../../../docker-compose.yml", import.meta.url);

function fakeMcp() {
  return {
    handleRequest: vi.fn(async () => new Response("mcp")),
    close: vi.fn(async () => {}),
  };
}

describe("serveOptions", () => {
  it("sets idleTimeout, so Bun does not cut a quiet SSE stream after its 10 s default (#51)", () => {
    const options = serveOptions(fakeMcp(), {
      port: 3000,
      hostname: "0.0.0.0",
    });
    expect(options.idleTimeout).toBe(IDLE_TIMEOUT_SECONDS);
    expect(options.port).toBe(3000);
    expect(options.hostname).toBe("0.0.0.0");
  });

  it("keeps the idle timeout above the SSE keep-alive interval and within Bun's limit", () => {
    expect(IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(SSE_KEEP_ALIVE_MS);
    expect(IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255);
  });

  it("routes requests through its fetch handler", async () => {
    const mcp = fakeMcp();
    const options = serveOptions(mcp, { port: 3000, hostname: "0.0.0.0" });
    const response = await options.fetch(
      new Request("http://localhost/mcp", { method: "POST", body: "{}" }),
    );
    expect(await response.text()).toBe("mcp");
  });
});

describe("routeRequest", () => {
  afterEach(() => {
    delete process.env.MCP_AUTH_TOKEN;
  });

  it("sends /mcp to the MCP endpoint", async () => {
    const mcp = fakeMcp();
    const req = new Request("http://localhost/mcp", { method: "POST" });
    const response = await routeRequest(mcp, req);
    expect(mcp.handleRequest).toHaveBeenCalledWith(req);
    expect(await response.text()).toBe("mcp");
  });

  it("refuses /mcp without the secret when MCP_AUTH_TOKEN is set", async () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";
    const mcp = fakeMcp();
    const response = await routeRequest(
      mcp,
      new Request("http://localhost/mcp", { method: "POST" }),
    );
    expect(response.status).toBe(401);
    expect(mcp.handleRequest).not.toHaveBeenCalled();
  });

  it("answers /health", async () => {
    const response = await routeRequest(
      fakeMcp(),
      new Request("http://localhost/health"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("answers 404 for any other path", async () => {
    const response = await routeRequest(
      fakeMcp(),
      new Request("http://localhost/other"),
    );
    expect(response.status).toBe(404);
  });
});

describe("createShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A server whose stop() resolves only when the test says the in-flight request is done. */
  function slowServer() {
    let finishRequest!: () => void;
    const drained = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    return { server: { stop: vi.fn(() => drained) }, finishRequest };
  }

  it("lets an in-flight call finish before it closes the endpoint and exits (#51)", async () => {
    const { server, finishRequest } = slowServer();
    const mcp = fakeMcp();
    const exit = vi.fn();
    const shutdown = createShutdown({ server, mcp, exit, log: () => {} });

    const done = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1000);
    expect(server.stop).toHaveBeenCalledTimes(1);
    // The call is still running inside the grace period: nothing is aborted yet.
    expect(mcp.close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    finishRequest();
    await done;
    expect(mcp.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("aborts what is still running once the grace period is over, and still exits", async () => {
    const { server } = slowServer();
    const mcp = fakeMcp();
    const exit = vi.fn();
    const log = vi.fn();
    const shutdown = createShutdown({ server, mcp, exit, log, graceMs: 5000 });

    const done = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(5000);
    await done;

    expect(mcp.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(log).toHaveBeenCalledWith(
      "Requests still running after 5000 ms; aborting them and exiting.",
    );
  });

  it("exits at once on a second signal", async () => {
    const { server } = slowServer();
    const exit = vi.fn();
    const shutdown = createShutdown({
      server,
      mcp: fakeMcp(),
      exit,
      log: () => {},
    });

    void shutdown("SIGINT");
    await shutdown("SIGINT");

    expect(exit).toHaveBeenCalledWith(1);
    expect(server.stop).toHaveBeenCalledTimes(1);
  });

  it("still exits when closing fails", async () => {
    const mcp = fakeMcp();
    mcp.close.mockRejectedValueOnce(new Error("boom"));
    const exit = vi.fn();
    const log = vi.fn();
    const shutdown = createShutdown({
      server: { stop: async () => {} },
      mcp,
      exit,
      log,
    });

    await shutdown("SIGTERM");

    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith("Shutdown failed: Error: boom");
  });

  it("fits the drain inside docker-compose's stop_grace_period", () => {
    const compose = readFileSync(COMPOSE_URL, "utf8");
    const match = /^\s*stop_grace_period:\s*(\d+)s\s*$/m.exec(compose);
    expect(
      match,
      "docker-compose.yml sets no stop_grace_period",
    ).not.toBeNull();
    expect(Number(match![1]) * 1000).toBeGreaterThan(SHUTDOWN_GRACE_MS);
  });
});
