/**
 * Apply a simple moving average to specified numeric keys.
 * Window shrinks at boundaries so no data is lost.
 * All non-smoothed fields are copied as-is.
 *
 * A key that is `undefined` on a point (the property is not part of that
 * point's shape at all) is left untouched. A key that is `null` (a real
 * sensor gap) is treated as missing for the purposes of the average: it is
 * excluded from the window sum, and the smoothed output at that position is
 * the mean of the window's non-null values, or `null` when the window has
 * none. Smoothing never fabricates a value where every sample is a gap.
 */
export function smooth<T extends object>(
  points: T[],
  numericKeys: readonly (keyof T & string)[],
  windowSize: number,
): T[] {
  const len = points.length;
  if (len < 3) return points;
  const half = Math.floor(windowSize / 2);

  return points.map((pt, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(len - 1, i + half);
    const smoothed = { ...pt };

    for (const key of numericKeys) {
      const own = pt[key] as number | null | undefined;
      if (own === undefined) {
        continue;
      }
      let sum = 0;
      let count = 0;
      for (let j = lo; j <= hi; j += 1) {
        const v = points[j]![key] as number | null | undefined;
        if (v !== null && v !== undefined) {
          sum += v;
          count += 1;
        }
      }
      // biome-ignore lint/suspicious/noExplicitAny: generic smoothing over dynamic keys
      (smoothed as any)[key] = count > 0 ? sum / count : null;
    }
    return smoothed;
  });
}
