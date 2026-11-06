import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledRateLimit } from "../__fixtures__";
import {
  loadRouteSuggestions,
  RouteSuggestionError,
  type RouteSuggestions,
} from "../routeSuggestions";
import { RouteSuggestionsOutputSchema } from "./outputs";
import { suggestRunRouteTool } from "./suggestRunRoute";

vi.mock("../routeSuggestions", async (o) => ({
  ...(await o<typeof import("../routeSuggestions")>()),
  loadRouteSuggestions: vi.fn(),
}));

const track = {
  coordinates: [
    [37.79, -122.39],
    [37.8, -122.39],
  ] as [number, number][],
  distance: [0, 6100],
  altitude: [5, 43],
};

const suggestions: RouteSuggestions = {
  generation_available: true,
  warnings: [],
  runs: [
    {
      event_id: 10,
      date: "2026-11-05",
      name: "Easy 6.5 km with light fartlek",
      description:
        "Iron Cove Bay Run (flat). 2 km easy, then 6 times 1 min steady.",
      distance_m: 3126,
      distance_source: "event",
      start: {
        label: "Embarcadero, San Francisco, CA, USA",
        point: [37.79539, -122.39371],
        source: "argument",
        history_runs: 0,
      },
      end: null,
      via: [],
      shape: "loop",
      terrain: "flat",
      candidates: [
        {
          kind: "past",
          activity_id: "i1",
          name: "Home loop",
          date: "2026-10-27",
          shape: "loop",
          distance_m: 6100,
          climb_m: 38,
          path_share: null,
          crossings_per_km: 14.2,
          hill: null,
          summary: 'Your run "Home loop" on 2026-10-27',
          track,
        },
        {
          kind: "generated",
          activity_id: null,
          name: "New loop",
          date: null,
          shape: "loop",
          distance_m: 3160,
          climb_m: 22,
          path_share: 0.78,
          crossings_per_km: null,
          hill: { start_m: 2300, length_m: 120, grade_pct: 6.7 },
          summary: "via Park Road, Foreshore Walk",
          track,
        },
      ],
      warnings: [
        "No new route was generated: OpenRouteService's rate limit was reached.",
      ],
    },
  ],
};

beforeEach(() => {
  vi.mocked(loadRouteSuggestions).mockReset();
});

describe("suggest-run-route", () => {
  it("prints each run with its distance source, start label and candidates", async () => {
    vi.mocked(loadRouteSuggestions).mockResolvedValue(suggestions);
    const result = await suggestRunRouteTool.execute(
      suggestRunRouteTool.inputSchema.parse({}),
      "k",
    );
    const text = result.content[0]!.text;
    expect(text).toContain(
      "2026-11-05: Easy 6.5 km with light fartlek (3.1 km, from the event)",
    );
    expect(text).toContain("Iron Cove Bay Run (flat)");
    expect(text).toContain(
      "Start: Embarcadero, San Francisco, CA, USA (given)",
    );
    expect(text).toContain(
      "1. Past run 2026-10-27: 6.1 km (+3.0 km), 38 m climb, 14.2 crossings/km, loop",
    );
    expect(text).toContain(
      "2. New loop: 3.2 km (+0.0 km), 22 m climb, 78% on paths, via Park Road, Foreshore Walk",
    );
    expect(text).toContain("Hill for repeats: 120 m at 6.7%, from 2.3 km");
    expect(text).toContain("Warning: No new route was generated");
    const parsed = RouteSuggestionsOutputSchema.parse(result.structuredContent);
    expect(parsed.count).toBe(1);
    expect(JSON.stringify(parsed)).not.toContain("coordinates");
    expect(parsed.runs[0]!.start).toMatchObject({ lat: 37.795, lng: -122.394 });
  });

  it("takes one via place or an ordered list, and lists them in order", async () => {
    const run = suggestions.runs[0]!;
    const places = [
      {
        label: "Blackwattle Bay",
        point: [-33.8738, 151.1847] as [number, number],
      },
      {
        label: "Anzac Bridge",
        point: [-33.86884, 151.18512] as [number, number],
      },
    ];
    vi.mocked(loadRouteSuggestions).mockResolvedValue({
      ...suggestions,
      runs: [{ ...run, via: places }],
    });
    const schema = suggestRunRouteTool.inputSchema;
    expect(schema.parse({ via: "Anzac Bridge" }).via).toBe("Anzac Bridge");
    const args = schema.parse({ via: ["Blackwattle Bay", "Anzac Bridge"] });
    expect(args.via).toEqual(["Blackwattle Bay", "Anzac Bridge"]);
    expect(schema.safeParse({ via: [] }).success).toBe(false);

    const result = await suggestRunRouteTool.execute(args, "k");
    expect(result.content[0]!.text).toContain(
      "Via: Blackwattle Bay, then Anzac Bridge",
    );
    const parsed = RouteSuggestionsOutputSchema.parse(result.structuredContent);
    expect(parsed.runs[0]!.via?.label).toBe("Blackwattle Bay");
    expect(parsed.runs[0]!.via_points.map((p) => p.label)).toEqual([
      "Blackwattle Bay",
      "Anzac Bridge",
    ]);
  });

  it("returns a RouteSuggestionError as its own message", async () => {
    vi.mocked(loadRouteSuggestions).mockRejectedValue(
      new RouteSuggestionError("No planned run from a to b."),
    );
    const result = await suggestRunRouteTool.execute(
      suggestRunRouteTool.inputSchema.parse({}),
      "k",
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("❌ No planned run from a to b.");
  });

  it("translates other failures through toolErrorText", async () => {
    vi.mocked(loadRouteSuggestions).mockRejectedValue(
      handledRateLimit("listActivities"),
    );
    const result = await suggestRunRouteTool.execute(
      suggestRunRouteTool.inputSchema.parse({}),
      "k",
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^❌ Rate limit reached/);
  });
});
