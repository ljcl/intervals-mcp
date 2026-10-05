import { describe, expect, it } from "vitest";
import { classifyToolInput } from "./AppShell";

interface ActivityArgs {
  activity_id?: string;
}

/** The parser shape an app with a required id uses. */
const requireActivityId = (args: unknown): ActivityArgs | null => {
  const next = args as ActivityArgs | undefined;
  return next?.activity_id ? next : null;
};

/** The parser shape an app with only optional args uses. */
const allOptional = (args: unknown): { days?: number } =>
  (args as { days?: number } | undefined) ?? {};

describe("classifyToolInput", () => {
  it("returns the parsed args when the host sends usable input", () => {
    const outcome = classifyToolInput(
      { activity_id: "123" },
      requireActivityId,
      "No activity id was provided.",
    );

    expect(outcome).toEqual({
      status: "ready",
      toolArgs: { activity_id: "123" },
    });
  });

  it("reports unusable input against the app's own message (ljcl/strava-mcp#249)", () => {
    const outcome = classifyToolInput(
      {},
      requireActivityId,
      "No activity id was provided.",
    );

    expect(outcome).toEqual({
      status: "unusable",
      message: "No activity id was provided.",
    });
  });

  it.each([
    ["undefined arguments", undefined],
    ["a null id", { activity_id: null }],
    ["an empty id", { activity_id: "" }],
    ["an unrelated payload", { foo: "bar" }],
  ])("treats %s as unusable, not as still-waiting", (_label, raw) => {
    expect(classifyToolInput(raw, requireActivityId, "Missing id.")).toEqual({
      status: "unusable",
      message: "Missing id.",
    });
  });

  it("falls back to a generic message when the app passes an empty one", () => {
    const outcome = classifyToolInput({}, requireActivityId, "");

    expect(outcome).toEqual({
      status: "unusable",
      message: "The host did not provide the arguments this view needs.",
    });
  });

  it("ignores unusable input for an app that declared no required args", () => {
    // No `missingArgsMessage`: nothing is required, so there is nothing to
    // complain about and the app keeps waiting rather than erroring.
    const parse = (): null => null;

    expect(classifyToolInput({}, parse)).toEqual({ status: "ignored" });
  });

  it("keeps an all-optional app on its defaults for empty input", () => {
    expect(classifyToolInput(undefined, allOptional)).toEqual({
      status: "ready",
      toolArgs: {},
    });
  });
});
