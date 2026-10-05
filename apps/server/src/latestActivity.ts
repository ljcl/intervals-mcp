/**
 * `id: "latest"` (any activity-id input but update-activity's): the athlete's
 * newest Run, TrailRun or VirtualRun in the last 366 days. Resolved here,
 * once per call, by `dispatchToolCall` after validation and before the
 * handler, so no handler ever sees the word.
 */
import { getTimeZone } from "./config";
import { listActivities } from "./intervalsClient";
import { addDays, todayLocal } from "./utils/localDate";
import { matchesTypeFilter } from "./utils/running";

const LOOKBACK_DAYS = 366;

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
 * `args` with every `idKeys` value equal to "latest" replaced by the newest
 * run's id. Returns `args` itself, with no request, when none says latest.
 * The listing read is cached by FetchClient, so repeat calls are free.
 */
export async function resolveLatestIds(
  args: Record<string, unknown>,
  idKeys: readonly string[],
  apiKey: string,
): Promise<Record<string, unknown>> {
  const keys = idKeys.filter((key) => args[key] === "latest");
  if (keys.length === 0) return args;
  const newest = todayLocal(getTimeZone());
  const activities = await listActivities(apiKey, {
    oldest: addDays(newest, -(LOOKBACK_DAYS - 1)),
    newest,
  });
  // listActivities returns newest first.
  const run = activities.find((a) => matchesTypeFilter(a.type ?? "", "runs"));
  if (!run) throw new NoLatestRunError();
  const out = { ...args };
  for (const key of keys) out[key] = run.id;
  return out;
}
