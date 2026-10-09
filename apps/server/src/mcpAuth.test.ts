import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestHasValidSecret, unauthorizedMcpResponse } from "./mcpAuth";

const request = (authorization?: string) =>
  new Request("http://localhost:3000/mcp", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });

describe("unauthorizedMcpResponse", () => {
  afterEach(() => {
    delete process.env.MCP_AUTH_TOKEN;
  });

  it("allows everything when MCP_AUTH_TOKEN is unset (behaviour unchanged)", () => {
    expect(unauthorizedMcpResponse(request())).toBeNull();
    expect(unauthorizedMcpResponse(request("Bearer anything"))).toBeNull();
  });

  it("rejects requests without an Authorization header", async () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";

    const denied = unauthorizedMcpResponse(request());

    expect(denied?.status).toBe(401);
    expect(denied?.headers.get("WWW-Authenticate")).toContain("Bearer");
    const body = await denied?.json();
    expect(body.error.message).toBe("Unauthorized");
  });

  it("rejects a wrong token", () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";

    expect(unauthorizedMcpResponse(request("Bearer nope"))?.status).toBe(401);
  });

  it("rejects a non-Bearer scheme carrying the right value", () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";

    expect(unauthorizedMcpResponse(request("Basic s3cret"))?.status).toBe(401);
  });

  it("allows the configured token", () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";

    expect(unauthorizedMcpResponse(request("Bearer s3cret"))).toBeNull();
  });

  it("accepts a case-insensitive Bearer scheme", () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";

    expect(unauthorizedMcpResponse(request("bearer s3cret"))).toBeNull();
  });
});

describe("requestHasValidSecret", () => {
  afterEach(() => {
    delete process.env.MCP_AUTH_TOKEN;
  });

  it("accepts a valid ?token= query parameter", () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";

    const url = new URL("http://localhost:3000/health?token=s3cret");
    const req = new Request(url);

    expect(requestHasValidSecret(req, url)).toBe(true);
  });

  it("rejects a wrong ?token= query parameter", () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";

    const url = new URL("http://localhost:3000/health?token=nope");
    const req = new Request(url);

    expect(requestHasValidSecret(req, url)).toBe(false);
  });

  it("returns false when no secret is configured", () => {
    const url = new URL("http://localhost:3000/health?token=anything");
    const req = new Request(url);

    expect(requestHasValidSecret(req, url)).toBe(false);
  });
});

describe("unauthorizedMcpResponse rejection log (#69)", () => {
  beforeEach(() => {
    process.env.MCP_AUTH_TOKEN = "s3cret";
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.MCP_AUTH_TOKEN;
    vi.restoreAllMocks();
  });

  function logged(): Array<Record<string, unknown>> {
    return vi
      .mocked(console.error)
      .mock.calls.map(([line]) => JSON.parse(String(line)));
  }

  it("logs a missing header", () => {
    unauthorizedMcpResponse(request());

    expect(logged()).toEqual([
      expect.objectContaining({
        event: "mcp_rejected",
        status: 401,
        code: -32001,
        reason: "no Authorization header",
        http_method: "POST",
      }),
    ]);
  });

  it("logs a scheme that is not Bearer", () => {
    unauthorizedMcpResponse(request("Basic s3cret"));

    expect(logged()).toEqual([
      expect.objectContaining({
        reason: "Authorization is not a Bearer token",
      }),
    ]);
    expect(JSON.stringify(logged())).not.toContain("s3cret");
  });

  it("logs a wrong token without the token", () => {
    unauthorizedMcpResponse(request("Bearer nope"));

    expect(logged()).toEqual([
      expect.objectContaining({
        reason: "bearer token does not match MCP_AUTH_TOKEN",
      }),
    ]);
    const text = JSON.stringify(logged());
    expect(text).not.toContain("nope");
    expect(text).not.toContain("s3cret");
  });

  it("copies the mcp-method and mcp-protocol-version headers", () => {
    const req = new Request("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        "mcp-method": "tools/call",
        "mcp-protocol-version": "2026-07-28",
      },
    });

    unauthorizedMcpResponse(req);

    expect(logged()).toEqual([
      expect.objectContaining({
        mcp_method: "tools/call",
        protocol_version: "2026-07-28",
      }),
    ]);
  });

  it("logs nothing for an allowed token", () => {
    unauthorizedMcpResponse(request("Bearer s3cret"));

    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs nothing when no secret is configured", () => {
    delete process.env.MCP_AUTH_TOKEN;

    unauthorizedMcpResponse(request());

    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs nothing when requestHasValidSecret fails", () => {
    requestHasValidSecret(request("Bearer nope"));
    requestHasValidSecret(request());

    expect(console.error).not.toHaveBeenCalled();
  });
});
