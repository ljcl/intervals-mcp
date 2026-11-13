/**
 * Regression tests for ljcl/strava-mcp#129: /health reports config and rate-limit state
 * without spending an intervals.icu request, and the advertised version
 * comes from the root package.json that release-please bumps.
 */
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiKeyConfigured,
  getIntervalsAthleteId,
  getOrsApiKey,
  timeZoneSetting,
} from "./config";
import { intervalsApi, orsApi } from "./fetchClient";
import { handleHealth } from "./health";
import { parseCommit, SERVER_VERSION } from "./version";

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return {
    ...actual,
    apiKeyConfigured: vi.fn(() => false),
    getOrsApiKey: vi.fn(() => null),
    getIntervalsAthleteId: vi.fn(() => "0"),
    timeZoneSetting: vi.fn(() => ({ zone: "UTC", source: "fallback" })),
  };
});

vi.mock("./fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchClient")>();
  return {
    ...actual,
    intervalsApi: {
      getRateLimitSnapshot: vi.fn(),
      getAttemptCounts: vi.fn(),
      getUpstreamHealth: vi.fn(),
    },
    orsApi: { getAttemptCounts: vi.fn(), getUpstreamHealth: vi.fn() },
  };
});

const mockedSnapshot = vi.mocked(intervalsApi.getRateLimitSnapshot);
const mockedAttempts = vi.mocked(intervalsApi.getAttemptCounts);
const mockedUpstream = vi.mocked(intervalsApi.getUpstreamHealth);
const mockedOrsAttempts = vi.mocked(orsApi.getAttemptCounts);
const mockedOrsUpstream = vi.mocked(orsApi.getUpstreamHealth);
const mockedOrsKey = vi.mocked(getOrsApiKey);
const mockedApiKeyConfigured = vi.mocked(apiKeyConfigured);
const mockedAthleteId = vi.mocked(getIntervalsAthleteId);
const mockedTimeZone = vi.mocked(timeZoneSetting);

const get = (path = "/health", headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000${path}`, { headers });

describe("handleHealth", () => {
  beforeEach(() => {
    mockedSnapshot.mockReset();
    mockedSnapshot.mockReturnValue(null);
    mockedAttempts.mockReset();
    mockedAttempts.mockReturnValue({
      last15Minutes: 3,
      utcDay: 40,
      utcDate: "2026-10-08",
    });
    mockedUpstream.mockReset();
    mockedUpstream.mockReturnValue({ lastSuccessAt: null, lastFailure: null });
    mockedOrsAttempts.mockReset();
    mockedOrsAttempts.mockReturnValue({
      last15Minutes: 0,
      utcDay: 0,
      utcDate: "2026-10-08",
    });
    mockedOrsUpstream.mockReset();
    mockedOrsUpstream.mockReturnValue({
      lastSuccessAt: null,
      lastFailure: null,
    });
    mockedOrsKey.mockReset();
    mockedOrsKey.mockReturnValue(null);
    mockedApiKeyConfigured.mockReset();
    mockedApiKeyConfigured.mockReturnValue(false);
    mockedAthleteId.mockReset();
    mockedAthleteId.mockReturnValue("0");
    mockedTimeZone.mockReset();
    mockedTimeZone.mockReturnValue({ zone: "UTC", source: "fallback" });
  });

  afterEach(() => {
    delete process.env.MCP_AUTH_TOKEN;
  });

  it("reports version, api key state, athlete id, and rate-limit snapshot as JSON", async () => {
    mockedApiKeyConfigured.mockReturnValue(true);
    mockedSnapshot.mockReturnValue({
      retryAfterSeconds: 42,
      observedAt: 1_752_300_000_000,
    });

    const req = get();
    const response = handleHealth(req);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.version).toBe(SERVER_VERSION);
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(body.api_key_configured).toBe(true);
    expect(body.athlete_id).toBe("0");
    expect(body.rate_limit.retryAfterSeconds).toBe(42);
  });

  it("reports rate_limit as null when the snapshot is null", async () => {
    const req = get();
    const body = await handleHealth(req).json();

    expect(body.rate_limit).toBeNull();
  });

  it("reports the upstream request counts", async () => {
    const req = get();
    const body = await handleHealth(req).json();

    expect(body.upstream_requests).toEqual({
      last_15_min: 3,
      utc_day: 40,
      utc_date: "2026-10-08",
    });
  });

  it("defaults athlete_id to 0", async () => {
    mockedApiKeyConfigured.mockReturnValue(true);

    const req = get();
    const body = await (await handleHealth(req)).json();

    expect(body.athlete_id).toBe("0");
  });

  it("reports the time zone and where it came from", async () => {
    mockedTimeZone.mockReturnValue({
      zone: "Australia/Sydney",
      source: "intervals.icu",
    });

    const req = get();
    const body = await (await handleHealth(req)).json();

    expect(body.time_zone).toBe("Australia/Sydney");
    expect(body.time_zone_source).toBe("intervals.icu");
  });

  it("reports api_key_configured: false when no key is set", async () => {
    const req = get();
    const body = await (await handleHealth(req)).json();

    expect(body.api_key_configured).toBe(false);
  });

  it("reports per-tool call counters (ljcl/strava-mcp#241)", async () => {
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

    const response = handleHealth(new Request("http://localhost/health"));
    const body = await response.json();

    expect(body.tools["get-best-efforts"]).toMatchObject({
      calls: 2,
      errors: 1,
      mean_ms: 100,
    });
  });

  it("keeps the counters behind the same secret as the rest of the detail", async () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";

    const response = handleHealth(new Request("http://localhost/health"));
    const body = await response.json();

    expect(body.tools).toBeUndefined();
  });

  it("advertises the release version from root package.json, not a hardcoded one", () => {
    const rootVersion = createRequire(import.meta.url)(
      "../../../package.json",
    ).version;

    expect(SERVER_VERSION).toBe(rootVersion);
  });

  it("serves liveness only to unauthenticated callers when a secret is set", async () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";

    const req = get();
    const response = handleHealth(req);
    const body = await response.json();

    // Docker HEALTHCHECK keeps working (200), but config/rate detail is gone.
    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.api_key_configured).toBeUndefined();
    expect(body.time_zone_source).toBeUndefined();
    expect(body.rate_limit).toBeUndefined();
    expect(body.upstream_requests).toBeUndefined();
  });

  it("serves full detail with the secret presented", async () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";
    mockedApiKeyConfigured.mockReturnValue(true);

    const req = get("/health", { authorization: "Bearer s3cret" });
    const body = await (await handleHealth(req)).json();

    expect(body.api_key_configured).toBe(true);
  });

  it("serves liveness only for a secret in the URL (#413)", async () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";

    const body = await handleHealth(get("/health?token=s3cret")).json();

    expect(body.status).toBe("ok");
    expect(body.api_key_configured).toBeUndefined();
    expect(body.upstream).toBeUndefined();
  });

  it("reports the commit in the liveness half (#414)", async () => {
    process.env.MCP_AUTH_TOKEN = "s3cret";

    const body = await handleHealth(get()).json();

    // Tests run from a checkout, where GIT_SHA is not set.
    expect(body).toHaveProperty("commit", null);
  });

  it("reports intervals.icu's last failure and last success (#412)", async () => {
    mockedUpstream.mockReturnValue({
      lastSuccessAt: "2026-11-13T00:00:00.000Z",
      lastFailure: {
        status: 401,
        kind: "http",
        at: "2026-11-13T01:00:00.000Z",
      },
    });

    const body = await handleHealth(get()).json();

    expect(body.upstream.intervals).toEqual({
      last_success_at: "2026-11-13T00:00:00.000Z",
      last_failure: {
        status: 401,
        kind: "http",
        at: "2026-11-13T01:00:00.000Z",
      },
    });
  });

  it("reports OpenRouteService's requests today and its last failure (#412)", async () => {
    mockedOrsKey.mockReturnValue("ors-key-value");
    mockedOrsAttempts.mockReturnValue({
      last15Minutes: 4,
      utcDay: 37,
      utcDate: "2026-11-13",
    });
    mockedOrsUpstream.mockReturnValue({
      lastSuccessAt: null,
      lastFailure: {
        status: 429,
        kind: "http",
        at: "2026-11-13T01:00:00.000Z",
      },
    });

    const response = handleHealth(get());
    const text = await response.text();
    const body = JSON.parse(text);

    expect(body.upstream.ors).toEqual({
      api_key_configured: true,
      requests: { last_15_min: 4, utc_day: 37, utc_date: "2026-11-13" },
      last_success_at: null,
      last_failure: {
        status: 429,
        kind: "http",
        at: "2026-11-13T01:00:00.000Z",
      },
    });
    expect(text).not.toContain("ors-key-value");
    expect(text).not.toContain("://");
  });

  it("keeps status ok when an upstream fails, so the HEALTHCHECK is unaffected", async () => {
    mockedUpstream.mockReturnValue({
      lastSuccessAt: null,
      lastFailure: {
        status: 503,
        kind: "http",
        at: "2026-11-13T01:00:00.000Z",
      },
    });

    const response = handleHealth(get());

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ok");
  });
});

describe("parseCommit", () => {
  it.each([
    [
      "a full sha",
      "0123456789abcdef0123456789abcdef01234567",
      "0123456789abcdef0123456789abcdef01234567",
    ],
    ["a short sha, trimmed and lowercased", " ABCDEF1 ", "abcdef1"],
    ["unset", undefined, null],
    ["blank", "", null],
    ["a branch name", "main", null],
    ["too short", "abc123", null],
  ])("%s", (_label, value, expected) => {
    expect(parseCommit(value)).toBe(expected);
  });
});
