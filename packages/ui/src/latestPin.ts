import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Tool-result `_meta` key carrying the ids a call's `"latest"` resolved to,
 * as `{ [argName]: id }`. Its home is `RESOLVED_ARGS_META_KEY` in
 * `apps/server/src/latestActivity.ts`; packages cannot import the server, so
 * the string is repeated here and `latestPin.test.ts` pins the literal.
 */
export const RESOLVED_ARGS_META_KEY = "intervals-mcp/resolvedArgs";

/**
 * How long an app opened with `"latest"` waits for the tool result that names
 * the run before it fetches with the word itself. A host that never sends
 * tool results then costs this delay, not a chart.
 */
export const LATEST_PIN_WAIT_MS = 1_500;

/**
 * The id arguments an app's `parseToolInput` normalises to, and the only ones
 * the server resolves `"latest"` in.
 */
const LATEST_ID_KEYS = ["id", "activityId1", "activityId2"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The resolved ids a tool result reports, or null when it reports none. */
export function resolvedArgsOf(result: {
  _meta?: unknown;
}): Record<string, unknown> | null {
  if (!isRecord(result._meta)) return null;
  const resolved = result._meta[RESOLVED_ARGS_META_KEY];
  return isRecord(resolved) ? resolved : null;
}

/** Whether any id argument still says `"latest"`. */
export function hasLatestId(args: unknown): boolean {
  if (!isRecord(args)) return false;
  return LATEST_ID_KEYS.some((key) => args[key] === "latest");
}

/**
 * `args` with each `"latest"` the server resolved replaced by its id. An id
 * that was not `"latest"` is never overwritten. Returns `args` itself when
 * nothing changes.
 */
export function pinResolvedArgs<TArgs>(
  args: TArgs,
  resolved: Record<string, unknown>,
): TArgs {
  if (!isRecord(args)) return args;
  const pinned: Record<string, unknown> = { ...args };
  let changed = false;
  for (const [key, id] of Object.entries(resolved)) {
    if (args[key] === "latest" && id !== "latest") {
      pinned[key] = id;
      changed = true;
    }
  }
  return changed ? (pinned as TArgs) : args;
}

export interface LatestPin<TArgs> {
  /** The parsed args with any resolved `"latest"` replaced by its id. */
  toolArgs: TArgs | null;
  /**
   * True while an id argument is `"latest"`, no tool result has arrived, and
   * {@link LATEST_PIN_WAIT_MS} has not passed. An app does not fetch yet.
   */
  pendingLatest: boolean;
  /** Feed every tool result here. Stable across renders. */
  onToolResult: (result: { _meta?: unknown }) => void;
}

/**
 * Pins an app opened with `id: "latest"` to the run it first showed. The view
 * tool's result names the run through {@link RESOLVED_ARGS_META_KEY}; without
 * the pin a re-mounted view (the chat reopened) would resolve the word again
 * and could show a newer run than the one the model described.
 */
export function useLatestPin<TArgs>(
  parsedArgs: TArgs | null,
): LatestPin<TArgs> {
  const [resolved, setResolved] = useState<Record<string, unknown> | null>(
    null,
  );
  const [resultArrived, setResultArrived] = useState(false);
  const [waitExpired, setWaitExpired] = useState(false);

  const onToolResult = useCallback((result: { _meta?: unknown }) => {
    const next = resolvedArgsOf(result);
    // A later result without the key does not undo an earlier pin.
    if (next) setResolved(next);
    setResultArrived(true);
  }, []);

  const toolArgs = useMemo(
    () =>
      parsedArgs !== null && resolved
        ? pinResolvedArgs(parsedArgs, resolved)
        : parsedArgs,
    [parsedArgs, resolved],
  );

  const awaitingResult = !resultArrived && hasLatestId(toolArgs);

  useEffect(() => {
    if (!awaitingResult || waitExpired) return;
    const timer = setTimeout(() => setWaitExpired(true), LATEST_PIN_WAIT_MS);
    return () => clearTimeout(timer);
  }, [awaitingResult, waitExpired]);

  return {
    toolArgs,
    pendingLatest: awaitingResult && !waitExpired,
    onToolResult,
  };
}
