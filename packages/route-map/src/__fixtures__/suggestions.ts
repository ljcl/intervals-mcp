import {
  type RouteMapData,
  type RouteSuggestionsData,
  type SuggestionStats,
} from "../types";

function stats(overrides: Partial<SuggestionStats> = {}): SuggestionStats {
  return {
    distance_m: 6000,
    distance_diff_m: 0,
    climb_m: 25,
    climb_per_km: 4.2,
    path_share: 0.62,
    crossings_per_km: 1.4,
    signals_per_km: 0.3,
    main_road_km: 0.8,
    green_share: 0.35,
    score: 81,
    losses: [
      { label: "crossings", points: 8 },
      { label: "main roads", points: 6 },
    ],
    ...overrides,
  };
}

function loop(id: string, name: string, dLat: number): RouteMapData {
  const coordinates: Array<[number, number]> = Array.from(
    { length: 40 },
    (_, i) => {
      const angle = (i / 39) * 2 * Math.PI;
      return [
        37.7955 + dLat * Math.sin(angle),
        -122.3937 + 0.01 * (1 - Math.cos(angle)),
      ];
    },
  );
  return {
    source: "suggestion",
    id,
    name,
    activityType: "Run",
    distance: 6000,
    elevationGain: 25,
    coordinates,
    start: coordinates[0]!,
    end: coordinates.at(-1)!,
    streams: {
      distance: coordinates.map((_, i) => (i * 6000) / 39),
      altitude: coordinates.map((_, i) => 5 + 10 * Math.sin(i / 6)),
    },
  };
}

export const awaySuggestions: RouteSuggestionsData = {
  source: "suggestion",
  date: "2026-10-20",
  name: "SF: Embarcadero 6 km",
  startLabel: "Embarcadero, San Francisco, CA, USA",
  startSource: "given",
  endLabel: null,
  distance_m: 6000,
  routesNote: null,
  candidates: [
    {
      label: "New loop, score 81",
      summary: "via The Embarcadero, Marina Green",
      notes: [],
      stats: stats({ distance_m: 6120, distance_diff_m: 120 }),
      map: loop("a", "SF: New loop", 0.008),
    },
    {
      label: "New loop 2, score 74",
      summary: "via Bay Trail, Crissy Field",
      notes: ["Retraces 0.4 km along the Marina Green path."],
      stats: stats({
        distance_m: 5810,
        distance_diff_m: -190,
        climb_m: 41,
        climb_per_km: 7.1,
        crossings_per_km: 2.2,
        score: 74,
      }),
      map: loop("b", "SF: New loop 2", -0.008),
    },
  ],
  warnings: [],
};

/** A start with history: a past run first, then one new loop (same SF geometry, no real home data). */
export const homeSuggestions: RouteSuggestionsData = {
  ...awaySuggestions,
  name: "Easy 6 km",
  startLabel: "Usual start (12 recent runs)",
  startSource: "inferred from recent runs",
  candidates: [
    {
      label: "Past run 2026-10-27, score 88",
      summary: 'Your run "Waterfront loop" on 2026-10-27',
      notes: [],
      stats: stats({ score: 88, losses: [{ label: "recency", points: 4 }] }),
      map: loop("p", "Easy 6 km: Past run 2026-10-27", 0.008),
    },
    {
      label: "New loop, score 79",
      summary: "via Bay Trail, Crissy Field",
      notes: [],
      stats: stats({ score: 79, signals_per_km: null, main_road_km: null }),
      map: loop("n", "Easy 6 km: New loop", -0.008),
    },
  ],
};

/** Without ORS_API_KEY: past runs only, and the note saying why. */
export const pastRunsOnlySuggestions: RouteSuggestionsData = {
  ...homeSuggestions,
  startSource: "HOME_START",
  candidates: homeSuggestions.candidates.slice(0, 1),
  routesNote: "Only 1 route: 1 past run fit.",
  warnings: [
    "New routes need ORS_API_KEY; without it nothing is routed, so only your past runs and saved corridors were offered.",
  ],
};

/** Routes and warnings together: a via kept off the distance. */
export const warnedSuggestions: RouteSuggestionsData = {
  ...awaySuggestions,
  warnings: [
    "No new route through Fort Mason came within 25% of 6.0 km; the nearest is kept.",
    "Elevation was unavailable for part of New loop 2.",
  ],
};
