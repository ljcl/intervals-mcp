import {
  type IntervalsActivityUpdate,
  type IntervalsGear,
} from "../intervalsClient";

export type DescriptionMode = "append" | "replace";

/**
 * Resolves the final description string to send to intervals.icu.
 * Replace overwrites; append preserves any existing description, separated
 * by a blank line.
 */
export function composeDescription(
  existing: string | null | undefined,
  incoming: string,
  mode: DescriptionMode,
): string {
  if (mode === "replace") {
    return incoming;
  }
  if (!existing || existing.trim() === "") {
    return incoming;
  }
  return `${existing}\n\n${incoming}`;
}

/**
 * The existing description text that writing `next` would lose, or `null`
 * when nothing is lost: the existing text is empty or whitespace-only, or
 * `next` already contains it (compared trimmed).
 */
export function discardedDescription(
  existing: string | null | undefined,
  next: string | null | undefined,
): string | null {
  if (!existing || existing.trim() === "") return null;
  return (next ?? "").includes(existing.trim()) ? null : existing;
}

/**
 * True when intervals.icu's `retired` field represents an actual
 * retirement. The OpenAPI spec types it as a string (a retirement date), but
 * a boolean is accepted defensively too (see `IntervalsGearSchema`);
 * `null`/`undefined`/empty string mean active.
 */
export function isGearRetired(
  retired: string | boolean | null | undefined,
): boolean {
  if (typeof retired === "boolean") return retired;
  return typeof retired === "string" && retired.trim() !== "";
}

/** Finds one gear entry by id in the athlete's gear list. */
export function findGear(
  gearId: string,
  gear: readonly IntervalsGear[],
): IntervalsGear | undefined {
  return gear.find((g) => g.id === gearId);
}

/**
 * Renders the athlete's gear as "id (name)" pairs for an unknown-gearId
 * error, so the caller can pick a valid one without a second round trip.
 */
export function describeGearOptions(gear: readonly IntervalsGear[]): string {
  if (gear.length === 0) return "no gear is on file";
  return gear
    .map((g) => {
      const label = g.name ?? "unnamed";
      return isGearRetired(g.retired)
        ? `${g.id} (${label}, retired)`
        : `${g.id} (${label})`;
    })
    .join(", ");
}

/** `null` and `""` both mean "no description"; treating them as equal keeps
 * an explicit clear (`description: ""` in replace mode) from being sent as a
 * no-op change when the activity already has no description. */
function normalizeDescription(value: string | null | undefined): string {
  return value ?? "";
}

/** The activity fields update-activity reads, writes, and echoes. */
export interface CurrentActivityFields {
  name: string | null;
  description: string | null;
  gearId: string | null;
  rpe: number | null;
  feel: number | null;
}

/** The fields a caller asked to change, already resolved (description has
 * already gone through `composeDescription`). */
export interface RequestedActivityFields {
  name?: string;
  description?: string;
  gearId?: string;
  rpe?: number;
  feel?: number;
}

/**
 * Builds the PUT patch, keeping only fields whose requested value differs
 * from `current`; a value that already matches is left out, so the write
 * never re-sends an unchanged field.
 */
export function buildActivityPatch(
  requested: RequestedActivityFields,
  current: CurrentActivityFields,
): IntervalsActivityUpdate {
  const patch: IntervalsActivityUpdate = {};
  if (requested.name !== undefined && requested.name !== current.name) {
    patch.name = requested.name;
  }
  if (
    requested.description !== undefined &&
    normalizeDescription(requested.description) !==
      normalizeDescription(current.description)
  ) {
    patch.description = requested.description;
  }
  if (requested.gearId !== undefined && requested.gearId !== current.gearId) {
    patch.gear = { id: requested.gearId };
  }
  if (requested.rpe !== undefined && requested.rpe !== current.rpe) {
    patch.icu_rpe = requested.rpe;
  }
  if (requested.feel !== undefined && requested.feel !== current.feel) {
    patch.feel = requested.feel;
  }
  return patch;
}

export interface ActivityWriteChange {
  field: string;
  before: string | number | null;
  after: string | number | null;
}

/**
 * Diffs the fresh re-read against the pre-write read for exactly the fields
 * in `patch`, and warns for any field whose re-read value does not match
 * what was sent (e.g. gear not applied; see docs/api-notes.md).
 */
export function diffActivityWrite(
  patch: IntervalsActivityUpdate,
  before: CurrentActivityFields,
  after: CurrentActivityFields,
): { changes: ActivityWriteChange[]; warnings: string[] } {
  const changes: ActivityWriteChange[] = [];
  const warnings: string[] = [];

  if (patch.name !== undefined) {
    changes.push({ field: "name", before: before.name, after: after.name });
    if (after.name !== patch.name) {
      warnings.push(
        `name was not applied: sent "${patch.name}", activity now shows ${after.name === null ? "nothing" : `"${after.name}"`}.`,
      );
    }
  }
  if (patch.description !== undefined) {
    changes.push({
      field: "description",
      before: before.description,
      after: after.description,
    });
    if (
      normalizeDescription(after.description) !==
      normalizeDescription(patch.description)
    ) {
      warnings.push("description was not applied as sent.");
    }
  }
  if (patch.gear !== undefined) {
    changes.push({
      field: "gear",
      before: before.gearId,
      after: after.gearId,
    });
    if (after.gearId !== patch.gear.id) {
      warnings.push(
        `gear was not applied: sent "${patch.gear.id}", activity now shows ${after.gearId === null ? "no gear" : `"${after.gearId}"`}.`,
      );
    }
  }
  if (patch.icu_rpe !== undefined) {
    changes.push({ field: "rpe", before: before.rpe, after: after.rpe });
    if (after.rpe !== patch.icu_rpe) {
      warnings.push(
        `rpe was not applied: sent ${patch.icu_rpe}, activity now shows ${after.rpe === null ? "nothing" : after.rpe}.`,
      );
    }
  }
  if (patch.feel !== undefined) {
    changes.push({ field: "feel", before: before.feel, after: after.feel });
    if (after.feel !== patch.feel) {
      warnings.push(
        `feel was not applied: sent ${patch.feel}, activity now shows ${after.feel === null ? "nothing" : after.feel}.`,
      );
    }
  }

  return { changes, warnings };
}
