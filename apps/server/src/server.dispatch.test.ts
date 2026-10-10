/**
 * Regression tests for ljcl/strava-mcp#107: tool input schemas are enforced at dispatch
 * time, so zod defaults apply when args are omitted and invalid args return
 * a structured error instead of flowing into intervals.icu requests as NaN.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "./__fixtures__";
import { intervalsApi } from "./fetchClient";
import {
  getActivityStreams,
  getAthletePaceCurves,
  getActivity as getIntervalsActivity,
  getWellness as getIntervalsWellness,
  type IntervalsAthletePaceCurves,
  listActivities as listIntervalsActivities,
} from "./intervalsClient";
import { trainingLoadWindow } from "./trainingLoad";

vi.mock("./intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./intervalsClient")>();
  return {
    ...actual,
    getActivity: vi.fn(),
    getActivityStreams: vi.fn(),
    getActivityFile: vi.fn(),
    getAthletePaceCurves: vi.fn(),
    getSportSettings: vi.fn(),
    listActivities: vi.fn(),
    getWellness: vi.fn(),
  };
});

// dispatchToolCall resolves the API key once per call (ljcl/strava-mcp#240).
vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, getIntervalsApiKey: vi.fn() };
});

// Import after the mock so server.ts's tool modules see the mocked client.
const { dispatchToolCall, TOOL_DEFS } = await import("./server");
const { getIntervalsApiKey, MissingApiKeyError } = await import("./config");
const mockedToken = vi.mocked(getIntervalsApiKey);

const mockedIntervalsList = vi.mocked(listIntervalsActivities);
const mockedIntervalsWellness = vi.mocked(getIntervalsWellness);
const mockedIntervalsActivity = vi.mocked(getIntervalsActivity);
const mockedAthleteCurves = vi.mocked(getAthletePaceCurves);
const mockedStreams = vi.mocked(getActivityStreams);

/** Inclusive day count of a listing window's oldest..newest dates. */
function windowDays(params: { oldest?: string; newest?: string } | undefined) {
  const oldest = Date.parse(`${params?.oldest}T00:00:00Z`);
  const newest = Date.parse(`${params?.newest}T00:00:00Z`);
  return Math.round((newest - oldest) / 86_400_000) + 1;
}

const emptyPaceCurves: IntervalsAthletePaceCurves = {
  list: [{ id: "1y", distance: [], values: [], activity_id: [] }],
  activities: {},
};

describe("dispatchToolCall input validation", () => {
  beforeEach(() => {
    mockedToken.mockReset();
    mockedToken.mockReturnValue("test-token");
    mockedIntervalsList.mockReset();
    mockedIntervalsActivity.mockReset();
    mockedAthleteCurves.mockReset();
  });

  it("applies zod defaults when optional args are omitted (get-best-efforts)", async () => {
    mockedAthleteCurves.mockResolvedValueOnce(emptyPaceCurves);

    const result = await dispatchToolCall("get-best-efforts", undefined);

    expect(result.isError).toBeUndefined();
    // Defaults applied: window "1y", topN 1. Previously an unset
    // maxActivities produced per_page=NaN against the old Strava client.
    expect(mockedAthleteCurves).toHaveBeenCalledWith("test-token", {
      type: "Run",
      curves: ["1y"],
    });
  });

  it("refuses get-best-efforts with both id and window, without calling intervals.icu", async () => {
    const result = await dispatchToolCall("get-best-efforts", {
      id: "i1",
      window: "1y",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(
      /^❌ Invalid arguments for get-best-efforts: [\s\S]*Send id or window, not both/,
    );
    expect(mockedAthleteCurves).not.toHaveBeenCalled();
    expect(mockedIntervalsActivity).not.toHaveBeenCalled();
  });

  it('resolves get-best-efforts id "latest" to the newest run before the handler reads it', async () => {
    mockedIntervalsList.mockResolvedValueOnce([
      {
        id: "i42",
        type: "Run",
        name: "Run 1",
        start_date_local: "2026-09-24T07:00:00",
      },
    ]);
    // A ride stops the handler after its first read: this test is about
    // which id reached it.
    mockedIntervalsActivity.mockResolvedValueOnce({
      id: "i42",
      type: "Ride",
      name: "Run 1",
      start_date_local: "2026-09-24T07:00:00",
    });

    const result = await dispatchToolCall("get-best-efforts", {
      id: "latest",
    });

    expect(mockedIntervalsActivity).toHaveBeenCalledWith("test-token", "i42");
    expect(mockedAthleteCurves).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain("Activity i42");
  });

  it("reads get-best-efforts activityId as its id (the issue's spelling)", async () => {
    mockedIntervalsActivity.mockResolvedValueOnce({
      id: "i43",
      type: "Ride",
      name: "Ride 1",
      start_date_local: "2026-09-24T07:00:00",
    });

    await dispatchToolCall("get-best-efforts", { activityId: "i43" });

    expect(mockedIntervalsActivity).toHaveBeenCalledWith("test-token", "i43");
    expect(mockedAthleteCurves).not.toHaveBeenCalled();
  });

  it("applies zod defaults for get-training-load (a real date window, not NaN)", async () => {
    mockedIntervalsList.mockResolvedValueOnce([]);
    mockedIntervalsWellness.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-training-load", {});

    expect(result.isError).toBeUndefined();
    const params = mockedIntervalsList.mock.calls[0]?.[1];
    expect(params?.oldest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(params?.newest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("rejects args above the documented bounds without calling intervals.icu", async () => {
    const result = await dispatchToolCall("get-best-efforts", {
      topN: 6,
    });

    expect(result.isError).toBe(true);
    // Every isError text on the surface starts with the prefix, the
    // dispatcher's own included.
    expect(result.content[0]?.text).toMatch(
      /^❌ Invalid arguments for get-best-efforts: /,
    );
    expect(mockedAthleteCurves).not.toHaveBeenCalled();
  });

  it("rejects wrongly-typed args without calling intervals.icu", async () => {
    const result = await dispatchToolCall("get-training-load", {
      days: "four weeks",
    });

    expect(result.isError).toBe(true);
    expect(mockedIntervalsList).not.toHaveBeenCalled();
  });

  it("rejects an app tool call missing its required id", async () => {
    const result = await dispatchToolCall("view-activity-chart", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Invalid arguments for view-activity-chart",
    );
    expect(mockedIntervalsActivity).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric id for app tools", async () => {
    const result = await dispatchToolCall("get-activity-streams-raw", {
      id: "not-an-id",
    });

    expect(result.isError).toBe(true);
    expect(mockedIntervalsActivity).not.toHaveBeenCalled();
  });

  it("explains an oversized id sent as a JSON number (view-route-map)", async () => {
    // Reported failure: an activity id above 2^53 was called as an unquoted
    // number, which the host's JSON.parse rounded before dispatch. The
    // advertised schema is now string-only so this shape should not be
    // generated at all; when it is, the error must name the rounded value
    // and the string fix once, rather than claiming the value is not a
    // whole number.
    const result = await dispatchToolCall("view-route-map", {
      id: JSON.parse("3516039180561708486"),
    });

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Invalid arguments for view-route-map");
    expect(text).toContain("3516039180561708500");
    expect(text).toContain("quoted as a string of digits");
    expect(text).not.toContain("whole number");
  });

  it("accepts an oversized id as a digit string", async () => {
    // The lossless form the advertised schema now asks for. It gets past
    // validation and fails later, at the (unmocked) intervals.icu fetch.
    const result = await dispatchToolCall("view-route-map", {
      id: "3516039180561708486",
    });

    expect(result.content[0]?.text ?? "").not.toContain("Invalid arguments");
  });

  it("advertises every id argument as a digit string, never a number", async () => {
    // A number branch in the advertised schema is what invited the lossy
    // call above; ids must stay string-only across every tool. Every
    // matched id here is an intervals.icu activity id
    // (intervalsActivityIdInput, tools/_ids.ts), which accepts an optional
    // "i" prefix, as list-activities returns them.
    const { TOOL_DEFS } = await import("./server");
    const idSchemas = (
      TOOL_DEFS as Array<{
        name: string;
        inputSchema?: { properties?: Record<string, Record<string, unknown>> };
      }>
    ).flatMap((tool) =>
      Object.entries(tool.inputSchema?.properties ?? {})
        .filter(
          ([key]) =>
            key === "id" || key.endsWith("_id") || /^activityId\d$/.test(key),
        )
        .map(([key, schema]) => ({ field: `${tool.name}.${key}`, schema })),
    );

    expect(idSchemas.length).toBeGreaterThan(6);
    for (const { field, schema } of idSchemas) {
      expect(`${field}: ${schema.type}`).toBe(`${field}: string`);
      const expected =
        field === "update-activity.id" ? "^i?\\d+$" : "^(?:i?\\d+|latest)$";
      expect(`${field}: ${schema.pattern}`).toBe(`${field}: ${expected}`);
    }
  });

  it("applies the days default for get-cadence-trend-data", async () => {
    mockedIntervalsList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-cadence-trend-data", {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "");
    expect(parsed.days).toBe(42);
    expect(parsed).not.toHaveProperty("weeks");
    const params = mockedIntervalsList.mock.calls[0]?.[1];
    expect(windowDays(params)).toBe(42);
  });

  it.each([6, 729])(
    "rejects days=%i outside 7 to 728 for get-cadence-trend-data",
    async (days) => {
      const result = await dispatchToolCall("get-cadence-trend-data", { days });

      expect(result.isError).toBe(true);
      expect(mockedIntervalsList).not.toHaveBeenCalled();
    },
  );

  it("applies the days default for get-training-load-data", async () => {
    mockedIntervalsList.mockResolvedValueOnce([]);
    mockedIntervalsWellness.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-training-load-data", {});

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    const parsed = JSON.parse(text);
    // The default 84 days is 12 complete weeks plus this week so far, so
    // the day count depends on today's weekday.
    const lookback = trainingLoadWindow(84, parsed.endDate);
    expect(parsed).toEqual({
      days: lookback.spanDays,
      startDate: lookback.startDate,
      endDate: lookback.endDate,
      endsToday: true,
      activityTypesIncluded: [],
      runOnly: false,
      current: null,
      source: "intervals.icu",
      totals: { runs: 0, distanceKm: 0, timeHours: 0, elevationM: 0, load: 0 },
      weeks: [],
    });
    const params = mockedIntervalsList.mock.calls[0]?.[1];
    // The listing starts 4 weeks early, for the volume-spike baseline.
    expect(params?.oldest).toBe(lookback.baselineStartDate);
    expect(params?.newest).toBe(lookback.endDate);
  });

  it.each(["get-fitness-trend", "get-training-load-data"])(
    "rejects a newest that is not a real calendar date for %s (#80)",
    async (tool) => {
      mockedIntervalsWellness.mockClear();
      const result = await dispatchToolCall(tool, { newest: "2026-02-30" });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        `Invalid arguments for ${tool}`,
      );
      expect(result.content[0]?.text).toContain("must be a real calendar date");
      expect(mockedIntervalsList).not.toHaveBeenCalled();
      expect(mockedIntervalsWellness).not.toHaveBeenCalled();
    },
  );

  it("rejects days above the documented bound for view-training-load", async () => {
    const result = await dispatchToolCall("view-training-load", { days: 900 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Invalid arguments for view-training-load",
    );
    expect(mockedIntervalsList).not.toHaveBeenCalled();
  });

  it("rejects view-compare-activities when an id is missing", async () => {
    const result = await dispatchToolCall("view-compare-activities", {
      activityId1: "123",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Invalid arguments for view-compare-activities",
    );
    expect(mockedIntervalsActivity).not.toHaveBeenCalled();
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
    // No streams: the comparison degrades to no per-km table.
    mockedStreams.mockResolvedValue([]);

    const result = await dispatchToolCall("get-compare-activities-data", {
      activityId1: "1",
      activityId2: "2",
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
    expect(result.content[0]?.text).toBe("❌ Unknown tool: not-a-tool");
  });

  it("returns isError naming INTERVALS_API_KEY when the key cannot be resolved", async () => {
    mockedToken.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });

    const result = await dispatchToolCall("get-best-efforts", undefined);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      `❌ ${new MissingApiKeyError().message}`,
    );
    expect(result.content[0]?.text).toContain("INTERVALS_API_KEY");
    expect(mockedAthleteCurves).not.toHaveBeenCalled();
  });

  // The app data handlers throw rather than return `isError`, so the
  // dispatcher's final catch is the only place their failures get the typed
  // 404/429 treatment and the ❌ prefix the text tools give themselves.
  it("renders a thrown RateLimitError with the rate-limit window", async () => {
    mockedIntervalsList.mockRejectedValueOnce(
      handledRateLimit("listActivities"),
    );

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
      activityId1: "1",
      activityId2: "2",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("❌ Not found.");
  });

  it("reports other thrown failures with the tool name and message", async () => {
    mockedIntervalsList.mockRejectedValueOnce(new Error("boom"));

    const result = await dispatchToolCall("get-training-load-data", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "❌ Failed to run get-training-load-data: boom",
    );
  });
});

describe("input naming scheme (#141)", () => {
  beforeEach(() => {
    mockedToken.mockReset();
    mockedToken.mockReturnValue("test-token");
    mockedIntervalsList.mockReset();
    mockedIntervalsActivity.mockReset();
    mockedAthleteCurves.mockReset();
  });

  it("advertises no activity_id, activity_id_1, activity_id_2 or weeks input", () => {
    const retired = new Set([
      "activity_id",
      "activity_id_1",
      "activity_id_2",
      "weeks",
    ]);
    const offenders = TOOL_DEFS.flatMap((tool) =>
      Object.keys(tool.inputSchema.properties ?? {})
        .filter((key) => retired.has(key))
        .map((key) => `${tool.name}.${key}`),
    );
    expect(offenders).toEqual([]);
  });

  it("accepts activity_id on view-route-map", async () => {
    mockedIntervalsActivity.mockRejectedValue(handledNotFound("getActivity"));

    const result = await dispatchToolCall("view-route-map", {
      activity_id: "i42",
    });

    expect(result.content[0]?.text).not.toContain("Invalid arguments");
    expect(mockedIntervalsActivity.mock.calls[0]?.[1]).toBe("i42");
  });

  it("accepts activity_id_1 and activity_id_2 on get-compare-activities-data", async () => {
    mockedIntervalsActivity.mockRejectedValue(handledNotFound("getActivity"));

    const result = await dispatchToolCall("get-compare-activities-data", {
      activity_id_1: "i1",
      activity_id_2: "i2",
    });

    expect(result.content[0]?.text).not.toContain("Invalid arguments");
    const ids = mockedIntervalsActivity.mock.calls.map((call) => call[1]);
    expect(ids).toEqual(["i1", "i2"]);
  });

  it('accepts raceDistance "Half Marathon" on get-race-prediction', async () => {
    mockedAthleteCurves.mockResolvedValueOnce({
      list: ["all", "90d"].map((id) => ({
        id,
        distance: [10000],
        values: [2400],
        activity_id: ["i1"],
      })),
      activities: {
        i1: {
          id: "i1",
          name: "Run 1",
          start_date_local: "2026-09-20T08:00:00",
          race: false,
        },
      },
    } as never);

    const result = await dispatchToolCall("get-race-prediction", {
      raceDistance: "Half Marathon",
    });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      target?: { distance: string };
    };
    expect(structured.target?.distance).toBe("half marathon");
  });

  // 4, not the default 6: zod strips an unknown `weeks`, so a value equal to
  // the default would pass with the alias rule deleted.
  it("reads weeks: 4 on get-cadence-trend-data as days: 28", async () => {
    mockedIntervalsList.mockResolvedValueOnce([]);

    const result = await dispatchToolCall("get-cadence-trend-data", {
      weeks: 4,
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "").days).toBe(28);
    expect(windowDays(mockedIntervalsList.mock.calls[0]?.[1])).toBe(28);
  });
});

/** The advertised pattern of an id input that accepts "latest". */
const LATEST_PATTERN = "^(?:i?\\d+|latest)$";

describe('dispatchToolCall id "latest"', () => {
  beforeEach(() => {
    mockedToken.mockReset();
    mockedToken.mockReturnValue("test-token");
    mockedIntervalsList.mockReset();
    mockedIntervalsActivity.mockReset();
  });

  describe("resolved ids in _meta", () => {
    const KEY = "intervals-mcp/resolvedArgs";
    const run = { id: "i999", type: "Run", start_date_local: "2026-10-01" };

    beforeEach(() => {
      // No streams: the route map still renders from the activity alone.
      mockedStreams.mockReset();
      mockedStreams.mockResolvedValue([]);
    });

    it("reports the id a latest resolved to", async () => {
      mockedIntervalsList.mockResolvedValue([run] as never);
      mockedIntervalsActivity.mockResolvedValue({
        id: "i999",
        name: "Easy",
        type: "Run",
      } as never);

      const result = await dispatchToolCall("view-route-map", { id: "latest" });

      expect(result.isError).toBeUndefined();
      expect(result._meta).toEqual({ [KEY]: { id: "i999" } });
    });

    it("reports every key that said latest, and only those", async () => {
      mockedIntervalsList.mockResolvedValue([run] as never);
      mockedIntervalsActivity.mockResolvedValue({
        id: "i999",
        name: "Easy",
        type: "Run",
      } as never);

      const result = await dispatchToolCall("view-compare-activities", {
        activityId1: "latest",
        activityId2: "i1",
      });

      expect(result._meta).toEqual({ [KEY]: { activityId1: "i999" } });
    });

    it("leaves the result alone when nothing was latest", async () => {
      mockedIntervalsActivity.mockResolvedValue({
        id: "i1",
        name: "Easy",
        type: "Run",
      } as never);

      const result = await dispatchToolCall("view-route-map", { id: "i1" });

      expect(result.isError).toBeUndefined();
      expect(result).not.toHaveProperty("_meta");
    });

    it("never attaches it to an error result", async () => {
      mockedIntervalsList.mockResolvedValue([run] as never);
      mockedIntervalsActivity.mockRejectedValue(handledNotFound);

      const result = await dispatchToolCall("get-activity", { id: "latest" });

      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty("_meta");
    });
  });

  it("refuses latest for update-activity with a message naming the fix", async () => {
    const result = await dispatchToolCall("update-activity", {
      id: "latest",
      name: "Easy",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      '"latest" is not accepted for a write',
    );
    expect(mockedIntervalsList).not.toHaveBeenCalled();
  });

  // Behavioural rather than reading the private key map: every advertised
  // latest field, sent "latest", must reach intervals.icu as the newest run's
  // id. Per-activity reads go through the mocked getActivity or, for the
  // unmocked client functions, `intervalsApi.get` with the id in the path.
  it("resolves every advertised latest field before the handler's reads", async () => {
    const latestFields = TOOL_DEFS.flatMap((tool) => {
      const props = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { pattern?: string }
      >;
      const fields = Object.entries(props)
        .filter(([, prop]) => prop.pattern === LATEST_PATTERN)
        .map(([key]) => key);
      return fields.map((field) => ({ tool: tool.name, field, fields }));
    });
    // Every per-activity tool but update-activity; a regression to zero
    // would make the loop below vacuous.
    expect(latestFields.length).toBeGreaterThanOrEqual(20);

    const get = vi.spyOn(intervalsApi, "get");
    try {
      for (const { tool, field, fields } of latestFields) {
        mockedIntervalsList.mockReset();
        mockedIntervalsActivity.mockReset();
        get.mockReset();
        mockedIntervalsList.mockResolvedValue([
          { id: "i999", type: "Run", start_date_local: "2026-10-01T07:00:00" },
        ] as never);
        mockedIntervalsActivity.mockRejectedValue(handledNotFound);
        get.mockRejectedValue(handledNotFound);

        const args = Object.fromEntries(
          fields.map((key) => [key, key === field ? "latest" : "i1"]),
        );
        await dispatchToolCall(tool, args);

        const seen = [
          ...mockedIntervalsActivity.mock.calls.map((call) => String(call[1])),
          ...get.mock.calls.map((call) => String(call[0])),
        ];
        expect(
          seen.some((value) => value.includes("i999")),
          `${tool}.${field} reached intervals.icu as the resolved id`,
        ).toBe(true);
        expect(
          seen.some((value) => value.includes("latest")),
          `${tool}.${field} never reached intervals.icu as the word`,
        ).toBe(false);
      }
    } finally {
      get.mockRestore();
    }
  });
});
