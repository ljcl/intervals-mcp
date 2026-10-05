/**
 * Pure helpers for reading and comparing a vitest config's
 * `coverage.thresholds` block, shared by two callers (#62):
 *
 * - `coverage-ratchet-guard.ts` wraps a `vitest run --coverage` invocation
 *   and restores any threshold vitest's own `autoUpdate` wrote below its
 *   value from before the run, so `test:coverage` never lowers a threshold
 *   on disk.
 * - `check-coverage-thresholds.ts` is the CI step: it fails a PR that
 *   lowers a committed threshold versus `origin/main`, and warns (without
 *   failing) when a threshold could rise but the PR has not committed it.
 *
 * Why a wrapper is needed at all: vitest's `thresholds.autoUpdate` callback
 * is called as `autoUpdate(newlyMeasuredValue)`, one argument, the actual
 * coverage percentage that just beat the current threshold. It is not
 * passed the previous threshold, nor which of statements/branches/
 * functions/lines it is updating (verified against the installed
 * vitest@4.1.11: `node_modules/vitest/dist/chunks/coverage.*.js`, the
 * `updateThresholds` loop calls `thresholdFormatter(newValue)` with nothing
 * else). So a config cannot floor its own rewrite against its prior value
 * from inside `autoUpdate`, there is nothing to compare against. Both
 * scripts here read and compare the config file's text instead.
 */

export const THRESHOLD_KEYS = [
  "statements",
  "branches",
  "functions",
  "lines",
] as const;

export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];

export type Thresholds = Partial<Record<ThresholdKey, number>>;

/**
 * Extracts the numeric `coverage.thresholds.<key>` values from a vitest
 * config file's source text. Returns `null` when the file has no
 * `thresholds: { ... }` block (no coverage gate configured) or none of the
 * four keys appear inside it.
 */
export function parseThresholds(source: string): Thresholds | null {
  const body = source.match(/thresholds:\s*{([^}]*)}/s)?.[1];
  if (body === undefined) return null;

  const result: Thresholds = {};
  for (const key of THRESHOLD_KEYS) {
    const match = body.match(new RegExp(`\\b${key}:\\s*(-?\\d+(?:\\.\\d+)?)`));
    if (match) result[key] = Number(match[1]);
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * True when the source text mentions a `thresholds:` key at all, even if
 * `parseThresholds` returned `null` for it. Lets a caller tell "no coverage
 * gate configured" (no mention at all) apart from "gate present but broken"
 * (mentioned, but unparseable, e.g. an emptied block or a malformed edit),
 * which callers should treat differently.
 */
export function mentionsThresholds(source: string): boolean {
  return /\bthresholds\s*:/.test(source);
}

/**
 * Rewrites `key: <value>` for each key in `updates`, scoped to the
 * `thresholds: { ... }` block only (so a coincidental `statements:` outside
 * that block, if one ever existed, is left alone). Keys not present in
 * `updates` are left untouched; a config with no `thresholds` block is
 * returned unchanged.
 */
export function applyThresholds(source: string, updates: Thresholds): string {
  const block = source.match(/thresholds:\s*{[^}]*}/s);
  if (!block) return source;

  let updatedBlock = block[0];
  for (const key of THRESHOLD_KEYS) {
    const value = updates[key];
    if (value === undefined) continue;
    updatedBlock = updatedBlock.replace(
      new RegExp(`(\\b${key}:\\s*)(-?\\d+(?:\\.\\d+)?)`),
      `$1${value}`,
    );
  }
  return source.replace(block[0], updatedBlock);
}

export interface ThresholdComparison {
  lowered: ThresholdKey[];
  raised: ThresholdKey[];
}

/**
 * Compares `next` against `base` key by key. A key present in `base` but
 * missing from `next` counts as lowered: removing a floor is a regression
 * the same as dropping its number would be. A key missing from `base` has
 * no prior value to be lower than, so it is skipped (adding a new
 * threshold is never a regression).
 */
export function compareThresholds(
  base: Thresholds,
  next: Thresholds,
): ThresholdComparison {
  const lowered: ThresholdKey[] = [];
  const raised: ThresholdKey[] = [];
  for (const key of THRESHOLD_KEYS) {
    const b = base[key];
    if (b === undefined) continue;
    const n = next[key];
    if (n === undefined) {
      lowered.push(key);
      continue;
    }
    if (n < b) lowered.push(key);
    else if (n > b) raised.push(key);
  }
  return { lowered, raised };
}

/**
 * Explains why a config that had a parseable `coverage.thresholds` block on
 * some base ref no longer has one at HEAD, a regression whatever the cause.
 * `headSource` is HEAD's raw file content, or `null` when the file does not
 * exist there at all (deleted, or renamed to a different path). Callers
 * should treat every branch here as a lowering; this only picks the message.
 */
export function describeVanishedThresholds(
  path: string,
  headSource: string | null,
): string {
  if (headSource === null) {
    return `${path} no longer exists at HEAD (deleted or renamed)`;
  }
  if (!mentionsThresholds(headSource)) {
    return `${path}'s coverage.thresholds gate was removed`;
  }
  return `${path} mentions thresholds but none parsed at HEAD`;
}

/**
 * Given `before`/`after` snapshots of the same config's thresholds taken
 * either side of a coverage run, returns the values that must be restored
 * to keep the ratchet monotonic: any key `after` holds below its `before`
 * value. Empty when the run only raised thresholds or left them alone.
 */
export function restoreLowered(
  before: Thresholds,
  after: Thresholds,
): Thresholds {
  const restored: Thresholds = {};
  for (const key of THRESHOLD_KEYS) {
    const b = before[key];
    const a = after[key];
    if (b !== undefined && a !== undefined && a < b) restored[key] = b;
  }
  return restored;
}
