import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import activitiesFixture from "../__fixtures__/intervals/activities.json";
import {
  type IntervalsActivity,
  listActivities,
  searchActivities,
} from "../intervalsClient";
import { addDays } from "../utils/localDate";
import { RESPONSE_BUDGET_CHARS, responseSize } from "./_responseBudget";
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
  return { ...actual, listActivities: vi.fn(), searchActivities: vi.fn() };
});
vi.mock("../config", async () => {
  const actual = await vi.importActual<typeof import("../config")>("../config");
  return { ...actual, getTimeZone: vi.fn(() => "UTC") };
});

const mockedListActivities = vi.mocked(listActivities);
const mockedSearch = vi.mocked(searchActivities);

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

  it("passes tags and race through", () => {
    const entry = mapActivitySummary({
      ...byId("i189807578"),
      tags: ["a"],
      race: true,
    } as IntervalsActivity);

    expect(entry.tags).toEqual(["a"]);
    expect(entry.race).toBe(true);
  });

  it("defaults tags to [] and race to false", () => {
    const entry = mapActivitySummary({
      ...byId("i189807578"),
      tags: null,
      race: null,
    } as IntervalsActivity);

    expect(entry.tags).toEqual([]);
    expect(entry.race).toBe(false);
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
      search: null,
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
      search: null,
      units: { distance: "km", pace: "min/km", time: "s", hr: "bpm" },
      activities: [run],
    });

    expect(text.split("\n")[0]).toBe(
      "Activities 2026-08-28 to 2026-09-24: showing 1 of 5, truncated",
    );
    // The list is newest first, so what was cut is older: name the call
    // that fetches it rather than leave the reader at a dead end.
    expect(text).toContain(
      "For the 4 older matches, call again with oldest: 2026-08-28, newest: 2026-09-24.",
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
      search: null,
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

    expect(mockedListActivities).toHaveBeenCalledWith(
      "key",
      { oldest: "2026-08-28", newest: "2026-09-24" },
      expect.any(Function),
    );
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

  it("returns fewer than limit, truncated, when limit would overrun the response budget", async () => {
    // A year of daily activities at limit 200 made a 72 KB response (#40).
    const year = Array.from({ length: 366 }, (_, i) => ({
      ...fixture[i % fixture.length]!,
      id: `i${300_000_000 + i}`,
      start_date_local: `${addDays("2026-09-28", -i)}T07:00:00`,
    }));
    mockedListActivities.mockResolvedValueOnce(year);

    const result = await listActivitiesTool.execute(
      { oldest: "2025-09-28", newest: "2026-09-28", limit: 200 },
      "key",
    );

    const text = result.content[0]!.text;
    const structured = result.structuredContent!;
    expect(responseSize(text, structured)).toBeLessThanOrEqual(
      RESPONSE_BUDGET_CHARS,
    );
    expect(structured.count).toBeLessThan(200);
    expect(structured.count).toBeGreaterThan(30);
    expect(structured.activities).toHaveLength(structured.count);
    expect(structured.matched).toBe(366);
    expect(structured.truncated).toBe(true);
    expect(text).toContain("response size limit");
    const oldestShown = structured.activities.at(-1)!.date;
    expect(text).toContain(
      `call again with oldest: 2025-09-28, newest: ${oldestShown}`,
    );
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
      search: null,
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

  it("accepts a range of exactly 366 calendar days (both endpoints inclusive)", async () => {
    mockedListActivities.mockResolvedValueOnce([]);

    const result = await listActivitiesTool.execute(
      { oldest: "2025-09-24", newest: "2026-09-24", limit: 30 },
      "key",
    );

    expect(result.isError).toBeUndefined();
  });

  it("rejects a non-calendar date (2026-02-30) at the schema level", () => {
    const result = listActivitiesTool.inputSchema.safeParse({
      oldest: "2026-02-30",
      limit: 30,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a range one day past 366 calendar days", async () => {
    // daysBetween alone (a difference, not a count) would read this as 366
    // and wrongly accept it; the calendar-inclusive count is 367.
    const result = await listActivitiesTool.execute(
      { oldest: "2025-09-23", newest: "2026-09-24", limit: 30 },
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

  it('treats type "runs" as Run, TrailRun and VirtualRun', async () => {
    const mixed = ["Run", "TrailRun", "VirtualRun", "Swim", "Ride"].map(
      (type, i) => ({
        ...fixture[0]!,
        id: `i${900 + i}`,
        type,
        start_date_local: `2026-09-2${i}T07:00:00`,
      }),
    );
    mockedListActivities.mockResolvedValueOnce(mixed);

    const result = await listActivitiesTool.execute(
      { type: "runs", limit: 30 },
      "key",
    );

    expect(
      result.structuredContent?.activities.map((a) => a.type).sort(),
    ).toEqual(["Run", "TrailRun", "VirtualRun"]);
  });

  it("accepts a comma-separated type list", async () => {
    const mixed = ["Run", "Hike", "Ride"].map((type, i) => ({
      ...fixture[0]!,
      id: `i${950 + i}`,
      type,
      start_date_local: `2026-09-2${i}T07:00:00`,
    }));
    mockedListActivities.mockResolvedValueOnce(mixed);

    const result = await listActivitiesTool.execute(
      { type: "run, hike", limit: 30 },
      "key",
    );

    expect(
      result.structuredContent?.activities.map((a) => a.type).sort(),
    ).toEqual(["Hike", "Run"]);
  });
});

describe("listActivitiesTool.execute search", () => {
  const twoYearsAgo = {
    ...fixture[0]!,
    id: "i700",
    name: "Club 10K",
    type: "Run",
    start_date_local: "2024-09-26T07:00:00",
    race: true,
    tags: ["club"],
  } as IntervalsActivity;
  const lastWeek = {
    ...fixture[0]!,
    id: "i701",
    name: "Club 10K recce",
    type: "Ride",
    start_date_local: "2026-09-28T07:00:00",
    race: null,
    tags: null,
  } as IntervalsActivity;

  beforeEach(() => {
    mockedListActivities.mockReset();
    mockedSearch.mockReset();
  });

  it("searches all history and reports tags and race", async () => {
    mockedSearch.mockResolvedValueOnce([lastWeek, twoYearsAgo]);

    const result = await listActivitiesTool.execute(
      { search: "club 10k", limit: 30 },
      "key",
    );

    expect(mockedSearch).toHaveBeenCalledWith("key", "club 10k", 200);
    expect(mockedListActivities).not.toHaveBeenCalled();
    const s = result.structuredContent!;
    expect(s.search).toBe("club 10k");
    expect(s.activities.map((a) => a.id)).toEqual(["i701", "i700"]);
    expect(s.activities[1]).toMatchObject({ race: true, tags: ["club"] });
    expect(s.activities[0]).toMatchObject({ race: false, tags: [] });
    expect(s.oldest).toBe("2024-09-26");
    expect(s.newest).toBe("2026-09-28");
    expect(result.content[0]!.text.split("\n")[0]).toBe(
      'Activities matching "club 10k" (all history): showing 2 of 2',
    );
  });

  it("post-filters a search by type and window", async () => {
    mockedSearch.mockResolvedValueOnce([lastWeek, twoYearsAgo]);

    const result = await listActivitiesTool.execute(
      {
        search: "club",
        type: "runs",
        oldest: "2024-01-01",
        newest: "2025-01-01",
        limit: 30,
      },
      "key",
    );

    expect(result.structuredContent!.activities.map((a) => a.id)).toEqual([
      "i700",
    ]);
    expect(result.structuredContent!.oldest).toBe("2024-01-01");
    expect(result.structuredContent!.newest).toBe("2025-01-01");
  });

  it("ignores the 366-day range cap for a search", async () => {
    mockedSearch.mockResolvedValueOnce([twoYearsAgo]);

    const result = await listActivitiesTool.execute(
      { search: "club", oldest: "2020-01-01", newest: "2026-10-05", limit: 30 },
      "key",
    );

    expect(result.isError).toBeUndefined();
  });

  it("says nameContains is ignored with a search", async () => {
    mockedSearch.mockResolvedValueOnce([twoYearsAgo]);

    const result = await listActivitiesTool.execute(
      { search: "club", nameContains: "10k", limit: 30 },
      "key",
    );

    expect(result.content[0]!.text).toContain(
      "nameContains is ignored with search",
    );
  });

  it("returns a valid empty payload when a search matches nothing", async () => {
    mockedSearch.mockResolvedValueOnce([]);

    const result = await listActivitiesTool.execute(
      { search: "nope", limit: 30 },
      "key",
    );

    expect(result.structuredContent).toMatchObject({
      count: 0,
      matched: 0,
      search: "nope",
    });
  });

  it("keeps oldest in a truncated search's paging hint only when given", async () => {
    const many = Array.from({ length: 5 }, (_, n) => ({
      ...twoYearsAgo,
      id: `i80${n}`,
      start_date_local: `2026-09-2${5 - n}T07:00:00`,
    })) as IntervalsActivity[];

    mockedSearch.mockResolvedValueOnce(many);
    const without = await listActivitiesTool.execute(
      { search: "club", limit: 2 },
      "key",
    );
    expect(without.content[0]!.text).toContain(
      'For the 3 older matches, call again with search: "club", newest: 2026-09-24.',
    );

    mockedSearch.mockResolvedValueOnce(many);
    const withOldest = await listActivitiesTool.execute(
      { search: "club", oldest: "2026-01-01", limit: 2 },
      "key",
    );
    expect(withOldest.content[0]!.text).toContain(
      'For the 3 older matches, call again with search: "club", oldest: 2026-01-01, newest: 2026-09-24.',
    );
  });

  it("labels the window in the header when only newest is given", async () => {
    mockedSearch.mockResolvedValueOnce([lastWeek, twoYearsAgo]);

    const result = await listActivitiesTool.execute(
      { search: "club", newest: "2025-01-01", limit: 30 },
      "key",
    );

    expect(result.content[0]!.text.split("\n")[0]).toBe(
      'Activities matching "club" (2024-09-26 to 2025-01-01): showing 1 of 1',
    );
  });

  it("notes the 200-match cap when the search returns 200", async () => {
    mockedSearch.mockResolvedValueOnce(
      Array.from({ length: 200 }, (_, n) => ({
        ...twoYearsAgo,
        id: `i9${n}`,
      })) as IntervalsActivity[],
    );

    const result = await listActivitiesTool.execute(
      { search: "club", limit: 5 },
      "key",
    );

    expect(result.content[0]!.text).toContain(
      "search returns at most 200 matches, the most recent first; narrow the query, or list a date window without search (oldest/newest, up to 366 days) with nameContains to reach older ones.",
    );
  });

  it("rejects a reversed search window before calling the client", async () => {
    const result = await listActivitiesTool.execute(
      { search: "club", oldest: "2026-09-24", newest: "2026-09-01", limit: 30 },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("after newest");
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it("translates a search failure into an error text", async () => {
    mockedSearch.mockRejectedValueOnce(handledRateLimit("searchActivities"));

    const result = await listActivitiesTool.execute(
      { search: "club", limit: 30 },
      "key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.startsWith("❌")).toBe(true);
  });

  it("quotes a search query containing a double quote", async () => {
    const many = Array.from({ length: 3 }, (_, n) => ({
      ...twoYearsAgo,
      id: `i70${n}`,
      start_date_local: `2026-09-2${5 - n}T07:00:00`,
    })) as IntervalsActivity[];
    mockedSearch.mockResolvedValueOnce(many);

    const result = await listActivitiesTool.execute(
      { search: 'the "big" one', limit: 1 },
      "key",
    );

    const text = result.content[0]!.text;
    expect(text.split("\n")[0]).toBe(
      'Activities matching "the \\"big\\" one" (all history): showing 1 of 3, truncated',
    );
    expect(text).toContain('search: "the \\"big\\" one", newest: 2026-09-25.');
  });

  it("carries the type filter into the paging hint on a search", async () => {
    const many = Array.from({ length: 3 }, (_, n) => ({
      ...twoYearsAgo,
      id: `i71${n}`,
      start_date_local: `2026-09-2${5 - n}T07:00:00`,
    })) as IntervalsActivity[];
    mockedSearch.mockResolvedValueOnce(many);

    const result = await listActivitiesTool.execute(
      { search: "club", type: "runs", limit: 1 },
      "key",
    );

    expect(result.content[0]!.text).toContain(
      'call again with search: "club", type: "runs", newest: 2026-09-25.',
    );
  });
});

describe("listActivitiesTool.execute paging hint with type", () => {
  beforeEach(() => {
    mockedListActivities.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("carries the type filter into a list paging hint", async () => {
    const runs = Array.from({ length: 3 }, (_, n) => ({
      ...fixture[0]!,
      id: `i72${n}`,
      type: "Run",
      start_date_local: `2026-09-2${4 - n}T07:00:00`,
    })) as IntervalsActivity[];
    mockedListActivities.mockResolvedValueOnce(runs);

    const result = await listActivitiesTool.execute(
      { type: "runs", limit: 1 },
      "key",
    );

    expect(result.content[0]!.text).toContain(
      'call again with type: "runs", oldest: 2026-08-28, newest: 2026-09-24.',
    );
  });
});
