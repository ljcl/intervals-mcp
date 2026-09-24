import styles from "./RampLegend.module.css";

export interface RampLegendProps {
  /** CSS gradient for the bar, e.g. `RAMP_GRADIENT_CSS` from `@intervals-mcp/data`. */
  gradient: string;
  /** Label for the low end of the scale. */
  minLabel: string;
  /** Label for the high end. */
  maxLabel: string;
  /**
   * What the colour encodes, for screen readers ("pace"). The bar itself is
   * decorative; without this the endpoints are two numbers with no subject.
   */
  label: string;
}

/**
 * Key for a continuous colour ramp: a gradient bar between its two endpoint
 * values.
 *
 * Extracted from route-map's metric scale when activity-segments needed the
 * same thing — it colours every row's dot with the identical shared ramp and
 * rendered no key at all, so the app's primary visual encoding could not be
 * interpreted: nothing said whether green meant fast or slow.
 *
 * The gradient arrives as a prop rather than imported, so this stays a purely
 * presentational component and `packages/ui` needs no data dependency.
 */
export function RampLegend({
  gradient,
  minLabel,
  maxLabel,
  label,
}: RampLegendProps) {
  return (
    // `role="img"` rather than a group or a hidden sentence. The scale is a
    // graphic, and the role makes it atomic: children are not announced, so
    // the label can state the subject *and* the endpoints without a screen
    // reader reading each value twice — which is what a hidden sentence
    // alongside readable labels did, and what route-map's story caught.
    <div
      className={styles.scale}
      role="img"
      aria-label={`Colour scale: ${label}, from ${minLabel} to ${maxLabel}.`}
    >
      <span className={styles.scaleLabel}>{minLabel}</span>
      <span className={styles.scaleBar} style={{ background: gradient }} />
      <span className={styles.scaleLabel}>{maxLabel}</span>
    </div>
  );
}
