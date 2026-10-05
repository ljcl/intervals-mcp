import { describe, expect, it } from "vitest";
import { argShape, normalizeArgs, unknownArgsText } from "./argAliases";

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
      enum: ["5K", "10K", "15K", "10 mile", "Half Marathon", "Marathon", "50K"],
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
      raceDistance: "Half Marathon",
    });
    expect(normalizeArgs({ raceDistance: "5km" }, race)).toEqual({
      raceDistance: "5K",
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
        raceDistance: { type: "string", enum: ["Half Marathon"] },
      },
    });
    expect(normalizeArgs({ race_distance: "half marathon" }, shape)).toEqual({
      raceDistance: "Half Marathon",
    });
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
