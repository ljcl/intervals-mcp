import { z } from "zod";
import { getTimeZone } from "../config";
import {
  createGearReminder,
  type IntervalsGear,
  type IntervalsGearReminder,
  listGear,
  updateGear as putGear,
  resetGearReminder,
} from "../intervalsClient";
import {
  describeGearOptions,
  findGear,
  isGearRetired,
} from "../utils/activityWrite";
import { todayLocal } from "../utils/localDate";
import { WRITE_DESTRUCTIVE } from "./_annotations";
import {
  isDefiniteWriteRejection,
  noteToolFailure,
  toolErrorText,
} from "./_errors";
import { type GearReminderEntry, mapGear, mapGearReminder } from "./listGear";
import { GearWriteOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "update-gear";

const description = `
Retires a gear item (shoes) or puts it back in use, or adds or resets a
distance reminder on it, in intervals.icu. It writes data: confirm the exact
change with the athlete first. Get gear and reminder ids from list-gear. To
put gear on an activity, use update-activity.

Notes:
- Give exactly one of retired, addReminderKm or resetReminderId: one call
  makes one change.
- retired: true retires the item today, in the configured time zone.
- The reply shows how much usage intervals.icu already counts toward a new
  reminder. Resetting a reminder restarts its count from now.
- A reminder with the same name and distance as one the item already has is
  refused, so a repeated call adds no duplicate.
- It reads the gear list fresh, sends one write (never retried), then
  re-reads and echoes before and after values.
- If the write times out, or anything fails after it was sent, the gear may
  already be updated. The response says so: check with list-gear before
  sending the same change again.
`;

const MAX_REMINDER_KM = 100_000;

const inputSchema = z
  .object({
    gearId: z
      .string()
      .min(1)
      .describe("Gear id to change, e.g. '71459', from list-gear."),
    retired: z
      .boolean()
      .optional()
      .describe(
        "true retires the item today; false puts a retired item back in use.",
      ),
    addReminderKm: z
      .number()
      .positive()
      .max(MAX_REMINDER_KM)
      .optional()
      .describe(
        "Adds a reminder that fires after this many km of use, e.g. 700.",
      ),
    reminderName: z
      .string()
      .refine((value) => value.trim().length > 0, {
        message: "reminderName must not be empty or whitespace-only.",
      })
      .optional()
      .describe(
        "Name for the new reminder, e.g. 'Replace shoes'. Defaults to the distance, e.g. '700 km'. Requires addReminderKm.",
      ),
    resetReminderId: z
      .number()
      .int()
      .optional()
      .describe(
        "Reminder id from list-gear whose usage count restarts from now.",
      ),
  })
  .superRefine((data, ctx) => {
    const actions = [
      data.retired,
      data.addReminderKm,
      data.resetReminderId,
    ].filter((value) => value !== undefined);
    if (actions.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message:
          "Give exactly one of retired, addReminderKm or resetReminderId: one call makes one change.",
      });
    }
    if (data.reminderName !== undefined && data.addReminderKm === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reminderName"],
        message: "reminderName requires addReminderKm to also be set.",
      });
    }
  });

type UpdateGearInput = z.infer<typeof inputSchema>;

type GearAction = "retire" | "unretire" | "add_reminder" | "reset_reminder";

interface GearChange {
  field: string;
  before: string | number | null;
  after: string | number | null;
}

/** The retirement date, or null while in use; a boolean `retired` (see
 * `IntervalsGearSchema`) reads as "retired" with no date. */
function retiredValue(gear: IntervalsGear): string | null {
  if (!isGearRetired(gear.retired)) return null;
  return typeof gear.retired === "string" ? gear.retired : "retired";
}

function gearLabel(gear: IntervalsGear): string {
  return `"${gear.name ?? "Gear"}" [${gear.id}]`;
}

/** "700 km" with no trailing ".0", the default reminder name. */
function kmText(km: number): string {
  return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
}

/** '3 "Replace shoes": 700.0 km, 62.0 km used (9%)'. */
function describeReminder(reminder: GearReminderEntry): string {
  const id = reminder.id !== undefined ? `${reminder.id} ` : "";
  const parts: string[] = [];
  if (reminder.distance_km !== undefined)
    parts.push(`${reminder.distance_km.toFixed(1)} km`);
  if (reminder.distance_used_km !== undefined) {
    const percent =
      reminder.percent_used !== undefined
        ? ` (${Math.round(reminder.percent_used)}%)`
        : "";
    parts.push(`${reminder.distance_used_km.toFixed(1)} km used${percent}`);
  }
  return `${id}"${reminder.name ?? "unnamed"}"${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`;
}

function describeReminderOptions(reminders: IntervalsGearReminder[]): string {
  if (reminders.length === 0) return "it has no reminders";
  return `its reminders are ${reminders.map((r) => describeReminder(mapGearReminder(r))).join("; ")}`;
}

export const updateGearTool = {
  name,
  title: "Update gear",
  description,
  inputSchema,
  annotations: WRITE_DESTRUCTIVE,
  outputSchema: GearWriteOutputSchema,
  execute: async (input: UpdateGearInput, apiKey: string) => {
    const { gearId, retired, addReminderKm, resetReminderId } = input;
    const action: GearAction =
      retired !== undefined
        ? retired
          ? "retire"
          : "unretire"
        : addReminderKm !== undefined
          ? "add_reminder"
          : "reset_reminder";

    // Tracks whether the write itself resolved: once true, any later
    // failure means the write cannot be confirmed, not that it failed.
    let written = false;

    try {
      const beforeList = await listGear(apiKey, { skipCache: true });
      const before = findGear(gearId, beforeList);
      if (!before) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ Unknown gear id "${gearId}". Available gear: ${describeGearOptions(beforeList)}.`,
            },
          ],
          isError: true,
        };
      }
      const beforeReminders = before.reminders ?? [];

      // Each branch checks its precondition against the fresh read, then
      // names the one write it sends.
      let send: () => Promise<unknown>;
      let reminderName: string | undefined;
      let reminderMetres: number | undefined;
      if (action === "retire" || action === "unretire") {
        const wantRetired = action === "retire";
        if (isGearRetired(before.retired) === wantRetired) {
          const structured = {
            action,
            gear: mapGear(before),
            changes: [],
            warnings: [],
          };
          warnOnSchemaDrift(name, GearWriteOutputSchema, structured);
          return {
            content: [
              {
                type: "text" as const,
                text: `No change: gear ${gearLabel(before)} is already ${wantRetired ? "retired" : "in use"}.`,
              },
            ],
            structuredContent: structured,
          };
        }
        const value = wantRetired ? todayLocal(getTimeZone()) : "";
        send = () => putGear(apiKey, gearId, { retired: value });
      } else if (action === "add_reminder") {
        const km = addReminderKm as number;
        reminderMetres = Math.round(km * 1000);
        reminderName = input.reminderName?.trim() || kmText(km);
        const duplicate = beforeReminders.find(
          (r) =>
            (r.name ?? "") === reminderName &&
            Math.round(r.distance ?? 0) === reminderMetres,
        );
        if (duplicate) {
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ Gear ${gearLabel(before)} already has the reminder ${describeReminder(mapGearReminder(duplicate))}. Nothing was added. To restart its count, use resetReminderId.`,
              },
            ],
            isError: true,
          };
        }
        const reminder = { name: reminderName, distance: reminderMetres };
        send = () => createGearReminder(apiKey, gearId, reminder);
      } else {
        const id = resetReminderId as number;
        if (!beforeReminders.some((r) => r.id === id)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ Gear ${gearLabel(before)} has no reminder ${id}: ${describeReminderOptions(beforeReminders)}.`,
              },
            ],
            isError: true,
          };
        }
        send = () => resetGearReminder(apiKey, gearId, id);
      }

      try {
        await send();
      } catch (writeError) {
        if (isDefiniteWriteRejection(writeError)) throw writeError;
        const detail =
          writeError instanceof Error ? writeError.message : String(writeError);
        noteToolFailure(writeError);
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ The change to gear ${gearId} may already have been applied (${detail}). Check with list-gear before retrying; do not resend the same change blindly.`,
            },
          ],
          isError: true,
        };
      }
      written = true;

      // Fresh re-read: confirms what intervals.icu actually stored.
      const after = findGear(
        gearId,
        await listGear(apiKey, { skipCache: true }),
      );
      if (!after) {
        throw new Error(`gear ${gearId} is missing from the re-read gear list`);
      }
      const afterReminders = after.reminders ?? [];

      const changes: GearChange[] = [];
      const warnings: string[] = [];
      let summary: string;

      if (action === "retire" || action === "unretire") {
        const wantRetired = action === "retire";
        changes.push({
          field: "retired",
          before: retiredValue(before),
          after: retiredValue(after),
        });
        if (isGearRetired(after.retired) !== wantRetired) {
          warnings.push(
            `retired was not applied: the gear now shows ${retiredValue(after) ?? "in use"}.`,
          );
        }
        summary = wantRetired
          ? `Retired gear ${gearLabel(after)}${retiredValue(after) ? ` on ${retiredValue(after)}` : ""}.`
          : `Put gear ${gearLabel(after)} back in use (was retired ${retiredValue(before)}).`;
      } else if (action === "add_reminder") {
        changes.push({
          field: "reminders",
          before: beforeReminders.length,
          after: afterReminders.length,
        });
        // The duplicate check above means no reminder with this name and
        // distance existed before the write.
        const added = afterReminders.find(
          (r) =>
            (r.name ?? "") === reminderName &&
            Math.round(r.distance ?? 0) === reminderMetres,
        );
        if (added) {
          summary = `Added reminder ${describeReminder(mapGearReminder(added))} to gear ${gearLabel(after)}.`;
        } else {
          warnings.push(
            `the new reminder was not found on the re-read: sent "${reminderName}" at ${kmText((reminderMetres ?? 0) / 1000)}.`,
          );
          summary = `Sent a reminder "${reminderName}" to gear ${gearLabel(after)}.`;
        }
      } else {
        const id = resetReminderId as number;
        const old = beforeReminders.find((r) => r.id === id);
        const now = afterReminders.find((r) => r.id === id);
        changes.push({
          field: "last_reset",
          before: old?.last_reset ?? null,
          after: now?.last_reset ?? null,
        });
        if (!now) {
          warnings.push(`reminder ${id} is missing from the re-read.`);
        } else if ((now.last_reset ?? null) === (old?.last_reset ?? null)) {
          warnings.push(
            `the reset could not be confirmed: last_reset still shows ${now.last_reset ?? "nothing"}.`,
          );
        }
        summary = `Reset reminder ${now ? describeReminder(mapGearReminder(now)) : id} on gear ${gearLabel(after)}.`;
      }

      const structured = {
        action,
        gear: mapGear(after),
        changes,
        warnings,
      };
      warnOnSchemaDrift(name, GearWriteOutputSchema, structured);
      const warningText =
        warnings.length > 0 ? ` Warning: ${warnings.join(" ")}` : "";

      return {
        content: [{ type: "text" as const, text: `${summary}${warningText}` }],
        structuredContent: structured,
      };
    } catch (error) {
      if (written) {
        const detail = error instanceof Error ? error.message : String(error);
        noteToolFailure(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ The change to gear ${gearId} was sent and may have been applied, but confirming it afterward failed: ${detail}. Check with list-gear before retrying; do not resend the same change blindly.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, {
              context: `update gear ${gearId}`,
              notFound: `Gear ${gearId} was not found.`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};
