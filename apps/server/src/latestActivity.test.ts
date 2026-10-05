import { beforeEach, describe, expect, it, vi } from "vitest";
import { listActivities } from "./intervalsClient";
import { NoLatestRunError, resolveLatestIds } from "./latestActivity";

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
    mockedList.mockResolvedValueOnce([act("i3", "Swim", "2026-10-04")]);
    await expect(
      resolveLatestIds({ id: "latest" }, ["id"], "k"),
    ).rejects.toBeInstanceOf(NoLatestRunError);
  });
});
