import { beforeEach, describe, expect, it, vi } from "vitest";
import { basicRunActivity, rideActivity } from "./__fixtures__";
import { stravaApi } from "./fetchClient";
import { getAllActivities } from "./stravaClient";

vi.mock("./fetchClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fetchClient")>();
  return {
    ...actual,
    stravaApi: { get: vi.fn(), put: vi.fn() },
  };
});

const mockedGet = vi.mocked(stravaApi.get);

const run = (id: number) => ({ ...basicRunActivity, id });
const ride = (id: number) => ({ ...rideActivity, id });

const page = (activities: unknown[]) => ({ data: activities });

describe("getAllActivities pagination bounds", () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it("pages until a short page when no cap is set", async () => {
    mockedGet
      .mockResolvedValueOnce(page([run(1), run(2)]))
      .mockResolvedValueOnce(page([run(3)]));

    const activities = await getAllActivities("test-token", { perPage: 2 });

    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(activities).toHaveLength(3);
  });

  // Regression for #111: get-best-efforts used to walk the athlete's whole
  // history before applying maxActivities, burning the rate quota.
  it("stops fetching once maxItems activities have been collected", async () => {
    mockedGet
      .mockResolvedValueOnce(page([run(1), run(2)]))
      .mockResolvedValueOnce(page([run(3), run(4)]))
      .mockResolvedValueOnce(page([run(5), run(6)]));

    const activities = await getAllActivities("test-token", {
      perPage: 2,
      maxItems: 3,
    });

    // Page 2 satisfies the cap; page 3 is never requested.
    expect(mockedGet).toHaveBeenCalledTimes(2);
    // The satisfying page is returned in full; callers apply their own slice.
    expect(activities).toHaveLength(4);
  });

  it("counts only matching activities toward maxItems via countActivity", async () => {
    const isRun = (a: { type?: string | null }) => a.type === "Run";
    mockedGet
      .mockResolvedValueOnce(page([run(1), ride(2)]))
      .mockResolvedValueOnce(page([ride(3), ride(4)]))
      .mockResolvedValueOnce(page([run(5), ride(6)]))
      .mockResolvedValueOnce(page([run(7), run(8)]));

    const activities = await getAllActivities("test-token", {
      perPage: 2,
      maxItems: 2,
      countActivity: isRun,
    });

    // Two runs only arrive by page 3, so pagination continues past pages
    // full of rides and stops there; page 4 is never requested.
    expect(mockedGet).toHaveBeenCalledTimes(3);
    expect(activities.filter(isRun)).toHaveLength(2);
    expect(activities).toHaveLength(6);
  });
});
