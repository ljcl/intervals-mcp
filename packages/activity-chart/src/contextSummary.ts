const METRIC_LABELS: Record<string, string> = {
  heartrate: "heart rate",
  power: "power",
  pace: "pace",
  altitude: "altitude",
  cadence: "cadence",
  grade: "grade",
  stanceTime: "ground contact time",
  verticalOscillation: "vertical oscillation",
  verticalRatio: "vertical ratio",
  stepLength: "step length",
};

/** Human name for a metric key, shared with the a11y narration so the
 * model context and the screen reader agree. The pace key reads "pace" or
 * "speed" by sport, so the caller supplies it (`meta.speed.label`, lowercased). */
export function metricLabel(key: string, paceLabel: string): string {
  return key === "pace" ? paceLabel : (METRIC_LABELS[key] ?? key);
}

export interface ChartContextInput {
  activityName: string | null;
  availableMetrics: string[];
  hidden: Set<string>;
  smooth: boolean;
  /** "pace" or "speed" (lowercased `meta.speed.label`), per the sport. */
  paceLabel: string;
  /**
   * The x-axis window currently shown, when zoomed. Echoed back so a
   * model that called `set-brush-window` — or a user who dragged the handles —
   * knows which part of the run the next question is about.
   */
  zoomWindow?: string | null;
  /**
   * Running-dynamics averages (ground contact time, vertical oscillation,
   * vertical ratio, step length), already formatted with units, e.g.
   * "Ground contact time averages 245 ms." Precomputed by the caller from
   * whichever dynamics the activity recorded; omitted entirely when it
   * recorded none, so the model never asks about metrics that aren't there.
   */
  dynamicsSummary?: string | null;
}

export function buildChartContextSummary(
  input: ChartContextInput,
): string | null {
  const {
    activityName,
    availableMetrics,
    hidden,
    smooth,
    paceLabel,
    zoomWindow,
    dynamicsSummary,
  } = input;
  if (!activityName || availableMetrics.length === 0) return null;

  const label = (k: string) => metricLabel(k, paceLabel);
  const shown = availableMetrics.filter((m) => !hidden.has(m)).map(label);
  const off = availableMetrics.filter((m) => hidden.has(m)).map(label);

  const parts = [`Viewing activity "${activityName}".`];
  parts.push(shown.length ? `Showing: ${shown.join(", ")}.` : "Showing: none.");
  if (off.length) parts.push(`Hidden: ${off.join(", ")}.`);
  parts.push(`Smoothing: ${smooth ? "on" : "off"}.`);
  if (zoomWindow) parts.push(`Zoomed to ${zoomWindow}.`);
  if (dynamicsSummary) parts.push(dynamicsSummary);
  return parts.join(" ");
}
