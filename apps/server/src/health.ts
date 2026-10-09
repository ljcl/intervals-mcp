import {
  apiKeyConfigured,
  getIntervalsAthleteId,
  timeZoneSetting,
} from "./config";
import { intervalsApi } from "./fetchClient";
import { authTokenConfigured, requestHasValidSecret } from "./mcpAuth";
import { toolCallStats } from "./telemetry";
import { SERVER_VERSION } from "./version";

/**
 * Structured /health. Everything here is served from local state: the
 * configured key and athlete, the time zone local dates use and where it came
 * from (`env`, `intervals.icu` or `fallback`; see `timeZoneSetting` in
 * config.ts), and the rate-limit snapshot captured off the most recent
 * response from `intervalsClient.ts`'s `intervalsApi`. The rate limit
 * is a snapshot only: intervals.icu sends no rate-limit headers (verified
 * 2026-09-24, docs/api-notes.md), so it reads `null` until a response carries
 * them. `upstream_requests` counts the attempts this process sent to
 * intervals.icu, retries included. The endpoint never spends an intervals.icu
 * request of its own.
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

  const timeZone = timeZoneSetting();
  const attempts = intervalsApi.getAttemptCounts();
  return Response.json({
    ...liveness,
    api_key_configured: apiKeyConfigured(),
    athlete_id: getIntervalsAthleteId(),
    time_zone: timeZone.zone,
    time_zone_source: timeZone.source,
    rate_limit: intervalsApi.getRateLimitSnapshot(),
    upstream_requests: {
      last_15_min: attempts.last15Minutes,
      utc_day: attempts.utcDay,
      utc_date: attempts.utcDate,
    },
    // Rolling per-tool counters since process start: which tools are
    // used, how slow they are, and how often they fail. Behind the same secret
    // as the rate-limit detail, since it describes the athlete's usage.
    tools: toolCallStats(),
  });
}
