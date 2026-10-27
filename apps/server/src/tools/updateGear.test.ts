import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound } from "../__fixtures__";
import {
  CallCancelledError,
  type CallScope,
  runInCallScope,
} from "../callScope";
import { HttpError, RequestTimeoutError } from "../fetchClient";
import {
  createGearReminder,
  type IntervalsGear,
  type IntervalsGearReminder,
  listGear,
  updateGear as putGear,
  resetGearReminder,
} from "../intervalsClient";
import { GearWriteOutputSchema } from "./outputs";
import { updateGearTool } from "./updateGear";

vi.mock("../intervalsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../intervalsClient")>();
  return {
    ...actual,
    listGear: vi.fn(),
    updateGear: vi.fn(),
    createGearReminder: vi.fn(),
    resetGearReminder: vi.fn(),
  };
});

vi.mock("../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config")>();
  return {
    ...actual,
    getIntervalsApiKey: vi.fn(() => "test-token"),
    getTimeZone: vi.fn(() => "Australia/Sydney"),
  };
});

const mockedList = vi.mocked(listGear);
const mockedPut = vi.mocked(putGear);
const mockedCreate = vi.mocked(createGearReminder);
const mockedReset = vi.mocked(resetGearReminder);

function shoe(overrides: Partial<IntervalsGear> = {}): IntervalsGear {
  return {
    id: "71459",
    name: "Daily Trainer B",
    type: "Shoes",
    distance: 62030.29,
    activities: 1,
    retired: null,
    purchased: "2026-09-01T00:00:00",
    notes: null,
    reminders: [],
    activity_filters: null,
    ...overrides,
  } as IntervalsGear;
}

const reminder = {
  id: 3,
  name: "Replace",
  distance: 700000,
  distance_used: 62030.29,
  percent_used: 8.86,
  last_reset: null,
};

function run(input: Record<string, unknown>) {
  return updateGearTool.execute(input as never, "test-token");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
  return () => vi.useRealTimers();
});

describe("updateGearTool input schema", () => {
  const parse = (input: Record<string, unknown>) =>
    updateGearTool.inputSchema.safeParse(input).success;

  it("takes exactly one change", () => {
    expect(parse({ gearId: "1", retired: true })).toBe(true);
    expect(parse({ gearId: "1", addReminderKm: 700 })).toBe(true);
    expect(parse({ gearId: "1", resetReminderId: 3 })).toBe(true);
    expect(parse({ gearId: "1" })).toBe(false);
    expect(parse({ gearId: "1", retired: true, addReminderKm: 700 })).toBe(
      false,
    );
  });

  it("rejects a bad distance and a name with no reminder", () => {
    expect(parse({ gearId: "1", addReminderKm: 0 })).toBe(false);
    expect(parse({ gearId: "1", addReminderKm: 100_001 })).toBe(false);
    expect(parse({ gearId: "1", retired: true, reminderName: "x" })).toBe(
      false,
    );
    expect(parse({ gearId: "1", addReminderKm: 700, reminderName: " " })).toBe(
      false,
    );
  });
});

describe("updateGearTool.execute", () => {
  it("lists the gear when the id is unknown, and writes nothing", async () => {
    mockedList.mockResolvedValueOnce([shoe()]);

    const result = await run({ gearId: "999", retired: true });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'Unknown gear id "999". Available gear: 71459 (Daily Trainer B)',
    );
    expect(mockedPut).not.toHaveBeenCalled();
  });

  it("retires today in the configured time zone, reading the list fresh both times", async () => {
    mockedList.mockResolvedValueOnce([shoe()]);
    mockedPut.mockResolvedValueOnce(shoe());
    mockedList.mockResolvedValueOnce([shoe({ retired: "2026-10-27" })]);

    const result = await run({ gearId: "71459", retired: true });

    expect(mockedPut).toHaveBeenCalledTimes(1);
    expect(mockedPut).toHaveBeenCalledWith("test-token", "71459", {
      retired: "2026-10-27",
    });
    expect(mockedList).toHaveBeenNthCalledWith(1, "test-token", {
      skipCache: true,
    });
    expect(mockedList).toHaveBeenNthCalledWith(2, "test-token", {
      skipCache: true,
    });
    expect(result.content[0]?.text).toBe(
      'Retired gear "Daily Trainer B" [71459] on 2026-10-27.',
    );
    const structured = GearWriteOutputSchema.parse(result.structuredContent);
    expect(structured.action).toBe("retire");
    expect(structured.gear.retired).toBe("2026-10-27");
    expect(structured.gear.purchased).toBe("2026-09-01");
    expect(structured.changes).toEqual([
      { field: "retired", before: null, after: "2026-10-27" },
    ]);
  });

  it("puts retired gear back in use with an empty retired", async () => {
    mockedList.mockResolvedValueOnce([shoe({ retired: "2026-01-01" })]);
    mockedPut.mockResolvedValueOnce(shoe());
    mockedList.mockResolvedValueOnce([shoe()]);

    const result = await run({ gearId: "71459", retired: false });

    expect(mockedPut).toHaveBeenCalledWith("test-token", "71459", {
      retired: "",
    });
    expect(result.content[0]?.text).toBe(
      'Put gear "Daily Trainer B" [71459] back in use (was retired 2026-01-01).',
    );
  });

  it("reports no change, with no write, when the gear already has that state", async () => {
    mockedList.mockResolvedValueOnce([shoe()]);

    const result = await run({ gearId: "71459", retired: false });

    expect(mockedPut).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toBe(
      'No change: gear "Daily Trainer B" [71459] is already in use.',
    );
  });

  it("warns when the re-read does not show the retirement", async () => {
    mockedList.mockResolvedValueOnce([shoe()]);
    mockedPut.mockResolvedValueOnce(shoe());
    mockedList.mockResolvedValueOnce([shoe()]);

    const result = await run({ gearId: "71459", retired: true });

    expect(
      GearWriteOutputSchema.parse(result.structuredContent).warnings,
    ).toEqual(["retired was not applied: the gear now shows in use."]);
  });

  it("adds a distance reminder in metres, named by its distance by default, and echoes its usage", async () => {
    mockedList.mockResolvedValueOnce([shoe()]);
    mockedCreate.mockResolvedValueOnce(shoe());
    mockedList.mockResolvedValueOnce([
      shoe({ reminders: [{ ...reminder, name: "700 km" }] }),
    ]);

    const result = await run({ gearId: "71459", addReminderKm: 700 });

    expect(mockedCreate).toHaveBeenCalledWith("test-token", "71459", {
      name: "700 km",
      distance: 700000,
    });
    expect(result.content[0]?.text).toBe(
      'Added reminder 3 "700 km": 700.0 km, 62.0 km used (9%) to gear "Daily Trainer B" [71459].',
    );
    const structured = GearWriteOutputSchema.parse(result.structuredContent);
    expect(structured.gear.reminders[0]).toMatchObject({
      id: 3,
      distance_km: 700,
      distance_used_km: 62,
    });
    expect(structured.changes).toEqual([
      { field: "reminders", before: 0, after: 1 },
    ]);
  });

  it("refuses a reminder the gear already has, so a repeat adds no duplicate", async () => {
    mockedList.mockResolvedValueOnce([shoe({ reminders: [reminder] })]);

    const result = await run({
      gearId: "71459",
      addReminderKm: 700,
      reminderName: "Replace",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("already has the reminder 3");
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("warns when the new reminder is missing from the re-read", async () => {
    mockedList.mockResolvedValueOnce([shoe()]);
    mockedCreate.mockResolvedValueOnce(shoe());
    mockedList.mockResolvedValueOnce([shoe()]);

    const result = await run({ gearId: "71459", addReminderKm: 650.5 });

    expect(result.content[0]?.text).toContain(
      'the new reminder was not found on the re-read: sent "650.5 km" at 650.5 km.',
    );
  });

  it("resets a reminder and echoes last_reset", async () => {
    mockedList.mockResolvedValueOnce([shoe({ reminders: [reminder] })]);
    mockedReset.mockResolvedValueOnce(shoe());
    mockedList.mockResolvedValueOnce([
      shoe({
        reminders: [
          {
            ...reminder,
            distance_used: 0,
            percent_used: 0,
            last_reset: "2026-10-27T00:00:00Z",
          },
        ],
      }),
    ]);

    const result = await run({ gearId: "71459", resetReminderId: 3 });

    expect(mockedReset).toHaveBeenCalledWith("test-token", "71459", 3);
    expect(result.content[0]?.text).toBe(
      'Reset reminder 3 "Replace": 700.0 km, 0.0 km used (0%) on gear "Daily Trainer B" [71459].',
    );
    expect(
      GearWriteOutputSchema.parse(result.structuredContent).changes,
    ).toEqual([
      { field: "last_reset", before: null, after: "2026-10-27T00:00:00Z" },
    ]);
  });

  describe("reset confirmation", () => {
    // 00:00 on 2026-10-27 in Sydney, the day the clock is pinned to: the
    // live value a reminder added that day carried (docs/api-notes.md).
    const todayStart = "2026-10-26T13:00:00.000+00:00";

    async function reset(
      before: Partial<IntervalsGearReminder>,
      after: Partial<IntervalsGearReminder>,
    ) {
      mockedList.mockResolvedValueOnce([
        shoe({ reminders: [{ ...reminder, ...before }] }),
      ]);
      mockedReset.mockResolvedValueOnce(shoe());
      mockedList.mockResolvedValueOnce([
        shoe({ reminders: [{ ...reminder, ...after }] }),
      ]);
      const result = await run({ gearId: "71459", resetReminderId: 3 });
      return {
        text: result.content[0]?.text,
        warnings: GearWriteOutputSchema.parse(result.structuredContent)
          .warnings,
      };
    }

    it("does not warn on a same-day reset with no usage counted", async () => {
      const unused = { last_reset: todayStart, distance_used: 0 };
      const { text, warnings } = await reset(unused, unused);

      expect(warnings).toEqual([]);
      expect(text).toContain(
        "last_reset already showed today and no usage was counted, so the re-read cannot show the reset.",
      );
    });

    it("confirms a same-day reset by the drop in usage", async () => {
      const { text, warnings } = await reset(
        { last_reset: todayStart, distance_used: 5000 },
        { last_reset: todayStart, distance_used: 0, percent_used: 0 },
      );

      expect(warnings).toEqual([]);
      expect(text).not.toContain("cannot show");
    });

    it("warns when last_reset stays on an earlier day", async () => {
      const old = { last_reset: "2026-10-20T13:00:00.000+00:00" };
      const { text, warnings } = await reset(
        { ...old, distance_used: 0 },
        { ...old, distance_used: 0 },
      );

      expect(warnings).toEqual([
        "the reset could not be confirmed: last_reset still shows 2026-10-20T13:00:00.000+00:00.",
      ]);
      expect(text).toContain("Warning: the reset could not be confirmed");
    });

    it("warns when a same-day reset leaves usage counted", async () => {
      const used = { last_reset: todayStart, distance_used: 5000 };
      const { warnings } = await reset(used, used);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("the reset could not be confirmed");
    });
  });

  it("names the reminders when the reminder id is unknown", async () => {
    mockedList.mockResolvedValueOnce([shoe({ reminders: [reminder] })]);

    const result = await run({ gearId: "71459", resetReminderId: 9 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'has no reminder 9: its reminders are 3 "Replace"',
    );
    expect(mockedReset).not.toHaveBeenCalled();
  });

  it("reports a possibly-applied write when the write times out", async () => {
    mockedList.mockResolvedValueOnce([shoe()]);
    mockedPut.mockRejectedValueOnce(
      new RequestTimeoutError("https://intervals.icu/api/v1/x", 30000),
    );

    const scope: CallScope = {};
    const result = await runInCallScope(scope, () =>
      run({ gearId: "71459", retired: true }),
    );

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("may already have been applied");
    expect(text).toContain("list-gear");
    expect(scope.failure).toEqual({ error_class: "RequestTimeoutError" });
  });

  it("reports a plain failure when the call was cancelled before the write left", async () => {
    mockedList.mockResolvedValueOnce([shoe()]);
    mockedCreate.mockRejectedValueOnce(new CallCancelledError("POST"));

    const result = await run({ gearId: "71459", addReminderKm: 700 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^❌ Failed to update gear 71459/);
  });

  it("reports a 404 from the write as not found", async () => {
    mockedList.mockResolvedValueOnce([shoe()]);
    mockedPut.mockRejectedValueOnce(handledNotFound("updateGear for ID 71459"));

    const result = await run({ gearId: "71459", retired: true });

    expect(result.content[0]?.text).toBe("❌ Gear 71459 was not found.");
  });

  it("reports a possibly-applied write on a 502 from the write", async () => {
    mockedList.mockResolvedValueOnce([shoe({ reminders: [reminder] })]);
    mockedReset.mockRejectedValueOnce(
      new HttpError("502", { status: 502, statusText: "", data: "" }),
    );

    const result = await run({ gearId: "71459", resetReminderId: 3 });

    expect(result.content[0]?.text).toContain("may already have been applied");
  });

  it("reports a possibly-applied write when the confirming re-read fails", async () => {
    mockedList.mockResolvedValueOnce([shoe()]);
    mockedPut.mockResolvedValueOnce(shoe());
    mockedList.mockRejectedValueOnce(new Error("network reset"));

    const result = await run({ gearId: "71459", retired: true });

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("was sent and may have been applied");
    expect(text).toContain("network reset");
    expect(mockedPut).toHaveBeenCalledTimes(1);
  });

  it("reports a possibly-applied write when the gear is gone from the re-read", async () => {
    mockedList.mockResolvedValueOnce([shoe()]);
    mockedPut.mockResolvedValueOnce(shoe());
    mockedList.mockResolvedValueOnce([]);

    const result = await run({ gearId: "71459", retired: true });

    expect(result.content[0]?.text).toContain(
      "missing from the re-read gear list",
    );
  });
});
