import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { completePromptArgument, getPrompt, listPrompts } from "./prompts";

const TODAY = "2026-10-05";

/** The rendered user-message text of a prompt. */
function text(name: string, args: Record<string, string> = {}): string {
  return (
    getPrompt(name, args, undefined, TODAY).messages[0]?.content.text ?? ""
  );
}

/** Asserts `call` throws Invalid Params (-32602) with a message matching `message`. */
function expectInvalidParams(call: () => unknown, message: RegExp | string) {
  // A plain Error would reach the client as Internal Error (-32603).
  expect(call).toThrow(ProtocolError);
  expect(call).toThrow(
    expect.objectContaining({
      code: ProtocolErrorCode.InvalidParams,
      message: expect.stringMatching(message),
    }),
  );
}

describe("listPrompts", () => {
  it("lists every workflow with a title, description and arguments", () => {
    const prompts = listPrompts();

    expect(prompts.map((p) => p.name)).toEqual([
      "weekly-review",
      "annotate-last-run",
      "race-readiness",
      "run-debrief",
      "injury-check",
    ]);
    for (const prompt of prompts) {
      expect(prompt.title).toMatch(/\S/);
      expect(prompt.description.length).toBeGreaterThan(0);
      expect(Array.isArray(prompt.arguments)).toBe(true);
    }
  });
});

describe("weekly-review", () => {
  it("lists activities over the whole review window, not the 28-day default", () => {
    const t = text("weekly-review", { weeks: "12" });

    expect(t).toContain("last 12 weeks (2026-07-14 to 2026-10-05)");
    expect(t).toContain("get-training-load with days=84");
    expect(t).toContain(
      "list-activities with oldest=2026-07-14, newest=2026-10-05",
    );
    expect(t).toContain("view-cadence-trends with days=84");
  });

  it("defaults to 4 weeks", () => {
    const t = text("weekly-review");

    expect(t).toContain("last 4 weeks (2026-09-08 to 2026-10-05)");
    expect(t).toContain("days=28");
  });

  it.each(["100", "0", "twelve", "4.5", "-3"])(
    "rejects weeks=%s with Invalid Params",
    (weeks) => {
      expectInvalidParams(
        () => getPrompt("weekly-review", { weeks }, undefined, TODAY),
        /weeks must be a whole number from 1 to 52/,
      );
    },
  );
});

describe("annotate-last-run", () => {
  it("picks the newest run by type, never another sport", () => {
    const t = text("annotate-last-run");

    expect(t).toContain('Use id "latest" (my most recent run).');
    expect(t).not.toContain("list-activities");
    expect(t).toContain('update-activity does not accept "latest"');
  });

  it("does not fetch the laps twice", () => {
    const t = text("annotate-last-run");

    expect(t).toContain("get-running-summary");
    expect(t).not.toContain("get-activity-laps");
  });

  it("takes id, and still accepts activity_id", () => {
    expect(text("annotate-last-run", { id: "i12345" })).toContain(
      "activity i12345",
    );
    expect(text("annotate-last-run", { activity_id: "12345" })).toContain(
      "activity 12345",
    );
  });

  it("appends after confirmation rather than overwriting", () => {
    const t = text("annotate-last-run");

    expect(t).toContain("ask before writing");
    expect(t).toContain('descriptionMode: "append"');
  });
});

describe("race-readiness", () => {
  it("chains fitness trend, prediction, wellness and load for the race", () => {
    const t = text("race-readiness", {
      raceDate: "2026-10-25",
      distance: "half marathon",
      targetTsb: "12",
    });

    expect(t).toContain("race on 2026-10-25 (half marathon), 20 days away");
    expect(t).toContain(
      "get-fitness-trend with targetDate=2026-10-25 and targetTsb=12",
    );
    expect(t).toContain(
      'get-race-prediction with raceDistance="half marathon"',
    );
    expect(t).toContain(
      "get-wellness with oldest=2026-09-29, newest=2026-10-05",
    );
    expect(t).toContain("get-training-load");
  });

  it("defaults targetTsb to 10 and predicts across distances with no distance", () => {
    const t = text("race-readiness", { raceDate: "2026-10-25" });

    expect(t).toContain("targetTsb=10");
    expect(t).toContain("get-race-prediction with no raceDistance");
  });

  it("requires raceDate", () => {
    expectInvalidParams(
      () => getPrompt("race-readiness", {}, undefined, TODAY),
      'Missing required argument "raceDate" for prompt race-readiness',
    );
  });

  it.each([
    ["2026-02-30", /not a real calendar date/],
    ["2026-10-05", /not after today/],
    ["2027-12-01", /at most 180 days/],
  ])("rejects raceDate %s", (raceDate, message) => {
    expectInvalidParams(
      () => getPrompt("race-readiness", { raceDate }, undefined, TODAY),
      message,
    );
  });

  it.each([
    ["Half Marathon", "half marathon"],
    ["5K", "5km"],
    ["50k", "50km"],
  ])("reads the distance %s as %s", (typed, label) => {
    const t = text("race-readiness", {
      raceDate: "2026-10-25",
      distance: typed,
    });

    expect(t).toContain(`get-race-prediction with raceDistance="${label}"`);
  });

  it("rejects an unknown distance, naming the ones it takes", () => {
    expectInvalidParams(
      () =>
        getPrompt(
          "race-readiness",
          { raceDate: "2026-10-25", distance: "100K" },
          undefined,
          TODAY,
        ),
      /distance "100K" is not one of: 5km, 10km, 15km, 10 mile, half marathon, marathon, 50km/,
    );
  });

  it.each(["41", "ten"])("rejects targetTsb=%s", (targetTsb) => {
    expectInvalidParams(
      () =>
        getPrompt(
          "race-readiness",
          { raceDate: "2026-10-25", targetTsb },
          undefined,
          TODAY,
        ),
      /targetTsb must be a number from -40 to 40/,
    );
  });
});

describe("run-debrief", () => {
  it("summarises, then calls only the one analysis that fits", () => {
    const t = text("run-debrief", { id: "i777" });

    expect(t).toContain("activity i777");
    expect(t).toContain("get-running-summary");
    for (const tool of [
      "get-interval-analysis",
      "get-split-analysis",
      "get-hill-analysis",
      "get-aerobic-analysis",
    ])
      expect(t).toContain(tool);
    expect(t).toContain("call only that one");
    expect(t).toContain("get-wellness with date set to the run's date");
  });

  it("finds the newest run when no id is given", () => {
    const t = text("run-debrief");
    expect(t).toContain('Use id "latest" (my most recent run).');
    expect(t).not.toContain("list-activities");
  });
});

describe("injury-check", () => {
  it("looks at load warnings, recovery trend, form flags and shoe mileage", () => {
    const t = text("injury-check");

    expect(t).toContain("get-training-load");
    expect(t).toContain(
      "get-wellness with oldest=2026-09-08, newest=2026-10-05",
    );
    expect(t).toContain("get-fitness-trend");
    expect(t).toContain("list-gear");
    expect(t).toContain("not a diagnosis");
  });
});

describe("getPrompt", () => {
  it("throws Invalid Params (-32602) on unknown prompt names", () => {
    expectInvalidParams(
      () => getPrompt("not-a-prompt"),
      "Unknown prompt: not-a-prompt",
    );
  });
});

describe("completePromptArgument", () => {
  it("suggests race distances, filtered by what was typed", () => {
    expect(completePromptArgument("race-readiness", "distance", "")).toEqual([
      "5km",
      "10km",
      "15km",
      "10 mile",
      "half marathon",
      "marathon",
      "50km",
    ]);
    expect(completePromptArgument("race-readiness", "distance", "Ma")).toEqual([
      "marathon",
    ]);
    expect(completePromptArgument("race-readiness", "distance", "1")).toEqual([
      "10km",
      "15km",
      "10 mile",
    ]);
  });

  it("suggests common review lengths for weeks", () => {
    expect(completePromptArgument("weekly-review", "weeks", "")).toEqual([
      "4",
      "6",
      "8",
      "12",
      "26",
      "52",
    ]);
  });

  it("suggests nothing for an argument or prompt without suggestions", () => {
    expect(completePromptArgument("run-debrief", "id", "i1")).toEqual([]);
    expect(completePromptArgument("no-such-prompt", "x", "")).toEqual([]);
  });
});
