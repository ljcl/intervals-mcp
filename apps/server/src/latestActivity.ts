/**
 * `id: "latest"` (any activity-id input but update-activity's): the athlete's
 * newest Run, TrailRun or VirtualRun in the last 366 days. Resolved here,
 * once per call, by `dispatchToolCall` after validation and before the
 * handler, so no handler ever sees the word.
 */
import { getTimeZone } from "./config";
import { listActivities } from "./intervalsClient";
import { NO_PROGRESS, type ReportProgress } from "./progress";
import { addDays, todayLocal } from "./utils/localDate";
import { matchesTypeFilter } from "./utils/running";

const LOOKBACK_DAYS = 366;

/** One intervals.icu listing window, the most `listActivities` reads per request. */
const WINDOW_DAYS = 31;

/** No run in the lookback window to stand in for "latest". */
export class NoLatestRunError extends Error {
  constructor() {
    super(
      `No run in the last ${LOOKBACK_DAYS} days to use for "latest"; pass an id from list-activities.`,
    );
    this.name = "NoLatestRunError";
  }
}

/**
 * The newest run's id, walking 31-day windows newest first and stopping at
 * the first window with a run. The newest run is almost always in the first
 * window, so a cold lookup is one request rather than the twelve a single
 * 366-day listing would make. Each window goes through `listActivities`, so
 * its own cache entry applies.
 */
async function newestRunId(
  apiKey: string,
  progress: ReportProgress,
): Promise<string> {
  const today = todayLocal(getTimeZone());
  const floor = addDays(today, -(LOOKBACK_DAYS - 1));
  for (let newest = today; newest >= floor; ) {
    const windowOldest = addDays(newest, -(WINDOW_DAYS - 1));
    const oldest = windowOldest < floor ? floor : windowOldest;
    if (newest !== today)
      progress(`Looking for your latest run, ${oldest} to ${newest}…`);
    const activities = await listActivities(
      apiKey,
      { oldest, newest },
      progress,
    );
    // listActivities returns newest first.
    const run = activities.find((a) => matchesTypeFilter(a.type ?? "", "runs"));
    if (run) return run.id;
    newest = addDays(oldest, -1);
  }
  throw new NoLatestRunError();
}

/**
 * `args` with every `idKeys` value equal to "latest" replaced by the newest
 * run's id, looked up once however many keys say latest. Returns `args`
 * itself, with no request, when none does.
 */
export async function resolveLatestIds(
  args: Record<string, unknown>,
  idKeys: readonly string[],
  apiKey: string,
  progress: ReportProgress = NO_PROGRESS,
): Promise<Record<string, unknown>> {
  const keys = idKeys.filter((key) => args[key] === "latest");
  if (keys.length === 0) return args;
  const id = await newestRunId(apiKey, progress);
  const out = { ...args };
  for (const key of keys) out[key] = id;
  return out;
}

/**
 * Tool-result `_meta` key reporting which ids a call's `"latest"` resolved to,
 * as `{ [argName]: id }`. An MCP App reads it to pin the run it first showed.
 * `packages/ui` declares the same string (packages cannot import the server);
 * `latestActivity.test.ts` asserts the literal.
 */
export const RESOLVED_ARGS_META_KEY = "intervals-mcp/resolvedArgs";

/** The keys whose value `resolveLatestIds` changed, with their new values. */
export function resolvedArgsOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(after).filter(([key, value]) => before[key] !== value),
  );
}

/**
 * `result` with `resolved` merged into its `_meta` under
 * {@link RESOLVED_ARGS_META_KEY}. Returns `result` itself when nothing was
 * resolved or the call failed (an error carries no pin).
 */
export function withResolvedArgs<
  T extends { content: unknown; isError?: boolean; _meta?: unknown },
>(result: T, resolved: Record<string, unknown>): T {
  if (result.isError || Object.keys(resolved).length === 0) return result;
  const meta =
    typeof result._meta === "object" && result._meta !== null
      ? (result._meta as Record<string, unknown>)
      : {};
  return { ...result, _meta: { ...meta, [RESOLVED_ARGS_META_KEY]: resolved } };
}
