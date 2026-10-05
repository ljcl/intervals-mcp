/** "+12" / "-4" / "0": form only reads correctly with its sign. */
export function formatSignedTsb(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

/**
 * Where CTL/ATL/TSB came from: intervals.icu's own wellness, or computed here
 * for a run-only scope. "From intervals.icu" / "Computed locally".
 */
export function fitnessSourceLabel(
  source: "intervals.icu" | "computed" | null | undefined,
): string {
  return source === "computed" ? "Computed locally" : "From intervals.icu";
}
