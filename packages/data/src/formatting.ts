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
 * "5 Jan", "5 Jan 25", or "5 Jan 2026". Month names are hardcoded and the
 * date parts read in UTC, so labels — and the tests asserting them — never
 * depend on the runtime locale or timezone.
 *
 * Chart axis labels want no year until the range crosses one ("short");
 * screen-reader narration always spells it out ("full").
 */
export function formatShortDate(
  iso: string,
  year: ShortDateYear = "none",
): string {
  const date = new Date(iso);
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  if (year === "none") return day;
  const fullYear = String(date.getUTCFullYear());
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
 * Slower than a walk: a pace derived from such a sample is a nonsense number
 * ("41'40 /km"), so it is rendered as paused instead. Speed in km/h needs no
 * such floor — zero is a true and useful reading — which is why
 * `formatSpeedAsKmh` has none.
 */
const MIN_PACE_SPEED = 0.3;

/** "4'10 /km" from metres per second, or "—" when the sample reads as paused. */
export function formatSpeedAsPace(metresPerSecond: number): string {
  if (metresPerSecond < MIN_PACE_SPEED) return "—";
  return `${formatPace(1000 / metresPerSecond / 60)} /km`;
}

/** "28.4 km/h" from metres per second. */
export function formatSpeedAsKmh(metresPerSecond: number): string {
  return `${(metresPerSecond * 3.6).toFixed(1)} km/h`;
}
