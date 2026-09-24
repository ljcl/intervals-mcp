/**
 * Progress plumbing end to end (#279): the token threads from a CallTool
 * request through `dispatchToolCall` into the handlers that fan out, and a
 * caller who did not ask for progress sees no change at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledRateLimit } from "./__fixtures__";
import {
  getAthletePaceCurves,
  type IntervalsAthletePaceCurves,
} from "./intervalsClient";
import { getAllActivities } from "./stravaClient";

vi.mock("./stravaClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stravaClient")>();
  return {
    ...actual,
    getAllActivities: vi.fn(),
    getActivityById: vi.fn(),
  };
});

vi.mock("./intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./intervalsClient")>();
  return { ...actual, getAthletePaceCurves: vi.fn() };
});

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, getIntervalsApiKey: vi.fn(() => "test-token") };
});

const { dispatchToolCall } = await import("./server");
const { connectTestClient } = await import("./mcpTestClient");

const mockedList = vi.mocked(getAllActivities);
const mockedAthleteCurves = vi.mocked(getAthletePaceCurves);

/** A pace curve just complete enough for `get-best-efforts`'s topN=1 path. */
const onePointPaceCurves: IntervalsAthletePaceCurves = {
  list: [
    {
      id: "1y",
      distance: [1000],
      values: [248],
      activity_id: ["i1"],
    },
  ],
  activities: { i1: { id: "i1", name: "Run", race: false } },
};

describe("dispatchToolCall progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("reports the pace-curve fetch phase for get-best-efforts", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(onePointPaceCurves);

    const messages: string[] = [];
    await dispatchToolCall(
      "get-best-efforts",
      { window: "1y", topN: 1 },
      { progress: (message) => messages.push(message) },
    );

    // The phase marker is `important`, so it cannot be lost to the throttle
    // no matter how fast the mocked fetch resolves.
    expect(messages[0]).toBe("Fetching pace curve (1y)…");
  });

  it("still emits the phase message when the pace-curve fetch then fails", async () => {
    mockedAthleteCurves.mockRejectedValueOnce(
      handledRateLimit("getAthletePaceCurves for 1y"),
    );

    const messages: string[] = [];
    const result = await dispatchToolCall(
      "get-best-efforts",
      { window: "1y", topN: 1 },
      { progress: (message) => messages.push(message) },
    );

    expect(messages).toContain("Fetching pace curve (1y)…");
    expect(result.isError).toBe(true);
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
    mockedAthleteCurves.mockResolvedValueOnce(onePointPaceCurves);

    // No `progress` option at all: the handler still calls its reporter, so
    // the default must be a working no-op rather than undefined.
    const result = await dispatchToolCall("get-best-efforts", {
      window: "1y",
      topN: 1,
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
    mockedAthleteCurves.mockResolvedValueOnce(onePointPaceCurves);

    const client = await connectTestClient("progress-test");
    const body = await client.sendRaw("tools/call", {
      name: "get-best-efforts",
      arguments: { window: "1y", topN: 1 },
      _meta: { progressToken: "scan-1" },
    });

    // Asserted over the wire, not against the reporter: a notification the
    // transport never emits is not progress.
    expect(body).toContain("notifications/progress");
    expect(body).toContain("scan-1");
    expect(body).toContain("Fetching pace curve");
  });

  it("emits none when the caller omits the token", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(onePointPaceCurves);

    const client = await connectTestClient("progress-test");
    const body = await client.sendRaw("tools/call", {
      name: "get-best-efforts",
      arguments: { window: "1y", topN: 1 },
    });

    expect(body).not.toContain("notifications/progress");
  });
});
