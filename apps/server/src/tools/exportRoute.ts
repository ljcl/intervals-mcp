import { z } from "zod";
import {
  loadRouteVersion,
  RouteBuildError,
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
the geometry. The result links the file (a resource link with its file
name, which the client reads), with a marker every km and any pins; the
text has only a summary. For "send me the GPX of that route" or "export
version 1".

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

/** The scheme of an export's link; resources/read rebuilds the file from it. */
const SCHEME = "route-export:";

/**
 * The file for `args`, with its link: the link holds the arguments, the
 * route's version pinned, so reading it later rebuilds the same file.
 */
async function buildExport(args: ExportRouteInput, apiKey: string) {
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
  fileName = `${fileName}.${args.format}`;
  const query = new URLSearchParams({
    args: JSON.stringify(version === null ? args : { ...args, version }),
  });
  const uri = `${SCHEME}//file/${fileName}?${query}`;
  return { fileName, uri, input, routeId, version };
}

/** Whether resources/read should hand `uri` to {@link readRouteExport}. */
export function isRouteExportUri(uri: string): boolean {
  return uri.startsWith(`${SCHEME}//`);
}

/**
 * The file an export-route link names, rebuilt from the arguments in it;
 * null when the link is malformed or its route is no longer stored.
 */
export async function readRouteExport(uri: string, apiKey: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(new URL(uri).searchParams.get("args") ?? "");
  } catch {
    return null;
  }
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return null;
  try {
    const built = await buildExport(parsed.data, apiKey);
    const file = exportRoute(parsed.data.format, built.input);
    return { uri, mimeType: MIME[parsed.data.format], text: file.text };
  } catch (error) {
    // The route or its version is no longer stored.
    if (error instanceof RouteBuildError) return null;
    throw error;
  }
}

export const exportRouteTool = {
  name,
  title: "Export a route",
  description,
  inputSchema,
  annotations: READ_ONLY,
  outputSchema: RouteExportOutputSchema,
  execute: async (args: ExportRouteInput, apiKey: string) => {
    try {
      const { fileName, uri, input, routeId, version } = await buildExport(
        args,
        apiKey,
      );
      const file = exportRoute(args.format, input);
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
        `${args.format === "gpx" ? "GPX" : "GeoJSON"} file linked: ${fileName}`,
        `"${input.name}", ${(length / 1000).toFixed(2)} km, ${file.points} track points (simplified to ${file.simplified_m} m), ${file.waypoints} waypoints.`,
        ...warnings.map((w) => `Warning: ${w}`),
      ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: structured,
        attachments: [
          {
            type: "resource_link" as const,
            uri,
            name: fileName,
            mimeType: MIME[args.format],
            size: Buffer.byteLength(file.text),
          },
        ],
      };
    } catch (error) {
      return routeErrorResult(error, "export a route");
    }
  },
};
