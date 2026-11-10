import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUNDAY_ACTIVITY,
  SUNDAY_ID,
  SUNDAY_START,
  sundayPointAt,
  sundayStreams,
} from "../__fixtures__/sundayRoute";
import { geocode } from "../orsClient";
import { placeNear, routeOsmStats } from "../osmIndex";
import { readActivityTrack } from "../routeBuilder";
import { sliceTrack } from "../routeGeometry";
import { loadRunStarts, type RunStart } from "../startClusters";
import { listCorridorsTool } from "./listCorridors";
import { manageCorridorsTool } from "./manageCorridors";
import { CorridorListOutputSchema } from "./outputs";

vi.mock("../osmIndex", async (o) => ({
  ...(await o<typeof import("../osmIndex")>()),
  routeOsmStats: vi.fn(),
  placeNear: vi.fn(),
}));
vi.mock("../intervalsClient", async (o) => ({
  ...(await o<typeof import("../intervalsClient")>()),
  getActivity: vi.fn(async () => structuredClone(SUNDAY_ACTIVITY)),
  getActivityStreams: vi.fn(async () => sundayStreams()),
}));
vi.mock("../orsClient", async (o) => ({
  ...(await o<typeof import("../orsClient")>()),
  geocode: vi.fn(),
}));
vi.mock("../startClusters", async (o) => ({
  ...(await o<typeof import("../startClusters")>()),
  loadRunStarts: vi.fn(),
}));

const isError = (r: object) => (r as { isError?: boolean }).isError;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "list-corridors-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.mocked(routeOsmStats).mockReset().mockReturnValue(null);
  vi.mocked(placeNear).mockReset().mockReturnValue(null);
  const { track } = await readActivityTrack("key", SUNDAY_ID);
  // The two older runs stop at 8 km, so the line all three share is not a closed loop (dropped as a found stretch).
  const runs: RunStart[] = ["2026-11-01", "2026-10-25", "2026-10-18"].map(
    (date, i) => ({
      id: `i${i + 1}`,
      date,
      name: "Sunday long run",
      distance_m: 12030,
      climb_m: 30,
      track: i === 0 ? track : sliceTrack(track, 0, 8000),
    }),
  );
  vi.mocked(loadRunStarts).mockResolvedValue({ runs, skipped: 0 });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const near = SUNDAY_START.join(",");
const list = async () => {
  const result = await listCorridorsTool.execute({ near }, "key");
  expect(isError(result)).toBeUndefined();
  const { structuredContent } = result as { structuredContent: unknown };
  return CorridorListOutputSchema.parse(structuredContent);
};

describe("list-corridors", () => {
  it("is an empty payload without history", async () => {
    vi.mocked(loadRunStarts).mockResolvedValue({ runs: [], skipped: 0 });
    const out = await list();
    expect(out).toMatchObject({ count: 0, corridors: [], found: [] });
  });

  it("lists by name with no known start", async () => {
    vi.stubEnv("HOME_START", "");
    await manageCorridorsTool.execute(
      {
        action: "add",
        name: "Bay Run",
        activity: { id: SUNDAY_ID, from_km: 1, to_km: 3 },
      },
      "key",
    );
    vi.mocked(loadRunStarts).mockResolvedValue({ runs: [], skipped: 0 });
    const result = await listCorridorsTool.execute({}, "key");
    expect(isError(result)).toBeUndefined();
    const out = CorridorListOutputSchema.parse(
      (result as { structuredContent: unknown }).structuredContent,
    );
    expect(out.near).toBeNull();
    expect(out.found).toEqual([]);
    expect(out.corridors).toMatchObject([
      { name: "Bay Run", distance_m: null },
    ]);
  });

  it("offers a found stretch, lists it once saved, nearest first", async () => {
    const before = await list();
    expect(before.corridors).toEqual([]);
    const stretch = before.found[0]!;
    expect(stretch.runs).toBeGreaterThanOrEqual(3);

    for (const [name, from_km, to_km] of [
      ["Far side", 8, 10],
      ["Start", stretch.from_km, stretch.to_km],
    ] as const) {
      const saved = await manageCorridorsTool.execute(
        {
          action: "add",
          name,
          activity: { id: stretch.activity_id, from_km, to_km },
        },
        "key",
      );
      expect(isError(saved)).toBeUndefined();
    }

    const after = await list();
    expect(after.count).toBe(2);
    expect(after.corridors[0]!.name).toBe("Start");
    expect(after.corridors[0]!.runs).toBeGreaterThanOrEqual(3);
    expect(after.corridors[0]!.distance_m).toBeLessThanOrEqual(
      after.corridors[1]!.distance_m!,
    );
    expect(after.found.map((f) => `${f.from_km}-${f.to_km}`)).not.toContain(
      `${stretch.from_km}-${stretch.to_km}`,
    );
  });

  it("numbers found stretches and cuts them at a saved corridor", async () => {
    const before = await list();
    expect(before.found.map((f) => f.n)).toEqual(
      before.found.map((_, i) => i + 1),
    );
    const stretch = before.found[0]!;
    await manageCorridorsTool.execute(
      {
        action: "add",
        name: "Glebe foreshore",
        activity: { id: stretch.activity_id, from_km: 4, to_km: 5 },
      },
      "key",
    );
    const result = await listCorridorsTool.execute({ near }, "key");
    const out = CorridorListOutputSchema.parse(
      (result as { structuredContent: unknown }).structuredContent,
    );
    // The stretch is cut either side of the saved corridor, not offered whole.
    expect(out.found.length).toBeGreaterThan(1);
    for (const f of out.found)
      expect(f.from_km >= 5 || f.to_km <= 4).toBe(true);
    const text = (result as { content: { text: string }[] }).content[0]!.text;
    expect(text).toMatch(/^1\. /m);
    for (const f of out.found) expect(f.overlaps_found).not.toContain(f.n);
  });

  it("names the ends of a found stretch when the index knows them", async () => {
    const quiet = await listCorridorsTool.execute({ near }, "key");
    expect(
      (quiet as { content: { text: string }[] }).content[0]!.text,
    ).not.toMatch(/ to /);
    vi.mocked(placeNear)
      .mockReturnValueOnce("Jubilee Park")
      .mockReturnValueOnce("Bridge Road");
    const result = await listCorridorsTool.execute({ near }, "key");
    const out = CorridorListOutputSchema.parse(
      (result as { structuredContent: unknown }).structuredContent,
    );
    expect(out.found[0]).toMatchObject({
      start_place: "Jubilee Park",
      end_place: "Bridge Road",
    });
    expect(
      (result as { content: { text: string }[] }).content[0]!.text,
    ).toContain(": Jubilee Park to Bridge Road");
  });

  describe("through", () => {
    const place = (km: number) => sundayPointAt(km).join(",");
    const through = async (places: string[]) => {
      const result = await listCorridorsTool.execute(
        { near, through: places },
        "key",
      );
      return result as {
        isError?: boolean;
        content: Array<{ text: string }>;
        structuredContent: {
          through: Array<{ from_km: number; to_km: number | null }> | null;
        };
      };
    };

    it("is null when not asked", async () => {
      expect((await list()).through).toBeNull();
    });

    it("lists runs through one place, newest first", async () => {
      const out = await through([place(2)]);
      expect(out.structuredContent.through).toHaveLength(3);
      expect(out.structuredContent.through![0]!.to_km).toBeNull();
      expect(out.structuredContent.through![0]!.from_km).toBeCloseTo(2, 0);
    });

    it("says other way when the places are in the reverse order", async () => {
      const fwd = await through([place(1), place(3)]);
      expect(fwd.content[0]!.text).not.toContain("(other way)");
      const back = await through([place(3), place(1)]);
      expect(back.content[0]!.text).toContain("(other way)");
    });

    it("refuses a place that matched only a suburb", async () => {
      vi.stubEnv("ORS_API_KEY", "k");
      vi.mocked(geocode).mockResolvedValue({
        label: "Glebe, NSW, Australia",
        point: sundayPointAt(1),
        match: { query: "Glebe", name: "Glebe", type: "locality" },
      });
      const out = await through(["Glebe"]);
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toContain("matched only Glebe");
    });

    it("says so when no run passes", async () => {
      const out = await through(["-33.0,150.0"]);
      expect(out.structuredContent.through).toEqual([]);
      expect(out.content[0]!.text).toContain("No recent run passes that.");
    });
  });
});
