/**
 * Pure GPX 1.1 synthesis from activity streams. Strava's API has no
 * activity-export endpoint, but the streams carry everything a valid GPX
 * track needs: latlng plus optional index-aligned time/altitude/heartrate/
 * cadence. Kept free of fetch/fs so it unit-tests next to polyline.ts.
 */

export interface GpxTrackInput {
  name: string;
  /** Strava sport type, emitted as the GPX track <type>. */
  activityType?: string | null;
  /**
   * ISO start time. Per-point <time> elements are emitted only when both
   * this and the `time` stream are present (polyline fallbacks have
   * neither).
   */
  startDate?: string | null;
  /** [lat, lng] pairs — the geometry is required, everything else optional. */
  coordinates: Array<[number, number]>;
  /** Seconds offset from start, index-aligned with coordinates. */
  time?: number[];
  /** Metres, index-aligned. */
  altitude?: number[];
  /** BPM, index-aligned; emitted as gpxtpx extension. */
  heartrate?: number[];
  /** RPM / strides-per-minute, index-aligned; emitted as gpxtpx extension. */
  cadence?: number[];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const GPXTPX_NS = "http://www.garmin.com/xmlschemas/TrackPointExtension/v1";

export function buildGpx(input: GpxTrackInput): string {
  const { name, activityType, coordinates, altitude, heartrate, cadence } =
    input;

  const startMs = input.startDate ? Date.parse(input.startDate) : Number.NaN;
  const hasTimestamps =
    Number.isFinite(startMs) && (input.time?.length ?? 0) > 0;
  const hasExtensions =
    (heartrate?.length ?? 0) > 0 || (cadence?.length ?? 0) > 0;

  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="intervals-mcp" xmlns="http://www.topografix.com/GPX/1/1"` +
      (hasExtensions ? ` xmlns:gpxtpx="${GPXTPX_NS}"` : "") +
      `>`,
  ];

  if (hasTimestamps) {
    lines.push(
      `  <metadata><time>${new Date(startMs).toISOString()}</time></metadata>`,
    );
  }

  lines.push(`  <trk>`, `    <name>${escapeXml(name)}</name>`);
  if (activityType) {
    lines.push(`    <type>${escapeXml(activityType)}</type>`);
  }
  lines.push(`    <trkseg>`);

  coordinates.forEach(([lat, lng], i) => {
    const point = [`      <trkpt lat="${lat}" lon="${lng}">`];

    const ele = altitude?.[i];
    if (ele !== undefined) point.push(`        <ele>${ele}</ele>`);

    const offset = input.time?.[i];
    if (hasTimestamps && offset !== undefined) {
      point.push(
        `        <time>${new Date(startMs + offset * 1000).toISOString()}</time>`,
      );
    }

    const hr = heartrate?.[i];
    const cad = cadence?.[i];
    if (hr !== undefined || cad !== undefined) {
      point.push(
        `        <extensions><gpxtpx:TrackPointExtension>` +
          (hr !== undefined ? `<gpxtpx:hr>${Math.round(hr)}</gpxtpx:hr>` : "") +
          (cad !== undefined
            ? `<gpxtpx:cad>${Math.round(cad)}</gpxtpx:cad>`
            : "") +
          `</gpxtpx:TrackPointExtension></extensions>`,
      );
    }

    point.push(`      </trkpt>`);
    lines.push(point.join("\n"));
  });

  lines.push(`    </trkseg>`, `  </trk>`, `</gpx>`, ``);
  return lines.join("\n");
}
