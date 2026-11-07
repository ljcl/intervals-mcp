import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { osmPbfBytes } from "./__fixtures__/osmPbf";
import {
  areaAround,
  areaKey,
  closeOsmIndex,
  osmIndexDir,
  osmIndexInfo,
  osmIndexMeta,
} from "./osmIndex";
import { refreshOsmIndex } from "./osmIndexRefresh";

const URL_ = "https://example.org/x.osm.pbf";
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");
const BYTES = osmPbfBytes({
  nodes: [
    { id: 1, lat: -33.87, lon: 151.2, tags: { highway: "crossing" } },
    { id: 2, lat: -33.871, lon: 151.2 },
  ],
  ways: [{ id: 10, refs: [1, 2], tags: { highway: "footway" } }],
});

let dir: string;
let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "osm-refresh-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("HOME_START", "-33.87,151.2");
  vi.stubEnv("OSM_EXTRACT_URL", URL_);
  closeOsmIndex();
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  closeOsmIndex();
  vi.unstubAllEnvs();
  errorLog.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

const ok = () =>
  new Response(BYTES as unknown as BodyInit, {
    headers: { etag: '"v1"', "last-modified": "Sat, 31 Oct 2026 16:21:44 GMT" },
  });
const leftovers = () =>
  ["extract.osm.pbf", "index.sqlite.tmp"].filter((f) =>
    existsSync(join(osmIndexDir(), f)),
  );

describe("refreshOsmIndex", () => {
  it("does nothing without the settings", async () => {
    vi.stubEnv("OSM_EXTRACT_URL", "");
    const fetch = vi.fn();
    expect(await refreshOsmIndex({ fetch })).toBe("off");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("builds the first index and cleans up", async () => {
    const fetch = vi.fn(async () => ok());
    expect(await refreshOsmIndex({ fetch, now: () => T0 })).toBe("built");
    const [url, init] = fetch.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(URL_);
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/^intervals-mcp\//);
    expect(headers["If-None-Match"]).toBeUndefined();
    expect(osmIndexInfo(T0)).toMatchObject({ state: "ready", age_days: 0 });
    expect(leftovers()).toEqual([]);
  });

  it("skips a check within a week, then asks conditionally", async () => {
    await refreshOsmIndex({ fetch: async () => ok(), now: () => T0 });
    const fetch = vi.fn(async () => new Response(null, { status: 304 }));
    expect(await refreshOsmIndex({ fetch, now: () => T0 + 3 * DAY })).toBe(
      "fresh",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await refreshOsmIndex({ fetch, now: () => T0 + 8 * DAY })).toBe(
      "unchanged",
    );
    const headers = (
      fetch.mock.calls[0]! as unknown as [string, RequestInit]
    )[1].headers as Record<string, string>;
    expect(headers["If-None-Match"]).toBe('"v1"');
    expect(headers["If-Modified-Since"]).toBe("Sat, 31 Oct 2026 16:21:44 GMT");
    expect(osmIndexInfo(T0 + 8 * DAY)).toMatchObject({
      state: "ready",
      age_days: 0,
    });
  });

  it("rebuilds for a new HOME_START without conditional headers", async () => {
    await refreshOsmIndex({ fetch: async () => ok(), now: () => T0 });
    vi.stubEnv("HOME_START", "-33.9,151.25");
    const fetch = vi.fn(async () => ok());
    expect(await refreshOsmIndex({ fetch, now: () => T0 + DAY })).toBe("built");
    const headers = (
      fetch.mock.calls[0]! as unknown as [string, RequestInit]
    )[1].headers as Record<string, string>;
    expect(headers["If-None-Match"]).toBeUndefined();
    expect(osmIndexMeta()!.area).toBe(areaKey(areaAround([-33.9, 151.25], 25)));
  });

  it.each([
    ["an HTTP error", async () => new Response("nope", { status: 500 })],
    [
      "a download that dies midway",
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(BYTES.subarray(0, 20));
              c.error(new Error("socket hang up"));
            },
          }),
        ),
    ],
  ])("keeps the old index after %s", async (_, failing) => {
    await refreshOsmIndex({ fetch: async () => ok(), now: () => T0 });
    vi.stubEnv("HOME_START", "-33.9,151.25");
    expect(await refreshOsmIndex({ fetch: failing, now: () => T0 + DAY })).toBe(
      "failed",
    );
    expect(osmIndexMeta()!.area).toBe(areaKey(areaAround([-33.87, 151.2], 25)));
    expect(leftovers()).toEqual([]);
    expect(
      errorLog.mock.calls.some(([m]: unknown[]) =>
        /refresh failed/.test(String(m)),
      ),
    ).toBe(true);
  });

  it("runs one refresh at a time", async () => {
    const fetch = vi.fn(async () => ok());
    const [a, b] = await Promise.all([
      refreshOsmIndex({ fetch, now: () => T0 }),
      refreshOsmIndex({ fetch, now: () => T0 }),
    ]);
    expect([a, b]).toEqual(["built", "built"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("builds over a stale temporary file", async () => {
    await mkdir(osmIndexDir(), { recursive: true });
    await writeFile(join(osmIndexDir(), "index.sqlite.tmp"), "junk");
    expect(
      await refreshOsmIndex({ fetch: async () => ok(), now: () => T0 }),
    ).toBe("built");
  });
});
