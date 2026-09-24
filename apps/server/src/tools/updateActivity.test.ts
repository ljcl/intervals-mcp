import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActivityById as fetchActivityById,
  updateActivity as putActivity,
  type StravaDetailedActivity,
} from "../stravaClient";
import { ActivityWriteOutputSchema } from "./outputs";
import { updateActivityTool } from "./updateActivity";

vi.mock("../stravaClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stravaClient")>();
  return { ...actual, getActivityById: vi.fn(), updateActivity: vi.fn() };
});

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, getIntervalsApiKey: vi.fn(() => "test-token") };
});

const mockedFetch = vi.mocked(fetchActivityById);
const mockedPut = vi.mocked(putActivity);

function updatedActivity(
  overrides: Partial<StravaDetailedActivity> = {},
): StravaDetailedActivity {
  return {
    id: "555",
    name: "Morning Run",
    sport_type: "Run",
    gear: null,
    description: null,
    ...overrides,
  } as unknown as StravaDetailedActivity;
}

describe("updateActivityTool input schema", () => {
  it("rejects a sport type Strava does not define, before any write (#244)", () => {
    const result = updateActivityTool.inputSchema.safeParse({
      activityId: "555",
      sportType: "Jogging",
    });

    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toContain(
      "is not a Strava sport type",
    );
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it("leaves sportType optional", () => {
    expect(
      updateActivityTool.inputSchema.safeParse({
        activityId: "555",
        name: "Renamed",
      }).success,
    ).toBe(true);
  });
});

describe("updateActivityTool.execute", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedPut.mockReset();
  });

  it("rejects a call with no mutating fields", async () => {
    const result = await updateActivityTool.execute(
      { activityId: "555" },
      "test-token",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Nothing to update");
    expect(mockedPut).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("sends only the provided fields in the write payload", async () => {
    mockedPut.mockResolvedValueOnce(
      updatedActivity({ name: "Evening Ride", sport_type: "Ride" }),
    );

    await updateActivityTool.execute(
      {
        activityId: "555",
        name: "Evening Ride",
        sportType: "Ride",
        commute: true,
      },
      "test-token",
    );

    expect(mockedPut).toHaveBeenCalledWith("test-token", "555", {
      name: "Evening Ride",
      description: undefined,
      sportType: "Ride",
      gearId: undefined,
      commute: true,
      trainer: undefined,
      hideFromHome: undefined,
    });
    // No description means no read-modify-write fetch.
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("appends to the existing description by default", async () => {
    mockedFetch.mockResolvedValueOnce(
      updatedActivity({ description: "Existing notes" }),
    );
    mockedPut.mockResolvedValueOnce(updatedActivity());

    const result = await updateActivityTool.execute(
      {
        activityId: "555",
        description: "New line",
      },
      "test-token",
    );

    // The append read bypasses the cache so it never appends onto stale notes.
    expect(mockedFetch).toHaveBeenCalledWith("test-token", "555", {
      skipCache: true,
    });
    expect(mockedPut).toHaveBeenCalledWith(
      "test-token",
      "555",
      expect.objectContaining({ description: "Existing notes\n\nNew line" }),
    );
    expect(result.content[0]?.text).toContain("description (append)");
  });

  it("replaces the description without fetching the current value", async () => {
    mockedPut.mockResolvedValueOnce(updatedActivity());

    const result = await updateActivityTool.execute(
      {
        activityId: "555",
        description: "Fresh text",
        descriptionMode: "replace",
      },
      "test-token",
    );

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(mockedPut).toHaveBeenCalledWith(
      "test-token",
      "555",
      expect.objectContaining({ description: "Fresh text" }),
    );
    expect(result.content[0]?.text).toContain("description (replace)");
  });

  it("summarizes every changed field", async () => {
    mockedPut.mockResolvedValueOnce(
      updatedActivity({
        name: "Tempo",
        sport_type: "TrailRun",
        gear: { id: "g1", name: "Peg Trail" } as StravaDetailedActivity["gear"],
      }),
    );

    const result = await updateActivityTool.execute(
      {
        activityId: "555",
        name: "Tempo",
        sportType: "TrailRun",
        gearId: "g1",
        trainer: true,
        hideFromHome: true,
      },
      "test-token",
    );

    const text = result.content[0]?.text ?? "";
    expect(text).toContain('name to "Tempo"');
    expect(text).toContain("sport type to TrailRun");
    expect(text).toContain("gear to Peg Trail");
    expect(text).toContain("trainer=true");
    expect(text).toContain("hideFromHome=true");
  });

  it("adds a scope hint on a 401 error", async () => {
    mockedPut.mockRejectedValueOnce(new Error("Request failed with 401"));

    const result = await updateActivityTool.execute(
      {
        activityId: "555",
        name: "x",
      },
      "test-token",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "activity:write scope is missing",
    );
  });

  it("reports other failures without the scope hint", async () => {
    mockedPut.mockRejectedValueOnce(new Error("server exploded"));

    const result = await updateActivityTool.execute(
      {
        activityId: "555",
        name: "x",
      },
      "test-token",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("server exploded");
    expect(result.content[0]?.text).not.toContain("activity:write scope");
  });
});

// Driven through dispatchToolCall (the path a host actually takes) rather
// than a direct tool.execute() call, so the structured payload is validated
// exactly as advertised (#243). A separate describe block: dynamically
// importing "../server" pulls in its whole module graph, which the tests
// above don't need.
describe("update-activity via dispatchToolCall", () => {
  it("returns the activity as Strava echoed it back", async () => {
    mockedPut.mockResolvedValueOnce({
      id: "9001",
      name: "Renamed",
      sport_type: "Yoga",
      start_date_local: "2026-07-13T07:30:00Z",
      distance: 0,
      elapsed_time: 1800,
      description: "Felt strong",
      gear_id: null,
      commute: false,
      trainer: false,
    } as never);

    const { dispatchToolCall } = await import("../server");
    const result = await dispatchToolCall("update-activity", {
      activityId: "9001",
      name: "Renamed",
    });

    const structured = ActivityWriteOutputSchema.parse(
      result.structuredContent,
    );
    expect(structured.name).toBe("Renamed");
    expect(structured.description).toBe("Felt strong");
  });
});
