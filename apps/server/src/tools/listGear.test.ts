import { beforeEach, describe, expect, it, vi } from "vitest";
import gearFixture from "../__fixtures__/intervals/gear.json";
import {
  type IntervalsGear,
  type IntervalsGearReminder,
  listGear,
} from "../intervalsClient";
import {
  formatGearListText,
  isRetired,
  listGearTool,
  mapGear,
  mapGearReminder,
} from "./listGear";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, listGear: vi.fn() };
});

const mockedListGear = vi.mocked(listGear);

const fixture = gearFixture as unknown as IntervalsGear[];
const byId = (id: string): IntervalsGear => {
  const found = fixture.find((g) => g.id === id);
  if (!found) throw new Error(`fixture missing ${id}`);
  return found;
};

describe("mapGear", () => {
  it("maps a real gear item: distance metres to km (1 dp), activities, no reminders", () => {
    const entry = mapGear(byId("71459"));

    expect(entry.id).toBe("71459");
    expect(entry.name).toBe("Dynafish Xiaonian B");
    expect(entry.type).toBe("Shoes");
    // 62030.29 m rounds to 62.0 km
    expect(entry.distance_km).toBe(62.0);
    expect(entry.activities).toBe(1);
    expect(entry.retired).toBeNull();
    expect(entry.reminders).toEqual([]);
  });

  it("rounds distance to 1 dp for another real item", () => {
    const entry = mapGear(byId("71460"));
    // 168000 m is exactly 168.0 km
    expect(entry.distance_km).toBe(168.0);
    expect(entry.activities).toBe(0);
  });

  it("maps a retired shoe (hand-written: the real account has none)", () => {
    const retiredShoe: IntervalsGear = {
      id: "99999",
      name: "Old Trainers",
      type: "Shoes",
      distance: 800000,
      activities: 120,
      retired: "2026-01-01T00:00:00",
      reminders: [],
    };

    const entry = mapGear(retiredShoe);
    expect(entry.retired).toBe("2026-01-01T00:00:00");
    expect(isRetired(retiredShoe)).toBe(true);
  });

  it("treats null and false retired as active", () => {
    expect(isRetired(byId("71459"))).toBe(false);
    expect(isRetired({ id: "1", retired: false } as IntervalsGear)).toBe(false);
  });

  it("falls back to defaults when name/type/distance/activities are missing", () => {
    const entry = mapGear({ id: "1" } as IntervalsGear);
    expect(entry.name).toBe("Gear");
    expect(entry.type).toBe("Equipment");
    expect(entry.distance_km).toBe(0);
    expect(entry.activities).toBe(0);
  });
});

describe("mapGearReminder", () => {
  it("maps known fields (distance metres to km, days, percent_used)", () => {
    const entry = mapGearReminder({
      name: "Replace soon",
      distance: 500000,
      days: 180,
      percent_used: 92,
    });

    expect(entry).toEqual({
      name: "Replace soon",
      distance_km: 500,
      days: 180,
      percent_used: 92,
    });
  });

  it("passes through an unrecognised numeric field rather than dropping it", () => {
    const entry = mapGearReminder({
      name: "Unusual reminder",
      some_new_field: 42,
    } as IntervalsGearReminder);

    expect(entry.name).toBe("Unusual reminder");
    expect(entry.some_new_field).toBe(42);
    expect(entry.distance_km).toBeUndefined();
  });

  it("omits distance_km/days/percent_used when absent, and defaults name to null", () => {
    const entry = mapGearReminder({});
    expect(entry).toEqual({ name: null });
  });
});

describe("formatGearListText", () => {
  it("reports the empty-gear message and count 0", () => {
    const text = formatGearListText({
      count: 0,
      units: { distance: "km" },
      gear: [],
    });
    expect(text).toBe(
      "No gear in intervals.icu. Add shoes on the intervals.icu Gear page to track mileage.",
    );
  });

  it("reports a different message when the account has gear but includeRetired filtered all of it out", () => {
    const text = formatGearListText(
      { count: 0, units: { distance: "km" }, gear: [] },
      3,
    );
    expect(text).toBe(
      "No active gear (3 retired hidden; pass includeRetired: true to show them).",
    );
  });

  it("renders one line per item with distance, activities, and id", () => {
    const entry = mapGear(byId("71459"));
    const text = formatGearListText({
      count: 1,
      units: { distance: "km" },
      gear: [entry],
    });

    const lines = text.split("\n");
    expect(lines[0]).toBe("Gear: 1");
    expect(lines[1]).toBe(
      "Dynafish Xiaonian B (Shoes): 62.0 km, 1 activities [71459]",
    );
  });

  it("flags retired items and reminder counts", () => {
    const entry = {
      ...mapGear(byId("71459")),
      retired: "2026-01-01",
      reminders: [{ name: "Replace soon" }],
    };
    const text = formatGearListText({
      count: 1,
      units: { distance: "km" },
      gear: [entry],
    });

    expect(text).toContain("retired");
    expect(text).toContain("1 reminder");
  });
});

describe("listGearTool.execute", () => {
  beforeEach(() => {
    mockedListGear.mockReset();
  });

  it("filters out retired gear by default", async () => {
    mockedListGear.mockResolvedValueOnce([
      ...fixture,
      {
        id: "9",
        name: "Retired Shoe",
        type: "Shoes",
        distance: 1000,
        activities: 1,
        retired: true,
        reminders: [],
      } as IntervalsGear,
    ]);

    const result = await listGearTool.execute({ includeRetired: false }, "key");

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.count).toBe(fixture.length);
    expect(result.structuredContent?.gear.some((g) => g.id === "9")).toBe(
      false,
    );
  });

  it("includes retired gear when includeRetired is true", async () => {
    mockedListGear.mockResolvedValueOnce([
      {
        id: "9",
        name: "Retired Shoe",
        type: "Shoes",
        distance: 1000,
        activities: 1,
        retired: true,
        reminders: [],
      } as IntervalsGear,
    ]);

    const result = await listGearTool.execute({ includeRetired: true }, "key");

    expect(result.structuredContent?.count).toBe(1);
    expect(result.structuredContent?.gear[0]?.id).toBe("9");
  });

  it("returns a valid empty payload (count 0) when the account has no gear", async () => {
    mockedListGear.mockResolvedValueOnce([]);

    const result = await listGearTool.execute({ includeRetired: false }, "key");

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      count: 0,
      units: { distance: "km" },
      gear: [],
    });
    expect(result.content[0]?.text).toBe(
      "No gear in intervals.icu. Add shoes on the intervals.icu Gear page to track mileage.",
    );
  });

  it("reports the retired-hidden message when every item is filtered out", async () => {
    mockedListGear.mockResolvedValueOnce([
      {
        id: "9",
        name: "Retired Shoe",
        type: "Shoes",
        distance: 1000,
        activities: 1,
        retired: true,
        reminders: [],
      } as IntervalsGear,
      {
        id: "10",
        name: "Another Retired Shoe",
        type: "Shoes",
        distance: 2000,
        activities: 2,
        retired: "2026-01-01",
        reminders: [],
      } as IntervalsGear,
    ]);

    const result = await listGearTool.execute({ includeRetired: false }, "key");

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.count).toBe(0);
    expect(result.content[0]?.text).toBe(
      "No active gear (2 retired hidden; pass includeRetired: true to show them).",
    );
  });

  it("maps the real fixture end to end", async () => {
    mockedListGear.mockResolvedValueOnce(fixture);

    const result = await listGearTool.execute({ includeRetired: false }, "key");

    expect(result.structuredContent?.count).toBe(fixture.length);
    expect(result.structuredContent?.gear.map((g) => g.id)).toEqual(
      fixture.map((g) => g.id),
    );
  });
});
