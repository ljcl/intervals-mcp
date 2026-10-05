import { isRunning, isSwimming } from "./activity-types";
import { formatPace, MIN_MOVING_SPEED_MPS } from "./formatting";

export { MIN_MOVING_SPEED_MPS };

/** How a sport's speed is shown: pace per km, pace per 100 m, or km/h. */
export type SpeedSport = "run" | "swim" | "other";

export interface SpeedDisplay {
  sport: SpeedSport;
  label: "Pace" | "Speed";
  unit: "min/km" | "/100m" | "km/h";
  /** Pace axes run fast-at-top. */
  reversed: boolean;
  /** Minutes per unit for pace sports, km/h otherwise; null is a gap. */
  fromMps(mps: number | null | undefined): number | null;
  /** A converted value for ticks and tooltips: 5'30" or 28.4. */
  format(value: number): string;
  /** A raw m/s sample as a labelled reading, "—" when it is a gap. */
  formatMps(mps: number | null | undefined): string;
}

export function speedSport(
  activityType: string | null | undefined,
): SpeedSport {
  if (!activityType) return "other";
  if (isSwimming(activityType)) return "swim";
  if (isRunning(activityType)) return "run";
  return "other";
}

function paceDisplay(
  sport: "run" | "swim",
  metres: number,
  unit: "min/km" | "/100m",
  suffix: string,
): SpeedDisplay {
  const fromMps = (mps: number | null | undefined): number | null =>
    typeof mps === "number" &&
    Number.isFinite(mps) &&
    mps >= MIN_MOVING_SPEED_MPS
      ? metres / mps / 60
      : null;
  return {
    sport,
    label: "Pace",
    unit,
    reversed: true,
    fromMps,
    format: formatPace,
    formatMps: (mps) => {
      const value = fromMps(mps);
      return value === null ? "—" : `${formatPace(value)} ${suffix}`;
    },
  };
}

const kmh = (v: number): string => v.toFixed(1);

const DISPLAYS: Record<SpeedSport, SpeedDisplay> = {
  run: paceDisplay("run", 1000, "min/km", "/km"),
  swim: paceDisplay("swim", 100, "/100m", "/100m"),
  other: {
    sport: "other",
    label: "Speed",
    unit: "km/h",
    reversed: false,
    fromMps: (mps) =>
      typeof mps === "number" && Number.isFinite(mps) && mps >= 0
        ? mps * 3.6
        : null,
    format: kmh,
    formatMps: (mps) =>
      typeof mps === "number" && Number.isFinite(mps) && mps >= 0
        ? `${kmh(mps * 3.6)} km/h`
        : "—",
  },
};

export function speedDisplayForSport(sport: SpeedSport): SpeedDisplay {
  return DISPLAYS[sport];
}

/** The one speed-to-pace conversion every MCP App uses (#63). */
export function speedDisplay(
  activityType: string | null | undefined,
): SpeedDisplay {
  return DISPLAYS[speedSport(activityType)];
}
