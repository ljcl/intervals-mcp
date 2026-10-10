import { TtlLruCache } from "./cache";
import {
  CallCancelledError,
  currentCallSignal,
  throwIfCancelled,
} from "./callScope";

/** What an {@link HttpError} keeps from the failed response. */
export interface HttpErrorResponse {
  status: number;
  statusText: string;
  /** The raw response body, never shortened. */
  data: string;
  /** The response's `Content-Type`, when it sent one. */
  contentType?: string;
  /**
   * True when Cloudflare, in front of intervals.icu, answered with a
   * challenge page (`cf-mitigated: challenge`) instead of passing the request
   * on. The API key was never checked, so a caller must not report this 403
   * as a rejected key.
   */
  cloudflareChallenge?: boolean;
}

export class HttpError extends Error {
  response: HttpErrorResponse;

  constructor(message: string, response: HttpErrorResponse) {
    super(message);
    this.name = "HttpError";
    this.response = response;
  }
}

/**
 * A single rate-limit window: how many requests are allowed and how many
 * have been used. The convention this parses (two windows, 15-minute and
 * daily, for both an overall and a read-only quota) is a third-party API's;
 * intervals.icu sends none of these headers (verified 2026-09-24), so this
 * stays dormant for it and is kept generic for any future host that does.
 */
export interface RateLimitWindow {
  limit: number;
  usage: number;
}

/**
 * Snapshot of the rate-limit headers from the most recent response, when the
 * upstream API sends them.
 *
 * Parses comma-separated `X-RateLimit-Limit` / `X-RateLimit-Usage` (overall)
 * and `X-ReadRateLimit-Limit` / `X-ReadRateLimit-Usage` (read-only) headers,
 * each formatted `"<15-min>,<daily>"`. A `Retry-After` header may also
 * accompany a 429.
 */
export interface RateLimitSnapshot {
  shortTerm?: RateLimitWindow;
  daily?: RateLimitWindow;
  readShortTerm?: RateLimitWindow;
  readDaily?: RateLimitWindow;
  retryAfterSeconds?: number;
  /** `Date.now()` when this snapshot was captured. */
  observedAt: number;
}

/**
 * Thrown when a request answers 429 and we have either exhausted our retries or
 * the window will not reset soon enough to be worth waiting on. Carries the parsed
 * rate-limit snapshot so callers can surface a structured, actionable message
 * (which window is exhausted, when it resets).
 */
export class RateLimitError extends HttpError {
  rateLimit: RateLimitSnapshot;
  retryAfterSeconds: number | null;
  /**
   * The window description on its own — which window is exhausted and when it
   * resets — with no caller context in front of it. `handleApiError` rethrows
   * this error unmodified, so a tool composing its own sentence ("the scan
   * stopped after 5 of 20 activities…") reads the useful half from here
   * rather than quoting an internal function name at the athlete.
   */
  detail: string;

  constructor(
    message: string,
    response: HttpErrorResponse,
    rateLimit: RateLimitSnapshot,
    retryAfterSeconds: number | null,
    detail: string = message,
  ) {
    super(message, response);
    this.name = "RateLimitError";
    this.rateLimit = rateLimit;
    this.retryAfterSeconds = retryAfterSeconds;
    this.detail = detail;
  }
}

/**
 * Thrown when a request exceeds its timeout and could not be recovered by a
 * retry. Distinct from a generic network fault so callers can say the upstream
 * API did not answer in time rather than surfacing an opaque `TimeoutError`.
 */
export class RequestTimeoutError extends Error {
  timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms.`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * HTTP statuses we treat as transient and retry on safe (GET) requests.
 * intervals.icu sits behind Cloudflare, whose 520-524 mean that Cloudflare
 * could not get an answer from intervals.icu in time (unknown error, origin
 * down, connection timed out, origin unreachable, response timed out): the
 * same kind of fault as a 502 or 504.
 */
const TRANSIENT_STATUSES = new Set([
  500, 502, 503, 504, 520, 521, 522, 523, 524,
]);

/** Longest excerpt of an error body that goes into an error message. */
const ERROR_BODY_EXCERPT_CHARS = 200;

function oneLineExcerpt(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= ERROR_BODY_EXCERPT_CHARS
    ? line
    : `${line.slice(0, ERROR_BODY_EXCERPT_CHARS).trimEnd()}…`;
}

/** The text of an HTML page's `<title>`, or "" when it has none. */
function htmlTitle(html: string): string {
  const open = html.search(/<title/i);
  if (open === -1) return "";
  const start = html.indexOf(">", open) + 1;
  if (start === 0) return "";
  const length = html.slice(start).search(/<\/title/i);
  return length === -1 ? "" : html.slice(start, start + length);
}

/**
 * A short, one-line summary of an error response body, for an error message
 * that a person or a model reads and that the logs print on one line.
 *
 * intervals.icu sits behind Cloudflare, so a failure can come back as a full
 * HTML page (a 52x error page or a challenge page) instead of a JSON error.
 * Putting that page in a message gave a tool error text of about 6,000
 * characters (#52). An HTML body becomes its `<title>` (Cloudflare's pages
 * name the error there, e.g. "522: Connection timed out"); any other body is
 * cut to {@link ERROR_BODY_EXCERPT_CHARS} characters on one line. The raw
 * body stays on `HttpError.response.data`.
 */
export function summarizeErrorBody(
  body: string,
  contentType?: string | null,
): string {
  const trimmed = body.trim();
  if (trimmed === "") return "";
  const isHtml =
    (contentType ?? "").toLowerCase().includes("html") ||
    /^<(!doctype html|html)\b/i.test(trimmed);
  if (!isHtml) return oneLineExcerpt(trimmed);
  const title = oneLineExcerpt(htmlTitle(trimmed));
  return title === "" ? "HTML error page" : `HTML error page "${title}"`;
}

/** Default per-request timeout. intervals.icu's slowest reads land well inside this. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Recognises an aborted request. `AbortSignal.timeout()` rejects `fetch` with a
 * `DOMException` named `TimeoutError`; a manual abort uses `AbortError`. Neither
 * is an `Error` subclass we can `instanceof`, so match on the name. A cancelled
 * call is classified before this check, so here `AbortError` and
 * `TimeoutError` come only from the per-attempt timeout.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

/** Parses the rate-limit convention's comma-separated `"<15-min>,<daily>"` header pair. */
function parsePair(
  limitHeader: string | null,
  usageHeader: string | null,
): { short?: RateLimitWindow; day?: RateLimitWindow } {
  if (!limitHeader || !usageHeader) return {};
  const limits = limitHeader.split(",").map((v) => Number(v.trim()));
  const usages = usageHeader.split(",").map((v) => Number(v.trim()));
  const result: { short?: RateLimitWindow; day?: RateLimitWindow } = {};
  if (Number.isFinite(limits[0]) && Number.isFinite(usages[0])) {
    result.short = { limit: limits[0] as number, usage: usages[0] as number };
  }
  if (Number.isFinite(limits[1]) && Number.isFinite(usages[1])) {
    result.day = { limit: limits[1] as number, usage: usages[1] as number };
  }
  return result;
}

/** Reads the rate-limit headers from a response into a snapshot. */
export function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot {
  const overall = parsePair(
    headers.get("x-ratelimit-limit"),
    headers.get("x-ratelimit-usage"),
  );
  const read = parsePair(
    headers.get("x-readratelimit-limit"),
    headers.get("x-readratelimit-usage"),
  );
  const retryAfterRaw = headers.get("retry-after");
  const retryAfter =
    retryAfterRaw !== null && Number.isFinite(Number(retryAfterRaw))
      ? Number(retryAfterRaw)
      : undefined;

  return {
    shortTerm: overall.short,
    daily: overall.day,
    readShortTerm: read.short,
    readDaily: read.day,
    retryAfterSeconds: retryAfter,
    observedAt: Date.now(),
  };
}

/** True when the snapshot holds at least one value parsed from a header. */
function carriesRateLimitData(s: RateLimitSnapshot): boolean {
  return (
    s.shortTerm !== undefined ||
    s.daily !== undefined ||
    s.readShortTerm !== undefined ||
    s.readDaily !== undefined ||
    s.retryAfterSeconds !== undefined
  );
}

/** Next quarter-hour boundary (UTC): when a 15-minute rate-limit window resets. */
function next15MinReset(now: Date): Date {
  const reset = new Date(now);
  const nextQuarter = (Math.floor(now.getUTCMinutes() / 15) + 1) * 15;
  // setUTCMinutes overflows past 59 into the next hour, which is what we want.
  reset.setUTCMinutes(nextQuarter, 0, 0);
  return reset;
}

/** Next UTC midnight: when a daily rate-limit window resets. */
function nextDailyReset(now: Date): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
    ),
  );
}

/**
 * Builds a structured, actionable description of an exhausted rate limit:
 * which window is exhausted, current usage, and when it resets.
 */
export function describeRateLimit(
  snapshot: RateLimitSnapshot,
  now = new Date(),
): string {
  const parts: string[] = [];

  const dailyExhausted =
    snapshot.daily && snapshot.daily.usage >= snapshot.daily.limit;
  const shortExhausted =
    snapshot.shortTerm && snapshot.shortTerm.usage >= snapshot.shortTerm.limit;

  // Prefer reporting the window that is actually exhausted; the daily window is
  // the more serious one when both are hit.
  if (dailyExhausted && snapshot.daily) {
    const reset = nextDailyReset(now);
    const mins = Math.max(
      1,
      Math.round((reset.getTime() - now.getTime()) / 60000),
    );
    parts.push(
      `Daily rate limit reached (${snapshot.daily.usage}/${snapshot.daily.limit} requests). Resets at ${reset.toISOString()} (~${mins} min).`,
    );
  } else if (shortExhausted && snapshot.shortTerm) {
    const reset = next15MinReset(now);
    const mins = Math.max(
      1,
      Math.round((reset.getTime() - now.getTime()) / 60000),
    );
    parts.push(
      `15-minute rate limit reached (${snapshot.shortTerm.usage}/${snapshot.shortTerm.limit} requests). Resets at ${reset.toISOString()} (~${mins} min).`,
    );
  } else if (snapshot.shortTerm !== undefined || snapshot.daily !== undefined) {
    // 429 with rate-limit headers present but neither window cleanly
    // exhausted (e.g. the read-only quota, which this snapshot doesn't carry
    // separately), the 15-minute window is the most likely culprit, and
    // headers being present at all means this is a response following that convention.
    const reset = next15MinReset(now);
    const mins = Math.max(
      1,
      Math.round((reset.getTime() - now.getTime()) / 60000),
    );
    parts.push(
      `Rate limit reached. The 15-minute window resets at ${reset.toISOString()} (~${mins} min).`,
    );
  } else {
    // No rate-limit headers at all: intervals.icu sends none (see the
    // `intervalsApi` client below) and paces requests itself instead, so
    // there is no window boundary to report. Guessing at a quarter-hour
    // reset here would be actively wrong for a provider that paces itself instead.
    parts.push("Rate limit reached; wait a few minutes and retry.");
  }

  if (snapshot.shortTerm) {
    parts.push(
      `15-min usage: ${snapshot.shortTerm.usage}/${snapshot.shortTerm.limit}.`,
    );
  }
  if (snapshot.daily) {
    parts.push(`Daily usage: ${snapshot.daily.usage}/${snapshot.daily.limit}.`);
  }
  if (snapshot.retryAfterSeconds !== undefined) {
    parts.push(`Retry-After: ${snapshot.retryAfterSeconds}s.`);
  }

  return parts.join(" ");
}

interface FetchConfig {
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  data?: unknown;
  method?: string;
  /**
   * `bytes` reads the body as raw bytes (a `Uint8Array`), for a binary file
   * such as an activity's original FIT file; an error body is still decoded
   * as text for its message.
   */
  responseType?: "json" | "text" | "bytes";
  /**
   * Skip the response cache for this request entirely — neither read a cached
   * value nor store the result. Used by write paths that need a guaranteed-fresh
   * read (e.g. composing an appended activity description), so they never act on
   * a stale cached copy.
   */
  skipCache?: boolean;
}

/**
 * Configures the {@link FetchClient} response cache. Caching is opt-in: without
 * a `ttlForPath`, the client never caches. The policy maps a request *path*
 * (URL minus base and query string) to a TTL in ms, or `null` to skip caching
 * that path — so only the resources you explicitly mark are cached.
 */
export interface ResponseCacheOptions {
  /**
   * Returns the cache TTL (ms) for a cacheable GET path, or `null` to not cache
   * it. Only GET/HEAD responses are ever cached.
   */
  ttlForPath: (path: string) => number | null;
  /** Max cached entries before LRU eviction (default 200). */
  maxEntries?: number;
  /**
   * A rough budget on the summed response-text length of cached entries,
   * measured as `body.length` before parsing (default unbounded). A response
   * bigger than the whole budget is served, and still coalesced, but not
   * cached.
   */
  maxBytes?: number;
  /** Injectable clock (ms) shared with the cache; tests override it. */
  now?: () => number;
}

/** The rolling window of {@link UpstreamAttemptCounts.last15Minutes}. */
export const ATTEMPT_WINDOW_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

/** How many request attempts a {@link FetchClient} has started recently. */
export interface UpstreamAttemptCounts {
  /** Attempts started in the last 15 minutes. */
  last15Minutes: number;
  /** Attempts started since 00:00 UTC. */
  utcDay: number;
  /** The UTC date `utcDay` counts, as `YYYY-MM-DD`. */
  utcDate: string;
}

/** Tunable backoff/retry behaviour for {@link FetchClient}. */
export interface RetryOptions {
  /** Max retry attempts beyond the initial request (default 2). */
  maxRetries?: number;
  /**
   * Per-attempt timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). A hung
   * connection would otherwise pin an MCP tool call open indefinitely. The
   * budget is per attempt, not per call, so each retry gets a fresh window.
   */
  timeoutMs?: number;
  /** Base delay for exponential backoff, in ms (default 500). */
  baseDelayMs?: number;
  /** Cap on any single backoff delay, in ms (default 8000). */
  maxDelayMs?: number;
  /**
   * Longest `Retry-After` we will wait out before giving up on a 429 and
   * surfacing a structured error instead, in ms (default 15000).
   */
  maxRetryAfterMs?: number;
  /** Sleep implementation; injectable so tests can run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Minimum spacing, in ms, enforced between the *start* of consecutive
   * request attempts: the initial attempt and every retry each count as one
   * start. Applies across concurrent callers, not just sequential ones. Omit
   * or 0 to disable (the default for ad-hoc clients and most tests).
   */
  minIntervalMs?: number;
  /**
   * The pacing clock (ms) for the `minIntervalMs` throttle. Defaults to
   * `performance.now()` (monotonic, captured at construction): a wall-clock
   * step back (VM resume, NTP) must not stall the next request. An injected
   * clock also drives the response cache when `cache.now` is not given. The
   * default does not: cache TTLs stay on the wall clock, so entries expire
   * across a host suspend.
   */
  now?: () => number;
  /**
   * The wall clock (ms since the epoch) for the attempt counters' rolling 15
   * minutes and UTC day, like intervals.icu's own windows. Defaults to
   * `Date.now`. Separate from the monotonic pacing clock `now`.
   */
  wallNow?: () => number;
  /**
   * Opt-in response cache for immutable-ish GETs. Omit to disable caching
   * entirely (the default for ad-hoc clients and most tests).
   */
  cache?: ResponseCacheOptions;
}

/**
 * Parses a JSON string while preserving integers that exceed
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1).
 *
 * A 64-bit id above 2^53 (the retired Strava client's ids were an example)
 * would otherwise be silently rounded by the default number-based
 * `JSON.parse`, corrupting the id before any validation runs (and tripping
 * Zod's safe-integer bound). The reviver's third argument exposes the raw
 * source text for each value (supported by Bun's JavaScriptCore and Node >=
 * 21), so we can detect an unsafe integer and keep its exact digits as a
 * string instead. intervals.icu's own ids are small, but `mcpEndpoint.ts`
 * still runs every request body through this seam, so a future oversized id
 * from any source stays lossless. Downstream id schemas accept string ids,
 * so they round-trip losslessly.
 *
 * On runtimes that don't expose the source text the reviver is a no-op and
 * parsing falls back to the (lossy) default — same behaviour as before.
 */
export function parseJsonWithLargeInts(text: string): unknown {
  const reviver = (
    _key: string,
    value: unknown,
    context?: { source?: string },
  ): unknown => {
    if (
      typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      typeof context?.source === "string" &&
      /^-?\d+$/.test(context.source)
    ) {
      return context.source;
    }
    return value;
  };

  // The 3-arg reviver is cast to the standard 2-arg signature so this compiles
  // regardless of the TS lib version; engines still pass `context` at runtime.
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

/**
 * Copies a value on its way out of the response cache so no two callers (and
 * never the cache itself) share a reference. Without this, a consumer sorting
 * or renaming fields in place on a cache hit would rewrite the entry for every
 * later reader within the TTL — and the miss path has the same hazard, since
 * the object stored is the one handed to the first caller.
 *
 * `structuredClone` is lossless here: cached payloads are parsed JSON (plain
 * objects, arrays, strings, numbers, booleans, null), and
 * {@link parseJsonWithLargeInts} keeps oversized ids as digit strings rather
 * than BigInt — either would survive the clone, but strings are what we have.
 * A `responseType: "text"` body is a primitive and clones trivially, and a
 * `"bytes"` body is a `Uint8Array`, which `structuredClone` copies too.
 *
 * Cloning was chosen over deep-freezing on purpose. Freezing would turn a
 * future in-place sort into a strict-mode TypeError at the call site — louder
 * than a corrupted cache, but it changes the contract every caller has today
 * (plain, mutable data). One clone per read is the price; the hot path is a
 * cache hit that already skipped a network round-trip.
 */
function cloneCached<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Settles like `work`, or rejects with a {@link CallCancelledError} as soon as
 * `signal` aborts, whichever comes first. `work` keeps running; only this
 * caller stops waiting for it. The abort listener goes once either side
 * settles. Without that, a call that waits many times piles listeners onto
 * its signal, and Node warns past 10.
 */
function abandonOnAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  what: string,
): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(
      new CallCancelledError(what, { cause: signal.reason }),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new CallCancelledError(what, { cause: signal.reason }));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * What stops an attempt loop. `signal` stops new attempts, retries, backoffs
 * and pacing waits. `interruptAttempt` also aborts an attempt already on the
 * wire. It is true only for a caller's own straight-to-wire read.
 */
interface AttemptCancel {
  signal: AbortSignal;
  interruptAttempt: boolean;
}

/**
 * A cacheable GET on the wire, shared by every caller that asked for it. An
 * entry whose controller has aborted is abandoned: every waiter left. Nobody
 * joins an abandoned entry.
 */
interface InFlightRead {
  promise: Promise<unknown>;
  /** Stops the shared read's waits and retries once every waiter has left. */
  controller: AbortController;
  /** Callers still waiting for `promise`. */
  waiters: number;
  settled: boolean;
}

export class FetchClient {
  private baseURL: string;
  private rateLimit: RateLimitSnapshot | null = null;

  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly wallNow: () => number;

  /**
   * Start times (wall clock) of recent attempts, oldest first from
   * {@link attemptHead}. Entries before the head have left the 15-minute
   * window and wait for compaction.
   */
  private attemptStarts: number[] = [];
  private attemptHead = 0;
  /** The UTC day number {@link dayAttempts} counts. */
  private attemptDay = -1;
  private dayAttempts = 0;

  private readonly minIntervalMs: number;
  /** The earliest time (per {@link now}) the next request attempt may start. */
  private nextSlot = 0;
  /**
   * Serializes {@link withSlot} reservations across concurrent callers: each
   * caller's turn chains onto the previous one via this promise, so `now()`
   * and `nextSlot` are always read and updated by one caller at a time even
   * when several requests are issued together (e.g. `Promise.all`).
   */
  private slotGate: Promise<void> = Promise.resolve();

  /** Response cache + its policy, or `null` when caching is disabled. */
  private readonly responseCache: TtlLruCache<unknown> | null;
  private readonly ttlForPath: ((path: string) => number | null) | null;
  /**
   * Cacheable GETs currently on the wire, keyed like the cache (full URL).
   * A second identical cacheable GET arriving before the first settles joins
   * this promise instead of paying the upstream API again; every MCP App fires its
   * `view-` and `get-…-data` calls together on open, and both miss the cache
   * when they race. Entries are removed on settle; only requests the cache
   * would serve (cacheable path, GET/HEAD, not `skipCache`) ever go here.
   */
  private readonly inFlight = new Map<string, InFlightRead>();

  constructor(baseURL: string, options: RetryOptions = {}) {
    this.baseURL = baseURL;
    this.maxRetries = options.maxRetries ?? 2;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 8000;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 15000;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    // Bound and captured here. An arrow that reads `performance.now()` at call
    // time hangs paced requests under vitest's default fake timers, which
    // fake `performance` from 0. An unbound reference throws under Node,
    // which runs the tests.
    this.now = options.now ?? performance.now.bind(performance);
    this.wallNow = options.wallNow ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? 0;

    if (options.cache) {
      this.responseCache = new TtlLruCache<unknown>({
        maxEntries: options.cache.maxEntries,
        maxBytes: options.cache.maxBytes,
        now: options.cache.now ?? options.now,
      });
      this.ttlForPath = options.cache.ttlForPath;
    } else {
      this.responseCache = null;
      this.ttlForPath = null;
    }
  }

  /**
   * Reduces a request URL to the path used for cache policy + invalidation
   * matching: strips the base URL and any query string. Keeping the cache *key*
   * as the full URL (query included) keeps differently-parameterised reads
   * (e.g. stream resolutions) distinct, while the path drives TTL and write
   * invalidation.
   */
  private toPath(url: string): string {
    const noBase = url.startsWith(this.baseURL)
      ? url.slice(this.baseURL.length)
      : url;
    const queryIndex = noBase.indexOf("?");
    return queryIndex === -1 ? noBase : noBase.slice(0, queryIndex);
  }

  /**
   * Clears the entire response cache and forgets every in-flight read (no-op
   * when caching is disabled). A test seam with no production caller. A
   * forgotten read still answers its waiters, but stores nothing.
   */
  clearResponseCache(): void {
    this.responseCache?.clear();
    this.inFlight.clear();
  }

  /**
   * Invalidates every cached read on the same branch as `path` (descendants
   * and ancestors, same rule as {@link invalidateWritten}), for a branch a
   * write's own request URL doesn't itself touch, e.g. `updateActivity`
   * dropping the athlete's activities list and gear list alongside the
   * written activity's own cache entry, which the write already invalidates
   * automatically.
   */
  invalidatePath(path: string): void {
    this.invalidateWritten(path);
  }

  /**
   * The rate-limit snapshot from the most recent response that carried
   * rate-limit data, or `null` until one does. intervals.icu sends none.
   */
  getRateLimitSnapshot(): RateLimitSnapshot | null {
    return this.rateLimit;
  }

  /**
   * How many request attempts this client started in the last 15 minutes and
   * since 00:00 UTC. Retries count; cache hits, joined in-flight reads and
   * attempts cancelled while queued do not. Both windows reset on restart.
   */
  getAttemptCounts(): UpstreamAttemptCounts {
    const now = this.wallNow();
    this.pruneAttempts(now);
    const day = Math.floor(now / DAY_MS);
    return {
      last15Minutes: this.attemptStarts.length - this.attemptHead,
      utcDay: day === this.attemptDay ? this.dayAttempts : 0,
      utcDate: new Date(day * DAY_MS).toISOString().slice(0, 10),
    };
  }

  /**
   * Moves the head past attempts that left the 15-minute window (one exactly
   * 15 minutes old has left), and compacts once half the array is dead. A
   * wall-clock step back can only over-count until the clock catches up.
   */
  private pruneAttempts(now: number): void {
    const starts = this.attemptStarts;
    while (
      this.attemptHead < starts.length &&
      (starts[this.attemptHead] as number) <= now - ATTEMPT_WINDOW_MS
    ) {
      this.attemptHead += 1;
    }
    if (this.attemptHead > 0 && this.attemptHead * 2 >= starts.length) {
      this.attemptStarts = starts.slice(this.attemptHead);
      this.attemptHead = 0;
    }
  }

  /** Records one request attempt that is about to go on the wire. */
  private countAttempt(): void {
    const now = this.wallNow();
    this.pruneAttempts(now);
    this.attemptStarts.push(now);
    const day = Math.floor(now / DAY_MS);
    if (day !== this.attemptDay) {
      this.attemptDay = day;
      this.dayAttempts = 0;
    }
    this.dayAttempts += 1;
  }

  /** Exponential backoff with full jitter for retry attempt `n` (0-indexed). */
  private backoffDelay(attempt: number): number {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
    return Math.round(Math.random() * exp);
  }

  /**
   * Runs `fire` (one request attempt) no earlier than `minIntervalMs` after
   * the previous attempt started, across every caller of this client,
   * concurrent callers included. Disabled entirely (fires immediately) when
   * `minIntervalMs` is 0.
   *
   * Reservation (reading `now()`, computing the slot, advancing `nextSlot`,
   * and sleeping out any gap) is serialized through {@link slotGate} so two
   * callers racing in from `Promise.all` still land on distinct, ordered
   * slots instead of both reading the same `now()`. The gate is released the
   * instant `fire` is *invoked*, not once it settles, so one slow request
   * never delays the next one's start. The release lives in `finally` so a
   * throwing `now()`, a rejecting `sleep`, or `fire` throwing synchronously
   * (rather than returning a rejected promise) still releases the gate.
   * Otherwise that failure would wedge `slotGate` forever and hang every
   * later request with no timeout.
   *
   * A cancelled `signal` takes the caller out of the queue. A caller that
   * leaves the gate queue passes its turn on when it would have come. A
   * caller that leaves during its gap wait gives its slot back, because
   * `nextSlot` moves only when the attempt really starts. The write after the
   * wait is safe: the caller still holds the gate.
   */
  private async withSlot<T>(
    fire: () => Promise<T>,
    signal: AbortSignal | undefined,
    url: string,
  ): Promise<T> {
    const what = `Request to ${url}`;
    throwIfCancelled(signal, what);
    if (this.minIntervalMs <= 0) return fire();

    const myTurn = this.slotGate;
    let release!: () => void;
    this.slotGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await abandonOnAbort(myTurn, signal, what);
    } catch (error) {
      void myTurn.then(release);
      throw error;
    }

    try {
      const now = this.now();
      const slot = Math.max(now, this.nextSlot);
      if (slot > now) {
        await abandonOnAbort(this.sleep(slot - now), signal, what);
      }
      throwIfCancelled(signal, what);
      this.nextSlot = slot + this.minIntervalMs;
      return fire();
    } finally {
      release();
    }
  }

  private async request<T>(
    url: string,
    config: FetchConfig = {},
  ): Promise<{ data: T }> {
    const fullUrl = url.startsWith("http") ? url : `${this.baseURL}${url}`;
    const requestConfig = { ...config, url: fullUrl };

    // Build URL with query params
    if (requestConfig.params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(requestConfig.params)) {
        searchParams.append(key, String(value));
      }
      const separator = requestConfig.url.includes("?") ? "&" : "?";
      requestConfig.url = `${requestConfig.url}${separator}${searchParams.toString()}`;
    }

    // Build fetch options
    const fetchOptions: RequestInit = {
      method: requestConfig.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...requestConfig.headers,
      },
    };

    if (requestConfig.data) {
      fetchOptions.body = JSON.stringify(requestConfig.data);
    }

    // Only idempotent reads are retried. Writes (POST/PUT/DELETE) are never
    // blindly retried, since a transient failure may still have mutated state.
    const method = (fetchOptions.method ?? "GET").toUpperCase();
    const isRetriable = method === "GET" || method === "HEAD";
    const signal = currentCallSignal();
    const what = `Request to ${requestConfig.url}`;

    // Response cache: serve immutable-ish GETs from memory, and invalidate a
    // resource's cached reads after it is written. The key is the full URL
    // (query included, so different stream resolutions stay distinct); TTL and
    // write invalidation match on the query-stripped path.
    const cacheKey = requestConfig.url;
    const cache = this.responseCache;
    let cacheTtl: number | null = null;
    if (cache && this.ttlForPath && isRetriable && !requestConfig.skipCache) {
      cacheTtl = this.ttlForPath(this.toPath(requestConfig.url));
    }

    if (cache === null || cacheTtl === null) {
      // Uncacheable read, `skipCache` read, or a write: straight to the wire.
      // A `skipCache` read deliberately ignores the in-flight map too — the
      // update-activity append read must never compose onto a shared read that
      // may already be stale by the time it lands.
      // The call signal stops a read's attempt on the wire. A started write
      // never carries it: the request may already have changed state upstream.
      const { data } = await this.fetchWithRetry<T>(
        requestConfig.url,
        fetchOptions,
        requestConfig.responseType,
        isRetriable,
        signal === undefined
          ? undefined
          : { signal, interruptAttempt: isRetriable },
      );
      if (cache && !isRetriable) this.invalidateWritten(requestConfig.url);
      return { data };
    }

    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return { data: cloneCached(cached) as T };
    }

    // A cancelled call neither joins nor starts a read. A cache hit above is
    // still served.
    throwIfCancelled(signal, what);

    // Coalesce: an identical cacheable GET already on the wire serves this
    // caller too. A rejection propagates to every awaiter; nothing is cached.
    // The shared read runs on its own controller, never a caller's signal, so
    // one caller leaving cannot stop the read for the others. An abandoned
    // entry (every waiter left) is never joined.
    let entry = this.inFlight.get(cacheKey);
    if (entry === undefined || entry.controller.signal.aborted) {
      const ttl = cacheTtl;
      const controller = new AbortController();
      const created: InFlightRead = {
        controller,
        waiters: 0,
        settled: false,
        promise: Promise.resolve(),
      };
      created.promise = this.fetchWithRetry<unknown>(
        requestConfig.url,
        fetchOptions,
        requestConfig.responseType,
        isRetriable,
        { signal: controller.signal, interruptAttempt: false },
      )
        .then(({ data, bytes }) => {
          // Identity check: a write that invalidated this path while we were in
          // flight has already dropped our entry, and our result predates that
          // write — storing it would resurrect the stale read the invalidation
          // just removed. An abandoned entry that a newer read replaced fails
          // the check too, so it never overwrites the newer result.
          if (this.inFlight.get(cacheKey) === created) {
            cache.set(cacheKey, data, ttl, bytes);
          }
          return data;
        })
        .finally(() => {
          created.settled = true;
          // Same identity check: never delete a newer request's entry.
          if (this.inFlight.get(cacheKey) === created) {
            this.inFlight.delete(cacheKey);
          }
        });
      // Every waiter may leave, so nobody is sure to observe a rejection.
      void created.promise.catch(() => undefined);
      this.inFlight.set(cacheKey, created);
      entry = created;
    }
    // No await between the set above and the waiter count in awaitShared.
    return {
      data: cloneCached(await this.awaitShared(entry, signal, what)) as T,
    };
  }

  /**
   * Waits for a shared read as one of its waiters. A cancelled waiter detaches
   * with a CallCancelledError and the read carries on for the others.
   */
  private async awaitShared(
    entry: InFlightRead,
    signal: AbortSignal | undefined,
    what: string,
  ): Promise<unknown> {
    entry.waiters += 1;
    try {
      return await abandonOnAbort(entry.promise, signal, what);
    } finally {
      entry.waiters -= 1;
      // Last waiter gone: abandon the read. Its queue, backoff and Retry-After
      // waits and its retries stop. An attempt already on the wire is not
      // interrupted: intervals.icu already has the request, so stopping it
      // saves nothing, and it may still fill the cache. A waiter that
      // completes normally never aborts: the chain's finally has set
      // `settled` before `entry.promise` resolves.
      if (entry.waiters === 0 && !entry.settled) entry.controller.abort();
    }
  }

  /**
   * A successful write invalidates every cached read on the same branch of the
   * resource tree — descendants and ancestors alike — and any identical read
   * still in flight, so its (pre-write) result cannot be stored once it lands.
   *
   * Descendants: updating an activity drops its cached detail, streams, zones
   * and laps so the next read re-fetches fresh.
   *
   * Ancestors: a write to a sub-resource changes how its parent reads, so a
   * descendants-only rule would leave the cached parent claiming a stale
   * value.
   *
   * A dropped in-flight entry keeps serving the waiters it already has.
   */
  private invalidateWritten(url: string): void {
    const writePath = this.toPath(url);
    const onBranch = (key: string): boolean => {
      const keyPath = this.toPath(key);
      return (
        keyPath === writePath ||
        keyPath.startsWith(`${writePath}/`) ||
        writePath.startsWith(`${keyPath}/`)
      );
    };
    this.responseCache?.deleteMatching(onBranch);
    for (const key of this.inFlight.keys()) {
      if (onBranch(key)) this.inFlight.delete(key);
    }
  }

  /**
   * One request with retries, returning the parsed body and the length of
   * its text (`bytes`, the response cache's size measure). Transient (5xx /
   * network / timeout) faults back off exponentially; a 429 honours
   * Retry-After. All backoff lives here so every tool benefits.
   *
   * With `cancel`, a cancelled call starts no new attempt, retry or wait. A
   * write rejected with CallCancelledError never reached `fetch`: writes
   * never take `interruptAttempt` or a retry wait, so the only cancel points
   * are before the attempt starts. `update-activity` relies on this.
   */
  private async fetchWithRetry<T>(
    url: string,
    fetchOptions: RequestInit,
    responseType: FetchConfig["responseType"],
    isRetriable: boolean,
    cancel: AttemptCancel | undefined,
  ): Promise<{ data: T; bytes: number }> {
    const signal = cancel?.signal;
    const what = `Request to ${url}`;
    let attempt = 0;
    while (true) {
      throwIfCancelled(signal, what);
      let response: Response;
      let body: string;
      let raw: Uint8Array | undefined;
      try {
        // A fresh signal per attempt: AbortSignal.timeout starts counting the
        // moment it is created, so a shared one would leave later retries with
        // whatever was left of the first attempt's budget. Each attempt (the
        // initial one and every retry) is a "request start" for the
        // minIntervalMs throttle, so it goes through withSlot too.
        response = await this.withSlot(
          () => {
            this.countAttempt();
            // Created when the attempt really starts. AbortSignal.timeout
            // counts from creation, so one made before withSlot would spend
            // the attempt's budget in the pacing queue, and a queued write
            // would be reported as timed out without ever being sent.
            const timeout = AbortSignal.timeout(this.timeoutMs);
            return fetch(url, {
              ...fetchOptions,
              signal:
                signal !== undefined && cancel?.interruptAttempt
                  ? AbortSignal.any([signal, timeout])
                  : timeout,
            });
          },
          signal,
          url,
        );
        // The body read is part of the attempt. The timeout signal also
        // covers it, and a body that stalls or is cut off is the same fault
        // as a connection that does: a safe read retries it, and a timeout
        // becomes a RequestTimeoutError, not a bare DOMException (#52).
        if (responseType === "bytes" && response.ok) {
          raw = new Uint8Array(await response.arrayBuffer());
          body = "";
        } else {
          body = await response.text();
        }
      } catch (networkError) {
        // A cancel is classified first. Under AbortSignal.any, fetch rejects
        // with the signal's reason or a bare AbortError, which the code below
        // would retry or report as a timeout.
        if (networkError instanceof CallCancelledError) throw networkError;
        if (cancel?.interruptAttempt && signal?.aborted) {
          throw new CallCancelledError(what, { cause: signal.reason });
        }
        // fetch and the body read reject on network faults (ECONNRESET, DNS,
        // etc.) and on our own timeout. Both are transient, so safe reads
        // back off and retry.
        if (isRetriable && attempt < this.maxRetries) {
          await abandonOnAbort(
            this.sleep(this.backoffDelay(attempt)),
            signal,
            what,
          );
          attempt += 1;
          continue;
        }
        // A write that times out is NOT retried: the request may still have
        // mutated state upstream. Surface it as a timeout so the caller
        // can say so rather than reporting an opaque failure.
        throw isAbortError(networkError)
          ? new RequestTimeoutError(url, this.timeoutMs)
          : networkError;
      }

      // Capture rate-limit headers from every response, success or error. A
      // response with none must not overwrite an earlier snapshot.
      const snapshot = parseRateLimitHeaders(response.headers);
      if (carriesRateLimitData(snapshot)) this.rateLimit = snapshot;

      if (!response.ok) {
        const status = response.status;

        if (status === 429) {
          const retryAfterMs =
            snapshot.retryAfterSeconds !== undefined
              ? snapshot.retryAfterSeconds * 1000
              : this.backoffDelay(attempt);

          if (
            isRetriable &&
            attempt < this.maxRetries &&
            retryAfterMs <= this.maxRetryAfterMs
          ) {
            await abandonOnAbort(this.sleep(retryAfterMs), signal, what);
            attempt += 1;
            continue;
          }

          throw new RateLimitError(
            describeRateLimit(snapshot),
            {
              status,
              statusText: response.statusText,
              data: body,
            },
            snapshot,
            snapshot.retryAfterSeconds ?? null,
          );
        }

        if (
          TRANSIENT_STATUSES.has(status) &&
          isRetriable &&
          attempt < this.maxRetries
        ) {
          await abandonOnAbort(
            this.sleep(this.backoffDelay(attempt)),
            signal,
            what,
          );
          attempt += 1;
          continue;
        }

        const contentType = response.headers.get("content-type") ?? undefined;
        const summary =
          summarizeErrorBody(body, contentType) || response.statusText;
        throw new HttpError(`HTTP ${status}: ${summary}`, {
          status,
          statusText: response.statusText,
          data: body,
          contentType,
          cloudflareChallenge:
            response.headers.get("cf-mitigated") === "challenge",
        });
      }

      // Parse response
      if (raw !== undefined) {
        return { data: raw as T, bytes: raw.byteLength };
      }
      if (responseType === "text") {
        return { data: body as T, bytes: body.length };
      }
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        // Parse via text so oversized ids survive without precision loss.
        return {
          data: parseJsonWithLargeInts(body) as T,
          bytes: body.length,
        };
      }
      return { data: body as T, bytes: body.length };
    }
  }

  async get<T>(url: string, config?: FetchConfig): Promise<{ data: T }> {
    return this.request<T>(url, { ...config, method: "GET" });
  }

  async post<T>(
    url: string,
    data?: unknown,
    config?: FetchConfig,
  ): Promise<{ data: T }> {
    return this.request<T>(url, { ...config, data, method: "POST" });
  }

  async put<T>(
    url: string,
    data?: unknown,
    config?: FetchConfig,
  ): Promise<{ data: T }> {
    return this.request<T>(url, { ...config, data, method: "PUT" });
  }

  async delete<T>(url: string, config?: FetchConfig): Promise<{ data: T }> {
    return this.request<T>(url, { ...config, method: "DELETE" });
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Cache TTL policy for intervals.icu GET endpoints, keyed by request path.
 * Returns a TTL in ms for cacheable resources, or `null` to never cache.
 *
 * Activity detail, its interval breakdown, and its data streams are
 * immutable-ish once intervals.icu has processed the activity; gear and
 * sport-settings change rarely. The activity listing gets a short TTL so a
 * newly recorded activity still shows up quickly, and wellness records (which
 * intervals.icu updates through the day) get a moderate one. Everything else
 * is left uncached.
 */
export function intervalsCacheTtl(path: string): number | null {
  // Activity data streams: one superset URL per activity (see
  // loadIntervalsStreams). Matched by prefix, since the id is followed by
  // arbitrary stream-selector content (a comma-separated list, a `.json`
  // extension). The path here is already query-stripped (toPath), so this
  // is about the selector living in the path segment itself, not a query.
  if (/^\/activity\/[^/]+\/streams/.test(path)) return 10 * MINUTE_MS;
  // An activity's interval breakdown.
  if (/^\/activity\/[^/]+\/intervals$/.test(path)) return 10 * MINUTE_MS;
  // Detailed activity.
  if (/^\/activity\/[^/]+$/.test(path)) return 10 * MINUTE_MS;
  // The original activity file (a FIT file's bytes, read for its weather).
  // It never changes after upload; the TTL only bounds the memory it holds.
  if (/^\/activity\/[^/]+\/file$/.test(path)) return 10 * MINUTE_MS;
  // Gear rarely changes.
  if (/^\/athlete\/[^/]+\/gear$/.test(path)) return 10 * MINUTE_MS;
  // Per-sport zones/settings change rarely.
  if (/^\/athlete\/[^/]+\/sport-settings\/[^/]+$/.test(path)) return HOUR_MS;
  // Every sport settings group at once (get-athlete-zones). Shorter than the
  // per-sport rule: an athlete who changes LTHR after the tool's hint can
  // check again with the same tool soon after.
  if (/^\/athlete\/[^/]+\/sport-settings$/.test(path)) return 10 * MINUTE_MS;
  // Heart rate curves: recomputed from history, like the pace curves below.
  if (/^\/athlete\/[^/]+\/hr-curves\.json$/.test(path)) return 10 * MINUTE_MS;
  // Activity listing: short, so a newly recorded activity shows up quickly.
  if (/^\/athlete\/[^/]+\/activities$/.test(path)) return MINUTE_MS;
  // Activity search: same freshness as the listing it stands in for.
  if (/^\/athlete\/[^/]+\/activities\/search-full$/.test(path))
    return MINUTE_MS;
  // Interval search: same freshness as the listing it searches.
  if (/^\/athlete\/[^/]+\/activities\/interval-search$/.test(path))
    return MINUTE_MS;
  // Activities by id (one or more `i`-prefixed ids, comma-separated): the
  // same rows as a detailed activity.
  if (/^\/athlete\/[^/]+\/activities\/i\d+(,i\d+)*$/.test(path))
    return 10 * MINUTE_MS;
  // Wellness records: matched by prefix like streams above, so a date
  // sub-path (`/wellness/2026-09-24`) or an extension (`wellness.json`)
  // both count; these update through the day.
  if (/^\/athlete\/[^/]+\/wellness/.test(path)) return 5 * MINUTE_MS;
  // Athlete pace curves: recomputed from an athlete's history, which
  // changes at most a few times a day.
  if (/^\/athlete\/[^/]+\/pace-curves\.json$/.test(path)) return 10 * MINUTE_MS;
  return null;
}

/**
 * The response cache's budget on summed response-text length (32 MiB). A
 * 4-hour activity's full stream set is about 1.25-1.4 MB of text, and the
 * parsed objects take roughly 1-2x that.
 */
const RESPONSE_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Create an instance for the intervals.icu API. intervals.icu sends no
 * rate-limit headers (verified 2026-09-24); its draft limits are 5,000
 * requests/day and 2,500 per 15 minutes per API key, and about 10/s per IP.
 * With no headers to react to, the client spaces requests 200ms apart instead
 * of reacting after the fact. Sustained, that spacing allows 4,500 requests
 * per 15 minutes, more than the 2,500 draft limit, so /health's
 * `upstream_requests` shows how much of it this process uses.
 */
export const intervalsApi = new FetchClient("https://intervals.icu/api/v1", {
  minIntervalMs: 200,
  cache: { ttlForPath: intervalsCacheTtl, maxBytes: RESPONSE_CACHE_MAX_BYTES },
});
