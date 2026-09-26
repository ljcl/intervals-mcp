import { describe, expect, it } from "vitest";
import { type IntervalsGear } from "../intervalsClient";
import {
  buildActivityPatch,
  composeDescription,
  describeGearOptions,
  diffActivityWrite,
  discardedDescription,
  findGear,
  isGearRetired,
} from "./activityWrite";

describe("composeDescription", () => {
  it("replaces when mode is replace", () => {
    expect(composeDescription("old notes", "new", "replace")).toBe("new");
  });

  it("appends with a blank-line separator", () => {
    expect(composeDescription("old notes", "new", "append")).toBe(
      "old notes\n\nnew",
    );
  });

  it("returns incoming alone when existing is null", () => {
    expect(composeDescription(null, "new", "append")).toBe("new");
  });

  it("returns incoming alone when existing is whitespace only", () => {
    expect(composeDescription("   ", "new", "append")).toBe("new");
  });
});

describe("discardedDescription", () => {
  it("returns the existing text when the new text does not contain it", () => {
    expect(discardedDescription("old notes", "new")).toBe("old notes");
  });

  it("returns the existing text when the new value clears it", () => {
    expect(discardedDescription("old notes", "")).toBe("old notes");
    expect(discardedDescription("old notes", null)).toBe("old notes");
  });

  it("returns null when there is no existing text to lose", () => {
    expect(discardedDescription(null, "new")).toBeNull();
    expect(discardedDescription(undefined, "new")).toBeNull();
    expect(discardedDescription("", "new")).toBeNull();
  });

  it("treats a whitespace-only existing description as empty", () => {
    expect(discardedDescription("  \n ", "new")).toBeNull();
  });

  it("returns null when the new text already contains the existing text, compared trimmed", () => {
    expect(discardedDescription("old notes\n", "old notes\n\nnew")).toBeNull();
    expect(discardedDescription("old notes", "old notes")).toBeNull();
  });
});

describe("isGearRetired", () => {
  it("is false for null", () => {
    expect(isGearRetired(null)).toBe(false);
  });
  it("is false for an empty string", () => {
    expect(isGearRetired("")).toBe(false);
  });
  it("is true for a retirement date string", () => {
    expect(isGearRetired("2026-01-01")).toBe(true);
  });
  it("passes booleans through", () => {
    expect(isGearRetired(true)).toBe(true);
    expect(isGearRetired(false)).toBe(false);
  });
});

const gearList: IntervalsGear[] = [
  { id: "g1", name: "Pegasus", retired: null },
  { id: "g2", name: "Old Trainers", retired: "2026-01-01" },
];

describe("findGear", () => {
  it("finds a matching id", () => {
    expect(findGear("g2", gearList)?.name).toBe("Old Trainers");
  });
  it("returns undefined for an unknown id", () => {
    expect(findGear("g99", gearList)).toBeUndefined();
  });
});

describe("describeGearOptions", () => {
  it("lists ids and names, marking retired gear", () => {
    expect(describeGearOptions(gearList)).toBe(
      "g1 (Pegasus), g2 (Old Trainers, retired)",
    );
  });
  it("reports when there is no gear on file", () => {
    expect(describeGearOptions([])).toBe("no gear is on file");
  });
});

const current = {
  name: "Morning Run",
  description: "Existing notes",
  gearId: "g1",
  rpe: 5,
  feel: 3,
};

describe("buildActivityPatch", () => {
  it("includes only fields that differ from current", () => {
    expect(
      buildActivityPatch({ name: "Morning Run", rpe: 7 }, current),
    ).toEqual({ icu_rpe: 7 });
  });

  it("is empty when nothing differs", () => {
    expect(
      buildActivityPatch(
        { name: "Morning Run", gearId: "g1", rpe: 5, feel: 3 },
        current,
      ),
    ).toEqual({});
  });

  it("maps every field to its intervals.icu key", () => {
    expect(
      buildActivityPatch(
        {
          name: "New name",
          description: "New notes",
          gearId: "g2",
          rpe: 8,
          feel: 2,
        },
        current,
      ),
    ).toEqual({
      name: "New name",
      description: "New notes",
      gear: { id: "g2" },
      icu_rpe: 8,
      feel: 2,
    });
  });
});

describe("diffActivityWrite", () => {
  it("echoes before/after only for patched fields", () => {
    const { changes, warnings } = diffActivityWrite({ icu_rpe: 7 }, current, {
      ...current,
      rpe: 7,
    });
    expect(changes).toEqual([{ field: "rpe", before: 5, after: 7 }]);
    expect(warnings).toEqual([]);
  });

  it("warns when the re-read value does not match what was sent", () => {
    const { changes, warnings } = diffActivityWrite(
      { gear: { id: "g2" } },
      current,
      { ...current, gearId: "g1" },
    );
    expect(changes).toEqual([{ field: "gear", before: "g1", after: "g1" }]);
    expect(warnings).toEqual([
      'gear was not applied: sent "g2", activity now shows "g1".',
    ]);
  });

  it("reports multiple changed fields", () => {
    const { changes, warnings } = diffActivityWrite(
      { name: "New name", feel: 1 },
      current,
      { ...current, name: "New name", feel: 1 },
    );
    expect(changes).toEqual([
      { field: "name", before: "Morning Run", after: "New name" },
      { field: "feel", before: 3, after: 1 },
    ]);
    expect(warnings).toEqual([]);
  });
});
