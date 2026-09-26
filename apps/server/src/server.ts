import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { dominantBucket } from "@intervals-mcp/data";
import {
  type CallToolResult,
  type ListResourcesResult,
  type ListToolsResult,
  LOG_LEVEL_META_KEY,
  type ReadResourceResult,
  ResourceNotFoundError,
  Server,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  type ActivityChartData,
  buildActivityChartData,
} from "./activityChartData";
import {
  type ActivityZonesData,
  hrZoneMismatchWarning,
  mapIntervalsZones,
} from "./activityZones";
import {
  buildCadenceTrendData,
  type CadenceTrendData,
} from "./cadenceTrendData";
import { getIntervalsApiKey, getTimeZone } from "./config";
import {
  type FitnessTrendAppData,
  mapFitnessTrendApp,
} from "./fitnessTrendApp";
import { activityDisplayName } from "./formatters";
import {
  getActivity as getIntervalsActivity,
  listActivities as listActivitiesFn,
} from "./intervalsClient";
import {
  IntervalsStreamsUnavailableError,
  type IntervalsStreamType,
  loadIntervalsStreams,
} from "./intervalsStreams";
import { loadFitnessTrend } from "./loadFitnessTrend";
import { type WaypointInput } from "./mapAnchors";
import {
  createProgressReporter,
  NO_PROGRESS,
  type ReportProgress,
} from "./progress";
import { getPrompt, listPrompts } from "./prompts";
import { buildRouteMapData, type RouteMapData } from "./routeMapData";
import {
  recordToolCall,
  type ToolCallRecord,
  type ToolOutcome,
} from "./telemetry";
import { READ_ONLY } from "./tools/_annotations";
import { toolErrorText } from "./tools/_errors";
import { idJsonSchemaOverride, intervalsActivityIdInput } from "./tools/_ids";
import {
  buildComparison,
  compareActivitiesTool,
} from "./tools/compareActivities";
import { getActivityTool } from "./tools/getActivity";
import { getActivityLapsTool } from "./tools/getActivityLaps";
import { getActivityStreamsTool } from "./tools/getActivityStreams";
import { getActivityZonesTool } from "./tools/getActivityZones";
import { getAerobicAnalysisTool } from "./tools/getAerobicAnalysis";
import { getAthleteStatsTool } from "./tools/getAthleteStats";
import { getBestEffortsTool } from "./tools/getBestEfforts";
import { getFitnessTrendTool } from "./tools/getFitnessTrend";
import { getHillAnalysisTool } from "./tools/getHillAnalysis";
import { getIntervalAnalysisTool } from "./tools/getIntervalAnalysis";
import { getRacePredictionTool } from "./tools/getRacePrediction";
import { getRunningDynamicsTool } from "./tools/getRunningDynamics";
import { getRunningSummaryTool } from "./tools/getRunningSummary";
import { getSplitAnalysisTool } from "./tools/getSplitAnalysis";
import { getTrainingLoadTool } from "./tools/getTrainingLoad";
import { getWellnessTool } from "./tools/getWellness";
import { listActivitiesTool } from "./tools/listActivities";
import { listGearTool } from "./tools/listGear";
import { updateActivityTool } from "./tools/updateActivity";
import {
  buildTrainingLoadData,
  type TrainingLoadAppData,
} from "./trainingLoad";
import { loadTrainingLoadInputs } from "./trainingLoadInputs";
import { addDays, dateInputSchema, todayLocal } from "./utils/localDate";
import { SERVER_VERSION } from "./version";

const EMPTY_SCHEMA = { type: "object", properties: {}, required: [] } as const;

/**
 * Build the advertised JSON Schema for a tool's *input*. Uses zod's `io:
 * "input"` projection so schemas that coerce their input (e.g.
 * `intervalsActivityIdInput`, which accepts a digit string or a
 * safe-integer number and normalises to a string) advertise the accepted
 * input shape rather than throwing on the output-side transform. Output
 * schemas keep the default (output) projection.
 *
 * `idJsonSchemaOverride` then narrows every such id to its string form
 * (`^i?\d+$` for intervals.icu activities) so a host cannot generate the
 * lossy number branch for an id above 2^53.
 */
function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io: "input",
    override: idJsonSchemaOverride,
  });
}

/**
 * Zod schemas for the MCP App tools. Single source of truth: the
 * advertised JSON Schemas in buildToolDefs derive from these, and dispatch
 * validates every call against them, so a host omitting or mistyping an
 * argument gets a structured error instead of `"undefined"`/NaN flowing
 * into intervals.icu request paths.
 */
const weeksInput = z
  .number()
  .int()
  .positive()
  .max(104)
  .default(6)
  .describe("Number of weeks of history to show (default: 6, max: 104)");

const daysInput = z
  .number()
  .int()
  .positive()
  .max(365)
  .default(84)
  .describe(
    "Number of days of history to analyze (default: 84, i.e. 12 weeks; max: 365)",
  );

const waypointsInput = z
  .array(
    z.object({
      km: z
        .number()
        .nonnegative()
        .describe(
          "Distance from the start of the track, in kilometres, where this waypoint sits.",
        ),
      label: z
        .string()
        .min(1)
        .max(120)
        .describe(
          'Short marker label shown on hover/tap, e.g. "Gel 1 (caffeinated)" or "Oxford St climb +55m".',
        ),
      kind: z
        .enum(["fuel", "climb", "water", "custom"])
        .default("custom")
        .describe(
          "Marker style: fuel (nutrition), climb (grade warning), water (drink/aid station), or custom (anything else, the default).",
        ),
    }),
  )
  .max(50)
  .optional()
  .describe(
    "Optional distance-anchored waypoints to pin along the track, e.g. fueling points or climb warnings from a race plan. " +
      "Rendered as a toggleable marker layer on the map and elevation profile. Waypoints beyond the end of the track are dropped with a warning.",
  );

/**
 * Fitness-trend args, shared by the view and data tools. Mirrors the
 * `get-fitness-trend` text tool's inputs, since both surfaces run one solve:
 * a lookback window, how far to project, and an optional taper target. The
 * projection defaults to a fortnight here rather than the text tool's zero —
 * the dashed continuation is half of what the chart is for.
 */
const fitnessTrendInput = z.object({
  days: z
    .number()
    .int()
    .positive()
    .max(365)
    .default(90)
    .describe(
      "Days to look back (default 90, a useful CTL/ATL/TSB trend window; max 365). " +
        "Whole-body CTL/ATL is read straight from intervals.icu wellness, not " +
        "recomputed locally, so this window does not need extra runway.",
    ),
  runOnly: z
    .boolean()
    .default(false)
    .describe(
      "Compute CTL/ATL/TSB from Run/TrailRun/VirtualRun training load only, " +
        "computed locally (intervals.icu has no per-sport CTL/ATL). Default " +
        "false reads whole-body CTL/ATL directly from intervals.icu wellness.",
    ),
  projectDays: z
    .number()
    .int()
    .min(0)
    .max(60)
    .default(14)
    .describe(
      "Days to project past today assuming rest (default 14; ignored when targetDate is set)",
    ),
  targetDate: dateInputSchema
    .optional()
    .describe(
      "Race or peak date (YYYY-MM-DD) to chart a solved taper toward. Omit for a rest projection.",
    ),
  targetTsb: z
    .number()
    .min(-40)
    .max(40)
    .default(10)
    .describe(
      "Form (TSB) to arrive at on targetDate (default +10; +5 to +15 is the usual race window)",
    ),
});

/**
 * Training-load args, shared by the view and data tools. Volume/warnings are
 * always run-based; `runOnly` scopes load and current CTL/ATL/TSB the same
 * way `get-training-load`'s input does.
 */
const trainingLoadInput = z.object({
  days: daysInput,
  runOnly: z
    .boolean()
    .default(false)
    .describe(
      "Sum load and compute CTL/ATL/TSB from Run/TrailRun/VirtualRun training " +
        "load only, instead of whole-body. Weekly volume/warnings are always run-based.",
    ),
});

const APP_TOOL_INPUT_SCHEMAS: Record<string, z.ZodType> = {
  "view-activity-chart": z.object({
    activity_id: intervalsActivityIdInput(
      "The intervals.icu activity id to visualize.",
    ),
  }),
  "get-activity-streams-raw": z.object({
    activity_id: intervalsActivityIdInput("The intervals.icu activity id."),
  }),
  "view-cadence-trends": z.object({ weeks: weeksInput }),
  "get-cadence-trend-data": z.object({ weeks: weeksInput }),
  "view-route-map": z.object({
    activity_id: intervalsActivityIdInput(
      "The intervals.icu activity id to map.",
    ),
    waypoints: waypointsInput,
  }),
  "get-route-map-data": z.object({
    activity_id: intervalsActivityIdInput("The intervals.icu activity id."),
    waypoints: waypointsInput,
  }),
  "view-training-load": trainingLoadInput,
  "get-training-load-data": trainingLoadInput,
  "view-fitness-trend": fitnessTrendInput,
  "get-fitness-trend-data": fitnessTrendInput,
  "view-activity-zones": z.object({
    activity_id: intervalsActivityIdInput("The intervals.icu activity id."),
  }),
  "get-activity-zones-data": z.object({
    activity_id: intervalsActivityIdInput("The intervals.icu activity id."),
  }),
  "view-compare-activities": z.object({
    activity_id_1: intervalsActivityIdInput(
      "First activity ID (baseline/older activity).",
    ),
    activity_id_2: intervalsActivityIdInput(
      "Second activity ID (comparison/newer activity).",
    ),
  }),
  "get-compare-activities-data": z.object({
    activity_id_1: intervalsActivityIdInput("First activity ID (baseline)."),
    activity_id_2: intervalsActivityIdInput("Second activity ID (comparison)."),
  }),
};

/**
 * Allowlist the OpenFreeMap tile origin so the route-map app can fetch
 * basemap tiles through the host's sandbox CSP. Tiles, styles, glyphs, and
 * sprites are all served from this one origin.
 * MapLibre loads everything via fetch (connect-src); the origin is mirrored
 * into resourceDomains in case a host routes images through img-src instead.
 * Declared once on the APP_RESOURCES entry; `appResourceMeta` emits it on
 * BOTH the resource descriptor and the ReadResource content — hosts may read
 * either.
 */
const ROUTE_MAP_CSP = {
  connectDomains: ["https://tiles.openfreemap.org"],
  resourceDomains: ["https://tiles.openfreemap.org"],
} as const;

const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

interface AppResource {
  uri: string;
  /** Human-readable resource name shown by hosts. */
  name: string;
  /** Bundled single-file HTML, resolved at startup. */
  htmlPath: string;
  /** Extra `_meta.ui` fields beyond the shared prefersBorder (e.g. csp). */
  ui?: Record<string, unknown>;
}

const appHtmlRequire = createRequire(import.meta.url);

/**
 * Every MCP App resource this server serves. ListResources and ReadResource
 * are derived from this table, so adding an app means one entry here (plus
 * the Dockerfile runner-stage COPY line). HTML paths resolve once at startup
 * via each package's `./app.html` export — works in dev (workspace symlink)
 * and in the Docker runner (pruned workspace tree with built dist/ copied in).
 */
const APP_RESOURCES: AppResource[] = [
  {
    uri: "ui://activity-chart/app.html",
    name: "Activity Chart",
    htmlPath: appHtmlRequire.resolve("@intervals-mcp/activity-chart/app.html"),
  },
  {
    uri: "ui://cadence-trends/app.html",
    name: "Cadence Trends",
    htmlPath: appHtmlRequire.resolve("@intervals-mcp/cadence-trends/app.html"),
  },
  {
    uri: "ui://route-map/app.html",
    name: "Route Map",
    htmlPath: appHtmlRequire.resolve("@intervals-mcp/route-map/app.html"),
    ui: { csp: ROUTE_MAP_CSP },
  },
  {
    uri: "ui://training-load/app.html",
    name: "Training Load",
    htmlPath: appHtmlRequire.resolve("@intervals-mcp/training-load/app.html"),
  },
  {
    uri: "ui://compare-activities/app.html",
    name: "Compare Activities",
    htmlPath: appHtmlRequire.resolve(
      "@intervals-mcp/compare-activities/app.html",
    ),
  },
  {
    uri: "ui://activity-zones/app.html",
    name: "Activity Zones",
    htmlPath: appHtmlRequire.resolve("@intervals-mcp/activity-zones/app.html"),
  },
  {
    uri: "ui://fitness-trend/app.html",
    name: "Fitness Trend",
    htmlPath: appHtmlRequire.resolve("@intervals-mcp/fitness-trend/app.html"),
  },
];

/**
 * The `_meta` every app resource carries: the apps own their card chrome
 * (`prefersBorder: false`, see the mobile conventions) plus any per-app
 * extras from the table. One builder for the descriptor and the content
 * response, so the two can never drift.
 */
function appResourceMeta(resource: AppResource): Record<string, unknown> {
  return { ui: { prefersBorder: false, ...resource.ui } };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

/**
 * Every tool implementation, all intervals.icu-backed (via
 * intervalsClient.ts). This file's Phase 4 app data handlers
 * (activity-chart, cadence-trends, route-map) are intervals.icu-backed too;
 * the retired Strava client has been deleted.
 */
const TOOLS = [
  getAthleteStatsTool,
  updateActivityTool,
  getActivityZonesTool,
  getActivityLapsTool,
  getRunningSummaryTool,
  getRunningDynamicsTool,
  getAerobicAnalysisTool,
  getHillAnalysisTool,
  getSplitAnalysisTool,
  getIntervalAnalysisTool,
  getTrainingLoadTool,
  getFitnessTrendTool,
  compareActivitiesTool,
  getBestEffortsTool,
  getRacePredictionTool,
  listActivitiesTool,
  getActivityTool,
  getActivityStreamsTool,
  listGearTool,
  getWellnessTool,
] as const;

/** Converts every tool implementation to the low-level TOOL_DEFS array. */
function buildToolDefs(): ToolDef[] {
  const defs: ToolDef[] = TOOLS.map((tool) => {
    const t = tool as {
      name: string;
      description: string;
      inputSchema?: z.ZodType;
      outputSchema?: z.ZodType;
      annotations?: ToolAnnotations;
    };
    const def: ToolDef = {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ? toInputSchema(t.inputSchema) : EMPTY_SCHEMA,
    };
    if (t.annotations) def.annotations = t.annotations;
    if (t.outputSchema) def.outputSchema = z.toJSONSchema(t.outputSchema);
    return def;
  });

  // Add MCP App tools
  defs.push({
    name: "view-activity-chart",
    description:
      "Open an interactive chart of one activity with selectable heart rate, power, pace, altitude, cadence, and grade overlays. " +
      "Prefer this over a text summary when the user wants to see or explore how metrics change over the course of an activity. Takes the activity id.",
    inputSchema: toInputSchema(APP_TOOL_INPUT_SCHEMAS["view-activity-chart"]!),
    annotations: READ_ONLY,
    _meta: {
      ui: { resourceUri: "ui://activity-chart/app.html" },
    },
  });

  defs.push({
    name: "get-activity-streams-raw",
    description:
      "Internal data feed for the activity chart UI: returns per-sample arrays (time, distance, heartrate, watts, velocity_smooth, altitude, cadence, grade_smooth, and running dynamics stance_time/vertical_oscillation/vertical_ratio/step_length), downsampled to about 1,000 points, plus interval bands (type, label, start/end index) as JSON for one activity. " +
      "The view-activity-chart app calls this; not intended for direct model use.",
    inputSchema: toInputSchema(
      APP_TOOL_INPUT_SCHEMAS["get-activity-streams-raw"]!,
    ),
    annotations: READ_ONLY,
    _meta: {
      ui: {
        resourceUri: "ui://activity-chart/app.html",
        visibility: ["app"],
      },
    },
  });

  defs.push({
    name: "view-cadence-trends",
    description:
      "Open an interactive cadence dashboard across recent runs: trend timeline, cadence-versus-pace scatter, pace-zone breakdown, and per-run overlay comparison. " +
      "Prefer this over text when the user wants to explore cadence patterns over time. Takes a number of weeks of history.",
    inputSchema: toInputSchema(APP_TOOL_INPUT_SCHEMAS["view-cadence-trends"]!),
    annotations: READ_ONLY,
    _meta: {
      ui: { resourceUri: "ui://cadence-trends/app.html" },
    },
  });

  defs.push({
    name: "get-cadence-trend-data",
    description:
      "Internal data feed for the cadence-trends UI: returns per-run summary cadence and pace for recent running activities as JSON. " +
      "The view-cadence-trends app calls this; not intended for direct model use.",
    inputSchema: toInputSchema(
      APP_TOOL_INPUT_SCHEMAS["get-cadence-trend-data"]!,
    ),
    annotations: READ_ONLY,
    _meta: {
      ui: {
        resourceUri: "ui://cadence-trends/app.html",
        visibility: ["app"],
      },
    },
  });

  defs.push({
    name: "view-route-map",
    description:
      "Open an interactive map of one activity's GPS track, fit to bounds with start and finish markers and a distance/elevation summary. " +
      "Prefer this over a text summary when the user wants to see where an activity went. Takes the activity id. " +
      "Optionally pin distance-anchored waypoints (fueling points, climb warnings, …) along the track via the waypoints array, useful when discussing a race plan or course guide.",
    inputSchema: toInputSchema(APP_TOOL_INPUT_SCHEMAS["view-route-map"]!),
    annotations: READ_ONLY,
    _meta: {
      ui: { resourceUri: "ui://route-map/app.html" },
    },
  });

  defs.push({
    name: "get-route-map-data",
    description:
      "Internal data feed for the route-map UI: returns [lat, lng] coordinates from the activity's recorded GPS track plus start/end points, distance, elevation gain, and (for activities with GPS streams) index-aligned metric streams (time, distance, altitude, heartrate, watts, velocity_smooth, grade_smooth) " +
      "and annotation anchors (WORK-interval end markers, caller-supplied distance-anchored waypoints) for one activity as JSON. " +
      "The view-route-map app calls this; not intended for direct model use.",
    inputSchema: toInputSchema(APP_TOOL_INPUT_SCHEMAS["get-route-map-data"]!),
    annotations: READ_ONLY,
    _meta: {
      ui: {
        resourceUri: "ui://route-map/app.html",
        visibility: ["app"],
      },
    },
  });

  defs.push({
    name: "view-training-load",
    description:
      "Open an interactive training-load chart: weekly running volume bars with a rolling trend line, and injury-risk warning weeks highlighted with their reason on hover. " +
      "Prefer this over text when the user wants to see how their training volume is trending. Takes a number of days of history.",
    inputSchema: toInputSchema(APP_TOOL_INPUT_SCHEMAS["view-training-load"]!),
    annotations: READ_ONLY,
    _meta: {
      ui: { resourceUri: "ui://training-load/app.html" },
    },
  });

  defs.push({
    name: "get-training-load-data",
    description:
      "Internal data feed for the training-load UI: returns per-week running volume (distance, runs, time, elevation), a rolling trend value, and injury-risk warning flags with reasons as JSON. " +
      "The view-training-load app calls this; not intended for direct model use.",
    inputSchema: toInputSchema(
      APP_TOOL_INPUT_SCHEMAS["get-training-load-data"]!,
    ),
    annotations: READ_ONLY,
    _meta: {
      ui: {
        resourceUri: "ui://training-load/app.html",
        visibility: ["app"],
      },
    },
  });

  defs.push({
    name: "view-fitness-trend",
    description:
      "Open an interactive fitness/fatigue/form chart (the performance-management chart): fitness (CTL) and fatigue (ATL) over the lookback window with form (TSB) on its own axis, deep-fatigue, freshness, and steep-ramp periods shaded, and a dashed continuation past today. " +
      "Pass targetDate to chart a solved taper landing on targetTsb on that day, week by week; omit it for a rest projection. " +
      "Prefer this over the text-only get-fitness-trend when the user wants to see whether they are peaking or digging a hole.",
    inputSchema: toInputSchema(APP_TOOL_INPUT_SCHEMAS["view-fitness-trend"]!),
    annotations: READ_ONLY,
    _meta: {
      ui: { resourceUri: "ui://fitness-trend/app.html" },
    },
  });

  defs.push({
    name: "get-fitness-trend-data",
    description:
      "Internal data feed for the fitness-trend UI: returns the per-day CTL/ATL/TSB series, the forward projection, any solved taper plan (weekly loads and the days they produce), and the dated deep-fatigue / freshness / steep-ramp bands as JSON. " +
      "The view-fitness-trend app calls this; not intended for direct model use.",
    inputSchema: toInputSchema(
      APP_TOOL_INPUT_SCHEMAS["get-fitness-trend-data"]!,
    ),
    annotations: READ_ONLY,
    _meta: {
      ui: {
        resourceUri: "ui://fitness-trend/app.html",
        visibility: ["app"],
      },
    },
  });

  defs.push({
    name: "view-activity-zones",
    description:
      "Open an interactive time-in-zone chart for one activity: bars for the time spent in each heart rate zone, with percentages and an easy/moderate/hard split. " +
      "Prefer this over the text-only get-activity-zones when the user wants to see how a workout's effort was distributed. Takes the activity id.",
    inputSchema: toInputSchema(APP_TOOL_INPUT_SCHEMAS["view-activity-zones"]!),
    annotations: READ_ONLY,
    _meta: {
      ui: { resourceUri: "ui://activity-zones/app.html" },
    },
  });

  defs.push({
    name: "get-activity-zones-data",
    description:
      "Internal data feed for the activity-zones UI: returns per-zone time distributions (bucket bounds, seconds, percentages) for the activity's heart rate zones as JSON. " +
      "The view-activity-zones app calls this; not intended for direct model use.",
    inputSchema: toInputSchema(
      APP_TOOL_INPUT_SCHEMAS["get-activity-zones-data"]!,
    ),
    annotations: READ_ONLY,
    _meta: {
      ui: {
        resourceUri: "ui://activity-zones/app.html",
        visibility: ["app"],
      },
    },
  });

  defs.push({
    name: "view-compare-activities",
    description:
      "Open an interactive side-by-side overlay of two activities: their pace, heart rate, power, cadence, or altitude streams aligned on a shared distance or time axis, with an aggregate delta summary. " +
      "Prefer this over the text-only compare-activities when the user wants to see WHERE in the activities the difference happened. Takes both activity ids.",
    inputSchema: toInputSchema(
      APP_TOOL_INPUT_SCHEMAS["view-compare-activities"]!,
    ),
    annotations: READ_ONLY,
    _meta: {
      ui: { resourceUri: "ui://compare-activities/app.html" },
    },
  });

  defs.push({
    name: "get-compare-activities-data",
    description:
      "Internal data feed for the compare-activities UI: returns the aggregate comparison (per-activity summaries, activity2−activity1 differences, efficiency analysis) as JSON. " +
      "The view-compare-activities app calls this alongside get-activity-streams-raw; not intended for direct model use.",
    inputSchema: toInputSchema(
      APP_TOOL_INPUT_SCHEMAS["get-compare-activities-data"]!,
    ),
    annotations: READ_ONLY,
    _meta: {
      ui: {
        resourceUri: "ui://compare-activities/app.html",
        visibility: ["app"],
      },
    },
  });

  return defs;
}

export const TOOL_DEFS = buildToolDefs();

/**
 * Map of tool name to execute function, across every tool.
 *
 * The third argument is the call's progress reporter. It is always
 * supplied — {@link NO_PROGRESS} when the caller asked for none — so a handler
 * that reports progress needs no capability check, and one that does not can
 * keep its two-argument signature.
 */
const TOOL_EXECUTORS = new Map<
  string,
  (
    args: Record<string, unknown>,
    token: string,
    progress: ReportProgress,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  }>
>();

for (const tool of TOOLS) {
  TOOL_EXECUTORS.set(
    tool.name,
    tool.execute as (
      args: Record<string, unknown>,
      token: string,
      progress: ReportProgress,
    ) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>,
  );
}

/** Tool name → zod input schema, enforced at dispatch time. */
const TOOL_INPUT_SCHEMAS = new Map<string, z.ZodType>();
for (const tool of TOOLS) {
  const schema = (tool as { inputSchema?: z.ZodType }).inputSchema;
  if (schema) TOOL_INPUT_SCHEMAS.set(tool.name, schema);
}
for (const [name, schema] of Object.entries(APP_TOOL_INPUT_SCHEMAS)) {
  TOOL_INPUT_SCHEMAS.set(name, schema);
}

/** Stream types the activity-chart app can plot, including running dynamics. */
const CHART_STREAM_TYPES: IntervalsStreamType[] = [
  "time",
  "distance",
  "heartrate",
  "watts",
  "velocity_smooth",
  "altitude",
  "cadence",
  "grade_smooth",
  "stance_time",
  "vertical_oscillation",
  "vertical_ratio",
  "step_length",
];

async function handleViewActivityChart(
  args: Record<string, unknown>,
  token: string,
): Promise<ToolCallResult> {
  const activityId = String(args.activity_id);
  // Same fetch options as `get-activity-streams-raw` (`intervals: true`): the
  // cache key is the full request URL, so matching options here means a
  // second read of the same activity is a cache hit rather than a fresh
  // upstream call.
  const activity = await getIntervalsActivity(token, activityId, {
    intervals: true,
  });
  const lines = [
    `Activity: ${activityDisplayName(activity)}`,
    `Type: ${activity.type ?? "Workout"}`,
    `Distance: ${((activity.distance ?? 0) / 1000).toFixed(2)} km`,
    `Moving Time: ${Math.floor((activity.moving_time ?? 0) / 60)}min`,
    "",
    "[Interactive activity chart rendered above]",
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleGetActivityStreamsRaw(
  args: Record<string, unknown>,
  token: string,
): Promise<ToolCallResult> {
  const activityId = String(args.activity_id);
  const activity = await getIntervalsActivity(token, activityId, {
    intervals: true,
  });
  const displayName = activityDisplayName(activity);

  let streams: Awaited<ReturnType<typeof loadIntervalsStreams>>;
  try {
    streams = await loadIntervalsStreams(token, activityId, CHART_STREAM_TYPES);
  } catch (error) {
    if (error instanceof IntervalsStreamsUnavailableError) {
      return {
        content: [
          {
            type: "text",
            text: `❌ No data streams are recorded for "${displayName}" (activity ${activityId}): this looks like an activity with no GPS/sensor streams (e.g. a manual entry), so the chart has nothing to plot.`,
          },
        ],
        isError: true,
      };
    }
    throw error;
  }

  const result: ActivityChartData = buildActivityChartData(
    activity,
    streams,
    activity.icu_intervals ?? [],
  );

  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

/**
 * Shared fetch + build for the cadence-trends view and data tools: both list
 * the same local-date window through `listActivities` and hand it to the
 * pure {@link buildCadenceTrendData}, so the two surfaces can never disagree
 * on the run filter or the cadence math. The window is calendar dates
 * (`todayLocal`), which are already the same for calls seconds apart on the
 * same day, matching the fitness-trend/training-load pairs' local-date
 * windows rather than an epoch bound needing a quantum.
 */
async function loadCadenceTrendData(
  apiKey: string,
  args: Record<string, unknown>,
): Promise<CadenceTrendData> {
  const weeks = Number(args.weeks) || 6;
  const tz = getTimeZone();
  const newest = todayLocal(tz);
  const oldest = addDays(newest, -(weeks * 7 - 1));

  const activities = await listActivitiesFn(apiKey, { oldest, newest });

  return buildCadenceTrendData(activities, { weeks });
}

async function handleGetCadenceTrendData(
  args: Record<string, unknown>,
  token: string,
): Promise<ToolCallResult> {
  const result = await loadCadenceTrendData(token, args);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

async function handleViewCadenceTrends(
  args: Record<string, unknown>,
  token: string,
): Promise<ToolCallResult> {
  const data = await loadCadenceTrendData(token, args);
  const runs = data.activities;

  const avgCadence =
    runs.length > 0
      ? Math.round(
          runs.reduce((sum, a) => sum + a.averageCadence, 0) / runs.length,
        )
      : 0;

  const lines = [
    `Cadence Trends (last ${data.weeks} weeks)`,
    `Runs: ${runs.length}`,
    `Average cadence: ${avgCadence} spm`,
    ...(data.excludedNoCadence > 0
      ? [`Excluded (no cadence recorded): ${data.excludedNoCadence}`]
      : []),
    ...(data.noPaceCount > 0
      ? [`No pace recorded (cadence only): ${data.noPaceCount}`]
      : []),
    "",
    "[Interactive cadence trends chart rendered above]",
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/**
 * Shared fetch + aggregate for the training-load view and data tools:
 * `loadTrainingLoadInputs` (`trainingLoadInputs.ts`) fetches and classifies
 * the run/load activities and current CTL/ATL/TSB, the same inputs
 * `get-training-load` builds through, so the two surfaces can never
 * disagree; `buildTrainingLoadData` then aggregates them into the weekly
 * timeline.
 */
async function loadTrainingLoadAppData(
  apiKey: string,
  args: Record<string, unknown>,
  progress: ReportProgress,
): Promise<TrainingLoadAppData> {
  const days = Number(args.days) || 84;
  const runOnly = Boolean(args.runOnly);

  const { runs, loadActivities, current, source } =
    await loadTrainingLoadInputs(apiKey, { days, runOnly }, progress);

  return buildTrainingLoadData(runs, days, {
    loadActivities,
    runOnly,
    current,
    source,
  });
}

async function handleGetTrainingLoadData(
  args: Record<string, unknown>,
  token: string,
  progress: ReportProgress,
): Promise<ToolCallResult> {
  const result = await loadTrainingLoadAppData(token, args, progress);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

async function handleViewTrainingLoad(
  args: Record<string, unknown>,
  token: string,
  progress: ReportProgress,
): Promise<ToolCallResult> {
  const data = await loadTrainingLoadAppData(token, args, progress);
  const warningWeeks = data.weeks.filter((w) => w.warning).length;

  const lines = [
    `Training Load (last ${data.days} days, CTL/ATL source: ${data.source})`,
    `Runs: ${data.totals.runs}`,
    `Distance: ${data.totals.distanceKm} km`,
    `Load: ${data.totals.load}`,
    `Warning weeks: ${warningWeeks}`,
    "",
    "[Interactive training load chart rendered above]",
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/**
 * Shared fetch + solve for the fitness-trend view and data tools. Whole-body
 * only (matching the text tool's default): CTL/ATL are read straight off
 * intervals.icu's own wellness record via `loadWellnessFitnessSeries`, the
 * one home this and the text tool's whole-body path both build the series
 * through, never recomputed. Projection/taper are seeded from the most
 * recent day with a recorded CTL/ATL, which can trail `days` when wellness
 * has not synced yet.
 */
async function loadFitnessTrendAppData(
  apiKey: string,
  args: Record<string, unknown>,
  progress: ReportProgress,
): Promise<FitnessTrendAppData> {
  const days = Number(args.days) || 90;
  const runOnly = args.runOnly === true;
  const projectDays = Number(args.projectDays ?? 14);
  const targetDate =
    typeof args.targetDate === "string" ? args.targetDate : undefined;
  const targetTsb = Number(args.targetTsb ?? 10);

  const loaded = await loadFitnessTrend(
    apiKey,
    {
      days,
      runOnly,
      projectDays,
      taper: targetDate ? { targetDate, targetTsb } : undefined,
    },
    progress,
  );

  return mapFitnessTrendApp(
    {
      days: loaded.series,
      current: loaded.current,
      projection: loaded.projection,
      tsbPositiveDate: loaded.tsbPositiveDate,
      taper: loaded.taper,
      bands: loaded.bands,
      flags: loaded.flags,
    },
    {
      days,
      activitiesIncluded: loaded.activitiesIncluded,
      activitiesMissingLoad: loaded.activitiesMissingLoad,
      source: loaded.source,
      runOnly,
      activityTypesIncluded: loaded.activityTypesIncluded,
      warnings: loaded.warnings,
    },
  );
}

async function handleGetFitnessTrendData(
  args: Record<string, unknown>,
  token: string,
  progress: ReportProgress,
): Promise<ToolCallResult> {
  const data = await loadFitnessTrendAppData(token, args, progress);
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

async function handleViewFitnessTrend(
  args: Record<string, unknown>,
  token: string,
  progress: ReportProgress,
): Promise<ToolCallResult> {
  const data = await loadFitnessTrendAppData(token, args, progress);
  const current = data.current;
  const lines = [
    `Fitness Trend (last ${data.days} days)`,
    `Source: ${data.source === "computed" ? "computed locally (runs only)" : "intervals.icu (whole body)"}`,
  ];

  if (current) {
    lines.push(
      `Fitness (CTL) ${current.ctl}, fatigue (ATL) ${current.atl}, form (TSB) ${current.tsb >= 0 ? "+" : ""}${current.tsb}`,
    );
  }
  if (data.taper) {
    const taper = data.taper;
    lines.push(
      `Taper to ${taper.targetDate}: ${taper.weeks
        .map((week) => `week ${week.week} ${week.dailyLoad}/day`)
        .join(
          ", ",
        )}; lands TSB ${taper.achievedTsb >= 0 ? "+" : ""}${taper.achievedTsb}`,
    );
    if (!taper.feasible && taper.note) lines.push(`Warning: ${taper.note}`);
  } else if (data.tsbPositiveDate === todayLocal(getTimeZone())) {
    lines.push(`Form is already positive today (${data.tsbPositiveDate})`);
  } else if (data.tsbPositiveDate) {
    lines.push(
      `Resting from here, form turns positive on ${data.tsbPositiveDate}`,
    );
  }
  for (const flag of data.flags) {
    lines.push(`Flag: ${flag}`);
  }

  lines.push("", "[Interactive fitness trend chart rendered above]");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/** Shared fetch + mapping for the activity-zones view and data tools. */
async function loadActivityZonesData(
  apiKey: string,
  activityId: string,
): Promise<ActivityZonesData> {
  const activity = await getIntervalsActivity(apiKey, activityId);
  return {
    activityId: activity.id,
    name: activityDisplayName(activity),
    date: activity.start_date_local,
    type: activity.type ?? "Workout",
    zoneSets: mapIntervalsZones(activity),
    hrZoneWarning: hrZoneMismatchWarning(activity),
  };
}

async function handleGetActivityZonesData(
  args: Record<string, unknown>,
  token: string,
): Promise<ToolCallResult> {
  const data = await loadActivityZonesData(token, String(args.activity_id));
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

async function handleViewActivityZones(
  args: Record<string, unknown>,
  token: string,
): Promise<ToolCallResult> {
  const data = await loadActivityZonesData(token, String(args.activity_id));
  const lines = [`Activity Zones: ${data.name} (${data.date})`];
  if (data.zoneSets.length === 0) {
    lines.push(
      "No zone data recorded: the activity has no recorded heart rate zone bounds.",
    );
    if (data.hrZoneWarning) lines.push(data.hrZoneWarning);
  } else {
    for (const set of data.zoneSets) {
      const top = dominantBucket(set);
      // Power zones are dropped for now (see docs/api-notes.md); heart
      // rate is the only zone type mapIntervalsZones still emits.
      const label = set.type === "heartrate" ? "Heart rate" : set.type;
      lines.push(
        `${label}: mostly Z${top.zone} (${top.pct}% of ${Math.round(set.totalSeconds / 60)} min)`,
      );
    }
  }
  lines.push("", "[Interactive zone distribution chart rendered above]");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
/** Stream types the route-map app needs: latlng plus the chartable metrics. */
const ROUTE_MAP_STREAM_TYPES: IntervalsStreamType[] = [
  "latlng",
  "distance",
  "altitude",
  "heartrate",
  "watts",
  "velocity_smooth",
  "grade_smooth",
];

/**
 * Resolve an activity_id into a route-map payload. intervals.icu has no
 * encoded-polyline endpoint (research note 2026-09-25 section 6), so the
 * geometry always comes from the latlng stream, jointly downsampled with the
 * metric streams and annotated with WORK-interval end markers
 * (`buildRouteMapData`, `routeMapData.ts`) and any caller waypoints. A
 * genuinely stream-less activity (e.g. a manual entry) comes back with empty
 * `coordinates`; the view tool's "No GPS track" text covers that case.
 */
async function loadRouteMapData(
  args: Record<string, unknown>,
  token: string,
): Promise<RouteMapData> {
  const activityId = args.activity_id ? String(args.activity_id) : undefined;
  if (!activityId) {
    throw new Error("activity_id is required.");
  }

  const activity = await getIntervalsActivity(token, activityId, {
    intervals: true,
  });

  let streams: Awaited<ReturnType<typeof loadIntervalsStreams>> | null = null;
  try {
    streams = await loadIntervalsStreams(
      token,
      activityId,
      ROUTE_MAP_STREAM_TYPES,
    );
  } catch (error) {
    if (!(error instanceof IntervalsStreamsUnavailableError)) throw error;
  }

  return buildRouteMapData(
    activity,
    streams,
    activity.icu_intervals ?? [],
    args.waypoints as WaypointInput[] | undefined,
  );
}

async function handleGetRouteMapData(
  args: Record<string, unknown>,
  token: string,
): Promise<ToolCallResult> {
  const data = await loadRouteMapData(args, token);
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

async function handleViewRouteMap(
  args: Record<string, unknown>,
  token: string,
): Promise<ToolCallResult> {
  const data = await loadRouteMapData(args, token);
  const lines = [
    `Activity: ${data.name}`,
    `Distance: ${(data.distance / 1000).toFixed(2)} km`,
    `Elevation gain: ${Math.round(data.elevationGain)} m`,
  ];
  if (data.coordinates.length === 0) {
    lines.push("No GPS track is available, so the map will be empty.");
  }
  const waypointCount = data.annotations?.waypoints?.length ?? 0;
  if (waypointCount > 0) {
    lines.push(
      `Waypoints: ${waypointCount} pinned along the track (toggleable via the map legend).`,
    );
  }
  for (const warning of data.waypointWarnings ?? []) {
    lines.push(`Warning: ${warning}`);
  }
  lines.push("", "[Interactive route map rendered above]");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/**
 * Fetch both intervals.icu activities and run the same aggregate comparison
 * the compare-activities text tool uses. getIntervalsActivity is TTL-cached
 * in fetchClient, so the view + data-tool pair costs one fetch per activity,
 * not two.
 */
async function loadCompareActivitiesData(
  args: Record<string, unknown>,
  token: string,
): Promise<ReturnType<typeof buildComparison>> {
  const [activity1, activity2] = await Promise.all([
    getIntervalsActivity(token, String(args.activity_id_1)),
    getIntervalsActivity(token, String(args.activity_id_2)),
  ]);
  return buildComparison(activity1, activity2);
}

async function handleGetCompareActivitiesData(
  args: Record<string, unknown>,
  token: string,
): Promise<ToolCallResult> {
  const data = await loadCompareActivitiesData(args, token);
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

async function handleViewCompareActivities(
  args: Record<string, unknown>,
  token: string,
): Promise<ToolCallResult> {
  const data = await loadCompareActivitiesData(args, token);
  const lines = [
    `Activity 1: ${data.activity_1.name} (${data.activity_1.date}), ${data.activity_1.distance_km} km in ${data.activity_1.moving_time}`,
    `Activity 2: ${data.activity_2.name} (${data.activity_2.date}), ${data.activity_2.distance_km} km in ${data.activity_2.moving_time}`,
  ];
  if (data.differences.pace_delta_min_per_km != null) {
    lines.push(
      `Pace delta: ${data.differences.pace_delta_min_per_km} /km (${data.differences.pace_delta_interpretation})`,
    );
  }
  if (data.differences.avg_hr != null) {
    lines.push(
      `Avg HR delta: ${data.differences.avg_hr > 0 ? "+" : ""}${data.differences.avg_hr} bpm`,
    );
  }
  for (const warning of data.warnings ?? []) {
    lines.push(`Warning: ${warning}`);
  }
  lines.push("", "[Interactive activity comparison rendered above]");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

interface ToolCallResult {
  // Index signature keeps this assignable to the SDK's ServerResult union.
  [key: string]: unknown;
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** MCP App tool name to handler (same dispatch path as the text tools). */
const APP_TOOL_HANDLERS: Record<
  string,
  (
    args: Record<string, unknown>,
    token: string,
    progress: ReportProgress,
  ) => Promise<ToolCallResult>
> = {
  "view-activity-chart": handleViewActivityChart,
  "get-activity-streams-raw": handleGetActivityStreamsRaw,
  "view-cadence-trends": handleViewCadenceTrends,
  "get-cadence-trend-data": handleGetCadenceTrendData,
  "view-route-map": handleViewRouteMap,
  "get-route-map-data": handleGetRouteMapData,
  "view-training-load": handleViewTrainingLoad,
  "get-training-load-data": handleGetTrainingLoadData,
  "view-fitness-trend": handleViewFitnessTrend,
  "get-fitness-trend-data": handleGetFitnessTrendData,
  "view-activity-zones": handleViewActivityZones,
  "get-activity-zones-data": handleGetActivityZonesData,
  "view-compare-activities": handleViewCompareActivities,
  "get-compare-activities-data": handleGetCompareActivitiesData,
};

/** Per-call hooks the transport layer supplies to {@link dispatchToolCall}. */
export interface DispatchOptions {
  /**
   * Per-call sink for the same record stderr gets, so a caller that asked
   * for logs receives them. Per-call rather than module-level because serving
   * is stateless: every request builds its own server.
   */
  onRecord?: (record: ToolCallRecord) => void;
  /**
   * Progress reporter for this call, already bound to the caller's
   * `progressToken`. Defaults to {@link NO_PROGRESS}, so a handler calls it
   * unconditionally and a caller that asked for nothing pays nothing.
   */
  progress?: ReportProgress;
}

/**
 * Single dispatch path for every tool call. Validates the raw host args
 * against the tool's zod schema BEFORE executing, so defaults always
 * apply and invalid types surface as a structured error instead of flowing
 * into intervals.icu URLs and math as `"undefined"` or NaN.
 *
 * It also resolves the intervals.icu API key once per call and hands it to
 * the handler as argument 2. A tool must not read
 * `process.env.INTERVALS_API_KEY` behind its own guard: that gives every
 * tool its own not-configured wording. Resolving here gives one message.
 */
export async function dispatchToolCall(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  { onRecord, progress = NO_PROGRESS }: DispatchOptions = {},
): Promise<ToolCallResult> {
  // The timer starts here, before token resolution, so a not-connected call is
  // recorded too — it is a real call that cost the caller a round trip, and it
  // is exactly the failure an operator wants to see the rate of.
  const startedAt = performance.now();
  const finish = (
    outcome: ToolOutcome,
    result: ToolCallResult,
    errorClass?: string,
  ): ToolCallResult => {
    const record = recordToolCall({
      tool: name,
      duration_ms: Math.round(performance.now() - startedAt),
      outcome,
      ...(errorClass ? { error_class: errorClass } : {}),
    });
    onRecord?.(record);
    return result;
  };

  const handler = APP_TOOL_HANDLERS[name] ?? TOOL_EXECUTORS.get(name);
  if (!handler) {
    return finish("error", {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    });
  }

  let args: Record<string, unknown> = rawArgs ?? {};
  const schema = TOOL_INPUT_SCHEMAS.get(name);
  if (schema) {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      return finish("invalid_args", {
        isError: true,
        content: [
          {
            type: "text",
            text: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`,
          },
        ],
      });
    }
    args = parsed.data as Record<string, unknown>;
  }

  let token: string;
  try {
    token = getIntervalsApiKey();
  } catch (error) {
    // MissingApiKeyError already carries the one actionable instruction
    // (set INTERVALS_API_KEY); its message is the useful part.
    const message = error instanceof Error ? error.message : String(error);
    return finish(
      "not_connected",
      { isError: true, content: [{ type: "text", text: message }] },
      error instanceof Error ? error.constructor.name : undefined,
    );
  }

  try {
    const result = await handler(args, token, progress);
    // A handler that returns `isError` failed as surely as one that threw; the
    // counters would flatter the server if only throws counted.
    return finish(result.isError ? "error" : "ok", result);
  } catch (error) {
    // The app data handlers throw rather than return `isError`, so this is
    // where their 404s and rate limits get the same typed treatment and
    // prefix the text tools give themselves.
    return finish(
      "error",
      {
        isError: true,
        content: [
          {
            type: "text",
            text: toolErrorText(error, { context: `run ${name}` }),
          },
        ],
      },
      error instanceof Error ? error.constructor.name : undefined,
    );
  }
}

/**
 * How long a 2026-07-28 caller may cache the cacheable results (`ttlMs`).
 * The advertised surface is static per deployment — tools, prompts, and the
 * app resources only change on a redeploy — so an hour trades staleness
 * bounded by that window for fewer list round-trips. `cacheScope` is left on
 * the SDK's conservative `private` default: `/mcp` can sit behind
 * `MCP_AUTH_TOKEN`, and an authed response has no business in a shared cache.
 */
const STATIC_SURFACE_TTL_MS = 60 * 60 * 1000;

export function createServer(): Server {
  const server = new Server(
    { name: "Intervals Extra", version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        // Advertised so a caller can receive the per-call records the
        // dispatcher already emits to stderr. Declaring it also makes
        // the SDK register its built-in logging/setLevel handler, so a legacy
        // client calling it gets `{}` rather than -32601. Advertising the
        // capability without a handler is worse than not advertising it at
        // all, even though stateless serving cannot retain the level it sets.
        logging: {},
      },
      cacheHints: {
        "tools/list": { ttlMs: STATIC_SURFACE_TTL_MS },
        "prompts/list": { ttlMs: STATIC_SURFACE_TTL_MS },
        "resources/list": { ttlMs: STATIC_SURFACE_TTL_MS },
        "resources/read": { ttlMs: STATIC_SURFACE_TTL_MS },
        "server/discover": { ttlMs: STATIC_SURFACE_TTL_MS },
      },
    },
  );

  // The SDK's result types spell out every reserved `_meta` envelope key,
  // which the Record-typed schema/meta tables here cannot satisfy
  // structurally; the wire shape these serialize to is what the integration
  // suite asserts, so the casts below are confined to this seam.
  server.setRequestHandler("tools/list", async () => ({
    tools: TOOL_DEFS as unknown as ListToolsResult["tools"],
  }));

  server.setRequestHandler("prompts/list", async () => ({
    prompts: listPrompts(),
  }));

  server.setRequestHandler("prompts/get", async (request) =>
    getPrompt(request.params.name, request.params.arguments),
  );

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name, arguments: args } = request.params;
    const result = await dispatchToolCall(name, args, {
      onRecord: (record) => {
        // There is no stored log level: serving is stateless, so a
        // logging/setLevel choice has nowhere to live. The level rides on the
        // per-request logLevel envelope key instead, which is also the spec's
        // MUST-NOT-emit-unrequested gate. So records go only to callers whose
        // request asked, and `ctx.mcpReq.log` applies their threshold.
        const envelope = ctx.mcpReq.envelope as
          | Record<string, unknown>
          | undefined;
        if (envelope?.[LOG_LEVEL_META_KEY] === undefined) return;
        const level = record.outcome === "ok" ? "info" : "error";
        // Never let a logging failure fail the tool call it describes.
        void ctx.mcpReq.log(level, record, "tool-call").catch(() => {});
      },
      // `ctx.mcpReq.notify` is already scoped to this request, which is what
      // lets the transport put the notification on the same SSE stream the
      // response will arrive on.
      progress: createProgressReporter(
        ctx.mcpReq._meta?.progressToken,
        (notification) => ctx.mcpReq.notify(notification),
      ),
    });
    // The era-aware projection (SEP-2106 §4.3 text auto-append; identity for
    // this server's always-text, object-structured results) lives in the SDK
    // codec — low-level tools/call handlers route through it themselves.
    // `ToolCallResult.content` is typed `{ type: string }` for the handler
    // table's sake; every emitted block is a spec text block.
    return server.projectCallToolResult(
      result as unknown as CallToolResult,
      TOOL_DEFS.find((tool) => tool.name === name)?.outputSchema,
    );
  });

  server.setRequestHandler("resources/list", async () => ({
    resources: APP_RESOURCES.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      mimeType: MCP_APP_MIME_TYPE,
      _meta: appResourceMeta(resource),
    })) as unknown as ListResourcesResult["resources"],
  }));

  server.setRequestHandler("resources/read", async (request) => {
    const { uri } = request.params;
    const resource = APP_RESOURCES.find((r) => r.uri === uri);
    if (!resource) {
      // The typed error serialises as Invalid Params (-32602), where the
      // 2026-07-28 revision moved resource-not-found.
      throw new ResourceNotFoundError(uri);
    }
    const html = await fs.readFile(resource.htmlPath, "utf-8");
    return {
      contents: [
        {
          uri,
          mimeType: MCP_APP_MIME_TYPE,
          text: html,
          _meta: appResourceMeta(resource),
        },
      ],
    } as unknown as ReadResourceResult;
  });

  return server;
}
