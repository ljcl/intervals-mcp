import { apiKeyConfigured, getIntervalsAthleteId, getTimeZone } from "./config";
import { intervalsApi } from "./fetchClient";
import { authTokenConfigured, requestHasValidSecret } from "./mcpAuth";
import { toolCallStats } from "./telemetry";
import { SERVER_VERSION } from "./version";

/**
 * Structured /health. Everything here is served from local state: the
 * configured key/athlete/timezone and the rate-limit snapshot captured off
 * the most recent response from `intervalsClient.ts`'s `intervalsApi`. This
 * is a snapshot only: intervals.icu sends no rate-limit headers (verified
 * 2026-09-24, docs/api-notes.md), so it reads `null` until that changes; the
 * endpoint never spends an intervals.icu request of its own either way.
 *
 * When MCP_AUTH_TOKEN is configured, unauthenticated callers (for example
 * the Docker HEALTHCHECK) get liveness fields only; config and rate-limit
 * detail require the secret.
 */
export function handleHealth(req: Request, url: URL): Response {
  const liveness = {
    status: "ok",
    version: SERVER_VERSION,
    uptime_seconds: Math.floor(process.uptime()),
  };

  if (authTokenConfigured() && !requestHasValidSecret(req, url)) {
    return Response.json(liveness);
  }

  return Response.json({
    ...liveness,
    api_key_configured: apiKeyConfigured(),
    athlete_id: getIntervalsAthleteId(),
    time_zone: getTimeZone(),
    rate_limit: intervalsApi.getRateLimitSnapshot(),
    // Rolling per-tool counters since process start: which tools are
    // used, how slow they are, and how often they fail. Behind the same secret
    // as the rate-limit detail, since it describes the athlete's usage.
    tools: toolCallStats(),
  });
}
