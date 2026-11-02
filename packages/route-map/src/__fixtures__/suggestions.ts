import { type RouteMapData, type RouteSuggestionsData } from "../types";

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
  candidates: [
    {
      label: "New loop",
      summary: "via The Embarcadero, Marina Green",
      map: loop("a", "SF: New loop", 0.008),
    },
    {
      label: "New loop 2",
      summary: "via Bay Trail, Crissy Field",
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
  candidates: [
    {
      label: "Past run 2026-10-27",
      summary: 'Your run "Waterfront loop" on 2026-10-27',
      map: loop("p", "Easy 6 km: Past run 2026-10-27", 0.008),
    },
    {
      label: "New loop",
      summary: "via Bay Trail, Crissy Field",
      map: loop("n", "Easy 6 km: New loop", -0.008),
    },
  ],
};
