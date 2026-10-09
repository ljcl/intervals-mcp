/**
 * Forgiving argument names and enum values (#78). The same input is spelled
 * several ways across tools (`id`, `activity_id`, `activityId1`,
 * `activity_id_1`; "5K" vs "5km"; `weeks` vs `days`), and a model reuses
 * the spelling from the last tool it called, so each mismatch used to cost
 * a failed call and a retry. The dispatcher runs `normalizeArgs` before
 * validation.
 *
 * Driven by the advertised JSON schema, not a per-tool table, so a new tool
 * gets it for free. It never changes what a host sees: the advertised
 * schemas, and so `tool-surface.lock.json`, are untouched. A rename happens
 * only when the tool's own key is absent, and an enum value is replaced only
 * when exactly one option matches, so anything ambiguous still fails
 * validation with the original value in the message.
 */

import { addDays } from "./utils/localDate";

/** The parts of a tool's advertised input schema the fix-up reads. */
export interface ArgShape {
  keys: string[];
  /** Key → allowed values, for a string enum or an array of them. */
  enums: Map<string, string[]>;
}

interface JsonSchemaProperty {
  enum?: unknown[];
  items?: { enum?: unknown[] };
}

/** Reads an {@link ArgShape} from a tool's advertised JSON input schema. */
export function argShape(inputSchema: {
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}): ArgShape {
  const properties = (inputSchema.properties ?? {}) as Record<
    string,
    JsonSchemaProperty
  >;
  const enums = new Map<string, string[]>();
  for (const [key, property] of Object.entries(properties)) {
    const values = property.enum ?? property.items?.enum;
    if (values?.every((v) => typeof v === "string"))
      enums.set(key, values as string[]);
  }
  return { keys: Object.keys(properties), enums };
}

/**
 * Spellings of the same activity-id input. A key in one group maps to the
 * member of that group the tool takes; groups never map onto each other, so
 * a bare `id` is not guessed into a pair tool's first slot.
 */
const ALIAS_GROUPS: string[][] = [
  ["id", "activity_id", "activityId"],
  ["activityId1", "activity_id_1", "activity_id1", "activityId_1", "id1"],
  ["activityId2", "activity_id_2", "activity_id2", "activityId_2", "id2"],
];

const toCamel = (key: string) =>
  key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const toSnake = (key: string) =>
  key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The tool's own key that `key` is another spelling of, if any. */
function canonicalKey(key: string, keys: readonly string[]): string | null {
  const group = ALIAS_GROUPS.find((g) => g.includes(key));
  const fromGroup = group?.find((member) => keys.includes(member));
  if (fromGroup) return fromGroup;
  for (const candidate of [toCamel(key), toSnake(key)])
    if (candidate !== key && keys.includes(candidate)) return candidate;
  return null;
}

/**
 * Comparison form of an enum value: case, spaces, hyphens and underscores
 * ignored, a trailing "k" read as "km" ("5K" is "5km"), "miles" as "mile".
 */
function labelKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/(\d)k$/, "$1km")
    .replace(/miles$/, "mile");
}

/**
 * `value` in the option's own spelling when exactly one option matches it
 * by {@link labelKey}, else `value` unchanged. Exported for the prompts,
 * which match a typed race distance the same way.
 */
export function matchEnum(value: unknown, options: readonly string[]): unknown {
  if (typeof value !== "string" || options.includes(value)) return value;
  const wanted = labelKey(value);
  const matches = options.filter((option) => labelKey(option) === wanted);
  return matches.length === 1 ? matches[0] : value;
}

/** What the date-range fix-up needs from the caller. */
export interface NormalizeContext {
  /** Today in the configured time zone (YYYY-MM-DD). */
  today: string;
}

/**
 * `args` with alias keys renamed to the tool's own keys and enum values
 * matched to the tool's own spelling. Pure; returns a new object. Without
 * `context` a date range is not turned into a `window`.
 */
export function normalizeArgs(
  args: Record<string, unknown>,
  shape: ArgShape,
  context?: NormalizeContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const target = shape.keys.includes(key)
      ? key
      : canonicalKey(key, shape.keys);
    if (target && target !== key && !(target in args)) out[target] = value;
    else out[key] = value;
  }
  if (context) rangeToWindow(out, shape, context.today);
  weeksToDays(out, shape);
  for (const [key, options] of shape.enums) {
    const value = out[key];
    if (value === undefined) continue;
    out[key] = Array.isArray(value)
      ? value.map((v) => matchEnum(v, options))
      : matchEnum(value, options);
  }
  return out;
}

/**
 * `weeks: n` read as `days: n * 7`, in place, for a tool that takes `days`
 * and not `weeks` when the caller sent no `days`: the windowed tools all
 * take days, and a model asked for "the last 6 weeks" often says so. Unit
 * aware, so unlike a key rename the value changes; a non-numeric `weeks` is
 * left for validation to report.
 */
function weeksToDays(out: Record<string, unknown>, shape: ArgShape): void {
  if (!("weeks" in out) || out.days !== undefined) return;
  if (!shape.keys.includes("days") || shape.keys.includes("weeks")) return;
  const raw = out.weeks;
  if (typeof raw !== "number" && typeof raw !== "string") return;
  const weeks = Number(raw);
  if (raw === "" || !Number.isFinite(weeks)) return;
  out.days = weeks * 7;
  delete out.weeks;
}

/** The range keys {@link rangeToWindow} reads. */
const RANGE_KEYS = ["oldest", "newest", "days", "weeks"];

/** A positive whole count from a number or numeric string, else null. */
function positiveCount(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const n = Number(raw);
  return raw !== "" && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * `oldest`/`newest`/`days`/`weeks` read as `window: "oldest..newest"`, in
 * place, for a tool that takes `window` and none of those keys, when the
 * caller sent no `window` (#151). `get-best-efforts` is the one such tool:
 * every other windowed tool takes the range keys, so a model reuses them,
 * and a successful parse would drop them and answer for the default year.
 *
 * The range ends at `newest`, else today. It starts at `oldest`; else
 * `days` (or `weeks` * 7) days back, inclusive, as the days tools count;
 * else a year back, the length of the default "1y". Dates are passed
 * through unchecked, so a malformed one fails the window's own validation;
 * a count that is not a positive whole number is left alone, and the
 * ignored-arguments note names it.
 */
function rangeToWindow(
  out: Record<string, unknown>,
  shape: ArgShape,
  today: string,
): void {
  if (out.window !== undefined || !shape.keys.includes("window")) return;
  if (RANGE_KEYS.some((key) => shape.keys.includes(key))) return;
  const oldest = typeof out.oldest === "string" ? out.oldest : undefined;
  const newest = typeof out.newest === "string" ? out.newest : undefined;
  const fromDays = positiveCount(out.days);
  const fromWeeks = positiveCount(out.weeks);
  const days = fromDays ?? (fromWeeks === null ? null : fromWeeks * 7);
  if (oldest === undefined && newest === undefined && days === null) return;
  const end = newest ?? today;
  const start = oldest ?? addDays(end, days === null ? -365 : -(days - 1));
  out.window = `${start}..${end}`;
  if (oldest !== undefined) delete out.oldest;
  if (newest !== undefined) delete out.newest;
  // A count is used only when there was no oldest; an unused one stays for
  // the ignored-arguments note.
  if (oldest !== undefined) return;
  if (fromDays !== null) delete out.days;
  else if (fromWeeks !== null) delete out.weeks;
}

/** The keys in `args` the tool does not take, as a quoted list, plus the
 * keys it does; null when every key is known. */
function strayArgs(
  args: Record<string, unknown>,
  shape: ArgShape,
): { label: string; detail: string } | null {
  const unknown = Object.keys(args).filter((k) => !shape.keys.includes(k));
  if (unknown.length === 0) return null;
  const names = unknown.map((k) => `"${k}"`).join(", ");
  const takes =
    shape.keys.length > 0
      ? `this tool takes: ${shape.keys.join(", ")}`
      : "this tool takes no arguments";
  return {
    label: `argument${unknown.length > 1 ? "s" : ""} ${names}`,
    detail: `(${takes})`,
  };
}

/**
 * A sentence naming every argument the tool does not take, and the ones it
 * does, for a failed validation; null when every key is known. The zod
 * message names a missing required key but never the stray key the caller
 * sent instead, which is usually the actual mistake.
 */
export function unknownArgsText(
  args: Record<string, unknown>,
  shape: ArgShape,
): string | null {
  const stray = strayArgs(args, shape);
  return stray ? `Unknown ${stray.label} ${stray.detail}.` : null;
}

/**
 * The same sentence for a call that passed validation: the parse dropped
 * these keys, so the answer did not use them, and the model must hear that
 * rather than read the reply as an answer to what it asked (#151).
 */
export function ignoredArgsText(
  args: Record<string, unknown>,
  shape: ArgShape,
): string | null {
  const stray = strayArgs(args, shape);
  return stray ? `Ignored ${stray.label} ${stray.detail}.` : null;
}
