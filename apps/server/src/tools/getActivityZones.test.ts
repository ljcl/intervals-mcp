import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import activityFixture from "../__fixtures__/intervals/activity.json";
import { mapIntervalsZones } from "../activityZones";
import { getActivity, type IntervalsActivity } from "../intervalsClient";
import { formatActivityZones, getActivityZonesTool } from "./getActivityZones";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, getActivity: vi.fn() };
});

const mockedGetActivity = vi.mocked(getActivity);

const runActivity = activityFixture as unknown as IntervalsActivity;

describe("formatActivityZones", () => {
  it("renders time and percentage per zone", () => {
    const text = formatActivityZones(mapIntervalsZones(runActivity));

    expect(text).toContain("Heart Rate Zones");
    // Fixture: icu_hr_zones [147,160,169,178,197], times [103,146,330,1684,111].
    // Total = 2374s; zone 4 (1684s) = 70.9%.
    expect(text).toContain("Z4 (169–178 bpm): 28:04 (70.9%)");
    // The top zone keeps its real upper bound, not an open-ended "+".
    expect(text).toContain("Z5 (178–197 bpm): 1:51 (4.7%)");
  });
});

describe("getActivityZonesTool.execute", () => {
  beforeEach(() => {
    mockedGetActivity.mockReset();
  });

  it("returns the formatted summary as the only text block", async () => {
    mockedGetActivity.mockResolvedValue(runActivity);

    const result = await getActivityZonesTool.execute(
      { id: "i12345" },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).toContain("Activity Zones (ID: i12345)");
    expect(result.content[0]?.text).toContain("Heart Rate Zones");
    expect(result.structuredContent?.zone_sets.length).toBeGreaterThan(0);
    expect(mockedGetActivity).toHaveBeenCalledWith("test-key", "i12345");
    // activity_id echoes the fetched activity's own id, not the raw input.
    expect(result.structuredContent?.activity_id).toBe(runActivity.id);
  });

  it("returns a graceful message when there is no zone data", async () => {
    mockedGetActivity.mockResolvedValue({
      ...runActivity,
      icu_hr_zones: null,
      icu_hr_zone_times: null,
    });

    const result = await getActivityZonesTool.execute(
      { id: "i999" },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("No zone data found");
    expect(result.structuredContent?.zone_sets).toEqual([]);
    expect(result.structuredContent?.activity_id).toBe(runActivity.id);
  });

  it("warns in the text when HR bounds and zone times counts don't match", async () => {
    mockedGetActivity.mockResolvedValue({
      ...runActivity,
      icu_hr_zones: [147, 160, 169, 178, 197],
      icu_hr_zone_times: [103, 146],
    });

    const result = await getActivityZonesTool.execute(
      { id: "i999" },
      "test-key",
    );

    expect(result.content[0]?.text).toContain("Heart rate zones omitted");
    expect(result.structuredContent?.zone_sets).toEqual([]);
  });

  it("maps a not-found error to a friendly message", async () => {
    mockedGetActivity.mockRejectedValue(handledNotFound("getActivity"));

    const result = await getActivityZonesTool.execute(
      { id: "i42" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("❌ Activity i42 was not found.");
  });

  it("renders the rate-limit window on a RateLimitError", async () => {
    mockedGetActivity.mockRejectedValue(handledRateLimit("getActivity"));

    const result = await getActivityZonesTool.execute(
      { id: "i42" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text.startsWith("❌")).toBe(true);
    expect(text).toContain("rate limit");
    expect(text).toContain("15-minute rate limit reached (100/100 requests).");
  });

  it("reports other failures with details", async () => {
    mockedGetActivity.mockRejectedValue(new Error("Bad Gateway"));

    const result = await getActivityZonesTool.execute(
      { id: "i42" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "❌ Failed to fetch zones for activity i42: Bad Gateway",
    );
  });
});
