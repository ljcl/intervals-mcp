/**
 * Resolving a time or distance window to brush indices.
 *
 * The `set-brush-window` view tool lets the model zoom the chart to the part
 * of the run being discussed — "the surge in the last kilometre" — instead of
 * asking the user to drag the handles there themselves. Recharts' `Brush` is
 * controlled by *indices*, so the whole job is turning a value range on the
 * axis into the index range that covers it.
 *
 * Kept pure and separate from the component for the usual reason: the
 * off-by-one at the ends is the part worth testing, and it is invisible inside
 * a chart.
 */

export interface BrushRange {
  startIndex: number;
  endIndex: number;
}

/**
 * The index range covering `[from, to]` in a non-decreasing series of axis
 * values (seconds for time, metres for distance).
 *
 * Returns null when the window lies entirely outside the recorded range —
 * asking for 40–50 km of a 10 km run is a mistake worth reporting, not a
 * reason to show the finish. A window that overhangs one end is clamped,
 * since "the last 2 km" of a 1.5 km run is a loose but reasonable ask.
 *
 * Gaps are tolerated (`undefined` values, e.g. a distance stream that starts
 * late) by skipping them rather than treating them as zero, which would drag
 * the window back to the start of the activity.
 */
export function indexRangeForValues(
  values: readonly (number | undefined)[],
  from: number,
  to: number,
): BrushRange | null {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);

  let firstDefined = -1;
  let lastDefined = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === undefined) continue;
    if (firstDefined === -1) firstDefined = i;
    lastDefined = i;
  }
  if (firstDefined === -1) return null;
  if (hi < values[firstDefined]! || lo > values[lastDefined]!) return null;

  let startIndex = -1;
  let endIndex = -1;
  for (let i = firstDefined; i <= lastDefined; i++) {
    const v = values[i];
    if (v === undefined) continue;
    if (startIndex === -1 && v >= lo) startIndex = i;
    if (v <= hi) endIndex = i;
  }
  if (startIndex === -1) startIndex = lastDefined;
  if (endIndex < startIndex) endIndex = startIndex;

  // A window narrower than the sample spacing collapses onto one index, which
  // Recharts renders as an empty brush. Widen by one sample so there is a
  // window to look at, preferring to grow forwards.
  if (endIndex === startIndex) {
    if (endIndex < lastDefined) endIndex += 1;
    else if (startIndex > firstDefined) startIndex -= 1;
  }

  return { startIndex, endIndex };
}

/** The value axis a window is read on. */
export type ZoomAxis = "distance" | "time";

/**
 * How a brush window reads in words, or null when the whole activity is
 * shown.
 *
 * Phrased on the axis the caller names. The context summary passes the axis
 * the brush is actually controlling (distance for swims, time otherwise) so
 * it matches the tick labels under it; `set-brush-window` passes the axis the
 * model asked in, so a window given in seconds is answered in seconds even
 * on a swim (#65). Both go through here, so a call and the state reported
 * back cannot describe the same window in different units by accident.
 */
export function describeZoomWindow(
  points: ReadonlyArray<{ time: number; distance?: number }>,
  axis: ZoomAxis,
  range: { startIndex?: number; endIndex?: number },
  formatTime: (seconds: number) => string,
): string | null {
  const { startIndex, endIndex } = range;
  if (startIndex === undefined || endIndex === undefined) return null;
  // The full range is not a zoom; saying "zoomed to 0:00–1:12:04" of a
  // 1:12:04 run is noise in every turn of the conversation.
  if (startIndex <= 0 && endIndex >= points.length - 1) return null;

  const from = points[startIndex];
  const to = points[endIndex];
  if (!from || !to) return null;

  if (axis === "distance") {
    if (from.distance === undefined || to.distance === undefined) return null;
    return `${(from.distance / 1000).toFixed(2)}–${(to.distance / 1000).toFixed(2)} km`;
  }
  return `${formatTime(from.time)}–${formatTime(to.time)}`;
}
