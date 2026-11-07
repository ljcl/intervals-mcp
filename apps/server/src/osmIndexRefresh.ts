/**
 * Keeps the local OpenStreetMap index (osmIndex.ts) current: at startup and
 * then daily, outside any tool call, it rebuilds when the index is missing,
 * was made for another URL or area, or was last checked over
 * OSM_REFRESH_DAYS ago. A check is a conditional GET, so an unchanged
 * extract costs one request. A failure keeps the old index and tries again
 * at the next daily check. Plain fetch, not FetchClient: a background file
 * download, never a cached API read.
 */
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getHomeStart, getOsmExtractUrl } from "./config";
import {
  areaAround,
  areaKey,
  closeOsmIndex,
  OSM_INDEX_RADIUS_KM,
  OSM_SCHEMA_VERSION,
  osmIndexDir,
  osmIndexMeta,
  osmIndexPath,
} from "./osmIndex";
import { buildOsmIndex } from "./osmIndexBuild";
import { SERVER_VERSION } from "./version";

export const OSM_REFRESH_DAYS = 7;
const DAY_MS = 86_400_000;
/** A hung download must not block every later check. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

export type RefreshResult = "off" | "fresh" | "unchanged" | "built" | "failed";

let running: Promise<RefreshResult> | null = null;

export function startOsmIndexRefresh(): void {
  if (!getOsmExtractUrl() || !getHomeStart()) {
    console.error(
      "OpenStreetMap index: off (set OSM_EXTRACT_URL and HOME_START to count road crossings in route suggestions)",
    );
    return;
  }
  void refreshOsmIndex();
  setInterval(() => void refreshOsmIndex(), DAY_MS).unref();
}

/** Bun's `typeof fetch` carries `preconnect`, so tests could not pass a plain function. */
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function refreshOsmIndex(
  opts: { now?: () => number; fetch?: Fetch } = {},
): Promise<RefreshResult> {
  running ??= refresh(opts.now ?? Date.now, opts.fetch ?? fetch).finally(() => {
    running = null;
  });
  return running;
}

async function refresh(
  now: () => number,
  fetchImpl: Fetch,
): Promise<RefreshResult> {
  const url = getOsmExtractUrl();
  const home = getHomeStart();
  if (!url || !home) return "off";
  const area = areaAround(home, OSM_INDEX_RADIUS_KM);
  const meta = osmIndexMeta();
  const same =
    meta?.source_url === url &&
    meta.area === areaKey(area) &&
    meta.schema_version === OSM_SCHEMA_VERSION;
  if (
    same &&
    now() - Date.parse(meta.checked_at ?? "") < OSM_REFRESH_DAYS * DAY_MS
  )
    return "fresh";

  const headers: Record<string, string> = {
    "User-Agent": `intervals-mcp/${SERVER_VERSION} (+https://github.com/ljcl/intervals-mcp)`,
  };
  if (same && meta.etag) headers["If-None-Match"] = meta.etag;
  if (same && meta.last_modified)
    headers["If-Modified-Since"] = meta.last_modified;

  const dir = osmIndexDir();
  const pbf = join(dir, "extract.osm.pbf");
  const tmp = join(dir, "index.sqlite.tmp");
  const started = now();
  try {
    await mkdir(dir, { recursive: true });
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (response.status === 304 && same) {
      touchCheckedAt(now());
      return "unchanged";
    }
    if (!response.ok || !response.body)
      throw new Error(`the download answered HTTP ${response.status}`);
    const file = await open(pbf, "w");
    try {
      for await (const chunk of response.body) await file.write(chunk);
    } finally {
      await file.close();
    }
    const result = await buildOsmIndex(
      pbf,
      tmp,
      area,
      {
        url,
        etag: response.headers.get("etag") ?? "",
        last_modified: response.headers.get("last-modified") ?? "",
      },
      now(),
    );
    await rename(tmp, osmIndexPath());
    // Close after the rename: a reader during the await would otherwise reopen and cache the old file.
    closeOsmIndex();
    console.error(
      `OpenStreetMap index: ${result.ways} ways and ${result.stops} crossing stops within ${OSM_INDEX_RADIUS_KM} km of HOME_START, data from ${result.data_date}, built in ${Math.round((now() - started) / 1000)} s`,
    );
    return "built";
  } catch (error) {
    console.error(
      `OpenStreetMap index: refresh failed (${error instanceof Error ? error.message : String(error)}); ${meta ? `keeping the index with data from ${meta.data_date}` : "no index yet"}. Trying again in a day.`,
    );
    return "failed";
  } finally {
    await rm(pbf, { force: true });
    await rm(tmp, { force: true });
  }
}

/** A 304: the index is current as of `at`. */
function touchCheckedAt(at: number): void {
  const db = new DatabaseSync(osmIndexPath());
  try {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'checked_at'").run(
      new Date(at).toISOString(),
    );
  } finally {
    db.close();
  }
  closeOsmIndex();
}
