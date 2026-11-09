import { z } from "zod";
import { foundStretches, linesOverlap, runsThrough } from "../corridors";
import { NO_PROGRESS, type ReportProgress } from "../progress";
import { versionTrack } from "../routeBuilder";
import { lineFollowers } from "../routeScore";
import { latestVersion, listCorridors } from "../routeStore";
import {
  coarseVia,
  RouteSuggestionError,
  resolvePlace,
  resolveStart,
  viaTarget,
} from "../routeSuggestions";
import { clusterStarts, loadRunStarts } from "../startClusters";
import { READ_ONLY } from "./_annotations";
import { corridorEntry, corridorLine } from "./_corridors";
import { noteToolFailure, prefixedErrorText, toolErrorText } from "./_errors";
import { placeText } from "./_storedRoutes";
import { CorridorListOutputSchema, warnOnSchemaDrift } from "./outputs";
import { routeSuggestionEnv } from "./suggestRunRoute";

const name = "list-corridors";

const description = `
Lists the athlete's saved running corridors (named lines they run again and
again, kept as stored routes) nearest first (by name when no start is
known), and stretches their recent runs repeat that are not saved yet,
for "which corridors do I have near
the office?" or "what do I keep running that I have not named?". Each
corridor gives its route_id, length, share on paths, how many recent runs
follow it and how far it is from the search point.

through (one or two places) lists recent runs through them instead.

Then: manage-corridors add to save a found stretch (its activity_id and km
range), rename, set one-way or delete. view-route-map with a corridor's
route_id draws it, or a found stretch with its activity_id, from_km and
to_km.

Notes:
- near is a place with its city, or lat,lng; default HOME_START, else the
  athlete's usual start. A place name is sent to OpenRouteService for
  lookup.
- Reads the athlete's recent runs (up to 180 days); found stretches are the
  parts of them 1 km or longer that several runs share.
`;

const inputSchema = z.object({
  through: z
    .array(placeText)
    .min(1)
    .max(2)
    .optional()
    .describe(
      "One or two places (with city, or lat,lng): recent runs through the place, or the part between two",
    ),
  near: placeText
    .optional()
    .describe(
      "A place with its city, or lat,lng, to order by; default the athlete's usual start",
    ),
});

type ListCorridorsInput = z.infer<typeof inputSchema>;

const round3 = (v: number) => Math.round(v * 1e3) / 1e3;

const overlapText = (f: {
  overlaps_found: number[];
  overlaps_corridors: string[];
}) => {
  const parts = [...f.overlaps_found.map(String), ...f.overlaps_corridors];
  return parts.length > 0 ? `; overlaps ${parts.join(", ")}` : "";
};

export const listCorridorsTool = {
  name,
  title: "List running corridors",
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: CorridorListOutputSchema,
  execute: async (
    args: ListCorridorsInput,
    apiKey: string,
    progress: ReportProgress = NO_PROGRESS,
  ) => {
    try {
      const env = routeSuggestionEnv();
      const { runs, skipped } = await loadRunStarts(
        apiKey,
        env.today,
        progress,
      );
      // Without near, a missing start only drops the ordering and the found stretches.
      const near = await resolveStart(
        args.near,
        env,
        clusterStarts(runs, env.today),
      ).catch((error) => {
        if (!args.near && error instanceof RouteSuggestionError) return null;
        throw error;
      });
      let through: ReturnType<typeof runsThrough> | null = null;
      if (args.through) {
        const places = [];
        for (const text of args.through) {
          const place = await resolvePlace(text, env, near?.point ?? null);
          const coarse = coarseVia(place, text);
          if (coarse) throw new RouteSuggestionError(coarse);
          places.push(viaTarget(place));
        }
        through = runsThrough(runs, places);
      }
      const saved = await listCorridors();
      const followers = lineFollowers(runs.map((r) => r.track));
      const corridors = saved
        .map((c) => corridorEntry(c, followers, near?.point ?? null))
        .sort((a, b) => (near ? (a.distance_m ?? 0) - (b.distance_m ?? 0) : 0));
      const savedTracks = saved.map((c) => versionTrack(c, latestVersion(c)));
      const foundRaw = near
        ? foundStretches(runs, savedTracks, near.point)
        : [];
      const found = foundRaw.map((f, i) => ({
        n: i + 1,
        activity_id: f.activity_id,
        name: f.name,
        date: f.date,
        from_km: f.from_km,
        to_km: f.to_km,
        length_m: f.length_m,
        runs: f.runs,
        overlaps_found: foundRaw
          .map((g, j) =>
            j !== i && linesOverlap(f.track, g.track) ? j + 1 : 0,
          )
          .filter(Boolean),
        overlaps_corridors: saved
          .filter((_, j) => linesOverlap(f.track, savedTracks[j]!))
          .map((c) => c.name),
        start_lat: round3(f.start[0]),
        start_lng: round3(f.start[1]),
        end_lat: round3(f.end[0]),
        end_lng: round3(f.end[1]),
      }));
      const warnings =
        skipped > 0
          ? [
              `${skipped} recent run${skipped === 1 ? "" : "s"} could not be read and left out.`,
            ]
          : [];
      const structured = {
        count: corridors.length,
        near: near
          ? {
              label: near.label,
              lat: round3(near.point[0]),
              lng: round3(near.point[1]),
            }
          : null,
        corridors,
        found,
        through,
        warnings,
      };
      warnOnSchemaDrift(name, CorridorListOutputSchema, structured);
      const lines = [
        near ? `Near ${near.label}:` : "No start known; ordered by name.",
      ];
      if (corridors.length === 0) lines.push("No saved corridors.");
      for (const c of corridors) lines.push(corridorLine(c));
      if (found.length > 0) {
        lines.push("Found in your runs, not saved:");
        for (const f of found)
          lines.push(
            `${f.n}. ${f.name} ${f.date} (${f.activity_id}) km ${f.from_km.toFixed(2)}-${f.to_km.toFixed(2)} (${(f.length_m / 1000).toFixed(1)} km, ${f.runs} runs)${overlapText(f)}`,
          );
        lines.push(
          "Save one with manage-corridors add (activity id and km range).",
        );
      }
      if (through) {
        lines.push("Runs through that:");
        if (through.length === 0) lines.push("No recent run passes that.");
        for (const t of through)
          lines.push(
            `${t.name} ${t.date} (${t.activity_id}) km ${t.from_km.toFixed(2)}${t.to_km === null ? "" : `-${t.to_km.toFixed(2)}`}${t.to_km !== null && t.from_km > t.to_km ? " (other way)" : ""}`,
          );
      }
      for (const w of warnings) lines.push(`Warning: ${w}`);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: structured,
      };
    } catch (error) {
      if (error instanceof RouteSuggestionError) {
        noteToolFailure(error);
        return {
          content: [
            { type: "text" as const, text: prefixedErrorText(error.message) },
          ],
          isError: true as const,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: toolErrorText(error, { context: "list corridors" }),
          },
        ],
        isError: true as const,
      };
    }
  },
};
