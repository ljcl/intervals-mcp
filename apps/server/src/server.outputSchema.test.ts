/**
 * Every result a tool returns against the outputSchema it publishes, over
 * the wire, validated the way a host validates it.
 *
 * The other suites parse `structuredContent` with the zod schema, which
 * strips a field it does not know; a host runs the published JSON Schema
 * through a JSON Schema validator, which does not. So this suite lists the
 * tools as a host sees them, calls each one with recorded intervals.icu
 * responses (`__fixtures__/intervals`, real activities), and runs every
 * result through the SDK's own Ajv validator. A tool with an outputSchema
 * and no call here fails, so a new tool cannot skip it.
 *
 * outputSchemaCompat.test.ts covers the other half: a result that still
 * matches the schema a host cached before a deploy.
 */
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFitFile,
  FIT_TYPES,
  fitFieldDescription,
} from "./__fixtures__/fitFile";
import activities from "./__fixtures__/intervals/activities.json";
import activitiesSimilar from "./__fixtures__/intervals/activities-similar.json";
import activity from "./__fixtures__/intervals/activity.json";
import activityHilly from "./__fixtures__/intervals/activity-hilly.json";
import activityIntervals from "./__fixtures__/intervals/activity-intervals.json";
import activityMultilap from "./__fixtures__/intervals/activity-multilap.json";
import multilapIntervals from "./__fixtures__/intervals/activity-multilap-intervals.json";
import activitySwim from "./__fixtures__/intervals/activity-swim.json";
import swimIntervals from "./__fixtures__/intervals/activity-swim-intervals.json";
import gear from "./__fixtures__/intervals/gear.json";
import hrCurves from "./__fixtures__/intervals/hr-curves.json";
import intervalSearch from "./__fixtures__/intervals/interval-search.json";
import paceCurves from "./__fixtures__/intervals/pace-curves.json";
import sportSettings from "./__fixtures__/intervals/sport-settings.json";
import sportSettingsRun from "./__fixtures__/intervals/sport-settings-run.json";
import streams from "./__fixtures__/intervals/streams.json";
import streamsHilly from "./__fixtures__/intervals/streams-hilly.json";
import streamsMultilap from "./__fixtures__/intervals/streams-multilap.json";
import wellness from "./__fixtures__/intervals/wellness.json";

/** Each recorded activity with its intervals and streams, by id. */
const RECORDED: Record<
  string,
  { activity: object; intervals?: object; streams?: unknown[] }
> = {
  [activity.id]: { activity, intervals: activityIntervals, streams },
  [activityHilly.id]: { activity: activityHilly, streams: streamsHilly },
  [activityMultilap.id]: {
    activity: activityMultilap,
    intervals: multilapIntervals,
    streams: streamsMultilap,
  },
  [activitySwim.id]: { activity: activitySwim, intervals: swimIntervals },
};

/** HealthFit's weather, as its FIT export writes it: 18 °C, 87% humidity. */
const HEALTHFIT_FILE = buildFitFile([
  fitFieldDescription(0, 3, "SESSION WEATHER HUMIDITY", FIT_TYPES.uint16),
  {
    global: 18,
    fields: [
      { num: 57, type: FIT_TYPES.sint8, value: 18 },
      { num: 5, type: FIT_TYPES.uint8, value: 1 },
    ],
    devFields: [{ num: 3, devIndex: 0, type: FIT_TYPES.uint16, value: 8700 }],
  },
]);

const recorded = (id: string) => {
  const entry = RECORDED[id];
  if (!entry) throw new Error(`no recorded activity ${id}`);
  return entry;
};

vi.mock("./intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./intervalsClient")>();
  return {
    ...actual,
    getActivity: vi.fn(
      async (_key: string, id: string, options?: { intervals?: boolean }) => {
        const entry = recorded(id);
        return structuredClone(
          options?.intervals
            ? { ...entry.activity, ...entry.intervals }
            : entry.activity,
        );
      },
    ),
    getActivityIntervals: vi.fn(async (_key: string, id: string) =>
      structuredClone(recorded(id).intervals ?? { id, icu_intervals: [] }),
    ),
    getActivityStreams: vi.fn(async (_key: string, id: string) =>
      structuredClone(recorded(id).streams ?? []),
    ),
    getActivityFile: vi.fn(async (_key: string, id: string) =>
      id === activity.id ? HEALTHFIT_FILE : new Uint8Array(),
    ),
    updateActivity: vi.fn(
      async (_key: string, id: string, patch: Record<string, unknown>) => ({
        ...structuredClone(recorded(id).activity),
        ...patch,
      }),
    ),
    listActivities: vi.fn(async () => structuredClone(activities)),
    searchActivities: vi.fn(async () => structuredClone(activities)),
    searchActivitiesByIntervals: vi.fn(async () =>
      structuredClone(intervalSearch),
    ),
    getActivitiesByIds: vi.fn(async () => structuredClone(activitiesSimilar)),
    listGear: vi.fn(async () => structuredClone(gear)),
    getWellness: vi.fn(async () => structuredClone(wellness)),
    getSportSettings: vi.fn(async () => structuredClone(sportSettingsRun)),
    listSportSettings: vi.fn(async () => structuredClone(sportSettings)),
    getAthleteHrCurves: vi.fn(async () => structuredClone(hrCurves)),
    getAthletePaceCurves: vi.fn(async () => structuredClone(paceCurves)),
  };
});

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, getIntervalsApiKey: vi.fn(() => "test-token") };
});

const { connectTestClient } = await import("./mcpTestClient");

/** One or more calls per tool: the recorded run first, then other shapes. */
const CALLS: Array<[tool: string, args: Record<string, unknown>]> = [
  ["get-athlete-stats", {}],
  ["update-activity", { id: activity.id, name: "Renamed run" }],
  ["get-activity-zones", { id: activity.id }],
  ["get-activity-laps", { id: activityMultilap.id }],
  ["get-activity-laps", { id: activitySwim.id }],
  ["get-running-summary", { id: activity.id }],
  ["get-running-summary", { id: activityHilly.id }],
  ["get-running-summary", { id: activityMultilap.id }],
  ["get-running-dynamics", { id: activity.id, includeIntervals: true }],
  ["get-aerobic-analysis", { id: activity.id, includeBreakdown: true }],
  ["get-hill-analysis", { id: activityHilly.id }],
  ["get-split-analysis", { id: activity.id }],
  ["get-interval-analysis", { id: activityMultilap.id, findSimilar: true }],
  ["get-training-load", {}],
  ["get-fitness-trend", { projectDays: 14 }],
  [
    "compare-activities",
    { activityId1: activityHilly.id, activityId2: activity.id },
  ],
  [
    "compare-activities",
    { activityId1: activity.id, activityId2: activitySwim.id },
  ],
  ["get-best-efforts", {}],
  ["get-best-efforts", { id: activity.id }],
  ["get-race-prediction", { raceDistance: "10k" }],
  ["list-activities", {}],
  ["get-activity", { id: activity.id, includeIntervals: true }],
  ["get-activity", { id: activitySwim.id, includeIntervals: true }],
  ["get-activity-streams", { id: activity.id }],
  ["list-gear", {}],
  ["get-wellness", {}],
  ["get-athlete-zones", {}],
];

const validators = new AjvJsonSchemaValidator();

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("structuredContent against the published outputSchema", async () => {
  const client = await connectTestClient("output-schema-test");
  const { result } = await client.send("tools/list");
  const tools = result?.tools as Array<{
    name: string;
    outputSchema?: Record<string, unknown>;
  }>;
  const published = new Map(
    tools.flatMap((tool) =>
      tool.outputSchema ? [[tool.name, tool.outputSchema] as const] : [],
    ),
  );

  it("calls every tool that publishes an outputSchema", () => {
    const called = new Set(CALLS.map(([tool]) => tool));
    expect([...published.keys()].filter((name) => !called.has(name))).toEqual(
      [],
    );
  });

  it.each(CALLS)("%s %j", async (tool, args) => {
    const schema = published.get(tool);
    expect(schema, `${tool} publishes no outputSchema`).toBeDefined();

    const response = await client.send("tools/call", {
      name: tool,
      arguments: args,
    });

    expect(response.error).toBeUndefined();
    const call = response.result as {
      isError?: boolean;
      content: Array<{ text?: string }>;
      structuredContent?: unknown;
    };
    expect(call.isError, call.content[0]?.text).toBeUndefined();
    const verdict = validators.getValidator(schema!)(call.structuredContent);
    expect(verdict.errorMessage).toBeUndefined();
  });
});
