/**
 * Every model-visible tool, on its largest fixture and its largest inputs,
 * stays under RESPONSE_BUDGET_CHARS (text plus structuredContent JSON).
 * Claude Code refuses a result over 25,000 tokens: a 61 KB
 * get-activity-streams payload (#40) and a 150 KB get-race-prediction one
 * (#41) both shipped before a check like this existed. App-only data feeds
 * (`visibility: ["app"]`) never reach the model and are out of scope here.
 *
 * Calls go through `dispatchToolCall`, the path a host takes. The client is
 * mocked so each read returns as much data as the request could get back:
 * a window full of activities and wellness days, the multi-lap activity, a
 * 4 h all-types stream for get-activity-streams.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syntheticAllTypesStreams } from "../__fixtures__";
import activitiesFixture from "../__fixtures__/intervals/activities.json";
import activitiesSimilarFixture from "../__fixtures__/intervals/activities-similar.json";
import activityMultilapFixture from "../__fixtures__/intervals/activity-multilap.json";
import activityMultilapIntervalsFixture from "../__fixtures__/intervals/activity-multilap-intervals.json";
import activityRepeatsFixture from "../__fixtures__/intervals/activity-repeats.json";
import gearFixture from "../__fixtures__/intervals/gear.json";
import hrCurvesFixture from "../__fixtures__/intervals/hr-curves.json";
import intervalSearchFixture from "../__fixtures__/intervals/interval-search.json";
import paceCurvesFixture from "../__fixtures__/intervals/pace-curves.json";
import paceCurvesSubmaxFixture from "../__fixtures__/intervals/pace-curves-submax.json";
import sportSettingsListFixture from "../__fixtures__/intervals/sport-settings.json";
import sportSettingsRunFixture from "../__fixtures__/intervals/sport-settings-run.json";
import streamsMultilapFixture from "../__fixtures__/intervals/streams-multilap.json";
import wellnessFixture from "../__fixtures__/intervals/wellness.json";
import * as client from "../intervalsClient";
import { addDays, daysBetween } from "../utils/localDate";
import { RESPONSE_BUDGET_CHARS, responseSize } from "./_responseBudget";

vi.mock("../intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../intervalsClient")>();
  return {
    ...actual,
    listActivities: vi.fn(),
    searchActivities: vi.fn(),
    searchActivitiesByIntervals: vi.fn(),
    getActivitiesByIds: vi.fn(),
    getActivity: vi.fn(),
    getActivityIntervals: vi.fn(),
    getActivityStreams: vi.fn(),
    getActivityFile: vi.fn(),
    updateActivity: vi.fn(),
    listGear: vi.fn(),
    updateGear: vi.fn(),
    createGearReminder: vi.fn(),
    resetGearReminder: vi.fn(),
    getWellness: vi.fn(),
    getWellnessDay: vi.fn(),
    updateWellness: vi.fn(),
    getSportSettings: vi.fn(),
    listSportSettings: vi.fn(),
    getAthleteHrCurves: vi.fn(),
    getAthletePaceCurves: vi.fn(),
  };
});

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return {
    ...actual,
    getIntervalsApiKey: vi.fn(() => "test-token"),
    getTimeZone: vi.fn(() => "UTC"),
  };
});

const { dispatchToolCall, TOOL_DEFS } = await import("../server");

const ID = "i189757183";
const ID_2 = "i189807578";
const LONG_RUN = syntheticAllTypesStreams(4 * 3600);

/** Each date from `oldest` to `newest`, inclusive. */
function datesIn(oldest: string, newest: string): string[] {
  const span = daysBetween(oldest.slice(0, 10), newest.slice(0, 10));
  return Array.from({ length: span + 1 }, (_, i) =>
    addDays(oldest.slice(0, 10), i),
  );
}

/** One fixture activity per day of the window, ids unique, newest first. */
function activitiesIn(range: client.DateRange): client.IntervalsActivity[] {
  const base = activitiesFixture as unknown as client.IntervalsActivity[];
  return datesIn(range.oldest, range.newest)
    .reverse()
    .map((date, i) => ({
      ...base[i % base.length]!,
      id: `i${300_000_000 + i}`,
      start_date_local: `${date}T07:00:00`,
    }));
}

/** One fixture wellness row per day of the window. */
function wellnessIn(range: client.DateRange): client.IntervalsWellness[] {
  const base = wellnessFixture as unknown as client.IntervalsWellness[];
  return datesIn(range.oldest, range.newest).map((date, i) => ({
    ...base[i % base.length]!,
    id: date,
  }));
}

const multilapActivity = {
  ...activityMultilapFixture,
  // The 10 minute streams cannot lose a warm-up and a cool-down.
  icu_cooldown_time: 0,
  icu_intervals: activityMultilapIntervalsFixture.icu_intervals,
  icu_groups: activityMultilapIntervalsFixture.icu_groups,
} as unknown as client.IntervalsActivity;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.listActivities).mockImplementation(async (_key, range) =>
    activitiesIn(range),
  );
  vi.mocked(client.searchActivities).mockImplementation(async () =>
    activitiesIn({ oldest: "2024-10-05", newest: "2026-10-05" }).slice(0, 200),
  );
  vi.mocked(client.searchActivitiesByIntervals).mockResolvedValue([]);
  vi.mocked(client.getActivitiesByIds).mockResolvedValue([]);
  vi.mocked(client.getActivity).mockImplementation(async (_key, id) => ({
    ...multilapActivity,
    id,
  }));
  vi.mocked(client.getActivityIntervals).mockResolvedValue(
    activityMultilapIntervalsFixture as unknown as client.IntervalsIntervals,
  );
  vi.mocked(client.getActivityStreams).mockResolvedValue(
    streamsMultilapFixture as unknown as client.IntervalsStream[],
  );
  // A FIT file with no weather; the weather is a few fields either way.
  vi.mocked(client.getActivityFile).mockResolvedValue(new Uint8Array());
  vi.mocked(client.updateActivity).mockImplementation(async (_key, id) => ({
    ...multilapActivity,
    id,
  }));
  vi.mocked(client.listGear).mockResolvedValue(
    gearFixture as unknown as Awaited<ReturnType<typeof client.listGear>>,
  );
  vi.mocked(client.getWellness).mockImplementation(async (_key, range) =>
    wellnessIn(range),
  );
  // A long comments text on the day, so update-wellness echoes its largest
  // reply (a replace quotes the comments it removed).
  vi.mocked(client.getWellnessDay).mockImplementation(async (_key, date) => ({
    ...(wellnessFixture[0] as unknown as client.IntervalsWellness),
    id: date,
    comments: "x".repeat(2000),
  }));
  vi.mocked(client.updateWellness).mockImplementation(async (_key, date) => ({
    id: date,
  }));
  vi.mocked(client.updateGear).mockResolvedValue(
    gearFixture[0] as unknown as client.IntervalsGear,
  );
  vi.mocked(client.getSportSettings).mockResolvedValue(
    sportSettingsRunFixture as unknown as client.IntervalsSportSettings,
  );
  vi.mocked(client.listSportSettings).mockResolvedValue(
    sportSettingsListFixture as unknown as client.IntervalsSportSettings[],
  );
  vi.mocked(client.getAthleteHrCurves).mockResolvedValue(
    hrCurvesFixture as unknown as client.IntervalsAthleteHrCurves,
  );
  vi.mocked(client.getAthletePaceCurves).mockResolvedValue(
    paceCurvesFixture as unknown as client.IntervalsAthletePaceCurves,
  );
});

interface ToolResult {
  structuredContent?: unknown;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface SizeCase {
  label: string;
  args: Record<string, unknown>;
  /** Swap a mock before the call, for a case needing different data. */
  setup?: () => void;
  /** Extra assertions on the result, to prove the case reached its largest path. */
  check?: (result: ToolResult) => void | Promise<void>;
}

const ALL_STREAM_TYPES = [
  "time",
  "distance",
  "heartrate",
  "cadence",
  "velocity_smooth",
  "altitude",
  "latlng",
  "watts",
  "stance_time",
  "vertical_oscillation",
  "vertical_ratio",
  "step_length",
];

/** The multi-lap run's 18 laps repeated 9 times: 162 laps, a 100+ km ultra's worth. */
const ultraLaps = () =>
  vi.mocked(client.getActivity).mockImplementation(async (_key, id) => ({
    ...multilapActivity,
    id,
    icu_intervals: Array.from(
      { length: 9 },
      () => multilapActivity.icu_intervals ?? [],
    ).flat(),
  }));

/**
 * The fromLap the text names for `tool`, and the rows (`key`) that call
 * returns, so a check can prove the pointer really returns the rest.
 */
async function followPointer(
  result: ToolResult,
  tool: string,
  key: "laps" | "intervals",
): Promise<{ fromLap: number; rows: { lap_index: number }[] }> {
  const text = result.content[0]?.text ?? "";
  const fromLap = Number(
    new RegExp(`${tool} with fromLap (\\d+)`).exec(text)?.[1],
  );
  expect(fromLap, text).toBeGreaterThan(1);
  const rest = await dispatchToolCall(tool, { id: ID, fromLap });
  expect(rest.isError).toBeUndefined();
  const rows = (
    rest.structuredContent as Record<string, { lap_index: number }[]>
  )[key];
  return { fromLap, rows: rows ?? [] };
}

/** The response kept fewer laps than the activity has, and names the rest. */
const lapsCut = async (result: ToolResult) => {
  const kept = (result.structuredContent as { laps: unknown[] }).laps.length;
  expect(kept).toBeLessThan(162);
  expect(result.content[0]?.text).toContain(
    `first ${kept} of 162 laps, to stay under the response size limit.`,
  );
  const { fromLap, rows } = await followPointer(
    result,
    "get-activity-laps",
    "laps",
  );
  expect(rows[0]?.lap_index).toBe(fromLap);
};

/** get-activity kept fewer intervals than the activity has, and says so. */
const activityIntervalsCut = async (result: ToolResult) => {
  const { intervals, interval_count } = result.structuredContent as {
    intervals: unknown[];
    interval_count: number;
  };
  expect(interval_count).toBe(162);
  expect(intervals.length).toBeLessThan(162);
  expect(result.content[0]?.text).toContain(
    `structuredContent.intervals keeps the first ${intervals.length} of 162`,
  );
  // The text lists 20; the laps after them start at lap 21.
  const { rows } = await followPointer(result, "get-activity-laps", "laps");
  expect(rows[0]?.lap_index).toBe(21);
};

/** get-running-dynamics kept fewer WORK rows than it has, and names the rest. */
const dynamicsCut = async (result: ToolResult) => {
  const { intervals, interval_count } = result.structuredContent as {
    intervals: { lap_index: number }[];
    interval_count: number;
  };
  expect(intervals.length).toBeLessThan(interval_count);
  const lastShown = intervals.at(-1)?.lap_index ?? 0;
  const { fromLap, rows } = await followPointer(
    result,
    "get-running-dynamics",
    "intervals",
  );
  expect(fromLap).toBe(lastShown + 1);
  // The next WORK row, which may sit after a recovery lap.
  expect(rows[0]?.lap_index).toBeGreaterThan(lastShown);
};

/** Every wellness day carries a 600-character comment and every score. */
const commentEveryDay = () =>
  vi.mocked(client.getWellness).mockImplementation(async (_key, range) =>
    wellnessIn(range).map((w) => ({
      ...w,
      readiness: 7,
      soreness: 3,
      fatigue: 3,
      stress: 2,
      mood: 2,
      motivation: 2,
      injury: 3,
      sleepQuality: 2,
      comments: "Left calf tight after the long run. ".repeat(17).slice(0, 600),
    })),
  );

/** The response kept the newest days, and names the range holding the rest. */
const wellnessCut = (result: ToolResult) => {
  const { days, count } = result.structuredContent as {
    days: { date: string }[];
    count: number;
  };
  expect(count).toBe(90);
  expect(days.length).toBeLessThan(90);
  expect(days[0]?.date).toBe("2026-09-28");
  const restNewest = addDays(days.at(-1)?.date ?? "", -1);
  expect(result.content[0]?.text).toContain(
    `newest ${days.length} of 90 days, to stay under the response size limit. For the rest, call get-wellness with oldest 2026-07-01 and newest ${restNewest}.`,
  );
};

const longRunStreams = () =>
  vi.mocked(client.getActivityStreams).mockResolvedValue(LONG_RUN);

/** A 5 x 1 km session whose search finds 5 earlier sessions with the same reps. */
const similarSessions = () => {
  vi.mocked(client.getActivity).mockImplementation(async (_key, id) => ({
    ...(activityRepeatsFixture as unknown as client.IntervalsActivity),
    id,
  }));
  vi.mocked(client.searchActivitiesByIntervals).mockResolvedValue(
    intervalSearchFixture as unknown as client.IntervalsActivity[],
  );
  vi.mocked(client.getActivitiesByIds).mockResolvedValue(
    activitiesSimilarFixture as unknown as client.IntervalsActivity[],
  );
};

/**
 * Every activity type intervals.icu has: the 60-value type enum in
 * docs/intervals-openapi.json, in its order. Real names, not long synthetic
 * ones: no account can send 60 names of the longest length.
 */
const INTERVALS_ACTIVITY_TYPES: string[] = (() => {
  const spec = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../../docs/intervals-openapi.json"),
      "utf8",
    ),
  );
  const found: string[][] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      const { enum: values } = node as { enum?: unknown };
      if (Array.isArray(values) && values.includes("WeightTraining"))
        found.push(values as string[]);
      Object.values(node).forEach(walk);
    }
  };
  walk(spec);
  return found[0] ?? [];
})();

/**
 * One activity of every type, plus one with no type, on the last day of
 * the range, on top of the default one-a-day list: every get-athlete-stats
 * period then lists every type.
 */
const everyActivityType = () =>
  vi.mocked(client.listActivities).mockImplementation(async (_key, range) => {
    const base = activitiesFixture as unknown as client.IntervalsActivity[];
    const types: (string | null)[] = [...INTERVALS_ACTIVITY_TYPES, null];
    return [
      ...types.map((type, i) => ({
        ...base[0]!,
        id: `i${400_000_000 + i}`,
        type,
        start_date_local: `${range.newest}T06:00:00`,
      })),
      ...activitiesIn(range),
    ];
  });

/**
 * Largest inputs per tool. A tool missing from this table fails the
 * coverage check below, so a new tool cannot skip the budget.
 */
const CASES: Record<string, SizeCase[]> = {
  "get-athlete-stats": [
    { label: "default", args: {} },
    { label: "every activity type", args: {}, setup: everyActivityType },
  ],
  "update-activity": [
    {
      label: "every field",
      args: {
        id: ID,
        name: "Renamed",
        description: "Notes",
        descriptionMode: "append",
        rpe: 7,
        feel: 2,
      },
    },
  ],
  "get-activity-zones": [{ label: "multi-lap", args: { id: ID } }],
  "get-activity-laps": [
    { label: "multi-lap", args: { id: ID } },
    { label: "162 laps", args: { id: ID }, setup: ultraLaps, check: lapsCut },
    {
      label: "162 laps from lap 81",
      args: { id: ID, fromLap: 81 },
      setup: ultraLaps,
      check: (result) =>
        expect(
          (result.structuredContent as { laps: { lap_index: number }[] })
            .laps[0]?.lap_index,
        ).toBe(81),
    },
  ],
  "get-running-summary": [
    { label: "multi-lap", args: { id: ID } },
    { label: "162 laps", args: { id: ID }, setup: ultraLaps, check: lapsCut },
  ],
  "get-running-dynamics": [
    { label: "multi-lap", args: { id: ID } },
    {
      label: "162 laps",
      args: { id: ID },
      setup: ultraLaps,
      check: dynamicsCut,
    },
  ],
  "get-aerobic-analysis": [
    { label: "with breakdown", args: { id: ID, includeBreakdown: true } },
  ],
  "get-hill-analysis": [
    { label: "4 h rolling run", args: { id: ID }, setup: longRunStreams },
  ],
  "get-split-analysis": [
    { label: "4 h run", args: { id: ID }, setup: longRunStreams },
  ],
  "get-interval-analysis": [
    { label: "multi-lap", args: { id: ID } },
    {
      label: "repeats, findSimilar",
      args: { id: "i189757858", findSimilar: true },
      setup: similarSessions,
      check: (result) => {
        const similar = (
          result.structuredContent as { similar?: { sessions: unknown[] } }
        ).similar;
        expect(similar?.sessions).toHaveLength(5);
      },
    },
  ],
  "get-training-load": [{ label: "365 days", args: { days: 365 } }],
  "get-fitness-trend": [
    {
      label: "365 days, 60-day projection",
      args: { days: 365, projectDays: 60 },
    },
  ],
  "compare-activities": [
    { label: "two activities", args: { activityId1: ID, activityId2: ID_2 } },
    {
      // The per-km table grows with distance: two 4 h runs pair about 46 km.
      label: "two 4 h runs",
      args: { activityId1: ID, activityId2: ID_2 },
      setup: longRunStreams,
      check: (result) =>
        expect(
          (
            result.structuredContent as {
              km_comparison: { rows: unknown[] } | null;
            }
          ).km_comparison?.rows.length,
        ).toBeGreaterThan(40),
    },
  ],
  "get-best-efforts": [
    {
      label: "every distance, top 5, all time",
      args: { window: "all", topN: 5 },
      // Four ranks below the best at every distance the window reaches.
      setup: () =>
        vi.mocked(client.getAthletePaceCurves).mockResolvedValue({
          ...paceCurvesSubmaxFixture,
          list: paceCurvesSubmaxFixture.list.map((c) => ({ ...c, id: "all" })),
        } as unknown as client.IntervalsAthletePaceCurves),
    },
    {
      label: "4 h run, every distance, top 5",
      args: { id: ID, topN: 5 },
      setup: longRunStreams,
    },
  ],
  "get-race-prediction": [
    { label: "marathon", args: { raceDistance: "marathon" } },
  ],
  "list-activities": [
    {
      label: "366 days, limit 200",
      args: { oldest: "2025-09-28", newest: "2026-09-28", limit: 200 },
    },
    { label: "search, limit 200", args: { search: "run", limit: 200 } },
  ],
  "get-activity": [
    { label: "multi-lap", args: { id: ID } },
    {
      label: "162 laps",
      args: { id: ID },
      setup: ultraLaps,
      check: activityIntervalsCut,
    },
  ],
  "get-activity-streams": [
    {
      label: "4 h run, every type, maxPoints 2000",
      args: { id: ID, types: ALL_STREAM_TYPES, maxPoints: 2000 },
      setup: longRunStreams,
    },
  ],
  "list-gear": [{ label: "with retired", args: { includeRetired: true } }],
  "update-wellness": [
    {
      label: "every field, comments replaced",
      args: {
        date: "2026-09-10",
        soreness: 3,
        fatigue: 3,
        stress: 2,
        mood: 2,
        motivation: 2,
        injury: 2,
        sleepQuality: 3,
        comments: "y".repeat(2000),
        commentsMode: "replace",
      },
    },
  ],
  "update-gear": [
    { label: "retire", args: { gearId: "71459", retired: true } },
  ],
  "get-wellness": [
    {
      label: "90-day range",
      args: { oldest: "2026-07-01", newest: "2026-09-28" },
    },
    {
      label: "90-day range, 600-char comment every day",
      args: { oldest: "2026-07-01", newest: "2026-09-28" },
      setup: commentEveryDay,
      check: wellnessCut,
    },
  ],
  "view-activity-chart": [{ label: "default", args: { id: ID } }],
  "view-cadence-trends": [{ label: "728 days", args: { days: 728 } }],
  "view-route-map": [{ label: "default", args: { id: ID } }],
  "view-training-load": [{ label: "365 days", args: { days: 365 } }],
  "view-fitness-trend": [{ label: "365 days", args: { days: 365 } }],
  "view-activity-zones": [{ label: "default", args: { id: ID } }],
  "view-compare-activities": [
    { label: "default", args: { activityId1: ID, activityId2: ID_2 } },
    {
      label: "two 4 h runs",
      args: { activityId1: ID, activityId2: ID_2 },
      setup: longRunStreams,
    },
  ],
  "get-athlete-zones": [{ label: "Run with HR curves", args: {} }],
};

const modelVisibleTools = TOOL_DEFS.filter(
  (def) =>
    !(
      def._meta?.ui as { visibility?: string[] } | undefined
    )?.visibility?.every((v) => v === "app"),
).map((def) => def.name);

describe("response size budget", () => {
  it("reads the activity type list from the spec", () => {
    expect(INTERVALS_ACTIVITY_TYPES.length).toBeGreaterThan(50);
  });

  it("has a case for every model-visible tool", () => {
    expect(Object.keys(CASES).sort()).toEqual([...modelVisibleTools].sort());
  });

  const rows = Object.entries(CASES).flatMap(([name, cases]) =>
    cases.map((c) => ({ name, ...c })),
  );

  it.each(rows)(
    "$name ($label) stays under the budget",
    async ({ name, args, setup, check }) => {
      setup?.();
      const result = await dispatchToolCall(name, args);
      const text = result.content
        .map((part) => ("text" in part ? part.text : ""))
        .join("");
      // A size check on an error message proves nothing.
      expect(result.isError, text).toBeUndefined();
      await check?.(result);
      expect(responseSize(text, result.structuredContent)).toBeLessThanOrEqual(
        RESPONSE_BUDGET_CHARS,
      );
    },
  );
});
