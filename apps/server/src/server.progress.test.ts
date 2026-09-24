/**
 * Progress plumbing end to end (#279): the token threads from a CallTool
 * request through `dispatchToolCall` into the handlers that fan out, and a
 * caller who did not ask for progress sees no change at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledRateLimit } from "./__fixtures__";
import {
  getActivityById,
  getAllActivities,
  type StravaSummaryActivity,
} from "./stravaClient";

vi.mock("./stravaClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stravaClient")>();
  return {
    ...actual,
    getAllActivities: vi.fn(),
    getActivityById: vi.fn(),
  };
});

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, getIntervalsApiKey: vi.fn(() => "test-token") };
});

const { dispatchToolCall } = await import("./server");
const { connectTestClient } = await import("./mcpTestClient");

const mockedList = vi.mocked(getAllActivities);
const mockedById = vi.mocked(getActivityById);

/** A summary activity just complete enough for the best-efforts scan. */
function run(id: string): StravaSummaryActivity {
  return {
    id,
    name: `Run ${id}`,
    type: "Run",
    sport_type: "Run",
    distance: 10000,
    moving_time: 3000,
    elapsed_time: 3000,
    total_elevation_gain: 0,
    start_date: "2026-07-01T06:00:00Z",
    start_date_local: "2026-07-01T16:00:00Z",
  } as StravaSummaryActivity;
}

describe("dispatchToolCall progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("reports the phases of a best-efforts scan", async () => {
    mockedList.mockResolvedValueOnce([run("1"), run("2")]);
    mockedById.mockResolvedValue({
      id: "1",
      name: "Run",
      best_efforts: [],
    } as never);

    const messages: string[] = [];
    await dispatchToolCall(
      "get-best-efforts",
      { maxActivities: 2 },
      { progress: (message) => messages.push(message) },
    );

    // The two phase markers are `important`, so neither can be lost to the
    // throttle no matter how fast the mocked fetches resolve.
    expect(messages[0]).toBe("Listing activities…");
    expect(messages).toContain("Reading 2 activities for best efforts…");
  });

  it("reports the rate-limit abort rather than simply stopping", async () => {
    mockedList.mockResolvedValueOnce([run("1"), run("2")]);
    // The shape the client really hands back once the quota is spent.
    mockedById.mockRejectedValue(handledRateLimit("getActivityById for ID 1"));

    const messages: string[] = [];
    await dispatchToolCall(
      "get-best-efforts",
      { maxActivities: 2 },
      { progress: (message) => messages.push(message) },
    );

    expect(messages).toContain("Strava rate limit reached — stopping the scan");
  });

  it("wires the paginator's page callback to the reporter", async () => {
    mockedList.mockResolvedValueOnce([]);
    const messages: string[] = [];

    await dispatchToolCall(
      "get-training-load-data",
      { days: 84 },
      { progress: (message) => messages.push(message) },
    );

    // The app-data tools page through a history that can run to thousands of
    // activities; the sweep is the whole call, so it is the only thing there
    // is to report.
    const [, params] = mockedList.mock.calls[0]!;
    params?.onProgress?.(200, 1);
    expect(messages).toEqual(["Listed 200 activities"]);
  });

  it("runs unchanged when the caller supplies no reporter", async () => {
    mockedList.mockResolvedValueOnce([run("1")]);
    mockedById.mockResolvedValue({
      id: "1",
      name: "Run",
      best_efforts: [],
    } as never);

    // No `progress` option at all: the handler still calls its reporter, so
    // the default must be a working no-op rather than undefined.
    const result = await dispatchToolCall("get-best-efforts", {
      maxActivities: 1,
    });

    expect(result.isError).toBeUndefined();
  });
});

describe("CallTool progress notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("puts progress on the same stream as the result when a token is sent", async () => {
    mockedList.mockResolvedValueOnce([run("1")]);
    mockedById.mockResolvedValue({
      id: "1",
      name: "Run",
      best_efforts: [],
    } as never);

    const client = await connectTestClient("progress-test");
    const body = await client.sendRaw("tools/call", {
      name: "get-best-efforts",
      arguments: { maxActivities: 1 },
      _meta: { progressToken: "scan-1" },
    });

    // Asserted over the wire, not against the reporter: a notification the
    // transport never emits is not progress.
    expect(body).toContain("notifications/progress");
    expect(body).toContain("scan-1");
    expect(body).toContain("Listing activities");
  });

  it("emits none when the caller omits the token", async () => {
    mockedList.mockResolvedValueOnce([run("1")]);
    mockedById.mockResolvedValue({
      id: "1",
      name: "Run",
      best_efforts: [],
    } as never);

    const client = await connectTestClient("progress-test");
    const body = await client.sendRaw("tools/call", {
      name: "get-best-efforts",
      arguments: { maxActivities: 1 },
    });

    expect(body).not.toContain("notifications/progress");
  });
});
