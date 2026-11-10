/**
 * Payload mapping for the `view-wellness` MCP App. No math of its own: the
 * numbers are get-wellness's (`loadWellness` in `tools/getWellness.ts`, its
 * days or its weekly means past 90 days), renamed to camelCase, put oldest
 * first and laid on every calendar day or week of the range, so a day with
 * no record is a null point and the chart draws a gap there, never a zero.
 */
import {
  type WellnessTrendData,
  type WellnessTrendPoint,
} from "@intervals-mcp/data";
import {
  type WellnessDayEntry,
  type WellnessResponse,
} from "./tools/getWellness";
import { addDays, startOfWeekMonday } from "./utils/localDate";

/**
 * The HRV measure the chart plots: the one more days carry (rMSSD on a tie).
 * rMSSD and SDNN are different measures, so one line never mixes them.
 */
function hrvMeasure(
  rows: Pick<WellnessDayEntry, "hrv_rmssd_ms" | "hrv_sdnn_ms">[],
): WellnessTrendData["hrvMeasure"] {
  const rmssd = rows.filter((r) => r.hrv_rmssd_ms != null).length;
  const sdnn = rows.filter((r) => r.hrv_sdnn_ms != null).length;
  if (rmssd === 0 && sdnn === 0) return null;
  return rmssd >= sdnn ? "rmssd" : "sdnn";
}

export function buildWellnessTrendData(
  response: WellnessResponse,
): WellnessTrendData {
  const weekly = response.granularity === "weekly";
  const rows = weekly ? (response.weeks ?? []) : response.days;
  const measure = hrvMeasure(rows);
  const hrvField = measure === "sdnn" ? "hrv_sdnn_ms" : "hrv_rmssd_ms";

  const byDate = new Map<string, WellnessTrendPoint>();
  for (const row of rows) {
    const date = "week_start" in row ? row.week_start : row.date;
    byDate.set(date, {
      date,
      hrv: measure ? row[hrvField] : null,
      restingHr: row.resting_hr,
      sleepHours: row.sleep_hours,
      ...("days" in row && { days: row.days }),
    });
  }

  const step = weekly ? 7 : 1;
  const first = weekly ? startOfWeekMonday(response.oldest) : response.oldest;
  const points: WellnessTrendPoint[] = [];
  for (let date = first; date <= response.newest; date = addDays(date, step))
    points.push(
      byDate.get(date) ?? {
        date,
        hrv: null,
        restingHr: null,
        sleepHours: null,
        ...(weekly && { days: 0 }),
      },
    );

  return {
    oldest: response.oldest,
    newest: response.newest,
    granularity: weekly ? "weekly" : "daily",
    count: response.count,
    hrvMeasure: measure,
    hrvNote: response.hrv_note,
    points,
  };
}
