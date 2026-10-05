import { beforeEach, describe, expect, it, vi } from "vitest";
import { listActivities } from "./intervalsClient";
import {
  NoLatestRunError,
  RESOLVED_ARGS_META_KEY,
  resolvedArgsOf,
  resolveLatestIds,
  withResolvedArgs,
} from "./latestActivity";
import { addDays, daysBetween, todayLocal } from "./utils/localDate";

vi.mock("./intervalsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./intervalsClient")>()),
  listActivities: vi.fn(),
}));
vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  getTimeZone: vi.fn(() => "UTC"),
}));

const mockedList = vi.mocked(listActivities);
const act = (id: string, type: string, date: string) =>
  ({ id, type, start_date_local: `${date}T07:00:00` }) as never;

beforeEach(() => mockedList.mockReset());

describe("resolveLatestIds", () => {
  it("swaps latest for the newest run, skipping a newer swim", async () => {
    mockedList.mockResolvedValueOnce([
      act("i3", "Swim", "2026-10-04"),
      act("i2", "TrailRun", "2026-10-03"),
      act("i1", "Run", "2026-10-01"),
    ]);
    expect(
      await resolveLatestIds({ id: "latest", days: 3 }, ["id"], "k"),
    ).toEqual({ id: "i2", days: 3 });
    const range = mockedList.mock.calls[0]![1];
    expect(range.newest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("looks up once for two latest keys", async () => {
    mockedList.mockResolvedValueOnce([act("i9", "Run", "2026-10-01")]);
    const out = await resolveLatestIds(
      { activityId1: "latest", activityId2: "latest" },
      ["activityId1", "activityId2"],
      "k",
    );
    expect(out).toEqual({ activityId1: "i9", activityId2: "i9" });
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it("makes no call when nothing says latest", async () => {
    const args = { id: "i5" };
    expect(await resolveLatestIds(args, ["id"], "k")).toBe(args);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("ignores latest in a key that is not an id", async () => {
    const args = { name: "latest" };
    expect(await resolveLatestIds(args, ["id"], "k")).toBe(args);
  });

  it("throws NoLatestRunError when no run is found", async () => {
    mockedList.mockResolvedValue([act("i3", "Swim", "2026-10-04")]);
    await expect(
      resolveLatestIds({ id: "latest" }, ["id"], "k"),
    ).rejects.toBeInstanceOf(NoLatestRunError);
  });

  describe("window walk", () => {
    const today = () => todayLocal("UTC");
    const ranges = () => mockedList.mock.calls.map((call) => call[1]);

    it("makes one call when the newest window has a run", async () => {
      mockedList.mockResolvedValueOnce([act("i7", "Run", "2026-10-01")]);
      expect(await resolveLatestIds({ id: "latest" }, ["id"], "k")).toEqual({
        id: "i7",
      });
      expect(ranges()).toEqual([
        { oldest: addDays(today(), -30), newest: today() },
      ]);
    });

    it("walks back to the third window and stops at its run", async () => {
      mockedList
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([act("i8", "Swim", "2026-08-20")])
        .mockResolvedValueOnce([
          act("i6", "VirtualRun", "2026-07-30"),
          act("i5", "Run", "2026-07-20"),
        ]);
      expect(await resolveLatestIds({ id: "latest" }, ["id"], "k")).toEqual({
        id: "i6",
      });
      expect(ranges()).toEqual([
        { oldest: addDays(today(), -30), newest: today() },
        { oldest: addDays(today(), -61), newest: addDays(today(), -31) },
        { oldest: addDays(today(), -92), newest: addDays(today(), -62) },
      ]);
    });

    it("covers exactly 366 days before throwing NoLatestRunError", async () => {
      mockedList.mockResolvedValue([]);
      await expect(
        resolveLatestIds({ id: "latest" }, ["id"], "k"),
      ).rejects.toBeInstanceOf(NoLatestRunError);
      const all = ranges();
      expect(all[0]!.newest).toBe(today());
      expect(all.at(-1)!.oldest).toBe(addDays(today(), -365));
      let covered = 0;
      for (const [index, range] of all.entries()) {
        covered += daysBetween(range.oldest, range.newest) + 1;
        if (index > 0)
          expect(range.newest).toBe(addDays(all[index - 1]!.oldest, -1));
      }
      expect(covered).toBe(366);
    });

    it("passes progress on and reports each window past the first", async () => {
      const progress = vi.fn();
      mockedList
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([act("i4", "Run", "2026-08-20")]);
      await resolveLatestIds({ id: "latest" }, ["id"], "k", progress);
      for (const call of mockedList.mock.calls) expect(call[2]).toBe(progress);
      expect(progress).toHaveBeenCalledTimes(1);
      expect(progress.mock.calls[0]![0]).toContain(addDays(today(), -61));
    });
  });
});

describe("RESOLVED_ARGS_META_KEY", () => {
  // packages/ui mirrors this string (it cannot import the server).
  it("is the published literal", () => {
    expect(RESOLVED_ARGS_META_KEY).toBe("intervals-mcp/resolvedArgs");
  });
});

describe("resolvedArgsOf", () => {
  it("lists only the keys whose value changed", () => {
    expect(
      resolvedArgsOf(
        { activityId1: "latest", activityId2: "i1" },
        { activityId1: "i9", activityId2: "i1" },
      ),
    ).toEqual({ activityId1: "i9" });
  });

  it("is empty when nothing changed", () => {
    const args = { id: "i1" };
    expect(resolvedArgsOf(args, args)).toEqual({});
  });
});

describe("withResolvedArgs", () => {
  const ok = { content: [{ type: "text", text: "x" }] };

  it("merges into existing _meta rather than replacing it", () => {
    const out = withResolvedArgs({ ...ok, _meta: { other: 1 } }, { id: "i9" });
    expect(out._meta).toEqual({
      other: 1,
      [RESOLVED_ARGS_META_KEY]: { id: "i9" },
    });
  });

  it("returns the result untouched when nothing was resolved", () => {
    expect(withResolvedArgs(ok, {})).toBe(ok);
  });

  it("returns an error result untouched", () => {
    const failed = { ...ok, isError: true };
    expect(withResolvedArgs(failed, { id: "i9" })).toBe(failed);
  });
});
