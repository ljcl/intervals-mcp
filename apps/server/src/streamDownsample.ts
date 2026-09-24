/**
 * Pure downsampling for intervals.icu activity data streams.
 *
 * A raw stream can carry thousands of samples (one per second); returning
 * every sample would blow past a sane response size and add nothing a model
 * needs. `downsampleColumns` bounds a set of index-aligned columns to at most
 * `maxPoints` contiguous buckets, reducing each bucket to a single
 * representative value.
 *
 * No knowledge of intervals.icu, MCP, or the tool layer lives here: this
 * module only knows about columns of numbers.
 */

export type ColumnValue = number | null;
export type Columns = Record<string, ColumnValue[]>;

/**
 * Keys whose bucket value is the bucket's *last* sample rather than the mean
 * of its non-null samples. `time` and `distance` are monotonically
 * increasing/cumulative, so the last sample in a bucket is the one that
 * describes "where this bucket ends"; averaging them would produce a value
 * that never actually occurred in the data.
 */
const LAST_VALUE_KEYS = new Set(["time", "distance"]);

/**
 * Splits `length` indices into `maxPoints` contiguous, roughly-equal-size
 * ranges `[start, end)` that partition `[0, length)` exactly (every index
 * belongs to exactly one range).
 */
function bucketRanges(
  length: number,
  maxPoints: number,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let bucket = 0; bucket < maxPoints; bucket += 1) {
    const start = Math.floor((bucket * length) / maxPoints);
    const end = Math.floor(((bucket + 1) * length) / maxPoints);
    ranges.push([start, end]);
  }
  return ranges;
}

/** Mean of the non-null values in `data[start, end)`; `null` if none are non-null. */
function bucketMean(
  data: ColumnValue[],
  start: number,
  end: number,
): number | null {
  let sum = 0;
  let count = 0;
  for (let i = start; i < end; i += 1) {
    const value = data[i];
    if (value != null) {
      sum += value;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

/** The last sample in `data[start, end)` (`null` when that sample is itself null). */
function bucketLast(
  data: ColumnValue[],
  _start: number,
  end: number,
): number | null {
  return data[end - 1] ?? null;
}

/**
 * Buckets every column in `columns` into at most `maxPoints` contiguous
 * buckets and reduces each bucket to one value: the mean of its non-null
 * numeric samples (`null` if every sample in the bucket is null), except
 * `time` and `distance`, which take the bucket's last sample instead of an
 * average (see {@link LAST_VALUE_KEYS}).
 *
 * When every column's length is already `<= maxPoints` (including the
 * trivial `columns = {}` case), `columns` is returned unchanged, by
 * reference: there is nothing to bucket.
 *
 * All columns are assumed to share one length (intervals.icu's streams are
 * index-aligned); bucket boundaries are computed once, from the first
 * column's length, and reused for every column.
 *
 * `latlng` is not a column this function understands directly: a `[lat,
 * lng]` pair isn't a `(number | null)[]`. Callers downsample its two
 * coordinate arrays separately with {@link lastValuePerBucket}, which applies
 * the same last-of-bucket rule as `time`/`distance`, then zip the two
 * downsampled arrays back into pairs.
 */
export function downsampleColumns(
  columns: Columns,
  maxPoints: number,
): Columns {
  const keys = Object.keys(columns);
  const length =
    keys.length > 0 ? (columns[keys[0] as string] as ColumnValue[]).length : 0;
  if (length <= maxPoints) return columns;

  const ranges = bucketRanges(length, maxPoints);
  const result: Columns = {};
  for (const key of keys) {
    const data = columns[key] as ColumnValue[];
    const reduce = LAST_VALUE_KEYS.has(key) ? bucketLast : bucketMean;
    result[key] = ranges.map(([start, end]) => reduce(data, start, end));
  }
  return result;
}

/**
 * Downsamples one column with the same last-of-bucket rule `downsampleColumns`
 * applies to `time`/`distance`, for a column it doesn't understand directly
 * (e.g. one half of a `latlng` pair). Returns `data` unchanged, by reference,
 * when `data.length <= maxPoints`.
 */
export function lastValuePerBucket(
  data: ColumnValue[],
  maxPoints: number,
): ColumnValue[] {
  if (data.length <= maxPoints) return data;
  return bucketRanges(data.length, maxPoints).map(([start, end]) =>
    bucketLast(data, start, end),
  );
}
