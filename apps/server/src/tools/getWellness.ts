import { z } from "zod";
import { getTimeZone } from "../config";
import { round } from "../formatters";
import {
  getWellness as getWellnessClient,
  type IntervalsWellness,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { dateInputSchema, todayLocal, validateRange } from "../utils/localDate";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { WellnessOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-wellness";

const HRV_NOTE =
  "Apple Watch reports HRV as SDNN (hrv_sdnn_ms); rMSSD (hrv_rmssd_ms) is usually null for this athlete. Do not compare SDNN values with rMSSD norms.";

const description = `
Returns daily wellness from intervals.icu (HRV, resting HR, sleep, weight, CTL/ATL/TSB) for a date or range; use to explain how a run felt.

Each day carries HRV (both SDNN and rMSSD, where reported), resting HR,
sleep, weight, training load (CTL/ATL/TSB), and the subjective fields the
athlete or a device logged (readiness, soreness, fatigue, stress, mood,
motivation, SpO2, respiration, comments).

Parameters:
- date (optional): a single day (YYYY-MM-DD). Cannot be combined with oldest/newest
- oldest (optional): inclusive lower bound (YYYY-MM-DD). Defaults to newest
- newest (optional): inclusive upper bound (YYYY-MM-DD). Defaults to today

Notes:
- With none of date/oldest/newest supplied, returns today only
- The date range cannot exceed 90 days
- Apple Watch reports HRV as SDNN, not rMSSD; see hrv_note in the response
`;

const inputSchema = z.object({
  date: dateInputSchema
    .optional()
    .describe(
      "A single day (YYYY-MM-DD). Cannot be combined with oldest/newest.",
    ),
  oldest: dateInputSchema
    .optional()
    .describe("Inclusive lower bound (YYYY-MM-DD). Defaults to newest."),
  newest: dateInputSchema
    .optional()
    .describe("Inclusive upper bound (YYYY-MM-DD). Defaults to today."),
});

type GetWellnessInput = z.infer<typeof inputSchema>;

const MAX_RANGE_DAYS = 90;

export interface WellnessDayEntry {
  date: string;
  hrv_sdnn_ms: number | null;
  hrv_rmssd_ms: number | null;
  resting_hr: number | null;
  sleep_hours: number | null;
  sleep_score: number | null;
  weight_kg: number | null;
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  ramp_rate: number | null;
  readiness: number | null;
  soreness: number | null;
  fatigue: number | null;
  stress: number | null;
  mood: number | null;
  motivation: number | null;
  spo2: number | null;
  respiration: number | null;
  comments: string | null;
}

/** Maps one raw intervals.icu wellness record to the compact entry. Exported for direct testing. */
export function mapWellnessDay(w: IntervalsWellness): WellnessDayEntry {
  const ctl = w.ctl ?? null;
  const atl = w.atl ?? null;
  const tsb = ctl != null && atl != null ? round(ctl - atl, 1) : null;

  return {
    date: w.id,
    hrv_sdnn_ms: w.hrvSDNN ?? null,
    hrv_rmssd_ms: w.hrv ?? null,
    resting_hr: w.restingHR ?? null,
    sleep_hours: w.sleepSecs != null ? round(w.sleepSecs / 3600, 1) : null,
    sleep_score: w.sleepScore ?? null,
    weight_kg: w.weight ?? null,
    ctl,
    atl,
    tsb,
    ramp_rate: w.rampRate ?? null,
    readiness: w.readiness ?? null,
    soreness: w.soreness ?? null,
    fatigue: w.fatigue ?? null,
    stress: w.stress ?? null,
    mood: w.mood ?? null,
    motivation: w.motivation ?? null,
    spo2: w.spO2 ?? null,
    respiration: w.respiration ?? null,
    comments: w.comments ?? null,
  };
}

interface WellnessResponse {
  oldest: string;
  newest: string;
  count: number;
  units: {
    hrv: "ms";
    resting_hr: "bpm";
    sleep: "hours";
    weight: "kg";
    spo2: "%";
    respiration: "breaths/min";
  };
  hrv_note: string;
  days: WellnessDayEntry[];
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((a, b) => a + b, 0) / values.length, 1);
}

function numbers(values: (number | null)[]): number[] {
  return values.filter((v): v is number => v != null);
}

function formatWellnessDayBlock(d: WellnessDayEntry): string {
  const lines = [`Wellness ${d.date}`];

  const core: string[] = [];
  if (d.hrv_sdnn_ms != null)
    core.push(`HRV SDNN ${d.hrv_sdnn_ms.toFixed(1)} ms`);
  if (d.resting_hr != null) core.push(`resting HR ${d.resting_hr}`);
  if (d.sleep_hours != null) core.push(`sleep ${d.sleep_hours.toFixed(1)} h`);
  if (d.weight_kg != null) core.push(`weight ${d.weight_kg} kg`);
  if (core.length > 0) lines.push(core.join(", "));

  const load: string[] = [];
  if (d.ctl != null) load.push(`CTL ${d.ctl.toFixed(1)}`);
  if (d.atl != null) load.push(`ATL ${d.atl.toFixed(1)}`);
  if (d.tsb != null) load.push(`TSB ${d.tsb.toFixed(1)}`);
  if (d.ramp_rate != null) load.push(`ramp ${d.ramp_rate.toFixed(1)}`);
  if (load.length > 0) lines.push(load.join(", "));

  const subjective: string[] = [];
  if (d.readiness != null) subjective.push(`readiness ${d.readiness}`);
  if (d.soreness != null) subjective.push(`soreness ${d.soreness}`);
  if (d.fatigue != null) subjective.push(`fatigue ${d.fatigue}`);
  if (d.stress != null) subjective.push(`stress ${d.stress}`);
  if (d.mood != null) subjective.push(`mood ${d.mood}`);
  if (d.motivation != null) subjective.push(`motivation ${d.motivation}`);
  if (d.spo2 != null) subjective.push(`SpO2 ${d.spo2}%`);
  if (d.respiration != null) subjective.push(`respiration ${d.respiration}`);
  if (d.sleep_score != null) subjective.push(`sleep score ${d.sleep_score}`);
  if (subjective.length > 0) lines.push(subjective.join(", "));

  if (d.comments) lines.push(`Comments: ${d.comments}`);

  return lines.join("\n");
}

function formatWellnessLine(d: WellnessDayEntry): string {
  const parts: string[] = [];
  if (d.hrv_sdnn_ms != null) parts.push(`HRV SDNN ${d.hrv_sdnn_ms.toFixed(1)}`);
  if (d.resting_hr != null) parts.push(`RHR ${d.resting_hr}`);
  if (d.sleep_hours != null) parts.push(`sleep ${d.sleep_hours.toFixed(1)}h`);
  if (d.weight_kg != null) parts.push(`wt ${d.weight_kg}kg`);
  if (d.ctl != null && d.atl != null)
    parts.push(`CTL/ATL ${d.ctl.toFixed(1)}/${d.atl.toFixed(1)}`);
  if (d.tsb != null) parts.push(`TSB ${d.tsb.toFixed(1)}`);
  return `${d.date}: ${parts.length > 0 ? parts.join(", ") : "no data"}`;
}

function formatWellnessAverages(days: WellnessDayEntry[]): string {
  const hrv = average(numbers(days.map((d) => d.hrv_sdnn_ms)));
  const rhr = average(numbers(days.map((d) => d.resting_hr)));
  const sleep = average(numbers(days.map((d) => d.sleep_hours)));

  const parts: string[] = [];
  if (hrv != null) parts.push(`HRV SDNN ${hrv.toFixed(1)} ms`);
  if (rhr != null) parts.push(`resting HR ${rhr.toFixed(1)}`);
  if (sleep != null) parts.push(`sleep ${sleep.toFixed(1)} h`);

  return `Averages: ${parts.length > 0 ? parts.join(", ") : "no data"}`;
}

/** Builds the tool's text response. Exported for direct testing. */
export function formatWellnessText(response: WellnessResponse): string {
  const { oldest, newest, days } = response;

  if (oldest === newest) {
    const day = days[0];
    return day
      ? formatWellnessDayBlock(day)
      : `No wellness data for ${oldest}.`;
  }

  if (days.length === 0) return `No wellness data ${oldest} to ${newest}.`;

  const lines = [`Wellness ${oldest} to ${newest}: ${days.length} days`];
  for (const d of days) lines.push(formatWellnessLine(d));
  lines.push(formatWellnessAverages(days));
  return lines.join("\n");
}

export const getWellnessTool = {
  name,
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: WellnessOutputSchema,
  execute: async (
    { date, oldest: rawOldest, newest: rawNewest }: GetWellnessInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    if (date && (rawOldest || rawNewest)) {
      return {
        content: [
          {
            type: "text" as const,
            text: "❌ date cannot be combined with oldest/newest. Use a single date, or an oldest/newest range.",
          },
        ],
        isError: true,
      };
    }

    const tz = getTimeZone();
    const newest = date ?? rawNewest ?? todayLocal(tz);
    const oldest = date ?? rawOldest ?? newest;

    const rangeError = validateRange(oldest, newest, MAX_RANGE_DAYS);
    if (rangeError) {
      return {
        content: [{ type: "text" as const, text: `❌ ${rangeError.message}` }],
        isError: true,
      };
    }

    try {
      progress(`Fetching wellness ${oldest} to ${newest}`);
      const records = await getWellnessClient(apiKey, { oldest, newest });
      const days = records
        .map(mapWellnessDay)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

      const response: WellnessResponse = {
        oldest,
        newest,
        count: days.length,
        units: {
          hrv: "ms",
          resting_hr: "bpm",
          sleep: "hours",
          weight: "kg",
          spo2: "%",
          respiration: "breaths/min",
        },
        hrv_note: HRV_NOTE,
        days,
      };

      warnOnSchemaDrift(name, WellnessOutputSchema, response);

      return {
        content: [
          { type: "text" as const, text: formatWellnessText(response) },
        ],
        structuredContent: response,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `fetch wellness ${oldest} to ${newest}`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
