import {
  apiKeyConfigured,
  getIntervalsAthleteId,
  getOrsApiKey,
  timeZoneSetting,
} from "./config";
import {
  intervalsApi,
  orsApi,
  type UpstreamFailure,
  type UpstreamHealth,
} from "./fetchClient";
import { authTokenConfigured, requestHasValidSecret } from "./mcpAuth";
import { toolCallStats } from "./telemetry";
import { SERVER_COMMIT, SERVER_VERSION } from "./version";

/** One upstream's last success and failure, as /health shows them. */
function upstreamState(health: UpstreamHealth): {
  last_success_at: string | null;
  last_failure: UpstreamFailure | null;
} {
  return {
    last_success_at: health.lastSuccessAt,
    last_failure: health.lastFailure,
  };
}

/**
 * Structured /health. Everything here is served from local state: the
 * configured key and athlete, the time zone local dates use and where it came
 * from (`env`, `intervals.icu` or `fallback`; see `timeZoneSetting` in
 * config.ts), and the rate-limit snapshot captured off the most recent
 * response from `intervalsClient.ts`'s `intervalsApi`. The rate limit
 * is a snapshot only: intervals.icu sends no rate-limit headers (verified
 * 2026-09-24, docs/api-notes.md), so it reads `null` until a response carries
 * them. `upstream_requests` counts the attempts this process sent to
 * intervals.icu, retries included. `upstream` holds each service's last
 * success and last failure (#412), and OpenRouteService's request counts,
 * so a revoked key or a spent ORS quota shows here. The endpoint never spends
 * an upstream request of its own, and never shows a URL, a coordinate or a
 * key.
 *
 * When MCP_AUTH_TOKEN is configured, unauthenticated callers (for example
 * the Docker HEALTHCHECK) get liveness fields only; config and rate-limit
 * detail require the secret in an `Authorization: Bearer` header. `status`
 * is always "ok": it says the process serves, so an upstream failure never
 * marks the container unhealthy.
 */
export function handleHealth(req: Request): Response {
  const liveness = {
    status: "ok",
    version: SERVER_VERSION,
    commit: SERVER_COMMIT,
    uptime_seconds: Math.floor(process.uptime()),
  };

  if (authTokenConfigured() && !requestHasValidSecret(req)) {
    return Response.json(liveness);
  }

  const timeZone = timeZoneSetting();
  const attempts = intervalsApi.getAttemptCounts();
  const orsAttempts = orsApi.getAttemptCounts();
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
    upstream: {
      intervals: upstreamState(intervalsApi.getUpstreamHealth()),
      ors: {
        api_key_configured: getOrsApiKey() !== null,
        requests: {
          last_15_min: orsAttempts.last15Minutes,
          utc_day: orsAttempts.utcDay,
          utc_date: orsAttempts.utcDate,
        },
        ...upstreamState(orsApi.getUpstreamHealth()),
      },
    },
    // Rolling per-tool counters since process start: which tools are
    // used, how slow they are, and how often they fail. Behind the same secret
    // as the rate-limit detail, since it describes the athlete's usage.
    tools: toolCallStats(),
  });
}
