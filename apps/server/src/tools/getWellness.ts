import { z } from "zod";
import { getTimeZone } from "../config";
import { ctlAtlTsb } from "../fitnessTrend";
import { round } from "../formatters";
import {
  getWellness as getWellnessClient,
  type IntervalsWellness,
} from "../intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import {
  addDays,
  dateInputSchema,
  daysBetween,
  startOfWeekMonday,
  todayLocal,
  validateRange,
} from "../utils/localDate";
import {
  WELLNESS_SCORE_NAMES,
  WELLNESS_SCORES,
  type WellnessScore,
  wellnessScoreLabel,
} from "../utils/wellnessWrite";
import { READ_ONLY } from "./_annotations";
import { toolErrorText } from "./_errors";
import { fitListToBudget } from "./_responseBudget";
import { WellnessOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "get-wellness";

const description = `
Returns daily wellness from intervals.icu for a day or a date range: HRV
(rMSSD, SDNN or both), resting HR, sleep, weight, CTL/ATL/TSB, and the
subjective scores the athlete or a device logged (readiness, soreness,
fatigue, stress, mood, motivation, injury, sleep quality, SpO2,
respiration, comments). Use it to explain how a run felt or to check
recovery. To log how the athlete feels, use update-wellness.

For form trends, a projection or a taper, use get-fitness-trend; this tool
reports each day's recorded values only.

Notes:
- With no date, oldest or newest, it returns today only. A date after today
  is refused. A range can span 366 days. Past 90 days it returns weekly
  averages (Monday start, with the day count) in weeks instead of daily rows
  in days. Weeks carry HRV, resting HR, sleep, weight and the scores, but no
  CTL/ATL/TSB, ramp, sleep score, SpO2, respiration or comments; use
  get-fitness-trend for load.
- A daily range with long comments keeps the newest days that fit the
  response size limit; count stays the full count and the text names the
  call for the rest.
- The HRV measure depends on the athlete's device. rMSSD and SDNN are
  different measures, so compare each only with its own norms. hrv_note in
  the response says which ones the days have.
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

const MAX_RANGE_DAYS = 366;
/** A range longer than this returns weekly averages: 90 daily rows already
 * measure 38,808 of the 40,000 character response budget. */
const DAILY_MAX_DAYS = 90;

/** A range line's comments are cut here, so 90 commented days fit the text. */
const COMMENT_MAX_CHARS = 80;

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
  injury: number | null;
  sleep_quality: number | null;
  spo2: number | null;
  respiration: number | null;
  comments: string | null;
}

/** Maps one raw intervals.icu wellness record to the compact entry. Exported for direct testing. */
export function mapWellnessDay(w: IntervalsWellness): WellnessDayEntry {
  // CTL/ATL/TSB come from `ctlAtlTsb`, the one home get-fitness-trend reads
  // its wellness series through too. A day with only one of CTL or ATL still
  // reports it, with no TSB.
  const loads = w.ctl != null && w.atl != null ? ctlAtlTsb(w.ctl, w.atl) : null;

  return {
    date: w.id,
    hrv_sdnn_ms: w.hrvSDNN ?? null,
    hrv_rmssd_ms: w.hrv ?? null,
    resting_hr: w.restingHR ?? null,
    sleep_hours: w.sleepSecs != null ? round(w.sleepSecs / 3600, 1) : null,
    sleep_score: w.sleepScore ?? null,
    weight_kg: w.weight ?? null,
    ctl: loads?.ctl ?? (w.ctl != null ? round(w.ctl, 1) : null),
    atl: loads?.atl ?? (w.atl != null ? round(w.atl, 1) : null),
    tsb: loads?.tsb ?? null,
    ramp_rate: w.rampRate != null ? round(w.rampRate, 1) : null,
    readiness: w.readiness ?? null,
    soreness: w.soreness ?? null,
    fatigue: w.fatigue ?? null,
    stress: w.stress ?? null,
    mood: w.mood ?? null,
    motivation: w.motivation ?? null,
    injury: w.injury ?? null,
    sleep_quality: w.sleepQuality ?? null,
    spo2: w.spO2 ?? null,
    respiration: w.respiration ?? null,
    comments: w.comments ?? null,
  };
}

/** The subjective 1 to 4 scores plus readiness, averaged per week. */
const WEEKLY_SCORE_FIELDS = [
  "readiness",
  ...WELLNESS_SCORE_NAMES.map((score) => WELLNESS_SCORES[score].output),
] as const;

export type WellnessWeekEntry = {
  /** Monday of the week; the first and last week of a range may be partial. */
  week_start: string;
  /** Days in the week that have a wellness record. */
  days: number;
  hrv_sdnn_ms: number | null;
  hrv_rmssd_ms: number | null;
  resting_hr: number | null;
  sleep_hours: number | null;
  weight_kg: number | null;
} & Record<(typeof WEEKLY_SCORE_FIELDS)[number], number | null>;

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
  /** Set with `weeks` when the range is past 90 days; `days` is then empty. */
  granularity?: "weekly";
  weeks?: WellnessWeekEntry[];
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((a, b) => a + b, 0) / values.length, 1);
}

function numbers(values: (number | null)[]): number[] {
  return values.filter((v): v is number => v != null);
}

/**
 * Monday-start weekly means, newest week first. Each field averages only the
 * days that carry it, so rMSSD and SDNN stay apart and a week with none of a
 * field reports null.
 */
export function aggregateWellnessWeeks(
  days: WellnessDayEntry[],
): WellnessWeekEntry[] {
  const byWeek = new Map<string, WellnessDayEntry[]>();
  for (const d of days) {
    const key = startOfWeekMonday(d.date);
    byWeek.set(key, [...(byWeek.get(key) ?? []), d]);
  }
  const mean = (
    group: WellnessDayEntry[],
    field: keyof WellnessDayEntry,
  ): number | null =>
    average(numbers(group.map((d) => d[field] as number | null)));
  return [...byWeek.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([week_start, group]) => ({
      week_start,
      days: group.length,
      hrv_sdnn_ms: mean(group, "hrv_sdnn_ms"),
      hrv_rmssd_ms: mean(group, "hrv_rmssd_ms"),
      resting_hr: mean(group, "resting_hr"),
      sleep_hours: mean(group, "sleep_hours"),
      weight_kg: mean(group, "weight_kg"),
      ...(Object.fromEntries(
        WEEKLY_SCORE_FIELDS.map((f) => [f, mean(group, f)]),
      ) as Record<(typeof WEEKLY_SCORE_FIELDS)[number], number | null>),
    }));
}

/**
 * Builds hrv_note from the HRV measures the days carry. Which measure is set
 * depends on the device (docs/api-notes.md), so the note never names one.
 */
function buildHrvNote(days: WellnessDayEntry[]): string {
  const hasRmssd = days.some((d) => d.hrv_rmssd_ms != null);
  const hasSdnn = days.some((d) => d.hrv_sdnn_ms != null);
  if (hasRmssd && hasSdnn)
    return "HRV has both rMSSD (hrv_rmssd_ms) and SDNN (hrv_sdnn_ms). They are different measures, so compare each only with its own norms.";
  if (hasRmssd)
    return "HRV is rMSSD (hrv_rmssd_ms). SDNN (hrv_sdnn_ms) is null.";
  if (hasSdnn)
    return "HRV is SDNN (hrv_sdnn_ms), not rMSSD (hrv_rmssd_ms is null). Do not compare SDNN values with rMSSD norms.";
  return "No HRV recorded.";
}

/** "soreness 3 (High)": the score with the web app's label for it. */
function formatScore(score: WellnessScore, value: number): string {
  const label = wellnessScoreLabel(score, value);
  const name = WELLNESS_SCORES[score].output.replace("_", " ");
  return label ? `${name} ${value} (${label})` : `${name} ${value}`;
}

/** Readiness and each logged 1 to 4 score with its label. */
function formatScores(d: WellnessDayEntry): string[] {
  const parts: string[] = [];
  if (d.readiness != null) parts.push(`readiness ${d.readiness}`);
  for (const score of WELLNESS_SCORE_NAMES) {
    const value = d[WELLNESS_SCORES[score].output];
    if (value != null) parts.push(formatScore(score, value));
  }
  return parts;
}

function formatWellnessDayBlock(d: WellnessDayEntry): string {
  const lines = [`Wellness ${d.date}`];

  const core: string[] = [];
  if (d.hrv_rmssd_ms != null)
    core.push(`HRV rMSSD ${d.hrv_rmssd_ms.toFixed(1)} ms`);
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

  const subjective = formatScores(d);
  if (d.spo2 != null) subjective.push(`SpO2 ${d.spo2}%`);
  if (d.respiration != null) subjective.push(`respiration ${d.respiration}`);
  if (d.sleep_score != null) subjective.push(`sleep score ${d.sleep_score}`);
  if (subjective.length > 0) lines.push(subjective.join(", "));

  if (d.comments) lines.push(`Comments: ${d.comments}`);

  return lines.join("\n");
}

function formatWellnessLine(d: WellnessDayEntry): string {
  const parts: string[] = [];
  if (d.hrv_rmssd_ms != null)
    parts.push(`HRV rMSSD ${d.hrv_rmssd_ms.toFixed(1)}`);
  if (d.hrv_sdnn_ms != null) parts.push(`HRV SDNN ${d.hrv_sdnn_ms.toFixed(1)}`);
  if (d.resting_hr != null) parts.push(`RHR ${d.resting_hr}`);
  if (d.sleep_hours != null) parts.push(`sleep ${d.sleep_hours.toFixed(1)}h`);
  if (d.weight_kg != null) parts.push(`wt ${d.weight_kg}kg`);
  if (d.ctl != null && d.atl != null)
    parts.push(`CTL/ATL ${d.ctl.toFixed(1)}/${d.atl.toFixed(1)}`);
  if (d.tsb != null) parts.push(`TSB ${d.tsb.toFixed(1)}`);
  parts.push(...formatScores(d));
  if (d.comments) {
    const oneLine = d.comments.replace(/\s+/g, " ").trim();
    parts.push(
      `comments "${oneLine.length > COMMENT_MAX_CHARS ? `${oneLine.slice(0, COMMENT_MAX_CHARS)}...` : oneLine}"`,
    );
  }
  return `${d.date}: ${parts.length > 0 ? parts.join(", ") : "no data"}`;
}

function formatWellnessWeekLine(w: WellnessWeekEntry): string {
  const parts: string[] = [];
  if (w.hrv_rmssd_ms != null) parts.push(`HRV rMSSD ${w.hrv_rmssd_ms}`);
  if (w.hrv_sdnn_ms != null) parts.push(`HRV SDNN ${w.hrv_sdnn_ms}`);
  if (w.resting_hr != null) parts.push(`RHR ${w.resting_hr}`);
  if (w.sleep_hours != null) parts.push(`sleep ${w.sleep_hours}h`);
  if (w.weight_kg != null) parts.push(`wt ${w.weight_kg}kg`);
  for (const f of WEEKLY_SCORE_FIELDS) {
    const v = w[f];
    if (v != null) parts.push(`${f.replace("_", " ")} ${v}`);
  }
  return `${w.week_start} (${w.days} d): ${parts.length > 0 ? parts.join(", ") : "no data"}`;
}

function formatWellnessAverages(days: WellnessDayEntry[]): string {
  // rMSSD and SDNN are different measures, so each gets its own average.
  const rmssd = average(numbers(days.map((d) => d.hrv_rmssd_ms)));
  const sdnn = average(numbers(days.map((d) => d.hrv_sdnn_ms)));
  const rhr = average(numbers(days.map((d) => d.resting_hr)));
  const sleep = average(numbers(days.map((d) => d.sleep_hours)));

  const parts: string[] = [];
  if (rmssd != null) parts.push(`HRV rMSSD ${rmssd.toFixed(1)} ms`);
  if (sdnn != null) parts.push(`HRV SDNN ${sdnn.toFixed(1)} ms`);
  if (rhr != null) parts.push(`resting HR ${rhr.toFixed(1)}`);
  if (sleep != null) parts.push(`sleep ${sleep.toFixed(1)} h`);

  return `Averages: ${parts.length > 0 ? parts.join(", ") : "no data"}`;
}

/**
 * Builds the tool's text response. `allDays` is every day read, newest
 * first; `response.days` may hold only the newest of them (the response
 * budget), and the averages still cover them all. Exported for direct testing.
 */
export function formatWellnessText(
  response: WellnessResponse,
  allDays: WellnessDayEntry[] = response.days,
): string {
  const { oldest, newest, days, count, weeks } = response;

  if (weeks) {
    if (weeks.length === 0) return `No wellness data ${oldest} to ${newest}.`;
    return [
      `Wellness ${oldest} to ${newest}: ${count} days, weekly averages (Monday start, newest first)`,
      ...weeks.map(formatWellnessWeekLine),
    ].join("\n");
  }

  if (oldest === newest) {
    const day = days[0];
    return day
      ? formatWellnessDayBlock(day)
      : `No wellness data for ${oldest}.`;
  }

  if (days.length === 0) return `No wellness data ${oldest} to ${newest}.`;

  const lines = [`Wellness ${oldest} to ${newest}: ${count} days`];
  for (const d of days) lines.push(formatWellnessLine(d));
  const oldestShown = days.at(-1)?.date;
  if (days.length < count && oldestShown)
    lines.push(
      `Showing the newest ${days.length} of ${count} days, to stay under the response size limit. For the rest, call get-wellness with oldest ${oldest} and newest ${addDays(oldestShown, -1)}.`,
    );
  lines.push(formatWellnessAverages(allDays));
  return lines.join("\n");
}

export const getWellnessTool = {
  name,
  title: "Wellness",
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

    const today = todayLocal(getTimeZone());
    const newest = date ?? rawNewest ?? today;
    const oldest = date ?? rawOldest ?? newest;

    // intervals.icu's rows past today hold a projection from planned
    // workouts, not records (docs/api-notes.md).
    if (newest > today) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ ${date ? "date" : "newest"} ${newest} is after today (${today}). Days after today hold intervals.icu's projection, not recorded wellness. Use today or an earlier date; for projected CTL/ATL/TSB, use get-fitness-trend with projectDays.`,
          },
        ],
        isError: true,
      };
    }

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

      const weekly = daysBetween(oldest, newest) + 1 > DAILY_MAX_DAYS;
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
        hrv_note: buildHrvNote(days),
        days: weekly ? [] : days,
        ...(weekly && {
          granularity: "weekly" as const,
          weeks: aggregateWellnessWeeks(days),
        }),
      };

      warnOnSchemaDrift(name, WellnessOutputSchema, response);

      // Weekly rows always fit (a 366-day range is about 17,400 characters).
      // Days are newest first, so a cut keeps the newest.
      const { text, structured } = weekly
        ? { text: formatWellnessText(response), structured: response }
        : fitListToBudget(days.length, (n) => {
            const shown = { ...response, days: days.slice(0, n) };
            return { text: formatWellnessText(shown, days), structured: shown };
          });

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: structured,
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
