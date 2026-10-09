/**
 * The athlete's time zone from intervals.icu, for a server whose `TZ` chooses
 * none (#56). Without it, "today" is UTC, so east of UTC this morning's run
 * falls outside every default date window.
 *
 * - `TZ` unset, blank or exactly `UTC` follows the athlete. docker-compose.yml
 *   injects `TZ=${TZ:-UTC}`, so exactly `UTC` means "not chosen". Any other
 *   zone is a choice, and `Etc/UTC` pins UTC.
 * - index.ts awaits {@link initAthleteTimeZone} before it listens.
 *   `getTimeZone()` is synchronous at every call site, including the
 *   instructions `createServer` builds per request, so the zone must be known
 *   before the first request. The wait is bounded; after it, the server
 *   serves with the fallback zone, and a late answer still applies.
 * - A transient failure (429, timeout, 5xx, network fault, an unexpected
 *   shape) re-runs the lookup after 1, 5 and 15 minutes, then hourly. This is
 *   a one-shot startup task run again, not an HTTP retry: each run goes
 *   through FetchClient's own bounded retries and pacing. A definite refusal
 *   (a 4xx such as a revoked key or a wrong athlete id) can never succeed, so
 *   it logs one WARNING and stops.
 * - It runs outside any tool call, so no call scope or signal applies.
 */
import {
  apiKeyConfigured,
  getIntervalsApiKey,
  getIntervalsAthleteId,
  getTimeZone,
  setAthleteTimeZone,
  timeZoneNeedsAthlete,
} from "./config";
import { HttpError, RateLimitError } from "./fetchClient";
import { getAthleteTimeZone } from "./intervalsClient";

/** The longest startup waits for intervals.icu before it listens anyway. */
export const TIME_ZONE_STARTUP_WAIT_MS = 5_000;

/** Delays before each re-run after a transient failure; the last repeats. */
export const TIME_ZONE_RETRY_DELAYS_MS: readonly number[] = [
  60_000, 300_000, 900_000, 3_600_000,
];

export interface AthleteTimeZoneOptions {
  /** How long to wait for the first answer. Default {@link TIME_ZONE_STARTUP_WAIT_MS}. */
  waitMs?: number;
  /** Where messages go. Default `console.error` (stderr). */
  log?: (message: string) => void;
}

type Log = (message: string) => void;

let started = false;
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A failure that a re-run cannot fix: intervals.icu answered with a 4xx. A
 * 429 is a rate limit, and a Cloudflare challenge never reached intervals.icu,
 * so both count as transient.
 */
function isDefiniteFailure(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    !(error instanceof RateLimitError) &&
    !error.response.cloudflareChallenge &&
    error.response.status < 500
  );
}

async function lookup(log: Log): Promise<void> {
  let raw: string | null;
  try {
    raw = await getAthleteTimeZone(getIntervalsApiKey());
  } catch (error) {
    // Error bodies reach a message only through summarizeErrorBody, and no
    // message carries the API key.
    const message = error instanceof Error ? error.message : String(error);
    if (isDefiniteFailure(error)) {
      log(
        `WARNING: intervals.icu refused the time zone lookup (${message}). Local dates use ${getTimeZone()}. Check INTERVALS_API_KEY and INTERVALS_ATHLETE_ID, or set TZ.`,
      );
      return;
    }
    const delay =
      TIME_ZONE_RETRY_DELAYS_MS[
        Math.min(failures, TIME_ZONE_RETRY_DELAYS_MS.length - 1)
      ]!;
    failures += 1;
    log(
      `WARNING: could not read the athlete's time zone from intervals.icu (${message}). Local dates use ${getTimeZone()}; trying again in ${delay / 60_000} min. Set TZ to skip the lookup.`,
    );
    retryTimer = setTimeout(() => void lookup(log), delay);
    // A pending re-run must not keep the process alive on shutdown.
    retryTimer.unref();
    return;
  }

  if (raw === null) {
    log(
      `WARNING: intervals.icu has no time zone set for athlete ${getIntervalsAthleteId()}, so local dates use ${getTimeZone()}. Set it in intervals.icu and restart, or set TZ.`,
    );
  } else if (!setAthleteTimeZone(raw)) {
    log(
      `WARNING: intervals.icu gave the time zone ${JSON.stringify(raw)}, which this server does not recognise, so local dates use ${getTimeZone()}. Set TZ.`,
    );
  } else {
    log(`Time zone ${raw}, from intervals.icu.`);
  }
}

/**
 * Reads the athlete's zone once, when TZ chooses none and a key is set. Waits
 * at most `waitMs` for the answer, then returns and lets the lookup finish in
 * the background. Never throws, and does nothing after the first call.
 */
export async function initAthleteTimeZone(
  options: AthleteTimeZoneOptions = {},
): Promise<void> {
  if (started || !timeZoneNeedsAthlete() || !apiKeyConfigured()) return;
  started = true;
  const waitMs = options.waitMs ?? TIME_ZONE_STARTUP_WAIT_MS;
  const log = options.log ?? ((message: string) => console.error(message));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<"waited">((resolve) => {
    timer = setTimeout(() => resolve("waited"), waitMs);
  });
  const outcome = await Promise.race([
    lookup(log).then(() => "answered" as const),
    waited,
  ]);
  clearTimeout(timer);
  if (outcome === "waited") {
    log(
      `intervals.icu has not answered the time zone lookup after ${waitMs / 1000} s; serving with ${getTimeZone()} until it does.`,
    );
  }
}

/** Test seam: forgets the lookup, its pending re-run and the athlete's zone. */
export function resetAthleteTimeZone(): void {
  started = false;
  failures = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  setAthleteTimeZone(null);
}
