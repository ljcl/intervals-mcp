import { TtlLruCache } from "./cache";

export class HttpError extends Error {
  response: {
    status: number;
    statusText: string;
    data: string;
  };

  constructor(
    message: string,
    response: { status: number; statusText: string; data: string },
  ) {
    super(message);
    this.name = "HttpError";
    this.response = response;
  }
}

/**
 * A single Strava rate-limit window: how many requests are allowed and how many
 * have been used. Strava reports two windows (15-minute and daily) for both the
 * overall and the read-only quotas.
 */
export interface RateLimitWindow {
  limit: number;
  usage: number;
}

/**
 * Snapshot of the rate-limit headers from the most recent Strava response.
 *
 * Strava returns comma-separated `X-RateLimit-Limit` / `X-RateLimit-Usage`
 * (overall) and `X-ReadRateLimit-Limit` / `X-ReadRateLimit-Usage` (read-only)
 * headers, each formatted `"<15-min>,<daily>"`. A `Retry-After` header may also
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
 * Thrown when Strava returns 429 and we have either exhausted our retries or the
 * window will not reset soon enough to be worth waiting on. Carries the parsed
 * rate-limit snapshot so callers can surface a structured, actionable message
 * (which window is exhausted, when it resets).
 */
export class RateLimitError extends HttpError {
  rateLimit: RateLimitSnapshot;
  retryAfterSeconds: number | null;
  /**
   * The window description on its own — which window is exhausted and when it
   * resets — with no caller context in front of it. `handleApiError` rethrows
   * this error with `in <context>` prefixed onto `message`, so a tool composing
   * its own sentence ("the scan stopped after 5 of 20 activities…") reads the
   * useful half from here rather than quoting an internal function name at the
   * athlete.
   */
  detail: string;

  constructor(
    message: string,
    response: { status: number; statusText: string; data: string },
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
 * Thrown by the retired Strava client for every call it makes: that
 * client sends no `Authorization` header on purpose (see its own module
 * comment), so every request answers 401. That 401 means "this tool has not
 * been ported to intervals.icu yet", a completely different situation from
 * intervals.icu itself rejecting an API key, and needs its own type so
 * `toolErrorText` (`tools/_errors.ts`) can tell the two apart by type rather
 * than by re-parsing the message. Lives here, not in the Strava client
 * module, so `tools/_errors.ts` never has to import from it: tool tests mock
 * that module with bare factories, which would leave a class imported
 * from there `undefined`.
 */
export class NotPortedError extends HttpError {
  constructor(
    message: string,
    response: { status: number; statusText: string; data: string },
  ) {
    super(message, response);
    this.name = "NotPortedError";
  }
}

/**
 * Thrown when a request exceeds its timeout and could not be recovered by a
 * retry. Distinct from a generic network fault so callers can say "Strava did
 * not answer in time" rather than surfacing an opaque `TimeoutError`.
 */
export class RequestTimeoutError extends Error {
  timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms.`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** HTTP statuses we treat as transient and retry on safe (GET) requests. */
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

/** Default per-request timeout. Strava's slowest reads land well inside this. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Recognises an aborted request. `AbortSignal.timeout()` rejects `fetch` with a
 * `DOMException` named `TimeoutError`; a manual abort uses `AbortError`. Neither
 * is an `Error` subclass we can `instanceof`, so match on the name.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

/** Parses Strava's comma-separated `"<15-min>,<daily>"` header pair. */
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

/** Next quarter-hour boundary (UTC) — when Strava's 15-minute window resets. */
function next15MinReset(now: Date): Date {
  const reset = new Date(now);
  const nextQuarter = (Math.floor(now.getUTCMinutes() / 15) + 1) * 15;
  // setUTCMinutes overflows past 59 into the next hour, which is what we want.
  reset.setUTCMinutes(nextQuarter, 0, 0);
  return reset;
}

/** Next UTC midnight — when Strava's daily window resets. */
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
    // separately), Strava's 15-minute window is the most likely culprit, and
    // headers being present at all means this is a Strava response.
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
    // there is no window boundary to report. Guessing at Strava's
    // quarter-hour reset here would be actively wrong for that provider.
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
  responseType?: "json" | "text";
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
  /** Injectable clock (ms) shared with the cache; tests override it. */
  now?: () => number;
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
   * Injectable clock (ms), shared by the `minIntervalMs` throttle and, when
   * `cache.now` is not given, the response cache. Defaults to `Date.now`.
   */
  now?: () => number;
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
 * Strava issues 64-bit identifiers; some ids (segment efforts, routes) run
 * well past 2^53, which the default number-based `JSON.parse` silently rounds,
 * corrupting the id before any validation runs (and tripping Zod's safe-integer
 * bound). The reviver's third argument exposes the raw source text for each
 * value (supported by Bun's JavaScriptCore and Node >= 21), so we can detect an
 * unsafe integer and keep its exact digits as a string instead. Downstream id
 * schemas accept string ids, so they round-trip losslessly.
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
 * A `responseType: "text"` body is a primitive and clones trivially.
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
   * this promise instead of paying Strava again — every MCP App fires its
   * `view-` and `get-…-data` calls together on open, and both miss the cache
   * when they race. Entries are removed on settle; only requests the cache
   * would serve (cacheable path, GET/HEAD, not `skipCache`) ever go here.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

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
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? 0;

    if (options.cache) {
      this.responseCache = new TtlLruCache<unknown>({
        maxEntries: options.cache.maxEntries,
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

  /** Clears the entire response cache (no-op when caching is disabled). */
  clearResponseCache(): void {
    this.responseCache?.clear();
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
   * The rate-limit snapshot from the most recent response, or `null` if no
   * request carrying rate-limit headers has completed yet.
   */
  getRateLimitSnapshot(): RateLimitSnapshot | null {
    return this.rateLimit;
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
   */
  private async withSlot<T>(fire: () => Promise<T>): Promise<T> {
    if (this.minIntervalMs <= 0) return fire();

    const myTurn = this.slotGate;
    let release!: () => void;
    this.slotGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await myTurn;

    try {
      const now = this.now();
      const slot = Math.max(now, this.nextSlot);
      this.nextSlot = slot + this.minIntervalMs;
      if (slot > now) {
        await this.sleep(slot - now);
      }
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
      const data = await this.fetchWithRetry<T>(
        requestConfig.url,
        fetchOptions,
        requestConfig.responseType,
        isRetriable,
      );
      if (cache && !isRetriable) this.invalidateWritten(requestConfig.url);
      return { data };
    }

    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return { data: cloneCached(cached) as T };
    }

    // Coalesce: an identical cacheable GET already on the wire serves this
    // caller too. A rejection propagates to every awaiter; nothing is cached.
    const shared = this.inFlight.get(cacheKey);
    if (shared !== undefined) {
      return { data: cloneCached(await shared) as T };
    }

    const ttl = cacheTtl;
    const promise: Promise<unknown> = this.fetchWithRetry<unknown>(
      requestConfig.url,
      fetchOptions,
      requestConfig.responseType,
      isRetriable,
    )
      .then((data) => {
        // Identity check: a write that invalidated this path while we were in
        // flight has already dropped our entry, and our result predates that
        // write — storing it would resurrect the stale read the invalidation
        // just removed.
        if (this.inFlight.get(cacheKey) === promise) {
          cache.set(cacheKey, data, ttl);
        }
        return data;
      })
      .finally(() => {
        // Same identity check: never delete a newer request's entry.
        if (this.inFlight.get(cacheKey) === promise) {
          this.inFlight.delete(cacheKey);
        }
      });
    this.inFlight.set(cacheKey, promise);
    // No bare `.catch` here: the creator awaits the shared promise itself, so a
    // rejection is always observed and cannot become an unhandled rejection.
    return { data: cloneCached(await promise) as T };
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
   * One request with retries, returning the parsed body. Transient (5xx /
   * network / timeout) faults back off exponentially; a 429 honours
   * Retry-After. All backoff lives here so every tool benefits.
   */
  private async fetchWithRetry<T>(
    url: string,
    fetchOptions: RequestInit,
    responseType: FetchConfig["responseType"],
    isRetriable: boolean,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      let response: Response;
      try {
        // A fresh signal per attempt: AbortSignal.timeout starts counting the
        // moment it is created, so a shared one would leave later retries with
        // whatever was left of the first attempt's budget. Each attempt (the
        // initial one and every retry) is a "request start" for the
        // minIntervalMs throttle, so it goes through withSlot too.
        response = await this.withSlot(() =>
          fetch(url, {
            ...fetchOptions,
            signal: AbortSignal.timeout(this.timeoutMs),
          }),
        );
      } catch (networkError) {
        // fetch rejects on network faults (ECONNRESET, DNS, etc.) and on our
        // own timeout. Both are transient, so safe reads back off and retry.
        if (isRetriable && attempt < this.maxRetries) {
          await this.sleep(this.backoffDelay(attempt));
          attempt += 1;
          continue;
        }
        // A write that times out is NOT retried: the request may still have
        // mutated state on Strava's side. Surface it as a timeout so the caller
        // can say so rather than reporting an opaque failure.
        throw isAbortError(networkError)
          ? new RequestTimeoutError(url, this.timeoutMs)
          : networkError;
      }

      // Capture rate-limit headers from every response, success or error.
      this.rateLimit = parseRateLimitHeaders(response.headers);

      if (!response.ok) {
        const errorText = await response.text();
        const status = response.status;

        if (status === 429) {
          const snapshot = this.rateLimit;
          const retryAfterMs =
            snapshot.retryAfterSeconds !== undefined
              ? snapshot.retryAfterSeconds * 1000
              : this.backoffDelay(attempt);

          if (
            isRetriable &&
            attempt < this.maxRetries &&
            retryAfterMs <= this.maxRetryAfterMs
          ) {
            await this.sleep(retryAfterMs);
            attempt += 1;
            continue;
          }

          throw new RateLimitError(
            describeRateLimit(snapshot),
            {
              status,
              statusText: response.statusText,
              data: errorText,
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
          await this.sleep(this.backoffDelay(attempt));
          attempt += 1;
          continue;
        }

        throw new HttpError(`HTTP ${status}: ${errorText}`, {
          status,
          statusText: response.statusText,
          data: errorText,
        });
      }

      // Parse response
      if (responseType === "text") {
        return (await response.text()) as T;
      }
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        // Parse via text so oversized Strava ids survive without precision loss.
        return parseJsonWithLargeInts(await response.text()) as T;
      }
      return (await response.text()) as T;
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
 * Cache TTL policy for Strava GET endpoints, keyed by request path. Returns a
 * TTL in ms for cacheable resources, or `null` to never cache (the default for
 * anything not listed — collection listings and exports, which are paginated,
 * parameterised, or produce a file).
 *
 * Immutable-once-recorded resources (a completed activity's detail, its data
 * streams, and its laps/zones) get long TTLs; identity and aggregate
 * resources that drift (profile, stats) get short ones. Everything under
 * `/activities/{id}` is additionally invalidated
 * whenever the activity is written (see {@link updateActivity}), so those TTLs
 * only bound staleness from edits made outside this server.
 *
 * The short TTLs exist mainly to stop each MCP App paying twice: every app is a
 * `view-` tool plus a `get-…-data` tool running the same loader, so an uncached
 * path costs double the Strava requests for one app open.
 */
export function stravaCacheTtl(path: string): number | null {
  // Activity data streams — immutable once the activity is recorded.
  if (/^\/activities\/\d+\/streams\//.test(path)) return 6 * HOUR_MS;
  // Detailed activity — immutable-ish; invalidated on update-activity writes.
  if (/^\/activities\/\d+$/.test(path)) return HOUR_MS;
  // Laps and zones of a recorded activity — same immutability as the
  // activity itself, and each is fetched twice per app open.
  if (/^\/activities\/\d+\/(laps|zones)$/.test(path)) return HOUR_MS;
  // Authenticated athlete profile — short; name/weight/gear can change.
  if (path === "/athlete") return 5 * MINUTE_MS;
  // Athlete stats — short; totals accumulate with each new activity.
  if (/^\/athletes\/\d+\/stats$/.test(path)) return 5 * MINUTE_MS;
  // The activity listing behind the cadence-trends, training-load, and
  // fitness-trend pairs — the three most expensive scans, each a full
  // pagination at up to a year of history. A bare TTL would hit zero times on
  // its own: each handler recomputes `after`/`before` from `Date.now()`, so a
  // pair's two calls built two URLs. server.ts therefore floors those bounds
  // to the minute (`quantizedEpochAfter`/`quantizedEpochBefore`), making a
  // pair share one key; this TTL then serves the second scan (every cached
  // page of it) from memory. Short on purpose: a new activity shows up within
  // two minutes, and no write invalidates this branch. Other listing shapes
  // (ad-hoc pages, exports) still churn keys and simply miss.
  if (path === "/athlete/activities") return 2 * MINUTE_MS;
  return null;
}

// Create an instance for Strava API
export const stravaApi = new FetchClient("https://www.strava.com/api/v3", {
  cache: { ttlForPath: stravaCacheTtl },
});

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
  // Activity data streams: matched by prefix, since the id is followed by
  // arbitrary stream-selector content (a comma-separated list, a `.json`
  // extension). The path here is already query-stripped (toPath), so this
  // is about the selector living in the path segment itself, not a query.
  if (/^\/activity\/[^/]+\/streams/.test(path)) return 10 * MINUTE_MS;
  // An activity's interval breakdown.
  if (/^\/activity\/[^/]+\/intervals$/.test(path)) return 10 * MINUTE_MS;
  // Detailed activity.
  if (/^\/activity\/[^/]+$/.test(path)) return 10 * MINUTE_MS;
  // Gear rarely changes.
  if (/^\/athlete\/[^/]+\/gear$/.test(path)) return 10 * MINUTE_MS;
  // Per-sport zones/settings change rarely.
  if (/^\/athlete\/[^/]+\/sport-settings\/[^/]+$/.test(path)) return HOUR_MS;
  // Activity listing: short, so a newly recorded activity shows up quickly.
  if (/^\/athlete\/[^/]+\/activities$/.test(path)) return MINUTE_MS;
  // Wellness records: matched by prefix like streams above, so a date
  // sub-path (`/wellness/2026-09-24`) or an extension (`wellness.json`)
  // both count; these update through the day.
  if (/^\/athlete\/[^/]+\/wellness/.test(path)) return 5 * MINUTE_MS;
  // Pace curves (athlete-level and per-activity): recomputed from an
  // athlete's history, which changes at most a few times a day.
  if (/^\/athlete\/[^/]+\/pace-curves\.json$/.test(path)) return 10 * MINUTE_MS;
  if (/^\/athlete\/[^/]+\/activity-pace-curves\.json$/.test(path))
    return 10 * MINUTE_MS;
  return null;
}

/**
 * Create an instance for the intervals.icu API. intervals.icu sends no
 * rate-limit headers (verified 2026-09-24); its draft limits are 5,000
 * requests/day and 2,500 per 15 minutes per API key, and about 10/s per IP.
 * With no headers to react to, the client spaces requests 200ms apart instead
 * of reacting after the fact.
 */
export const intervalsApi = new FetchClient("https://intervals.icu/api/v1", {
  minIntervalMs: 200,
  cache: { ttlForPath: intervalsCacheTtl },
});
