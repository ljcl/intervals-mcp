/**
 * Regression tests for #129: /health reports config and rate-limit state
 * without spending an intervals.icu request, and the advertised version
 * comes from the root package.json that release-please bumps.
 */
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeyConfigured, getIntervalsAthleteId, getTimeZone } from "./config";
import { intervalsApi } from "./fetchClient";
import { handleHealth } from "./health";
import { SERVER_VERSION } from "./version";

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return {
    ...actual,
    apiKeyConfigured: vi.fn(() => false),
    getIntervalsAthleteId: vi.fn(() => "0"),
    getTimeZone: vi.fn(() => "UTC"),
  };
});

vi.mock("./fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchClient")>();
  return {
    ...actual,
    intervalsApi: { getRateLimitSnapshot: vi.fn() },
  };
});

const mockedSnapshot = vi.mocked(intervalsApi.getRateLimitSnapshot);
const mockedApiKeyConfigured = vi.mocked(apiKeyConfigured);
const mockedAthleteId = vi.mocked(getIntervalsAthleteId);
const mockedTimeZone = vi.mocked(getTimeZone);

const get = (path = "/health", headers: Record<string, string> = {}) => {
  const url = new URL(`http://localhost:3000${path}`);
  return { req: new Request(url, { headers }), url };
};

describe("handleHealth", () => {
  beforeEach(() => {
    mockedSnapshot.mockReset();
    mockedSnapshot.mockReturnValue(null);
    mockedApiKeyConfigured.mockReset();
    mockedApiKeyConfigured.mockReturnValue(false);
    mockedAthleteId.mockReset();
    mockedAthleteId.mockReturnValue("0");
    mockedTimeZone.mockReset();
    mockedTimeZone.mockReturnValue("UTC");
  });

  afterEach(() => {
    delete process.env.MCP_AUTH_TOKEN;
  });

  it("reports version, api key state, athlete id, and rate-limit snapshot as JSON", async () => {
    mockedApiKeyConfigured.mockReturnValue(true);
    mockedSnapshot.mockReturnValue({
      shortTerm: { usage: 42, limit: 100 },
      daily: { usage: 310, limit: 1000 },
      observedAt: 1_752_300_000_000,
    } as ReturnType<typeof intervalsApi.getRateLimitSnapshot>);

    const { req, url } = get();
    const response = handleHealth(req, url);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.version).toBe(SERVER_VERSION);
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(body.api_key_configured).toBe(true);
    expect(body.athlete_id).toBe("0");
    expect(body.rate_limit.shortTerm.usage).toBe(42);
  });

  it("defaults athlete_id to 0 and reports the configured time zone", async () => {
    mockedApiKeyConfigured.mockReturnValue(true);
    mockedTimeZone.mockReturnValue("Australia/Sydney");

    const { req, url } = get();
    const body = await (await handleHealth(req, url)).json();

    expect(body.athlete_id).toBe("0");
    expect(body.time_zone).toBe("Australia/Sydney");
  });

  it("reports api_key_configured: false when no key is set", async () => {
    const { req, url } = get();
    const body = await (await handleHealth(req, url)).json();

    expect(body.api_key_configured).toBe(false);
  });

  it("reports per-tool call counters (#241)", async () => {
    mockedApiKeyConfigured.mockReturnValue(true);
    const { recordToolCall, resetToolCallStats } = await import("./telemetry");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    resetToolCallStats();
    recordToolCall({
      tool: "get-best-efforts",
      duration_ms: 120,
      outcome: "ok",
    });
    recordToolCall({
      tool: "get-best-efforts",
      duration_ms: 80,
      outcome: "error",
    });
    stderr.mockRestore();

    const response = handleHealth(
      new Request("http://localhost/health"),
      new URL("http://localhost/health"),
    );
    const body = await response.json();

    expect(body.tools["get-best-efforts"]).toMatchObject({
      calls: 2,
      errors: 1,
      mean_ms: 100,
    });
  });

  it("keeps the counters behind the same secret as the rest of the detail", async () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";

    const response = handleHealth(
      new Request("http://localhost/health"),
      new URL("http://localhost/health"),
    );
    const body = await response.json();

    expect(body.tools).toBeUndefined();
  });

  it("advertises the release version from root package.json, not a hardcoded one", () => {
    const rootVersion = createRequire(import.meta.url)(
      "../../../package.json",
    ).version;

    expect(SERVER_VERSION).toBe(rootVersion);
    expect(SERVER_VERSION).not.toBe("1.0.0");
  });

  it("serves liveness only to unauthenticated callers when a secret is set", async () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";

    const { req, url } = get();
    const response = handleHealth(req, url);
    const body = await response.json();

    // Docker HEALTHCHECK keeps working (200), but config/rate detail is gone.
    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.api_key_configured).toBeUndefined();
    expect(body.rate_limit).toBeUndefined();
  });

  it("serves full detail with the secret presented", async () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";
    mockedApiKeyConfigured.mockReturnValue(true);

    const { req, url } = get("/health", { authorization: "Bearer s3cret" });
    const body = await (await handleHealth(req, url)).json();

    expect(body.api_key_configured).toBe(true);
  });
});
