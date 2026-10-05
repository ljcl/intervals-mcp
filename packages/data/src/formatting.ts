export function formatTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${String(hrs)}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * "4:04" under an hour, "1:02:05" above — the leading unit is never
 * zero-padded, so an effort time reads the way a watch shows it.
 *
 * Distinct from `formatTime`, which always pads minutes to two digits
 * ("02:05") because its callers align it in a column.
 */
export function formatClock(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return hours > 0
    ? `${hours}:${mm}:${String(secs).padStart(2, "0")}`
    : `${mm}:${String(secs).padStart(2, "0")}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** How much of the year a short date carries, if any. */
export type ShortDateYear = "none" | "short" | "full";

/**
 * "5 Jan", "5 Jan 25", or "5 Jan 2026". Reads the leading `YYYY-MM-DD` as
 * written and ignores any time or offset after it, so the label is the day
 * the string names. It never builds a `Date`. `new Date` reads a date-time
 * with no offset (intervals.icu's `start_date_local`) as the viewer's local
 * time, so the day could shift with the viewer's time zone. Month names are
 * hardcoded, so labels, and the tests that assert them, do not depend on
 * the runtime locale either.
 *
 * Chart axis labels want no year until the range crosses one ("short");
 * screen-reader narration always spells it out ("full").
 */
export function formatShortDate(
  iso: string,
  year: ShortDateYear = "none",
): string {
  const fullYear = iso.slice(0, 4);
  const month = MONTHS[Number(iso.slice(5, 7)) - 1];
  const day = `${Number(iso.slice(8, 10))} ${month}`;
  if (year === "none") return day;
  return `${day} ${year === "short" ? fullYear.slice(2) : fullYear}`;
}

/**
 * Coarse duration for summary tiles and tooltips: "3m", "45m", "1h 05m",
 * "3h". Minutes are dropped entirely when they round to zero, and padded to
 * two digits otherwise so sibling cards line up.
 */
export function formatDurationShort(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export function formatDistance(metres: number): string {
  return `${Math.round(metres)}m`;
}

export function formatPace(minPerUnit: number): string {
  const mins = Math.floor(minPerUnit);
  const secs = Math.round((minPerUnit - mins) * 60);
  if (secs === 60) return `${mins + 1}'00"`;
  return `${mins}'${String(secs).padStart(2, "0")}"`;
}

/**
 * Below this speed a sample reads as stopped: a pace derived from it is a
 * nonsense number ("41'40 /km"), so pace sports draw it as a gap. Speed in
 * km/h needs no such floor, since 0 km/h is a true reading.
 */
export const MIN_MOVING_SPEED_MPS = 0.3;

/**
 * "6 weeks" for a whole number of weeks ("1 week" for 7 days), else
 * "30 days". The one home for a day window's label, so the server's
 * `view-cadence-trends` text and the cadence app's subtitle agree.
 */
export function windowLabel(days: number): string {
  if (days % 7 !== 0) return `${days} days`;
  const weeks = days / 7;
  return weeks === 1 ? "1 week" : `${weeks} weeks`;
}

/** "6w" for a whole number of weeks, else "30d": the compact form of {@link windowLabel}. */
export function windowShortLabel(days: number): string {
  return days % 7 === 0 ? `${days / 7}w` : `${days}d`;
}
