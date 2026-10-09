/**
 * A cancelled tool call stops its upstream work (#70). These drive the real
 * dispatch, the real `FetchClient` and the real transport, with only
 * `fetch` replaced by a routed, counting fake. Held fetches stand in for a
 * slow intervals.icu and reject when their signal aborts, as a real fetch
 * does; every case releases its own before it ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activityFixture from "./__fixtures__/intervals/activity.json";
import sportSettingsFixture from "./__fixtures__/intervals/sport-settings-run.json";

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, getIntervalsApiKey: vi.fn(() => "test-token") };
});

const { dispatchToolCall } = await import("./server");
const { connectTestClient } = await import("./mcpTestClient");
const { intervalsApi } = await import("./fetchClient");
const { resetToolCallStats, toolCallStats } = await import("./telemetry");

/** A fetch the test answers by hand, once it has seen the request. */
interface Held {
  url: string;
  respond(body: unknown): void;
}

let held: Held[];
let calls: string[];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Routes by path. `holdActivities` and `holdActivity` hold those reads until
 * `respond` is called; everything else answers at once.
 */
function stubFetch(options: {
  holdActivities?: boolean;
  holdActivity?: boolean;
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const hold =
        (options.holdActivities && url.includes("/athlete/0/activities")) ||
        (options.holdActivity && url.includes("/activity/i1"));
      if (hold) {
        return new Promise<Response>((resolve, reject) => {
          held.push({ url, respond: (body) => resolve(json(body)) });
          // A real fetch rejects when its signal aborts.
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }
      if (url.includes("/sport-settings/")) {
        return Promise.resolve(json(sportSettingsFixture));
      }
      if (url.includes("/activity/")) {
        return Promise.resolve(json(activityFixture));
      }
      return Promise.resolve(json([]));
    }),
  );
}

/** The `tool_call` records written to stderr so far. */
function loggedRecords(): Array<Record<string, unknown>> {
  return vi
    .mocked(console.error)
    .mock.calls.map(([line]) => String(line))
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.event === "tool_call");
}

beforeEach(() => {
  held = [];
  calls = [];
  intervalsApi.clearResponseCache();
  resetToolCallStats();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // A case that failed early must not leave a fetch hanging.
  for (const request of held) request.respond([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dispatchToolCall with a signal", () => {
  it("records a call cancelled before it starts as cancelled, with no request", async () => {
    stubFetch({});

    await dispatchToolCall(
      "get-activity-laps",
      { id: "i1" },
      { signal: AbortSignal.abort() },
    );

    expect(calls).toEqual([]);
    expect(loggedRecords()).toEqual([
      expect.objectContaining({
        tool: "get-activity-laps",
        outcome: "cancelled",
      }),
    ]);
    expect(toolCallStats()["get-activity-laps"]).toMatchObject({
      calls: 1,
      cancelled: 1,
      errors: 0,
    });
  });

  it("records a call whose signal never aborts exactly as one without a signal", async () => {
    stubFetch({});
    const controller = new AbortController();

    const result = await dispatchToolCall(
      "get-activity",
      { id: "i1" },
      { signal: controller.signal },
    );

    expect(result.isError).toBeFalsy();
    expect(loggedRecords()).toEqual([
      expect.objectContaining({ tool: "get-activity", outcome: "ok" }),
    ]);
    expect(toolCallStats()["get-activity"]).toMatchObject({
      cancelled: 0,
      errors: 0,
    });
  });
});

describe("cancellation over the wire", () => {
  it("answers a cancelled 'latest' call with nothing and starts no second listing window", async () => {
    stubFetch({ holdActivities: true });
    const client = await connectTestClient("cancel-test");
    const controller = new AbortController();

    const sent = client.sendRaw(
      "tools/call",
      { name: "get-activity", arguments: { id: "latest" } },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(held).toHaveLength(1));
    controller.abort();

    // The client left while the listing is still on the wire (499, no body).
    await expect(sent).resolves.toBe("");
    expect(calls).toHaveLength(1);
    expect(loggedRecords()).toEqual([
      expect.objectContaining({ tool: "get-activity", outcome: "cancelled" }),
    ]);

    // The listing lands empty. An uncancelled call would walk to the next
    // 31-day window now; this one must not.
    held[0]?.respond([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toHaveLength(1);
  });

  it("still completes a shared read for the call that stayed", async () => {
    stubFetch({ holdActivity: true });
    const client = await connectTestClient("cancel-test");
    const controller = new AbortController();
    const args = { name: "get-activity", arguments: { id: "i1" } };

    const first = client.sendRaw("tools/call", args, {
      signal: controller.signal,
    });
    const second = client.send("tools/call", args);
    // Both calls join one upstream read of the activity. The paced
    // sport-settings read starts after it, so both calls have joined by then.
    await vi.waitFor(() =>
      expect(
        calls.filter((url) => url.includes("/sport-settings/")),
      ).toHaveLength(1),
    );
    expect(held).toHaveLength(1);
    controller.abort();
    await expect(first).resolves.toBe("");
    held[0]?.respond(activityFixture);

    const response = await second;
    expect(response.result?.isError).toBeFalsy();
    expect(calls.filter((url) => url.includes("/activity/i1"))).toHaveLength(1);
    expect(
      loggedRecords()
        .map((record) => record.outcome)
        .sort(),
    ).toEqual(["cancelled", "ok"]);
  });
});
