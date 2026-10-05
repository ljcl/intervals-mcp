import { type AxisKey, type MetricKey } from "./types";

/** `set-metric` arguments after the registry has dropped the nulls. */
export interface SetMetricArgs {
  metric?: MetricKey;
  axis?: AxisKey;
}

export interface SetMetricOk {
  kind: "ok";
  /** Absent when the call left the metric alone. */
  metric?: MetricKey;
  /** Absent when the call left the axis alone. */
  axis?: AxisKey;
}

export type SetMetricResult = SetMetricOk | { kind: "error"; text: string };

/** The name the view shows for a metric: pace reads "Speed" for a mixed pair. */
export type MetricLabel = (metric: MetricKey) => string;

/** Shown when a side recorded nothing to overlay, so no choice exists. */
export const NOTHING_TO_CHOOSE =
  "These activities have no overlapping streams, so there is no metric or axis to choose.";

const keyLabel: MetricLabel = (metric) => metric;

/**
 * A metric as the model can send it, with the name the view shows beside it
 * where that differs ("heartrate" shows as "heart rate", pace as "speed" for a
 * mixed pair). `note` shapes the parenthesised part.
 */
function sendable(
  metric: MetricKey,
  label: MetricLabel,
  note: (shown: string) => string,
): string {
  const shown = label(metric).toLowerCase();
  return shown === metric ? metric : `${metric} (${note(shown)})`;
}

/**
 * Settle a `set-metric` call against what both activities recorded, before
 * anything on screen changes: either part being unavailable refuses the whole
 * call, so a half-applied change never needs explaining. Refusals name each
 * metric by the value the schema accepts, adding the displayed label only
 * where it differs: the model must be able to send what it is told, and the
 * strict enum rejects "speed" or "heart rate".
 *
 * A side that recorded no streams leaves both lists empty, so there is
 * nothing to list, and the same is true of two sides with no metric in common.
 */
export function resolveSetMetric(
  args: SetMetricArgs,
  metrics: readonly MetricKey[],
  axes: readonly AxisKey[],
  label: MetricLabel = keyLabel,
): SetMetricResult {
  if (metrics.length === 0 || axes.length === 0) {
    return { kind: "error", text: NOTHING_TO_CHOOSE };
  }
  if (args.metric === undefined && args.axis === undefined) {
    return { kind: "error", text: "Pass metric or axis." };
  }

  const problems: string[] = [];
  if (args.metric !== undefined && !metrics.includes(args.metric)) {
    const available = metrics
      .map((m) => sendable(m, label, (shown) => `shown as ${shown}`))
      .join(", ");
    problems.push(
      `These activities did not both record ${sendable(args.metric, label, (shown) => shown)}. Available metrics: ${available}.`,
    );
  }
  if (args.axis !== undefined && !axes.includes(args.axis)) {
    problems.push(
      `These activities cannot be compared by ${args.axis}. Available axes: ${axes.join(", ")}.`,
    );
  }
  if (problems.length > 0) return { kind: "error", text: problems.join(" ") };

  return { kind: "ok", metric: args.metric, axis: args.axis };
}

/**
 * One line telling the model what the overlay now shows. Takes the metric and
 * axis as they will be, not as they were given, so a call that changed only
 * one still describes the whole overlay.
 */
export function describeSetMetric(
  metric: MetricKey,
  axis: AxisKey,
  label: MetricLabel,
): string {
  return `Comparing ${label(metric).toLowerCase()} by ${axis}.`;
}
