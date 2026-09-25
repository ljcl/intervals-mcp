/**
 * Apply a simple moving average to specified numeric keys.
 * Window shrinks at boundaries so no data is lost.
 * All non-smoothed fields are copied as-is.
 *
 * A key that is `undefined` on a point (the property is not part of that
 * point's shape at all) is left untouched. A key that is `null` (a real
 * sensor gap) stays `null`: a gap is never filled in, even when the window
 * around it has real neighbours, because that would fabricate a value where
 * there was none. Only a point whose own value is non-null gets smoothed,
 * and its average is taken over the window's non-null values (nulls inside
 * the window are excluded from the sum, not treated as zero).
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
      // A gap stays a gap: never fabricate a value at a null sample, no
      // matter how many real neighbours surround it.
      if (own === undefined || own === null) {
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
      // own is a non-null number and is itself within [lo, hi], so count is
      // always at least 1 here.
      // biome-ignore lint/suspicious/noExplicitAny: generic smoothing over dynamic keys
      (smoothed as any)[key] = sum / count;
    }
    return smoothed;
  });
}
