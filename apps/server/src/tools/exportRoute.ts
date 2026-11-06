import { z } from "zod";
import {
  loadRouteVersion,
  readActivityTrack,
  summarizeRoute,
  versionTrack,
} from "../routeBuilder";
import { exportRoute } from "../routeExport";
import { trackLength } from "../routeGeometry";
import { READ_ONLY } from "./_annotations";
import { intervalsActivityIdInput } from "./_ids";
import { kmInput, routeErrorResult, routeIdInput } from "./_storedRoutes";
import { RouteExportOutputSchema, warnOnSchemaDrift } from "./outputs";

const name = "export-route";

const description = `
Gives a stored route or a past run's GPS track as a file: GPX to load as a
course on a watch or app, or GeoJSON for a client to check, join or change
the geometry. The file is attached to the result, with a marker every km
and any pins; the text has only a summary. For "send me the GPX of that
route" or "export version 1".

Pass route_id (from stitch-route, amend-route or suggest-run-route) and
optionally version, or id for a past run. The track is simplified (by a
few metres) only as far as the file needs to fit in one result; the
result says how far.
`;

const inputSchema = z
  .object({
    route_id: routeIdInput("A stored route").optional(),
    version: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("The route's version; default the latest"),
    id: intervalsActivityIdInput(
      "A past run to export instead of a route.",
    ).optional(),
    format: z
      .enum(["gpx", "geojson"])
      .default("gpx")
      .describe("gpx (default) for a watch or app; geojson for the geometry"),
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe("Name in the file; default the route's or run's"),
    km_markers: z
      .boolean()
      .default(true)
      .describe("A waypoint every km (default true)"),
    waypoints: z
      .array(
        z.object({
          km: kmInput("Km along this version"),
          label: z.string().trim().min(1).max(80),
          kind: z.enum(["fuel", "climb", "water", "custom"]).default("custom"),
        }),
      )
      .max(50)
      .optional()
      .describe("Pins to add as waypoints"),
  })
  .refine((args) => (args.route_id === undefined) !== (args.id === undefined), {
    message: "Pass route_id or id, not both.",
  });

type ExportRouteInput = z.infer<typeof inputSchema>;

const MIME = {
  gpx: "application/gpx+xml",
  geojson: "application/geo+json",
} as const;

export const exportRouteTool = {
  name,
  title: "Export a route",
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: RouteExportOutputSchema,
  execute: async (args: ExportRouteInput, apiKey: string) => {
    try {
      let fileName: string;
      let input: Parameters<typeof exportRoute>[1];
      let routeId: string | null = null;
      let version: number | null = null;
      if (args.route_id) {
        const loaded = await loadRouteVersion(args.route_id, args.version);
        const summary = summarizeRoute(loaded.route, loaded.version);
        routeId = loaded.route.route_id;
        version = loaded.version.version;
        fileName = `${routeId}-v${version}`;
        input = {
          name: args.name ?? `${loaded.route.name} (v${version})`,
          track: versionTrack(loaded.route, loaded.version),
          kmMarkers: args.km_markers,
          pins: args.waypoints ?? [],
          properties: {
            route_id: routeId,
            version,
            sections: summary.segments.map((s) => ({
              index: s.index,
              kind: s.kind,
              label: s.label,
              from_km: s.from_km,
              to_km: s.to_km,
            })),
          },
        };
      } else {
        const activityId = args.id!;
        const loaded = await readActivityTrack(apiKey, activityId);
        fileName = `activity-${activityId}`;
        input = {
          name: args.name ?? loaded.name,
          track: loaded.track,
          kmMarkers: args.km_markers,
          pins: args.waypoints ?? [],
          properties: { activity_id: activityId },
        };
      }
      const file = exportRoute(args.format, input);
      const uri = `route-export://${fileName}.${args.format}`;
      const length = trackLength(input.track);
      const warnings = (args.waypoints ?? [])
        .filter((w) => w.km * 1000 > length + 1)
        .map(
          (w) =>
            `Pin "${w.label}" at km ${w.km} is past the end (${(length / 1000).toFixed(2)} km) and was left out.`,
        );
      const structured = {
        format: args.format,
        name: input.name,
        route_id: routeId,
        version,
        activity_id: args.id ?? null,
        distance_m: Math.round(length),
        points: file.points,
        simplified_m: file.simplified_m,
        waypoints: file.waypoints,
        uri,
        warnings,
      };
      warnOnSchemaDrift(name, RouteExportOutputSchema, structured);
      const lines = [
        `${args.format === "gpx" ? "GPX" : "GeoJSON"} file attached: ${uri}`,
        `"${input.name}", ${(length / 1000).toFixed(2)} km, ${file.points} track points (simplified to ${file.simplified_m} m), ${file.waypoints} waypoints.`,
        ...warnings.map((w) => `Warning: ${w}`),
      ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: structured,
        attachments: [
          {
            type: "resource" as const,
            resource: { uri, mimeType: MIME[args.format], text: file.text },
          },
        ],
      };
    } catch (error) {
      return routeErrorResult(error, "export a route");
    }
  },
};
