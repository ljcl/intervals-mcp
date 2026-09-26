import { formatShortDate } from "@intervals-mcp/data";
import { BAND_LABELS, isPlanned, planDays, signedTsb } from "./normalize";
import { type FitnessTrendData, type TrendBand } from "./types";

/**
 * Narration spells the year out: "14 Sep 2025". Dates are date-only ISO
 * strings and `formatShortDate` reads the day as written, so the narrated
 * day never shifts by the viewer's (or CI's) timezone.
 */
const fullDate = (iso: string) => formatShortDate(iso, "full");

export interface ChartA11y {
  title: string;
  desc: string;
}

/**
 * What the chart is currently drawing, so the narration can describe what a
 * sighted user actually sees rather than everything that was fetched.
 */
export interface TrendVisibility {
  showCtl: boolean;
  showAtl: boolean;
  showTsb: boolean;
  showPlan: boolean;
  hiddenBandKinds: TrendBand["kind"][];
}

const ALL_VISIBLE: TrendVisibility = {
  showCtl: true,
  showAtl: true,
  showTsb: true,
  showPlan: true,
  hiddenBandKinds: [],
};

/**
 * Screen-reader narration for the fitness-trend chart. Recharts'
 * accessibilityLayer gives keyboard focus and arrow-key tooltip stepping, but
 * the SVG carries no accessible name or summary of its own; this feeds the
 * chart's `title`/`desc` props, per the convention in the sibling apps.
 * Series, plan, and bands toggled off in the legend are left out.
 */
export function buildTrendA11y(
  data: FitnessTrendData,
  visibility: TrendVisibility = ALL_VISIBLE,
): ChartA11y {
  const title = "Fitness, fatigue, and form";
  const first = data.series[0];
  const last = data.series[data.series.length - 1];
  if (!first || !last) {
    return { title, desc: "No days to display." };
  }

  const parts = [
    `${data.series.length} day${data.series.length === 1 ? "" : "s"} from ${fullDate(first.date)} to ${fullDate(last.date)}.`,
  ];

  const latest = [
    ...(visibility.showCtl ? [`fitness (CTL) ${last.ctl}`] : []),
    ...(visibility.showAtl ? [`fatigue (ATL) ${last.atl}`] : []),
    ...(visibility.showTsb ? [`form (TSB) ${signedTsb(last.tsb)}`] : []),
  ];
  if (latest.length > 0) {
    const joined = latest.join(", ");
    parts.push(
      `${joined.charAt(0).toUpperCase()}${joined.slice(1)} on ${fullDate(last.date)}.`,
    );
  }

  const direction =
    visibility.showCtl && data.series.length >= 8
      ? last.ctl - data.series[data.series.length - 8]!.ctl
      : null;
  if (direction !== null) {
    const rounded = Math.round(direction * 10) / 10;
    parts.push(
      rounded > 0
        ? `Fitness rose ${rounded} over the last 7 days.`
        : rounded < 0
          ? `Fitness fell ${Math.abs(rounded)} over the last 7 days.`
          : "Fitness held level over the last 7 days.",
    );
  }

  const plan = visibility.showPlan ? planDays(data) : [];
  if (plan.length > 0) {
    const landing = plan[plan.length - 1]!;
    parts.push(
      isPlanned(data)
        ? `A dashed ${plan.length}-day taper plan continues the curves to ${fullDate(landing.date)}, landing on form ${signedTsb(landing.tsb)}.`
        : `A dashed ${plan.length}-day rest projection continues the curves to ${fullDate(landing.date)}, reaching form ${signedTsb(landing.tsb)}.`,
    );
  }

  const shownBands = data.bands.filter(
    (band) => !visibility.hiddenBandKinds.includes(band.kind),
  );
  if (shownBands.length > 0) {
    const described = shownBands
      .map(
        (band) =>
          `${BAND_LABELS[band.kind].toLowerCase()} from ${fullDate(band.startDate)} to ${fullDate(band.endDate)}`,
      )
      .join(", ");
    parts.push(
      `${shownBands.length} shaded period${shownBands.length === 1 ? "" : "s"}: ${described}.`,
    );
  } else {
    parts.push("No periods are shaded for fatigue, freshness, or ramp risk.");
  }

  return { title, desc: parts.join(" ") };
}
