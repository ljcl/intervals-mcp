/**
 * Regression tests for #107: tool input schemas are enforced at dispatch
 * time, so zod defaults apply when args are omitted and invalid args return
 * a structured error instead of flowing into Strava requests as NaN.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "./__fixtures__";
import { getActivity as getIntervalsActivity } from "./intervalsClient";
import {
  getActivityById,
  getAllActivities,
  getAthleteStats,
} from "./stravaClient";

vi.mock("./stravaClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stravaClient")>();
  return {
    ...actual,
    getAllActivities: vi.fn(),
    getActivityById: vi.fn(),
    getAthleteStats: vi.fn(),
  };
});

vi.mock("./intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./intervalsClient")>();
  return { ...actual, getActivity: vi.fn() };
});

// dispatchToolCall resolves the API key once per call (#240).
vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, getIntervalsApiKey: vi.fn() };
});

// Import after the mock so server.ts's tool modules see the mocked client.
const { dispatchToolCall } = await import("./server");
const { getIntervalsApiKey, MissingApiKeyError } = await import("./config");
const mockedToken = vi.mocked(getIntervalsApiKey);

const mockedList = vi.mocked(getAllActivities);
const mockedById = vi.mocked(getActivityById);
const mockedStats = vi.mocked(getAthleteStats);
const mockedIntervalsActivity = vi.mocked(getIntervalsActivity);

describe("dispatchToolCall input validation", () => {
  beforeEach(() => {
    mockedToken.mockReset();
    mockedToken.mockReturnValue("test-token");
    mockedList.mockReset();
    mockedById.mockReset();
    mockedStats.mockReset();
    mockedIntervalsActivity.mockReset();
  });

  it("applies zod defaults when optional args are omitted (get-best-efforts)", async () => {
    mockedList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-best-efforts", undefined);

    expect(result.isError).toBeUndefined();
    // Defaults applied: maxActivities 100, so perPage is min(100, 200) = 100
    // — previously Math.min(undefined, 200) produced per_page=NaN.
    expect(mockedList).toHaveBeenCalledWith("test-token", {
      perPage: 100,
      maxItems: 100,
      countActivity: expect.any(Function),
      onProgress: expect.any(Function),
    });
  });

  it("applies zod defaults for get-training-load (no NaN after timestamp)", async () => {
    mockedList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-training-load", {});

    expect(result.isError).toBeUndefined();
    const params = mockedList.mock.calls[0]?.[1];
    expect(Number.isFinite(params?.after)).toBe(true);
  });

  it("rejects args above the documented bounds without calling Strava", async () => {
    const result = await dispatchToolCall("get-best-efforts", {
      maxActivities: 500,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Invalid arguments for get-best-efforts",
    );
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("rejects wrongly-typed args without calling Strava", async () => {
    const result = await dispatchToolCall("get-training-load", {
      days: "four weeks",
    });

    expect(result.isError).toBe(true);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("rejects an app tool call missing its required activity_id", async () => {
    const result = await dispatchToolCall("view-activity-chart", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Invalid arguments for view-activity-chart",
    );
    expect(mockedById).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric activity_id for app tools", async () => {
    const result = await dispatchToolCall("get-activity-streams-raw", {
      activity_id: "not-an-id",
    });

    expect(result.isError).toBe(true);
    expect(mockedById).not.toHaveBeenCalled();
  });

  it("explains an oversized activity_id sent as a JSON number (view-route-map)", async () => {
    // Reported failure: an activity id pasted from a Strava activity URL was
    // called as an unquoted number, which the host's JSON.parse rounded
    // before dispatch. The advertised schema is now string-only so this
    // shape should not be generated at all; when it is, the error must name
    // the rounded value and the string fix once, rather than claiming the
    // value is not a whole number.
    const result = await dispatchToolCall("view-route-map", {
      activity_id: JSON.parse("3516039180561708486"),
    });

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Invalid arguments for view-route-map");
    expect(text).toContain("3516039180561708500");
    expect(text).toContain("quoted as a string of digits");
    expect(text).not.toContain("whole number");
  });

  it("accepts an oversized activity_id as a digit string", async () => {
    // The lossless form the advertised schema now asks for. It gets past
    // validation and fails later, at the (unmocked) Strava fetch.
    const result = await dispatchToolCall("view-route-map", {
      activity_id: "3516039180561708486",
    });

    expect(result.content[0]?.text ?? "").not.toContain("Invalid arguments");
  });

  it("advertises every id argument as a digit string, never a number", async () => {
    // A number branch in the advertised schema is what invited the lossy
    // call above; ids must stay string-only across every tool. intervals.icu
    // activity ids (get-activity, get-activity-streams, get-activity-laps,
    // get-running-summary, get-activity-zones, view-activity-zones,
    // get-activity-zones-data, get-hill-analysis, get-split-analysis,
    // get-aerobic-analysis) are the exception to the digits-only pattern:
    // they accept an optional "i" prefix, as list-activities returns them
    // (intervalsActivityIdInput, tools/_ids.ts).
    const { TOOLS } = await import("./server");
    const idSchemas = (
      TOOLS as Array<{
        name: string;
        inputSchema?: { properties?: Record<string, Record<string, unknown>> };
      }>
    ).flatMap((tool) =>
      Object.entries(tool.inputSchema?.properties ?? {})
        .filter(([key]) => key === "id" || key.endsWith("_id"))
        .map(([key, schema]) => ({ field: `${tool.name}.${key}`, schema })),
    );

    expect(idSchemas.length).toBeGreaterThan(6);
    for (const { field, schema } of idSchemas) {
      const expectedPattern =
        field === "get-activity.id" ||
        field === "get-activity-streams.id" ||
        field === "get-activity-laps.id" ||
        field === "get-running-summary.id" ||
        field === "get-activity-zones.id" ||
        field === "view-activity-zones.activity_id" ||
        field === "get-activity-zones-data.activity_id" ||
        field === "get-hill-analysis.id" ||
        field === "get-split-analysis.id" ||
        field === "get-aerobic-analysis.id"
          ? "^i?\\d+$"
          : "^\\d+$";
      expect(`${field}: ${schema.type}`).toBe(`${field}: string`);
      expect(`${field}: ${schema.pattern}`).toBe(
        `${field}: ${expectedPattern}`,
      );
    }
  });

  it("applies the weeks default for app tools", async () => {
    mockedList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-cadence-trend-data", {});

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(JSON.parse(text).weeks).toBe(6);
  });

  it("applies the days default for get-training-load-data", async () => {
    mockedList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-training-load-data", {});

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual({
      days: 84,
      totals: { runs: 0, distanceKm: 0, timeHours: 0, elevationM: 0 },
      weeks: [],
    });
    const params = mockedList.mock.calls[0]?.[1];
    expect(Number.isFinite(params?.after)).toBe(true);
  });

  it("rejects days above the documented bound for view-training-load", async () => {
    const result = await dispatchToolCall("view-training-load", { days: 900 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Invalid arguments for view-training-load",
    );
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("rejects view-compare-activities when an id is missing", async () => {
    const result = await dispatchToolCall("view-compare-activities", {
      activity_id_1: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Invalid arguments for view-compare-activities",
    );
    expect(mockedById).not.toHaveBeenCalled();
  });

  it("returns the comparison JSON for get-compare-activities-data", async () => {
    const activity = {
      id: "1",
      name: "Run A",
      type: "Run",
      start_date_local: "2026-06-01T07:00:00",
      distance: 5000,
      moving_time: 1500,
    };
    mockedIntervalsActivity.mockResolvedValueOnce(
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      activity as any,
    );
    mockedIntervalsActivity.mockResolvedValueOnce(
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      { ...activity, id: "2", name: "Run B" } as any,
    );

    const result = await dispatchToolCall("get-compare-activities-data", {
      activity_id_1: "1",
      activity_id_2: "2",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.activity_1.name).toBe("Run A");
    expect(parsed.activity_2.name).toBe("Run B");
    expect(parsed.differences.distance_km).toBe(0);
  });

  it("returns a structured error for unknown tools", async () => {
    const result = await dispatchToolCall("not-a-tool", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool: not-a-tool");
  });

  it("returns isError naming INTERVALS_API_KEY when the key cannot be resolved", async () => {
    mockedToken.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    const result = await dispatchToolCall("get-best-efforts", undefined);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("INTERVALS_API_KEY");
    expect(mockedList).not.toHaveBeenCalled();
  });

  // The app data handlers throw rather than return `isError`, so the
  // dispatcher's final catch is the only place their failures get the typed
  // 404/429 treatment and the ❌ prefix the text tools give themselves.
  it("renders a thrown RateLimitError with the rate-limit window", async () => {
    mockedList.mockRejectedValueOnce(handledRateLimit("getAllActivities"));

    const result = await dispatchToolCall("get-training-load-data", {});

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text.startsWith("❌")).toBe(true);
    expect(text).toContain("rate limit");
    expect(text).toContain("get-training-load-data");
    expect(text).toContain("15-minute rate limit reached (100/100 requests).");
    expect(text).not.toContain("Tool error");
  });

  it("maps a thrown 404 to a not-found line", async () => {
    mockedIntervalsActivity.mockRejectedValue(handledNotFound("getActivity"));

    const result = await dispatchToolCall("get-compare-activities-data", {
      activity_id_1: "1",
      activity_id_2: "2",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("❌ Not found.");
  });

  it("reports other thrown failures with the tool name and message", async () => {
    mockedList.mockRejectedValueOnce(new Error("boom"));

    const result = await dispatchToolCall("get-training-load-data", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "❌ Failed to run get-training-load-data: boom",
    );
  });
});
