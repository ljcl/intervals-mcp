import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound } from "../__fixtures__";
import { RequestTimeoutError } from "../fetchClient";
import {
  getActivity,
  type IntervalsActivity,
  type IntervalsGear,
  listGear,
  updateActivity as putActivity,
} from "../intervalsClient";
import { ActivityWriteOutputSchema } from "./outputs";
import { updateActivityTool } from "./updateActivity";

vi.mock("../intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../intervalsClient")>();
  return {
    ...actual,
    getActivity: vi.fn(),
    updateActivity: vi.fn(),
    listGear: vi.fn(),
  };
});

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return { ...actual, getIntervalsApiKey: vi.fn(() => "test-token") };
});

const mockedGetActivity = vi.mocked(getActivity);
const mockedPut = vi.mocked(putActivity);
const mockedListGear = vi.mocked(listGear);

function activity(
  overrides: Partial<IntervalsActivity> = {},
): IntervalsActivity {
  return {
    id: "555",
    start_date_local: "2026-09-20T07:00:00",
    name: "Morning Run",
    description: null,
    gear: null,
    icu_rpe: null,
    feel: null,
    ...overrides,
  } as IntervalsActivity;
}

const gearList: IntervalsGear[] = [
  { id: "g1", name: "Pegasus", retired: null },
  { id: "g2", name: "Old Trainers", retired: "2026-01-01" },
];

describe("updateActivityTool input schema", () => {
  it("rejects rpe below 1", () => {
    expect(
      updateActivityTool.inputSchema.safeParse({ id: "555", rpe: 0 }).success,
    ).toBe(false);
  });
  it("rejects rpe above 10", () => {
    expect(
      updateActivityTool.inputSchema.safeParse({ id: "555", rpe: 11 }).success,
    ).toBe(false);
  });
  it("rejects feel above 5", () => {
    expect(
      updateActivityTool.inputSchema.safeParse({ id: "555", feel: 6 }).success,
    ).toBe(false);
  });
  it("rejects a non-integer feel", () => {
    expect(
      updateActivityTool.inputSchema.safeParse({ id: "555", feel: 2.5 })
        .success,
    ).toBe(false);
  });
  it("accepts a bare name change", () => {
    expect(
      updateActivityTool.inputSchema.safeParse({ id: "555", name: "x" })
        .success,
    ).toBe(true);
  });
  it("rejects an empty name", () => {
    expect(
      updateActivityTool.inputSchema.safeParse({ id: "555", name: "" }).success,
    ).toBe(false);
  });
  it("rejects a whitespace-only name", () => {
    expect(
      updateActivityTool.inputSchema.safeParse({ id: "555", name: "   " })
        .success,
    ).toBe(false);
  });
  it("rejects a whitespace-only description in append mode", () => {
    const result = updateActivityTool.inputSchema.safeParse({
      id: "555",
      description: "   ",
      descriptionMode: "append",
    });
    expect(result.success).toBe(false);
  });
  it("rejects an empty description in append mode", () => {
    const result = updateActivityTool.inputSchema.safeParse({
      id: "555",
      description: "",
      descriptionMode: "append",
    });
    expect(result.success).toBe(false);
  });
  it("accepts an empty description in replace mode (an explicit clear)", () => {
    expect(
      updateActivityTool.inputSchema.safeParse({
        id: "555",
        description: "",
        descriptionMode: "replace",
      }).success,
    ).toBe(true);
  });
  it("accepts an empty description with no descriptionMode (replace is the default)", () => {
    expect(
      updateActivityTool.inputSchema.safeParse({ id: "555", description: "" })
        .success,
    ).toBe(true);
  });
  it("rejects descriptionMode without description", () => {
    const result = updateActivityTool.inputSchema.safeParse({
      id: "555",
      descriptionMode: "append",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateActivityTool.execute", () => {
  beforeEach(() => {
    mockedGetActivity.mockReset();
    mockedPut.mockReset();
    mockedListGear.mockReset();
  });

  it("rejects a call with no mutating fields, before any network call", async () => {
    const result = await updateActivityTool.execute(
      { id: "555" } as never,
      "test-token",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Nothing to update");
    expect(mockedGetActivity).not.toHaveBeenCalled();
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it("always does a fresh read before writing", async () => {
    mockedGetActivity.mockResolvedValueOnce(activity());
    mockedPut.mockResolvedValueOnce(activity({ name: "Evening Run" }));
    mockedGetActivity.mockResolvedValueOnce(activity({ name: "Evening Run" }));

    await updateActivityTool.execute(
      { id: "555", name: "Evening Run" } as never,
      "test-token",
    );

    expect(mockedGetActivity).toHaveBeenNthCalledWith(1, "test-token", "555", {
      skipCache: true,
    });
  });

  it("replaces the description by default", async () => {
    mockedGetActivity.mockResolvedValueOnce(
      activity({ description: "Existing notes" }),
    );
    mockedPut.mockResolvedValueOnce(activity({ description: "New text" }));
    mockedGetActivity.mockResolvedValueOnce(
      activity({ description: "New text" }),
    );

    const result = await updateActivityTool.execute(
      { id: "555", description: "New text" } as never,
      "test-token",
    );

    expect(mockedPut).toHaveBeenCalledWith("test-token", "555", {
      description: "New text",
    });
    expect(result.isError).toBeUndefined();
  });

  it("appends to the existing description when descriptionMode is append", async () => {
    mockedGetActivity.mockResolvedValueOnce(
      activity({ description: "Existing notes" }),
    );
    mockedPut.mockResolvedValueOnce(
      activity({ description: "Existing notes\n\nNew line" }),
    );
    mockedGetActivity.mockResolvedValueOnce(
      activity({ description: "Existing notes\n\nNew line" }),
    );

    await updateActivityTool.execute(
      {
        id: "555",
        description: "New line",
        descriptionMode: "append",
      } as never,
      "test-token",
    );

    expect(mockedPut).toHaveBeenCalledWith("test-token", "555", {
      description: "Existing notes\n\nNew line",
    });
  });

  it("clears the description with an explicit empty string in replace mode", async () => {
    mockedGetActivity.mockResolvedValueOnce(
      activity({ description: "Existing notes" }),
    );
    mockedPut.mockResolvedValueOnce(activity({ description: null }));
    mockedGetActivity.mockResolvedValueOnce(activity({ description: null }));

    const result = await updateActivityTool.execute(
      { id: "555", description: "" } as never,
      "test-token",
    );

    expect(mockedPut).toHaveBeenCalledWith("test-token", "555", {
      description: "",
    });
    expect(result.isError).toBeUndefined();
  });

  it("treats null and empty-string description as equal, sending no PUT", async () => {
    mockedGetActivity.mockResolvedValueOnce(activity({ description: null }));

    const result = await updateActivityTool.execute(
      { id: "555", description: "" } as never,
      "test-token",
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("No change");
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it("sends only the fields that differ from the current value", async () => {
    mockedGetActivity.mockResolvedValueOnce(
      activity({ name: "Morning Run", icu_rpe: 5 }),
    );
    mockedPut.mockResolvedValueOnce(
      activity({ name: "Morning Run", icu_rpe: 7 }),
    );
    mockedGetActivity.mockResolvedValueOnce(
      activity({ name: "Morning Run", icu_rpe: 7 }),
    );

    await updateActivityTool.execute(
      { id: "555", name: "Morning Run", rpe: 7 } as never,
      "test-token",
    );

    expect(mockedPut).toHaveBeenCalledWith("test-token", "555", {
      icu_rpe: 7,
    });
  });

  it("reports no change and skips the PUT when every requested value already matches", async () => {
    mockedGetActivity.mockResolvedValueOnce(
      activity({ name: "Morning Run", icu_rpe: 5 }),
    );

    const result = await updateActivityTool.execute(
      { id: "555", name: "Morning Run", rpe: 5 } as never,
      "test-token",
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("No change");
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it("reads the activity before validating gear, so a missing activity reports not-found first", async () => {
    mockedGetActivity.mockRejectedValueOnce(
      handledNotFound("getActivity for ID 555"),
    );

    const result = await updateActivityTool.execute(
      { id: "555", gearId: "g99" } as never,
      "test-token",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Activity 555 was not found.");
    expect(mockedListGear).not.toHaveBeenCalled();
  });

  it("validates gearId against a fresh list-gear read and rejects an unknown id, listing available gear", async () => {
    mockedGetActivity.mockResolvedValueOnce(activity());
    mockedListGear.mockResolvedValueOnce(gearList);

    const result = await updateActivityTool.execute(
      { id: "555", gearId: "g99" } as never,
      "test-token",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unknown gear id "g99"');
    expect(result.content[0]?.text).toContain("g1 (Pegasus)");
    expect(result.content[0]?.text).toContain("g2 (Old Trainers, retired)");
    expect(mockedGetActivity).toHaveBeenCalledTimes(1);
    expect(mockedListGear).toHaveBeenCalledWith("test-token", {
      skipCache: true,
    });
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it("allows retired gear with a warning", async () => {
    mockedGetActivity.mockResolvedValueOnce(activity({ gear: null }));
    mockedListGear.mockResolvedValueOnce(gearList);
    mockedPut.mockResolvedValueOnce(
      activity({ gear: { id: "g2", name: null } }),
    );
    mockedGetActivity.mockResolvedValueOnce(
      activity({ gear: { id: "g2", name: null } }),
    );

    const result = await updateActivityTool.execute(
      { id: "555", gearId: "g2" } as never,
      "test-token",
    );

    expect(result.isError).toBeUndefined();
    expect(mockedPut).toHaveBeenCalledWith("test-token", "555", {
      gear: { id: "g2" },
    });
    expect(result.content[0]?.text).toContain("retired");
    const structured = ActivityWriteOutputSchema.parse(
      result.structuredContent,
    );
    expect(structured.gear_name).toBe("Old Trainers");
    expect(structured.warnings.some((w) => w.includes("retired"))).toBe(true);
  });

  it("warns when the re-read shows gear was not applied, and leaves gear_name null", async () => {
    mockedGetActivity.mockResolvedValueOnce(activity({ gear: null }));
    mockedListGear.mockResolvedValueOnce(gearList);
    mockedPut.mockResolvedValueOnce(activity({ gear: null }));
    // Re-read shows the gear never actually took (e.g. server ignored it).
    mockedGetActivity.mockResolvedValueOnce(activity({ gear: null }));

    const result = await updateActivityTool.execute(
      { id: "555", gearId: "g1" } as never,
      "test-token",
    );

    expect(result.isError).toBeUndefined();
    const structured = ActivityWriteOutputSchema.parse(
      result.structuredContent,
    );
    expect(
      structured.warnings.some((w) => w.includes("gear was not applied")),
    ).toBe(true);
    expect(structured.gear_name).toBeNull();
  });

  it("echoes before/after for every changed field", async () => {
    mockedGetActivity.mockResolvedValueOnce(
      activity({ name: "Morning Run", feel: 3 }),
    );
    mockedPut.mockResolvedValueOnce(activity({ name: "Tempo", feel: 1 }));
    mockedGetActivity.mockResolvedValueOnce(
      activity({ name: "Tempo", feel: 1 }),
    );

    const result = await updateActivityTool.execute(
      { id: "555", name: "Tempo", feel: 1 } as never,
      "test-token",
    );

    const structured = ActivityWriteOutputSchema.parse(
      result.structuredContent,
    );
    expect(structured.changes).toEqual([
      { field: "name", before: "Morning Run", after: "Tempo" },
      { field: "feel", before: 3, after: 1 },
    ]);
  });

  it("shows the description change as its length and a 120-character preview in the text response", async () => {
    const longText = "x".repeat(200);
    mockedGetActivity.mockResolvedValueOnce(activity({ description: null }));
    mockedPut.mockResolvedValueOnce(activity({ description: longText }));
    mockedGetActivity.mockResolvedValueOnce(
      activity({ description: longText }),
    );

    const result = await updateActivityTool.execute(
      { id: "555", description: longText } as never,
      "test-token",
    );

    const text = result.content[0]?.text ?? "";
    expect(text).toContain(`description to ${longText.length} chars`);
    expect(text).toContain(`"${"x".repeat(120)}..."`);
    expect(text).not.toContain(longText);
    // The full text is still in structuredContent.changes.
    const structured = ActivityWriteOutputSchema.parse(
      result.structuredContent,
    );
    expect(structured.changes[0]?.after).toBe(longText);
  });

  it("never retries: exactly one PUT even when it rejects", async () => {
    mockedGetActivity.mockResolvedValueOnce(activity());
    mockedPut.mockRejectedValueOnce(new Error("upstream 503"));

    const result = await updateActivityTool.execute(
      { id: "555", name: "x" } as never,
      "test-token",
    );

    expect(result.isError).toBe(true);
    expect(mockedPut).toHaveBeenCalledTimes(1);
  });

  it("uses toolErrorText's notFound message on a 404", async () => {
    mockedGetActivity.mockRejectedValueOnce(
      handledNotFound("getActivity for ID 555"),
    );

    const result = await updateActivityTool.execute(
      { id: "555", name: "x" } as never,
      "test-token",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Activity 555 was not found.");
    expect(result.content[0]?.text).not.toContain("401");
  });

  it("reports the intervals.icu activity URL", async () => {
    mockedGetActivity.mockResolvedValueOnce(activity());
    mockedPut.mockResolvedValueOnce(activity({ name: "Tempo" }));
    mockedGetActivity.mockResolvedValueOnce(activity({ name: "Tempo" }));

    const result = await updateActivityTool.execute(
      { id: "555", name: "Tempo" } as never,
      "test-token",
    );

    const structured = ActivityWriteOutputSchema.parse(
      result.structuredContent,
    );
    expect(structured.url).toBe("https://intervals.icu/activities/555");
  });

  it("reports a possibly-applied write when the PUT itself times out", async () => {
    mockedGetActivity.mockResolvedValueOnce(activity());
    mockedPut.mockRejectedValueOnce(
      new RequestTimeoutError(
        "https://intervals.icu/api/v1/activity/555",
        30000,
      ),
    );

    const result = await updateActivityTool.execute(
      { id: "555", name: "Tempo" } as never,
      "test-token",
    );

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("timed out");
    expect(text).toContain("may already have been applied");
    expect(text).toContain("get-activity");
    expect(text.toLowerCase()).not.toContain("retry now");
  });

  it("reports a possibly-applied write when the confirming re-read fails after the PUT resolved", async () => {
    mockedGetActivity.mockResolvedValueOnce(activity());
    mockedPut.mockResolvedValueOnce(activity({ name: "Tempo" }));
    mockedGetActivity.mockRejectedValueOnce(new Error("network reset"));

    const result = await updateActivityTool.execute(
      { id: "555", name: "Tempo" } as never,
      "test-token",
    );

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("was sent and may have been applied");
    expect(text).toContain("confirming it afterward failed");
    expect(text).toContain("network reset");
    expect(text).toContain("get-activity");
    expect(mockedPut).toHaveBeenCalledTimes(1);
  });
});

// Driven through dispatchToolCall (the path a host actually takes) rather
// than a direct tool.execute() call, so the structured payload is validated
// exactly as advertised (#243).
describe("update-activity via dispatchToolCall", () => {
  it("returns the intervals.icu activity as freshly re-read", async () => {
    mockedGetActivity.mockResolvedValueOnce(activity());
    mockedPut.mockResolvedValueOnce(activity({ name: "Renamed" }));
    mockedGetActivity.mockResolvedValueOnce(activity({ name: "Renamed" }));

    const { dispatchToolCall } = await import("../server");
    const result = await dispatchToolCall("update-activity", {
      id: "555",
      name: "Renamed",
    });

    const structured = ActivityWriteOutputSchema.parse(
      result.structuredContent,
    );
    expect(structured.activity_id).toBe("555");
    expect(structured.name).toBe("Renamed");
    expect(structured.url).toBe("https://intervals.icu/activities/555");
  });
});
