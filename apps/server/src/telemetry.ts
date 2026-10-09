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

export type ToolOutcome =
  | "ok"
  | "error"
  | "not_connected"
  | "invalid_args"
  | "cancelled";

/** The `error_class` of an `isError` answer that no exception explains, such as a refused argument. */
export const ERROR_RESULT_CLASS = "ToolErrorResult";

/** Longest `tool`, `client_name` or `client_version` the log line keeps. */
const MAX_FIELD_CHARS = 64;

/** The `tool` logged when a name is empty after bounding. */
const UNKNOWN_TOOL = "unknown";

/**
 * What a client can put in a logged string that breaks a log line or hides
 * text from a reader: control characters, format characters such as the
 * bidi override U+202E, and line or paragraph separators.
 */
const LOG_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A client-sent string made safe for one log line: well-formed, stripped of
 * {@link LOG_UNSAFE} characters, trimmed and cut to `max` code points (with
 * an ellipsis). Undefined for a non-string or an empty result.
 */
function boundedLogField(
  value: unknown,
  max = MAX_FIELD_CHARS,
): string | undefined {
  if (typeof value !== "string") return undefined;
  // The pre-slice keeps a huge name cheap. It may cut a surrogate pair, so
  // the high surrogate it leaves behind goes before toWellFormed.
  const cleaned = value
    .slice(0, max * 4)
    .replace(/[\uD800-\uDBFF]$/, "")
    .toWellFormed()
    .replace(LOG_UNSAFE, "")
    .trim();
  if (cleaned === "") return undefined;
  const chars = Array.from(cleaned);
  return chars.length <= max
    ? cleaned
    : `${chars.slice(0, max - 1).join("")}\u2026`;
}

/** The W3C trace context ids a client sent. */
export interface TraceIds {
  trace_id: string;
  parent_id: string;
}

const TRACEPARENT =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const MAX_TRACEPARENT_CHARS = 256;

/**
 * The ids in a W3C `traceparent` value, or undefined when it is not one. A
 * version 00 value has exactly four fields; a later version may add more.
 */
export function parseTraceparent(value: unknown): TraceIds | undefined {
  if (typeof value !== "string" || value.length > MAX_TRACEPARENT_CHARS) {
    return undefined;
  }
  const match = TRACEPARENT.exec(value);
  if (!match) return undefined;
  const [, version, traceId, parentId, , rest] = match;
  if (version === "ff" || (version === "00" && rest !== undefined)) {
    return undefined;
  }
  if (/^0+$/.test(traceId!) || /^0+$/.test(parentId!)) return undefined;
  return { trace_id: traceId!, parent_id: parentId! };
}

export interface ToolCallRecord {
  event: "tool_call";
  /** When the call finished, as an ISO timestamp. The call started at `ts` minus `duration_ms`. */
  ts: string;
  tool: string;
  /** Wall-clock duration including token resolution, not just the handler. */
  duration_ms: number;
  outcome: ToolOutcome;
  /**
   * Class of the thrown or translated error, or {@link ERROR_RESULT_CLASS}
   * for an `isError` answer that no exception explains (an argument refusal).
   */
  error_class?: string;
  /** The intervals.icu status behind the failure, when it was an HTTP error. */
  http_status?: number;
  /** intervals.icu quota as of the most recent response that carried it.
   * Null until intervals.icu sends rate-limit headers (it sends none). */
  rate_limit?: RateLimitSnapshot | null;
  /** Whether the request's client advertised MCP Apps (#77). */
  client_apps?: boolean;
  /** clientInfo.name from the request envelope, when sent. Bounded when logged. */
  client_name?: string;
  /** clientInfo.version from the request envelope, when sent. Bounded when logged. */
  client_version?: string;
  /** From a valid W3C `traceparent` in the request's `_meta`. */
  trace_id?: string;
  /** The `traceparent`'s parent-id. */
  parent_id?: string;
}

/** Rolling per-tool counters, the shape `/health` exposes. */
export interface ToolCounters {
  calls: number;
  errors: number;
  /** Calls whose client cancelled or disconnected before the answer. Not counted in `errors`. */
  cancelled: number;
  /** Total duration across calls, for a mean without keeping samples. */
  total_ms: number;
  last_called_at: string;
}

/**
 * Cardinality is bounded by the tool surface (34 names), but only names the
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
 * The log line for `record`, keys in a fixed order and unset fields left out.
 * `tool` is the already bounded name.
 */
function buildLine(
  record: Omit<ToolCallRecord, "event" | "ts">,
  tool: string,
  ts: string,
): ToolCallRecord {
  const clientName = boundedLogField(record.client_name);
  const clientVersion = boundedLogField(record.client_version);
  return {
    event: "tool_call",
    ts,
    tool,
    duration_ms: record.duration_ms,
    outcome: record.outcome,
    ...(record.error_class ? { error_class: record.error_class } : {}),
    ...(record.http_status !== undefined
      ? { http_status: record.http_status }
      : {}),
    rate_limit: record.rate_limit ?? rateLimitSnapshot(),
    ...(record.client_apps !== undefined
      ? { client_apps: record.client_apps }
      : {}),
    ...(clientName ? { client_name: clientName } : {}),
    ...(clientVersion ? { client_version: clientVersion } : {}),
    ...(record.trace_id ? { trace_id: record.trace_id } : {}),
    ...(record.parent_id ? { parent_id: record.parent_id } : {}),
  };
}

/**
 * Emit one structured line, fold the call into the rolling counters, and
 * return the record so a caller can forward the same object to a client.
 */
export function recordToolCall(
  record: Omit<ToolCallRecord, "event" | "ts">,
): ToolCallRecord {
  const ts = new Date().toISOString();
  // An unknown tool's name is the client's text, so it is bounded like the
  // client strings. It also keys the counters, so /health keys stay short.
  const tool = boundedLogField(record.tool) ?? UNKNOWN_TOOL;
  const line = buildLine(record, tool, ts);
  // Telemetry must never be able to fail the call it describes: a throw here
  // would turn a successful tool call into an error for the sake of a log line.
  try {
    console.error(JSON.stringify(line));
  } catch {
    // A record that cannot be serialised is not worth losing the call over.
  }

  const existing = counters.get(tool) ?? {
    calls: 0,
    errors: 0,
    cancelled: 0,
    total_ms: 0,
    last_called_at: "",
  };
  counters.set(tool, {
    calls: existing.calls + 1,
    errors:
      existing.errors +
      (record.outcome === "ok" || record.outcome === "cancelled" ? 0 : 1),
    cancelled: existing.cancelled + (record.outcome === "cancelled" ? 1 : 0),
    total_ms: existing.total_ms + record.duration_ms,
    last_called_at: ts,
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
