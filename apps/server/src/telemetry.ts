/**
 * Per-tool-call telemetry.
 *
 * The server ran for months emitting only free-text `console.error`, so there
 * was no way to answer which tool burns the intervals.icu quota, how slow
 * `get-best-efforts` actually is, or how often calls fail. One structured
 * record per call to stderr answers all three, and a rolling in-memory counter
 * backs the authed `/health` view.
 *
 * Deliberately not a metrics library: a single JSON line per call is greppable
 * in `docker compose logs`, which is where this server's operator already is.
 */

import { intervalsApi, type RateLimitSnapshot } from "./fetchClient";

export type ToolOutcome = "ok" | "error" | "not_connected" | "invalid_args";

export interface ToolCallRecord {
  event: "tool_call";
  tool: string;
  /** Wall-clock duration including token resolution, not just the handler. */
  duration_ms: number;
  outcome: ToolOutcome;
  /** Constructor name of the thrown error, when one was thrown. */
  error_class?: string;
  /** intervals.icu quota as of the most recent response, when known
   * (currently always null: intervals.icu sends no rate-limit headers). */
  rate_limit?: RateLimitSnapshot | null;
}

/** Rolling per-tool counters, the shape `/health` exposes. */
export interface ToolCounters {
  calls: number;
  errors: number;
  /** Total duration across calls, for a mean without keeping samples. */
  total_ms: number;
  last_called_at: string;
}

/**
 * Cardinality is bounded by the tool surface (~49 names), but only names the
 * server actually dispatched are held — an unknown-tool call must not be able
 * to grow the map without limit.
 */
const counters = new Map<string, ToolCounters>();

/** The quota as of the last intervals.icu response, or null if it cannot be
 * read. */
function rateLimitSnapshot(): RateLimitSnapshot | null {
  try {
    return intervalsApi.getRateLimitSnapshot();
  } catch {
    return null;
  }
}

/**
 * Emit one structured line, fold the call into the rolling counters, and
 * return the record so a caller can forward the same object to a client.
 */
export function recordToolCall(
  record: Omit<ToolCallRecord, "event">,
): ToolCallRecord {
  const line: ToolCallRecord = {
    event: "tool_call",
    ...record,
    rate_limit: record.rate_limit ?? rateLimitSnapshot(),
  };
  // Telemetry must never be able to fail the call it describes: a throw here
  // would turn a successful tool call into an error for the sake of a log line.
  try {
    console.error(JSON.stringify(line));
  } catch {
    // A record that cannot be serialised is not worth losing the call over.
  }

  const existing = counters.get(record.tool) ?? {
    calls: 0,
    errors: 0,
    total_ms: 0,
    last_called_at: "",
  };
  counters.set(record.tool, {
    calls: existing.calls + 1,
    errors: existing.errors + (record.outcome === "ok" ? 0 : 1),
    total_ms: existing.total_ms + record.duration_ms,
    last_called_at: new Date().toISOString(),
  });

  return line;
}

/** Snapshot of the counters, busiest tool first, for `/health`. */
export function toolCallStats(): Record<
  string,
  ToolCounters & { mean_ms: number }
> {
  const entries = [...counters.entries()]
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([tool, stats]) => [
      tool,
      {
        ...stats,
        mean_ms: stats.calls > 0 ? Math.round(stats.total_ms / stats.calls) : 0,
      },
    ]);
  return Object.fromEntries(entries);
}

/** Test seam: forget every counter. */
export function resetToolCallStats(): void {
  counters.clear();
}
