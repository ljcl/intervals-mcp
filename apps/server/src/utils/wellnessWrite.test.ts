import { describe, expect, it } from "vitest";
import { type IntervalsWellness } from "../intervalsClient";
import {
  buildWellnessPatch,
  type CurrentWellnessFields,
  currentWellnessFields,
  diffWellnessWrite,
  wellnessScoreLabel,
} from "./wellnessWrite";

function fields(
  overrides: Partial<CurrentWellnessFields> = {},
): CurrentWellnessFields {
  return {
    soreness: null,
    fatigue: null,
    stress: null,
    mood: null,
    motivation: null,
    injury: null,
    sleepQuality: null,
    comments: null,
    ...overrides,
  };
}

describe("wellnessScoreLabel", () => {
  it("names each 1 to 4 value as the web app does, 1 the best state", () => {
    expect(wellnessScoreLabel("soreness", 1)).toBe("Low");
    expect(wellnessScoreLabel("soreness", 4)).toBe("Extreme");
    expect(wellnessScoreLabel("mood", 4)).toBe("Grumpy");
    expect(wellnessScoreLabel("motivation", 1)).toBe("Extreme");
    expect(wellnessScoreLabel("injury", 2)).toBe("Niggle");
    expect(wellnessScoreLabel("sleepQuality", 4)).toBe("Poor");
  });

  it("is null outside the scale", () => {
    expect(wellnessScoreLabel("fatigue", 0)).toBeNull();
    expect(wellnessScoreLabel("fatigue", 5)).toBeNull();
    expect(wellnessScoreLabel("fatigue", 2.5)).toBeNull();
    expect(wellnessScoreLabel("fatigue", null)).toBeNull();
  });
});

describe("currentWellnessFields", () => {
  it("reads the scores by their intervals.icu names", () => {
    const day = {
      id: "2026-10-27",
      soreness: 3,
      sleepQuality: 2,
      comments: "calf",
    } as IntervalsWellness;
    expect(currentWellnessFields(day)).toEqual(
      fields({ soreness: 3, sleepQuality: 2, comments: "calf" }),
    );
  });
});

describe("buildWellnessPatch", () => {
  it("sends only fields that differ, under their intervals.icu names", () => {
    const patch = buildWellnessPatch(
      { soreness: 3, fatigue: 2, sleepQuality: 1 },
      fields({ fatigue: 2 }),
    );
    expect(patch).toEqual({ soreness: 3, sleepQuality: 1 });
  });

  it("clears a set score with -1, and sends nothing to clear an empty one", () => {
    expect(
      buildWellnessPatch({ injury: null, mood: null }, fields({ injury: 2 })),
    ).toEqual({ injury: -1 });
  });

  it("treats null and empty comments as equal", () => {
    expect(buildWellnessPatch({ comments: "" }, fields())).toEqual({});
    expect(
      buildWellnessPatch({ comments: "" }, fields({ comments: "old" })),
    ).toEqual({ comments: "" });
  });
});

describe("diffWellnessWrite", () => {
  it("echoes before and after under get-wellness names", () => {
    const { changes, warnings } = diffWellnessWrite(
      { sleepQuality: 2, comments: "tired" },
      fields(),
      fields({ sleepQuality: 2, comments: "tired" }),
    );
    expect(changes).toEqual([
      { field: "sleep_quality", before: null, after: 2 },
      { field: "comments", before: null, after: "tired" },
    ]);
    expect(warnings).toEqual([]);
  });

  it("expects null after a -1 clear", () => {
    const { warnings } = diffWellnessWrite(
      { injury: -1 },
      fields({ injury: 3 }),
      fields(),
    );
    expect(warnings).toEqual([]);
  });

  it("warns for each value the re-read does not show", () => {
    const { warnings } = diffWellnessWrite(
      { soreness: 3, injury: -1, comments: "x" },
      fields({ injury: 2 }),
      fields({ injury: 2 }),
    );
    expect(warnings).toEqual([
      "soreness was not applied: sent 3, the day now shows nothing.",
      "injury was not applied: sent nothing, the day now shows 2.",
      "comments were not applied as sent.",
    ]);
  });
});
