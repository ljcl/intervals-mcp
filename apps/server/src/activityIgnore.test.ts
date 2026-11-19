import { describe, expect, it } from "vitest";
import { ignoreWarnings } from "./activityIgnore";

const both = { hr: true, pace: true };

describe("ignoreWarnings (#510)", () => {
  it("is empty for an activity with no mark", () => {
    expect(ignoreWarnings({}, both)).toEqual([]);
    expect(
      ignoreWarnings(
        {
          icu_ignore_hr: false,
          icu_ignore_time: false,
          ignore_pace: false,
          ignore_velocity: null,
          ignore_parts: null,
        },
        both,
      ),
    ).toEqual([]);
  });

  it("warns about ignored heart rate only to a caller that reads heart rate", () => {
    const marked = { icu_ignore_hr: true };
    expect(ignoreWarnings(marked, { hr: false, pace: true })).toEqual([]);
    expect(ignoreWarnings(marked, both)).toEqual([
      "You marked this activity's heart rate to ignore in intervals.icu. intervals.icu keeps it in the activity's own numbers, and so do the numbers here: read each heart-rate number as not reliable.",
    ]);
  });

  it.each([
    ["ignore_pace", { ignore_pace: true }],
    ["ignore_velocity", { ignore_velocity: true }],
  ])("warns about ignored pace for %s", (_, marked) => {
    expect(ignoreWarnings(marked, { hr: true, pace: false })).toEqual([]);
    const [warning, ...rest] = ignoreWarnings(marked, both);
    expect(warning).toContain("You marked this activity's pace to ignore");
    expect(rest).toEqual([]);
  });

  it("counts the ignored parts for each kind", () => {
    const marked = {
      ignore_parts: [
        { start_index: 300, end_index: 599, hr: true, pace: false },
        { start_index: 700, end_index: 799, hr: true, pace: true },
        { start_index: 900, end_index: 950, power: true },
      ],
    };
    expect(ignoreWarnings(marked, both)).toEqual([
      "You marked 2 parts of this activity to ignore for heart rate in intervals.icu. intervals.icu keeps it in the activity's own numbers, and so do the numbers here: a heart-rate number that covers such a part is not reliable.",
      "You marked 1 part of this activity to ignore for pace in intervals.icu. intervals.icu keeps it in the activity's own numbers, and so do the numbers here: a pace number that covers such a part is not reliable.",
    ]);
  });

  it("names the whole-activity mark, not the parts, when the activity has both", () => {
    const warnings = ignoreWarnings(
      { icu_ignore_hr: true, ignore_parts: [{ hr: true }] },
      both,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("this activity's heart rate");
  });

  it("warns about ignored time to every caller", () => {
    expect(
      ignoreWarnings({ icu_ignore_time: true }, { hr: false, pace: false }),
    ).toEqual([
      "You marked this activity's time to ignore in intervals.icu. intervals.icu keeps it in the activity's own numbers, and so do the numbers here.",
    ]);
  });

  it("reads a malformed ignore_parts as no parts", () => {
    expect(ignoreWarnings({ ignore_parts: "bad" }, both)).toEqual([]);
    expect(ignoreWarnings({ ignore_parts: [null] }, both)).toEqual([]);
  });
});
