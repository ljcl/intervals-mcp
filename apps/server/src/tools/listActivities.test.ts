import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import activitiesFixture from "../__fixtures__/intervals/activities.json";
import { type IntervalsActivity, listActivities } from "../intervalsClient";
import {
  formatActivityListText,
  listActivitiesTool,
  mapActivitySummary,
} from "./listActivities";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, listActivities: vi.fn() };
});
vi.mock("../config", async () => {
  const actual = await vi.importActual<typeof import("../config")>("../config");
  return { ...actual, getTimeZone: vi.fn(() => "UTC") };
});

const mockedListActivities = vi.mocked(listActivities);

const fixture = activitiesFixture as unknown as IntervalsActivity[];
const byId = (id: string): IntervalsActivity => {
  const found = fixture.find((a) => a.id === id);
  if (!found) throw new Error(`fixture missing ${id}`);
  return found;
};

describe("mapActivitySummary", () => {
  it("maps a run with pace computed from distance / moving_time", () => {
    const entry = mapActivitySummary(byId("i189807578"));

    expect(entry.id).toBe("i189807578");
    expect(entry.date).toBe("2026-09-24");
    expect(entry.start_local).toBe("2026-09-24T16:25:25");
    expect(entry.type).toBe("Run");
    expect(entry.name).toBe("Run 1");
    expect(entry.distance_km).toBe(8.03);
    expect(entry.moving_time_s).toBe(2372);
    expect(entry.moving_time).toBe("39:32");
    expect(entry.pace_min_per_km).toBe("4:55");
    expect(entry.average_hr).toBe(171);
    expect(entry.load).toBe(56);
    expect(entry.gear_id).toBe("71459");
    expect(entry.source).toBe("OAUTH_CLIENT");
    expect(entry.is_strava_stub).toBe(false);
  });

  it("leaves distance and pace null for a non-distance activity", () => {
    const entry = mapActivitySummary(byId("i189757177"));

    expect(entry.type).toBe("WeightTraining");
    expect(entry.distance_km).toBeNull();
    expect(entry.pace_min_per_km).toBeNull();
    expect(entry.moving_time_s).toBe(3350);
    expect(entry.gear_id).toBeNull();
  });

  it("reports distance but no pace for a non-running distance sport", () => {
    const entry = mapActivitySummary(byId("i189757185"));

    expect(entry.type).toBe("Swim");
    expect(entry.distance_km).toBe(1.5);
    expect(entry.pace_min_per_km).toBeNull();
  });

  it("flags an activity sourced from Strava as a stub", () => {
    const stub = {
      ...byId("i189757177"),
      id: "i999",
      source: "STRAVA",
    } as IntervalsActivity;

    expect(mapActivitySummary(stub).is_strava_stub).toBe(true);
  });
});

describe("formatActivityListText", () => {
  it("renders a header, one line per activity, and a stub note", () => {
    const run = mapActivitySummary(byId("i189807578"));
    const stub = {
      ...mapActivitySummary(byId("i189757177")),
      is_strava_stub: true,
    };

    const text = formatActivityListText({
      oldest: "2026-08-28",
      newest: "2026-09-24",
      count: 2,
      matched: 2,
      truncated: false,
      units: { distance: "km", pace: "min/km", time: "s", hr: "bpm" },
      activities: [run, stub],
    });

    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "Activities 2026-08-28 to 2026-09-24: showing 2 of 2",
    );
    expect(lines[1]).toBe(
      "2026-09-24 Run Run 1, 8.03 km, 39:32, 4:55 /km, HR 171, load 56 [i189807578]",
    );
    expect(lines.at(-1)).toBe(
      "stub: details unavailable through the API; use the HealthFit copy.",
    );
  });

  it("marks truncation in the header and omits the stub note when none apply", () => {
    const run = mapActivitySummary(byId("i189807578"));

    const text = formatActivityListText({
      oldest: "2026-08-28",
      newest: "2026-09-24",
      count: 1,
      matched: 5,
      truncated: true,
      units: { distance: "km", pace: "min/km", time: "s", hr: "bpm" },
      activities: [run],
    });

    expect(text.split("\n")[0]).toBe(
      "Activities 2026-08-28 to 2026-09-24: showing 1 of 5, truncated",
    );
    expect(text).not.toContain("stub:");
  });

  it("renders a valid header with no activity lines when empty", () => {
    const text = formatActivityListText({
      oldest: "2026-08-28",
      newest: "2026-09-24",
      count: 0,
      matched: 0,
      truncated: false,
      units: { distance: "km", pace: "min/km", time: "s", hr: "bpm" },
      activities: [],
    });

    expect(text).toBe("Activities 2026-08-28 to 2026-09-24: showing 0 of 0");
  });
});

describe("listActivitiesTool.execute", () => {
  beforeEach(() => {
    mockedListActivities.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults newest to today and oldest to 27 days earlier", async () => {
    mockedListActivities.mockResolvedValueOnce([]);

    const result = await listActivitiesTool.execute({ limit: 30 }, "key");

    expect(mockedListActivities).toHaveBeenCalledWith("key", {
      oldest: "2026-08-28",
      newest: "2026-09-24",
    });
    expect(result.structuredContent?.oldest).toBe("2026-08-28");
    expect(result.structuredContent?.newest).toBe("2026-09-24");
    expect(result.structuredContent?.count).toBe(0);
    expect(result.isError).toBeUndefined();
  });

  it("filters by type, case-insensitively", async () => {
    mockedListActivities.mockResolvedValueOnce(fixture);

    const result = await listActivitiesTool.execute(
      { type: "weighttraining", limit: 30 },
      "key",
    );

    const activities = result.structuredContent?.activities ?? [];
    expect(activities.length).toBeGreaterThan(0);
    expect(
      activities.every((a: { type: string }) => a.type === "WeightTraining"),
    ).toBe(true);
    expect(result.structuredContent?.matched).toBe(activities.length);
  });

  it("filters by nameContains, case-insensitively", async () => {
    mockedListActivities.mockResolvedValueOnce(fixture);

    const result = await listActivitiesTool.execute(
      { nameContains: "PILATES", limit: 30 },
      "key",
    );

    const activities = result.structuredContent?.activities ?? [];
    expect(activities.length).toBe(2);
    expect(
      activities.every((a: { name: string }) => a.name.includes("Pilates")),
    ).toBe(true);
  });

  it("truncates to limit and reports matched vs count", async () => {
    mockedListActivities.mockResolvedValueOnce(fixture);

    const result = await listActivitiesTool.execute({ limit: 3 }, "key");

    expect(result.structuredContent?.count).toBe(3);
    expect(result.structuredContent?.matched).toBe(fixture.length);
    expect(result.structuredContent?.truncated).toBe(true);
  });

  it("does not truncate when matched equals or is under limit", async () => {
    mockedListActivities.mockResolvedValueOnce(fixture);

    const result = await listActivitiesTool.execute({ limit: 200 }, "key");

    expect(result.structuredContent?.count).toBe(fixture.length);
    expect(result.structuredContent?.matched).toBe(fixture.length);
    expect(result.structuredContent?.truncated).toBe(false);
  });

  it("returns a valid empty payload when nothing matches", async () => {
    mockedListActivities.mockResolvedValueOnce([]);

    const result = await listActivitiesTool.execute({ limit: 30 }, "key");

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      oldest: "2026-08-28",
      newest: "2026-09-24",
      count: 0,
      matched: 0,
      truncated: false,
      units: { distance: "km", pace: "min/km", time: "s", hr: "bpm" },
      activities: [],
    });
  });

  it("rejects oldest after newest", async () => {
    const result = await listActivitiesTool.execute(
      { oldest: "2026-09-24", newest: "2026-09-01", limit: 30 },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("oldest");
    expect(result.content[0]?.text).toContain("after newest");
    expect(mockedListActivities).not.toHaveBeenCalled();
  });

  it("rejects a range over 366 days", async () => {
    const result = await listActivitiesTool.execute(
      { oldest: "2024-01-01", newest: "2026-09-24", limit: 30 },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("366 days");
    expect(mockedListActivities).not.toHaveBeenCalled();
  });

  it("returns a friendly error for a 404", async () => {
    mockedListActivities.mockRejectedValueOnce(
      handledNotFound("listActivities"),
    );

    const result = await listActivitiesTool.execute({ limit: 30 }, "key");

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("❌");
  });

  it("renders the rate-limit window on a RateLimitError", async () => {
    mockedListActivities.mockRejectedValueOnce(
      handledRateLimit("listActivities"),
    );

    const result = await listActivitiesTool.execute({ limit: 30 }, "key");

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("rate limit");
  });
});
