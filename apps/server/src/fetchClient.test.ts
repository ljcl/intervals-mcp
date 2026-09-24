import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeRateLimit,
  FetchClient,
  HttpError,
  parseJsonWithLargeInts,
  parseRateLimitHeaders,
  RateLimitError,
  RequestTimeoutError,
  stravaCacheTtl,
} from "./fetchClient";

describe("HttpError", () => {
  it("creates error with correct message", () => {
    const error = new HttpError("HTTP 404: Not Found", {
      status: 404,
      statusText: "Not Found",
      data: "Resource not found",
    });

    expect(error.message).toBe("HTTP 404: Not Found");
  });

  it("has correct name property", () => {
    const error = new HttpError("Test error", {
      status: 500,
      statusText: "Internal Server Error",
      data: "Server error",
    });

    expect(error.name).toBe("HttpError");
  });

  it("stores response data correctly", () => {
    const error = new HttpError("HTTP 401: Unauthorized", {
      status: 401,
      statusText: "Unauthorized",
      data: '{"error": "Invalid token"}',
    });

    expect(error.response.status).toBe(401);
    expect(error.response.statusText).toBe("Unauthorized");
    expect(error.response.data).toBe('{"error": "Invalid token"}');
  });

  it("is an instance of Error", () => {
    const error = new HttpError("Test", {
      status: 400,
      statusText: "Bad Request",
      data: "",
    });

    expect(error).toBeInstanceOf(Error);
  });

  it("is an instance of HttpError", () => {
    const error = new HttpError("Test", {
      status: 400,
      statusText: "Bad Request",
      data: "",
    });

    expect(error).toBeInstanceOf(HttpError);
  });

  it("can be caught as Error", () => {
    const throwHttpError = () => {
      throw new HttpError("Test error", {
        status: 500,
        statusText: "Internal Server Error",
        data: "",
      });
    };

    expect(throwHttpError).toThrow(Error);
  });

  it("preserves stack trace", () => {
    const error = new HttpError("Test", {
      status: 400,
      statusText: "Bad Request",
      data: "",
    });

    expect(error.stack).toBeDefined();
  });
});

describe("parseJsonWithLargeInts", () => {
  it("preserves integers beyond MAX_SAFE_INTEGER as exact strings", () => {
    // A real-world Strava segment-effort id, well past 2^53 - 1.
    const big = "3503400000123456789";
    const out = parseJsonWithLargeInts(`{"id":${big}}`) as { id: unknown };
    expect(out.id).toBe(big);
  });

  it("leaves safe integers as numbers", () => {
    const out = parseJsonWithLargeInts('{"id":18685903457}') as { id: unknown };
    expect(out.id).toBe(18685903457);
    expect(typeof out.id).toBe("number");
  });

  it("does not touch floats or non-integer numbers", () => {
    const out = parseJsonWithLargeInts('{"distance":5000.5,"grade":-1.2}') as {
      distance: unknown;
      grade: unknown;
    };
    expect(out.distance).toBe(5000.5);
    expect(out.grade).toBe(-1.2);
  });

  it("preserves oversized ids nested in arrays", () => {
    const out = parseJsonWithLargeInts(
      '{"segment_efforts":[{"id":3503400000123456789},{"id":42}]}',
    ) as { segment_efforts: Array<{ id: unknown }> };
    expect(out.segment_efforts[0]?.id).toBe("3503400000123456789");
    expect(out.segment_efforts[1]?.id).toBe(42);
  });

  it("preserves negative oversized integers", () => {
    const out = parseJsonWithLargeInts('{"id":-9007199254740993}') as {
      id: unknown;
    };
    expect(out.id).toBe("-9007199254740993");
  });
});

describe("parseRateLimitHeaders", () => {
  it("parses overall and read windows plus retry-after", () => {
    const headers = new Headers({
      "x-ratelimit-limit": "100,1000",
      "x-ratelimit-usage": "42,512",
      "x-readratelimit-limit": "100,1000",
      "x-readratelimit-usage": "30,400",
      "retry-after": "120",
    });

    const snapshot = parseRateLimitHeaders(headers);

    expect(snapshot.shortTerm).toEqual({ limit: 100, usage: 42 });
    expect(snapshot.daily).toEqual({ limit: 1000, usage: 512 });
    expect(snapshot.readShortTerm).toEqual({ limit: 100, usage: 30 });
    expect(snapshot.readDaily).toEqual({ limit: 1000, usage: 400 });
    expect(snapshot.retryAfterSeconds).toBe(120);
    expect(typeof snapshot.observedAt).toBe("number");
  });

  it("leaves windows undefined when headers are absent", () => {
    const snapshot = parseRateLimitHeaders(new Headers());
    expect(snapshot.shortTerm).toBeUndefined();
    expect(snapshot.daily).toBeUndefined();
    expect(snapshot.retryAfterSeconds).toBeUndefined();
  });
});

describe("describeRateLimit", () => {
  it("reports the exhausted 15-minute window with a reset time", () => {
    const message = describeRateLimit({
      shortTerm: { limit: 100, usage: 100 },
      daily: { limit: 1000, usage: 500 },
      observedAt: Date.now(),
    });

    expect(message).toContain("15-minute rate limit reached");
    expect(message).toContain("100/100");
    expect(message).toContain("Resets at");
  });

  it("prefers the daily window when it is the exhausted one", () => {
    const message = describeRateLimit({
      shortTerm: { limit: 100, usage: 10 },
      daily: { limit: 1000, usage: 1000 },
      observedAt: Date.now(),
    });

    expect(message).toContain("Daily rate limit reached");
    expect(message).toContain("1000/1000");
  });
});

function makeResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

describe("FetchClient retry and rate-limit behaviour", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // No real waiting; tiny base delay keeps jitter math harmless.
  const newClient = () =>
    new FetchClient("https://example.test", {
      maxRetries: 2,
      baseDelayMs: 1,
      sleep: async () => {},
    });

  it("captures rate-limit headers after a successful request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse('{"ok":true}', {
        headers: {
          "x-ratelimit-limit": "100,1000",
          "x-ratelimit-usage": "10,200",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = newClient();
    await client.get("/thing");

    const snapshot = client.getRateLimitSnapshot();
    expect(snapshot?.shortTerm).toEqual({ limit: 100, usage: 10 });
    expect(snapshot?.daily).toEqual({ limit: 1000, usage: 200 });
  });

  it("honours Retry-After on a 429 and retries to success", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse("rate limited", {
          status: 429,
          headers: {
            "retry-after": "2",
            "x-ratelimit-limit": "100,1000",
            "x-ratelimit-usage": "100,500",
          },
        }),
      )
      .mockResolvedValueOnce(makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = new FetchClient("https://example.test", {
      maxRetries: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await client.get<{ ok: boolean }>("/thing");

    expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Waited exactly the Retry-After window (2s) before retrying.
    expect(sleeps).toEqual([2000]);
  });

  it("throws a structured RateLimitError once retries are exhausted", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      makeResponse("rate limited", {
        status: 429,
        headers: {
          "retry-after": "1",
          "x-ratelimit-limit": "100,1000",
          "x-ratelimit-usage": "100,500",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = newClient();

    await expect(client.get("/thing")).rejects.toMatchObject({
      name: "RateLimitError",
      retryAfterSeconds: 1,
    });
    // Initial attempt + 2 retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const err = await client.get("/thing").catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.message).toContain("15-minute rate limit reached");
    expect(err.rateLimit.shortTerm).toEqual({ limit: 100, usage: 100 });
  });

  it("does not wait out a Retry-After that exceeds the cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse("rate limited", {
        status: 429,
        headers: { "retry-after": "900" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new FetchClient("https://example.test", {
      maxRetries: 2,
      maxRetryAfterMs: 15000,
      sleep: async () => {},
    });

    await expect(client.get("/thing")).rejects.toBeInstanceOf(RateLimitError);
    // 900s far exceeds the 15s cap, so no retry is attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient 5xx errors on GET and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse("boom", { status: 503 }))
      .mockResolvedValueOnce(makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newClient();
    const result = await client.get<{ ok: boolean }>("/thing");

    expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries network faults on GET and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newClient();
    const result = await client.get<{ ok: boolean }>("/thing");

    expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up on a transient error after exhausting retries", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = newClient();

    await expect(client.get("/thing")).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry writes on a transient 5xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse("boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = newClient();

    await expect(client.put("/thing", { a: 1 })).rejects.toBeInstanceOf(
      HttpError,
    );
    // No retry for a PUT — a single attempt only.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry writes on a 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse("rate limited", {
        status: 429,
        headers: { "retry-after": "1" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = newClient();

    await expect(client.post("/thing", { a: 1 })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends an AbortSignal on every attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    await newClient().get("/thing");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries a timed-out GET and then succeeds", async () => {
    const timeout = new DOMException(
      "The operation timed out.",
      "TimeoutError",
    );
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await newClient().get<{ ok: boolean }>("/thing");

    expect(result.data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A fresh deadline per attempt, not one shared budget across the call.
    const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(second.signal).not.toBe(first.signal);
  });

  it("surfaces a RequestTimeoutError once a GET exhausts its retries", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new DOMException("The operation timed out.", "TimeoutError"),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new FetchClient("https://example.test", {
      maxRetries: 2,
      baseDelayMs: 1,
      timeoutMs: 1234,
      sleep: async () => {},
    });

    const error = await client.get("/thing").catch((e) => e);
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error.timeoutMs).toBe(1234);
    expect(error.message).toContain("timed out after 1234ms");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a timed-out write", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new DOMException("The operation timed out.", "TimeoutError"),
      );
    vi.stubGlobal("fetch", fetchMock);

    // A POST may have mutated state before the deadline, so it is never resent.
    await expect(newClient().post("/thing", { a: 1 })).rejects.toBeInstanceOf(
      RequestTimeoutError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a plain network fault as-is once retries are exhausted", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);

    const error = await newClient()
      .get("/thing")
      .catch((e) => e);
    expect(error).not.toBeInstanceOf(RequestTimeoutError);
    expect(error.message).toBe("ECONNRESET");
  });

  it("does not retry a non-transient 4xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = newClient();

    await expect(client.get("/thing")).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("stravaCacheTtl policy", () => {
  it("caches activity streams the longest (immutable)", () => {
    expect(stravaCacheTtl("/activities/123/streams/time,heartrate")).toBe(
      6 * 60 * 60_000,
    );
  });

  it("caches detailed activity for an hour", () => {
    expect(stravaCacheTtl("/activities/123")).toBe(60 * 60_000);
  });

  it("caches profile and stats briefly", () => {
    expect(stravaCacheTtl("/athlete")).toBe(5 * 60_000);
    expect(stravaCacheTtl("/athletes/999/stats")).toBe(5 * 60_000);
  });

  it("caches an activity's laps and zones like the activity", () => {
    // #238: each is fetched once by a `view-` tool and again by its
    // `get-…-data` twin, so an uncached path doubled the cost of one app open.
    expect(stravaCacheTtl("/activities/123/laps")).toBe(60 * 60_000);
    expect(stravaCacheTtl("/activities/123/zones")).toBe(60 * 60_000);
  });

  it("caches the activity listing briefly, so a view-/get-…-data pair costs one scan", () => {
    // #329: the three listing-driven app pairs each run a full history
    // pagination; server.ts quantizes their window bounds to the minute so
    // the pair builds one URL, and this TTL serves the second scan.
    expect(stravaCacheTtl("/athlete/activities")).toBe(2 * 60_000);
  });

  it("does not cache listings, exports, or ad-hoc queries", () => {
    expect(stravaCacheTtl("/athlete/clubs")).toBeNull();
    expect(stravaCacheTtl("/activities/123/photos")).toBeNull();
  });
});

describe("FetchClient response cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // A cacheable path + an uncacheable one, plus an injectable clock for expiry.
  const newCachingClient = (now: () => number = () => 0) =>
    new FetchClient("https://example.test", {
      maxRetries: 0,
      sleep: async () => {},
      cache: {
        ttlForPath: (path) => (path.startsWith("/activities/") ? 1000 : null),
        now,
      },
    });

  it("serves a repeat cacheable GET from cache (hit) without re-fetching", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse('{"id":1,"name":"first"}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    const a = await client.get<{ name: string }>("/activities/1");
    const b = await client.get<{ name: string }>("/activities/1");

    expect(a.data.name).toBe("first");
    expect(b.data.name).toBe("first");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache paths the policy declines (miss every time)", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    await client.get("/athlete/activities");
    await client.get("/athlete/activities");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("distinguishes cache entries by query string", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    await client.get("/activities/1/streams/heartrate");
    await client.get("/activities/1/streams/heartrate");
    await client.get("/activities/1/streams/watts");

    // Two distinct URLs => two fetches; the repeat of the first is cached.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches once the TTL has expired", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    let time = 0;
    const client = newCachingClient(() => time);
    await client.get("/activities/1");
    time = 1000; // reach the TTL boundary
    await client.get("/activities/1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skipCache bypasses both reading and writing the cache", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    // Warm the cache, then a skipCache read must still hit the network...
    await client.get("/activities/1");
    await client.get("/activities/1", { skipCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached reads under a written resource path", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    // Cache the detail and a sub-resource stream.
    await client.get("/activities/1");
    await client.get("/activities/1/streams/heartrate");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A write to the activity drops both cached reads.
    await client.put("/activities/1", { name: "renamed" });

    await client.get("/activities/1");
    await client.get("/activities/1/streams/heartrate");
    // 2 initial + 1 write + 2 re-fetches after invalidation.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("does not invalidate sibling resources on a write (path boundary)", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    await client.get("/activities/12"); // sibling of /activities/1
    await client.put("/activities/1", { name: "x" });
    await client.get("/activities/12"); // still cached

    // 1 initial GET + 1 write; the second GET is a cache hit (no extra fetch).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates a parent resource when a sub-resource is written", async () => {
    // #238: a PUT to a sub-resource flips a field on the parent. A
    // descendants-only rule left the cached parent claiming the pre-write
    // value for its whole TTL.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse('{"id":55}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = new FetchClient("https://example.test", {
      maxRetries: 0,
      sleep: async () => {},
      cache: { ttlForPath: stravaCacheTtl },
    });

    await client.get("/activities/55");
    await client.put("/activities/55/laps", { note: "edited" });
    await client.get("/activities/55");

    // 1 initial GET + 1 write + 1 re-fetch: the write dropped the parent.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("serves a repeated activity-listing page from cache (one upstream fetch per pair, #329)", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse("[]"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new FetchClient("https://example.test", {
      maxRetries: 0,
      sleep: async () => {},
      cache: { ttlForPath: stravaCacheTtl },
    });

    // The same quantized window a view-/get-…-data pair builds seconds apart.
    const params = { page: 1, per_page: 200, after: 1_700_000_040 };
    await client.get("/athlete/activities", { params });
    await client.get("/athlete/activities", { params });
    // A different window is a different key and still fetches.
    await client.get("/athlete/activities", {
      params: { ...params, after: 1_700_000_100 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not invalidate an unrelated ancestor branch on a write", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    await client.get("/activities/1");
    // /activities/12 is not an ancestor of /activities/1 despite the prefix.
    await client.put("/activities/12/kudos", { ok: true });
    await client.get("/activities/1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clearResponseCache() forces the next read to re-fetch", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    await client.get("/activities/1");
    client.clearResponseCache();
    await client.get("/activities/1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/** A fetch whose response the test releases by hand, to sequence races. */
function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets already-started requests reach their `fetch` call before we continue. */
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

type Payload = { id: number; tags: string[] };

describe("FetchClient response cache hand-out immutability (#357)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const newCachingClient = () =>
    new FetchClient("https://example.test", {
      maxRetries: 0,
      sleep: async () => {},
      cache: {
        ttlForPath: (path) => (path.startsWith("/activities/") ? 1000 : null),
      },
    });

  it("hands out a clone on a hit, so mutating one result cannot poison the next", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse('{"id":1,"tags":["a"]}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    await client.get<Payload>("/activities/1"); // miss: populates
    const hit = await client.get<Payload>("/activities/1");
    hit.data.tags.push("mutated");
    hit.data.id = 999;

    const next = await client.get<Payload>("/activities/1");
    expect(next.data).toEqual({ id: 1, tags: ["a"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands out a clone on a miss, so the first caller cannot poison later hits", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse('{"id":1,"tags":["a"]}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    const miss = await client.get<Payload>("/activities/1");
    miss.data.tags.push("mutated");
    miss.data.id = 999;

    const hit = await client.get<Payload>("/activities/1");
    expect(hit.data).toEqual({ id: 1, tags: ["a"] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a text body intact across the clone", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response("<gpx/>", {
          status: 200,
          headers: { "content-type": "application/gpx+xml" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    const a = await client.get<string>("/activities/1", {
      responseType: "text",
    });
    const b = await client.get<string>("/activities/1", {
      responseType: "text",
    });
    expect(a.data).toBe("<gpx/>");
    expect(b.data).toBe("<gpx/>");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("FetchClient in-flight GET coalescing (#355)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const newCachingClient = () =>
    new FetchClient("https://example.test", {
      maxRetries: 0,
      sleep: async () => {},
      cache: {
        ttlForPath: (path) => (path.startsWith("/activities/") ? 1000 : null),
      },
    });

  it("collapses N concurrent identical cacheable GETs onto one upstream call", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse('{"id":1,"tags":["a"]}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.get<Payload>("/activities/1")),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.data).toEqual({ id: 1, tags: ["a"] });
    }
    // Coalesced awaiters are independent clones, not one shared object.
    results[0]?.data.tags.push("mutated");
    expect(results[1]?.data.tags).toEqual(["a"]);
    expect(results[4]?.data.tags).toEqual(["a"]);
    // ...and the cache entry itself is untouched.
    const later = await client.get<Payload>("/activities/1");
    expect(later.data.tags).toEqual(["a"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce GETs on a path the cache policy declines", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeResponse("[]"));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    await Promise.all(
      Array.from({ length: 3 }, () => client.get("/athlete/activities")),
    );

    // Scope pinned: only cacheable reads share a wire call.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects every awaiter with the same error, caches nothing, and refetches next time", async () => {
    const failure = new Error("ECONNRESET");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockImplementation(async () => makeResponse('{"id":1,"tags":["a"]}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    const settled = await Promise.allSettled(
      Array.from({ length: 3 }, () => client.get<Payload>("/activities/1")),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const outcome of settled) {
      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toBe(failure);
    }

    // The failed flight left no cache entry and no in-flight entry behind.
    const recovered = await client.get<Payload>("/activities/1");
    expect(recovered.data).toEqual({ id: 1, tags: ["a"] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets a skipCache GET bypass an identical in-flight GET", async () => {
    const deferred = deferredResponse();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(deferred.promise)
      .mockImplementation(async () => makeResponse('{"id":2}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    const shared = client.get<{ id: number }>("/activities/1");
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The append-read shape: must be its own fetch, never the shared one.
    const fresh = await client.get<{ id: number }>("/activities/1", {
      skipCache: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fresh.data).toEqual({ id: 2 });

    deferred.resolve(makeResponse('{"id":1}'));
    expect((await shared).data).toEqual({ id: 1 });
  });

  it("drops an in-flight GET's result when a write invalidates its path mid-flight", async () => {
    const deferred = deferredResponse();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(deferred.promise)
      .mockImplementation(async () => makeResponse('{"name":"after"}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    const inFlight = client.get<{ name: string }>("/activities/1");
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The write lands while the GET is still on the wire.
    await client.put("/activities/1", { name: "after" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The stale response arrives; its caller still gets it...
    deferred.resolve(makeResponse('{"name":"before"}'));
    expect((await inFlight).data).toEqual({ name: "before" });

    // ...but it must not be stored: the next read goes upstream again.
    const next = await client.get<{ name: string }>("/activities/1");
    expect(next.data).toEqual({ name: "after" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never lets a write join an in-flight GET or populate the cache", async () => {
    const deferred = deferredResponse();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(deferred.promise)
      .mockImplementation(async () => makeResponse('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const client = newCachingClient();
    const inFlight = client.get("/activities/1");
    await flushMicrotasks();

    // A POST to the same URL is its own wire call, not a join.
    await client.post("/activities/1", { name: "x" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");

    deferred.resolve(makeResponse('{"ok":true}'));
    await inFlight;

    // The write invalidated the branch (and the flight); nothing it returned
    // was cached, so the next GET fetches.
    await client.get("/activities/1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
