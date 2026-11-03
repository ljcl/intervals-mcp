import { type RouteSuggestions } from "../routeSuggestions";

const track = {
  coordinates: [
    [37.79, -122.39],
    [37.8, -122.39],
  ] as [number, number][],
  distance: [0, 6100],
  altitude: [5, 43],
};

/** The most the tool can return: seven runs, each with a full candidate list. */
export function routeSuggestionsFixture(runCount: number): RouteSuggestions {
  const place = {
    label: "Embarcadero, San Francisco, CA, USA",
    point: [37.79539, -122.39371] as [number, number],
  };
  return {
    generation_available: true,
    warnings: ["A week of runs shares one budget of routing calls."],
    runs: Array.from({ length: runCount }, (_, i) => ({
      event_id: 100 + i,
      date: `2026-11-0${i + 1}`,
      name: "Easy 6.5 km with light fartlek",
      description:
        "Iron Cove Bay Run (flat). 2 km easy, then 6 times 1 min steady. ".repeat(
          6,
        ),
      distance_m: 6500,
      distance_source: "event" as const,
      start: { ...place, source: "argument" as const, history_runs: 0 },
      end: place,
      via: place,
      shape: "loop" as const,
      terrain: "hill-repeats" as const,
      candidates: Array.from({ length: 4 }, (_, k) => ({
        kind: k < 2 ? ("past" as const) : ("generated" as const),
        activity_id: k < 2 ? `i${k}` : null,
        name: `Candidate ${k}`,
        date: k < 2 ? "2026-10-27" : null,
        shape: "loop" as const,
        distance_m: 6100,
        climb_m: 38,
        path_share: k < 2 ? null : 0.78,
        crossings_per_km: 14.2,
        hill: { start_m: 2300, length_m: 120, grade_pct: 6.7 },
        summary:
          "via Park Road, Foreshore Walk, Iron Cove Bay Run, Callan Park",
        track,
      })),
      warnings: [
        "No new route was generated: OpenRouteService's rate limit was reached.",
      ],
    })),
  };
}
