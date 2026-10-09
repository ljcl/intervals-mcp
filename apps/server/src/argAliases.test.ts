import { describe, expect, it } from "vitest";
import {
  argShape,
  ignoredArgsText,
  normalizeArgs,
  unknownArgsText,
} from "./argAliases";

const single = argShape({
  type: "object",
  properties: {
    id: { type: "string" },
    includeIntervals: { type: "boolean" },
  },
});

const app = argShape({
  type: "object",
  properties: { activity_id: { type: "string" } },
});

const pair = argShape({
  type: "object",
  properties: {
    activityId1: { type: "string" },
    activityId2: { type: "string" },
  },
});

const appPair = argShape({
  type: "object",
  properties: {
    activity_id_1: { type: "string" },
    activity_id_2: { type: "string" },
  },
});

const bestEfforts = argShape({
  type: "object",
  properties: {
    distances: {
      type: "array",
      items: {
        type: "string",
        enum: ["400m", "1km", "5km", "10km", "half marathon", "marathon"],
      },
    },
    topN: { type: "integer" },
  },
});

const race = argShape({
  type: "object",
  properties: {
    raceDistance: {
      type: "string",
      enum: [
        "5km",
        "10km",
        "15km",
        "10 mile",
        "half marathon",
        "marathon",
        "50km",
      ],
    },
  },
});

describe("normalizeArgs: activity id spellings", () => {
  it.each([
    ["activity_id", single, "id"],
    ["activityId", single, "id"],
    ["id", app, "activity_id"],
    ["activityId", app, "activity_id"],
  ])("maps %s to the tool's own key", (from, shape, to) => {
    expect(normalizeArgs({ [from]: "i42" }, shape)).toEqual({ [to]: "i42" });
  });

  it("maps every pair spelling to the tool's own pair keys", () => {
    expect(
      normalizeArgs({ activity_id_1: "i1", activity_id_2: "i2" }, pair),
    ).toEqual({ activityId1: "i1", activityId2: "i2" });
    expect(normalizeArgs({ activityId1: "i1", id2: "i2" }, appPair)).toEqual({
      activity_id_1: "i1",
      activity_id_2: "i2",
    });
    expect(
      normalizeArgs({ activity_id1: "i1", activityId_2: "i2" }, pair),
    ).toEqual({ activityId1: "i1", activityId2: "i2" });
  });

  it("never overwrites the canonical key when the caller sent it too", () => {
    expect(normalizeArgs({ id: "i1", activity_id: "i2" }, single)).toEqual({
      id: "i1",
      activity_id: "i2",
    });
  });

  it("does not map a single-id spelling onto a pair tool", () => {
    expect(normalizeArgs({ id: "i1" }, pair)).toEqual({ id: "i1" });
  });
});

describe("normalizeArgs: camelCase and snake_case", () => {
  it("maps a snake_case key to the camelCase one the tool takes", () => {
    expect(normalizeArgs({ include_intervals: false }, single)).toEqual({
      includeIntervals: false,
    });
  });

  it("maps a camelCase key to the snake_case one the tool takes", () => {
    const shape = argShape({
      type: "object",
      properties: { run_only: { type: "boolean" } },
    });
    expect(normalizeArgs({ runOnly: true }, shape)).toEqual({ run_only: true });
  });

  it("leaves a key that matches nothing for validation to report", () => {
    expect(normalizeArgs({ activity: "i1" }, single)).toEqual({
      activity: "i1",
    });
  });
});

describe("normalizeArgs: enum values", () => {
  it("matches a distance label across case, spacing and K/km styles", () => {
    expect(
      normalizeArgs(
        { distances: ["Half Marathon", "5K", "10 km", "Marathon", "400m"] },
        bestEfforts,
      ),
    ).toEqual({
      distances: ["half marathon", "5km", "10km", "marathon", "400m"],
    });
    expect(normalizeArgs({ raceDistance: "half-marathon" }, race)).toEqual({
      raceDistance: "half marathon",
    });
    expect(normalizeArgs({ raceDistance: "Half Marathon" }, race)).toEqual({
      raceDistance: "half marathon",
    });
    expect(normalizeArgs({ raceDistance: "5K" }, race)).toEqual({
      raceDistance: "5km",
    });
    expect(normalizeArgs({ raceDistance: "50K" }, race)).toEqual({
      raceDistance: "50km",
    });
    expect(normalizeArgs({ raceDistance: "10 miles" }, race)).toEqual({
      raceDistance: "10 mile",
    });
  });

  it("matches a value written with underscores or hyphens", () => {
    const streams = argShape({
      type: "object",
      properties: {
        types: {
          type: "array",
          items: { type: "string", enum: ["heartrate", "velocity_smooth"] },
        },
      },
    });
    expect(
      normalizeArgs({ types: ["heart_rate", "Velocity-Smooth"] }, streams),
    ).toEqual({ types: ["heartrate", "velocity_smooth"] });
  });

  it("leaves a value that matches no option, or more than one, unchanged", () => {
    expect(normalizeArgs({ raceDistance: "100K" }, race)).toEqual({
      raceDistance: "100K",
    });
    const ambiguous = argShape({
      type: "object",
      properties: { mode: { type: "string", enum: ["a-b", "a_b"] } },
    });
    expect(normalizeArgs({ mode: "AB" }, ambiguous)).toEqual({ mode: "AB" });
  });

  it("leaves non-string values alone", () => {
    expect(normalizeArgs({ raceDistance: 5 }, race)).toEqual({
      raceDistance: 5,
    });
  });

  it("applies enum matching to a key it just renamed", () => {
    const shape = argShape({
      type: "object",
      properties: {
        raceDistance: { type: "string", enum: ["half marathon"] },
      },
    });
    expect(normalizeArgs({ race_distance: "Half Marathon" }, shape)).toEqual({
      raceDistance: "half marathon",
    });
  });
});

describe("normalizeArgs: weeks to days", () => {
  const takesDays = argShape({
    type: "object",
    properties: { days: { type: "integer" } },
  });

  it("turns weeks into days when the tool takes days and not weeks", () => {
    expect(normalizeArgs({ weeks: 6 }, takesDays)).toEqual({ days: 42 });
    expect(normalizeArgs({ weeks: "4" }, takesDays)).toEqual({ days: 28 });
  });

  it("leaves weeks alone when the tool takes weeks", () => {
    const takesWeeks = argShape({
      type: "object",
      properties: { weeks: { type: "integer" }, days: { type: "integer" } },
    });
    expect(normalizeArgs({ weeks: 6 }, takesWeeks)).toEqual({ weeks: 6 });
  });

  it("leaves weeks alone when the tool takes neither", () => {
    expect(normalizeArgs({ weeks: 6 }, single)).toEqual({ weeks: 6 });
  });

  it("never overrides days the caller sent", () => {
    expect(normalizeArgs({ weeks: 6, days: 10 }, takesDays)).toEqual({
      weeks: 6,
      days: 10,
    });
  });

  it("leaves a non-numeric weeks for validation to report", () => {
    expect(normalizeArgs({ weeks: "six" }, takesDays)).toEqual({
      weeks: "six",
    });
  });
});

describe("normalizeArgs: date range to window", () => {
  const takesWindow = argShape({
    type: "object",
    properties: { window: { type: "string" }, topN: { type: "integer" } },
  });
  const today = "2026-10-06";

  it("turns oldest and newest into a window range", () => {
    expect(
      normalizeArgs(
        { oldest: "2026-01-01", newest: "2026-03-31", topN: 2 },
        takesWindow,
        { today },
      ),
    ).toEqual({ window: "2026-01-01..2026-03-31", topN: 2 });
  });

  it("ends a range with no newest today", () => {
    expect(
      normalizeArgs({ oldest: "2026-01-01" }, takesWindow, { today }),
    ).toEqual({ window: "2026-01-01..2026-10-06" });
  });

  it("starts a range with no oldest a year before newest, like the default", () => {
    expect(
      normalizeArgs({ newest: "2026-03-31" }, takesWindow, { today }),
    ).toEqual({ window: "2025-03-31..2026-03-31" });
  });

  it("turns days, or weeks, into a range of that many days ending today", () => {
    expect(normalizeArgs({ days: 90 }, takesWindow, { today })).toEqual({
      window: "2026-07-09..2026-10-06",
    });
    expect(normalizeArgs({ weeks: "2" }, takesWindow, { today })).toEqual({
      window: "2026-09-23..2026-10-06",
    });
  });

  it("ends a days range at newest when both are sent", () => {
    expect(
      normalizeArgs({ days: 7, newest: "2026-03-31" }, takesWindow, { today }),
    ).toEqual({ window: "2026-03-25..2026-03-31" });
  });

  it("keeps a count it did not use, so the note names it", () => {
    expect(
      normalizeArgs({ oldest: "2026-01-01", days: 30 }, takesWindow, { today }),
    ).toEqual({ window: "2026-01-01..2026-10-06", days: 30 });
  });

  it("never overrides a window the caller sent", () => {
    expect(
      normalizeArgs({ window: "90d", oldest: "2026-01-01" }, takesWindow, {
        today,
      }),
    ).toEqual({ window: "90d", oldest: "2026-01-01" });
  });

  it("leaves a range alone when the call names one activity", () => {
    const takesIdOrWindow = argShape({
      type: "object",
      properties: { id: { type: "string" }, window: { type: "string" } },
    });
    expect(
      normalizeArgs(
        { id: "i1", oldest: "2026-01-01", newest: "2026-03-31" },
        takesIdOrWindow,
        { today },
      ),
    ).toEqual({ id: "i1", oldest: "2026-01-01", newest: "2026-03-31" });
  });

  it("leaves values it cannot read for the ignored-arguments note", () => {
    expect(normalizeArgs({ days: "ninety" }, takesWindow, { today })).toEqual({
      days: "ninety",
    });
    expect(normalizeArgs({ days: 0 }, takesWindow, { today })).toEqual({
      days: 0,
    });
  });

  it("passes a malformed date through for window validation to report", () => {
    expect(normalizeArgs({ oldest: "Jan 1" }, takesWindow, { today })).toEqual({
      window: "Jan 1..2026-10-06",
    });
  });

  it("does nothing without today, or for a tool that takes oldest", () => {
    expect(normalizeArgs({ oldest: "2026-01-01" }, takesWindow)).toEqual({
      oldest: "2026-01-01",
    });
    const takesRange = argShape({
      type: "object",
      properties: { window: {}, oldest: {}, newest: {} },
    });
    expect(
      normalizeArgs({ oldest: "2026-01-01" }, takesRange, { today }),
    ).toEqual({ oldest: "2026-01-01" });
  });
});

describe("ignoredArgsText", () => {
  it("names each key a successful call dropped, and the keys the tool takes", () => {
    expect(ignoredArgsText({ id: "i1", activity: "i1" }, single)).toBe(
      'Ignored argument "activity" (this tool takes: id, includeIntervals).',
    );
  });

  it("is null when every key is known", () => {
    expect(ignoredArgsText({ id: "i1" }, single)).toBeNull();
  });
});

describe("unknownArgsText", () => {
  it("names each key the tool does not take, and the keys it does", () => {
    expect(unknownArgsText({ activity: "i1", id: "i1" }, single)).toBe(
      'Unknown argument "activity" (this tool takes: id, includeIntervals).',
    );
    expect(unknownArgsText({ a: 1, b: 2 }, single)).toBe(
      'Unknown arguments "a", "b" (this tool takes: id, includeIntervals).',
    );
  });

  it("is null when every key is known", () => {
    expect(unknownArgsText({ id: "i1" }, single)).toBeNull();
  });

  it("says when a tool takes no arguments", () => {
    const none = argShape({ type: "object", properties: {} });
    expect(unknownArgsText({ id: "i1" }, none)).toBe(
      'Unknown argument "id" (this tool takes no arguments).',
    );
  });
});
