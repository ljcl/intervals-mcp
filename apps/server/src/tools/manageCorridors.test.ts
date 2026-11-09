import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SUNDAY_ACTIVITY,
  SUNDAY_ID,
  sundayStreams,
} from "../__fixtures__/sundayRoute";
import { routeOsmStats } from "../osmIndex";
import { listCorridors } from "../routeStore";
import { manageCorridorsTool } from "./manageCorridors";
import { CorridorResultOutputSchema } from "./outputs";

vi.mock("../osmIndex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../osmIndex")>()),
  routeOsmStats: vi.fn(),
}));

vi.mock("../intervalsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../intervalsClient")>()),
  getActivity: vi.fn(async () => structuredClone(SUNDAY_ACTIVITY)),
  getActivityStreams: vi.fn(async () => sundayStreams()),
}));

const isError = (r: object) => (r as { isError?: boolean }).isError;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "manage-corridors-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.mocked(routeOsmStats).mockReset().mockReturnValue(null);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

type Args = Parameters<typeof manageCorridorsTool.execute>[0];
const run = (args: Args) => manageCorridorsTool.execute(args, "key");
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;
const add = (name: string, from_km = 1, to_km = 3) =>
  run({
    action: "add",
    name,
    activity: { id: SUNDAY_ID, from_km, to_km },
  });

describe("manage-corridors", () => {
  it("adds from a km range, and the same add twice changes nothing", async () => {
    const first = await add("Bay Run");
    expect(isError(first)).toBeUndefined();
    const out = (
      first as {
        structuredContent: {
          created: boolean;
          corridor: {
            route_id: string;
            runs: null;
            from_run: unknown;
          };
        };
      }
    ).structuredContent;
    expect(out.created).toBe(true);
    expect(out.corridor.runs).toBeNull();
    expect(out.corridor.from_run).toEqual({
      activity_id: SUNDAY_ID,
      from_km: 1,
      to_km: 3,
    });
    CorridorResultOutputSchema.parse(
      (first as { structuredContent: unknown }).structuredContent,
    );

    const again = await add("Bay Run");
    expect(
      (again as { structuredContent: { created: boolean } }).structuredContent
        .created,
    ).toBe(false);
    expect(text(again as never)).toContain("already saved");
    expect(await listCorridors()).toHaveLength(1);
  });

  it.each([
    ["no name", { action: "add", activity: { id: SUNDAY_ID } }],
    ["no source", { action: "add", name: "X" }],
    [
      "both sources",
      {
        action: "add",
        name: "X",
        activity: { id: SUNDAY_ID },
        route: { route_id: "rabcdefghij" },
      },
    ],
    ["delete without id", { action: "delete" }],
  ])("refuses %s and stores nothing", async (_label, args) => {
    const result = await run(args as Args);
    expect(isError(result)).toBe(true);
    expect(text(result as never)).toMatch(/^❌/);
    expect(await listCorridors()).toHaveLength(0);
  });

  it.each([
    ["rename", {}, "rename needs name"],
    ["set_one_way", {}, "set_one_way needs one_way"],
    ["delete", { route_id: "" }, "delete needs route_id"],
  ])(
    "refuses %s with a missing field and changes nothing",
    async (action, extra, message) => {
      const added = await add("Bay Run");
      const id = (
        added as { structuredContent: { corridor: { route_id: string } } }
      ).structuredContent.corridor.route_id;
      const result = await run({
        action,
        route_id: id,
        ...extra,
      } as Args);
      expect(isError(result)).toBe(true);
      expect(text(result as never)).toContain(message);
      expect(await listCorridors()).toMatchObject([
        { route_id: id, name: "Bay Run", one_way: false },
      ]);
    },
  );

  it("refuses a rename to a name another corridor has", async () => {
    await add("Bay Run");
    const other = await add("Foreshore", 4, 6);
    const id = (
      other as { structuredContent: { corridor: { route_id: string } } }
    ).structuredContent.corridor.route_id;
    const result = await run({
      action: "rename",
      route_id: id,
      name: "bay  run",
    });
    expect(isError(result)).toBe(true);
    expect(text(result as never)).toContain("Bay Run");
  });

  it("refuses a rename to a name with no words", async () => {
    const added = await add("Bay Run");
    const id = (
      added as { structuredContent: { corridor: { route_id: string } } }
    ).structuredContent.corridor.route_id;
    const result = await run({ action: "rename", route_id: id, name: " !! " });
    expect(isError(result)).toBe(true);
    expect(text(result as never)).toContain("at least one word");
  });

  it("renames and sets one-way", async () => {
    const added = await add("Bay Run");
    const id = (
      added as { structuredContent: { corridor: { route_id: string } } }
    ).structuredContent.corridor.route_id;
    await run({ action: "rename", route_id: id, name: "Harbour" });
    const flipped = await run({
      action: "set_one_way",
      route_id: id,
      one_way: true,
    });
    expect(
      (
        flipped as {
          structuredContent: { corridor: { name: string; one_way: boolean } };
        }
      ).structuredContent.corridor,
    ).toMatchObject({ name: "Harbour", one_way: true });
  });

  it("deletes, then the list is empty", async () => {
    const added = await add("Bay Run");
    const id = (
      added as { structuredContent: { corridor: { route_id: string } } }
    ).structuredContent.corridor.route_id;
    const result = await run({ action: "delete", route_id: id });
    expect(
      (result as { structuredContent: { deleted: boolean; corridor: null } })
        .structuredContent,
    ).toMatchObject({ deleted: true, corridor: null });
    expect(await listCorridors()).toHaveLength(0);
  });

  it("refuses to delete a route that is not a corridor", async () => {
    const result = await run({ action: "delete", route_id: "rabcdefghij" });
    expect(isError(result)).toBe(true);
    expect(text(result as never)).toMatch(/^❌.*No saved corridor/);
  });
});
