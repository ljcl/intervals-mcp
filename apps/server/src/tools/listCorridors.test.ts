import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUNDAY_ACTIVITY,
  SUNDAY_ID,
  SUNDAY_START,
  sundayStreams,
} from "../__fixtures__/sundayRoute";
import { routeOsmStats } from "../osmIndex";
import { readActivityTrack } from "../routeBuilder";
import { loadRunStarts, type RunStart } from "../startClusters";
import { listCorridorsTool } from "./listCorridors";
import { manageCorridorsTool } from "./manageCorridors";
import { CorridorListOutputSchema } from "./outputs";

vi.mock("../osmIndex", async (o) => ({
  ...(await o<typeof import("../osmIndex")>()),
  routeOsmStats: vi.fn(),
}));
vi.mock("../intervalsClient", async (o) => ({
  ...(await o<typeof import("../intervalsClient")>()),
  getActivity: vi.fn(async () => structuredClone(SUNDAY_ACTIVITY)),
  getActivityStreams: vi.fn(async () => sundayStreams()),
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
  const { track } = await readActivityTrack("key", SUNDAY_ID);
  const runs: RunStart[] = ["2026-11-01", "2026-10-25", "2026-10-18"].map(
    (date, i) => ({
      id: `i${i + 1}`,
      date,
      name: "Sunday long run",
      distance_m: 12030,
      climb_m: 30,
      track,
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
});
