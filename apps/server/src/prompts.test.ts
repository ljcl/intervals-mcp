import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { getPrompt, listPrompts } from "./prompts";

describe("listPrompts", () => {
  it("lists the two workflows with argument declarations", () => {
    const prompts = listPrompts();

    expect(prompts.map((p) => p.name)).toEqual([
      "weekly-review",
      "annotate-last-run",
    ]);
    for (const prompt of prompts) {
      expect(prompt.description.length).toBeGreaterThan(0);
      expect(Array.isArray(prompt.arguments)).toBe(true);
    }
  });
});

describe("getPrompt", () => {
  it("substitutes arguments into the workflow text", () => {
    const result = getPrompt("weekly-review", { weeks: "6" });

    const text = result.messages[0]?.content.text ?? "";
    expect(result.messages[0]?.role).toBe("user");
    expect(text).toContain("last 6 weeks");
    expect(text).toContain("days=42");
    expect(text).toContain("view-cadence-trends with weeks=6");
  });

  it("applies defaults when optional arguments are omitted", () => {
    const result = getPrompt("weekly-review");

    const text = result.messages[0]?.content.text ?? "";
    expect(text).toContain("last 4 weeks");
    expect(text).toContain("days=28");
  });

  it("references this server's own list-activities discovery when no activity_id is given", () => {
    const withoutId = getPrompt("annotate-last-run");
    const withId = getPrompt("annotate-last-run", { activity_id: "12345" });

    expect(withoutId.messages[0]?.content.text).toContain("list-activities");
    expect(withId.messages[0]?.content.text).toContain("activity 12345");
  });

  it("throws Invalid Params (-32602) on unknown prompt names", () => {
    const call = () => getPrompt("not-a-prompt");

    // A plain Error would reach the client as Internal Error (-32603).
    expect(call).toThrow(ProtocolError);
    expect(call).toThrow(
      expect.objectContaining({
        code: ProtocolErrorCode.InvalidParams,
        message: "Unknown prompt: not-a-prompt",
      }),
    );
  });

  it("throws Invalid Params (-32602) when a required argument is missing", () => {
    // No shipped prompt has a required argument yet, so this uses its own.
    const prompts = [
      {
        name: "needs-an-id",
        title: "Needs an id",
        description: "A prompt with one required argument.",
        arguments: [
          { name: "activity_id", description: "Activity", required: true },
        ],
        build: (args: Record<string, string>) => `Use ${args.activity_id}.`,
      },
    ];

    const call = () => getPrompt("needs-an-id", {}, prompts);

    expect(call).toThrow(ProtocolError);
    expect(call).toThrow(
      expect.objectContaining({
        code: ProtocolErrorCode.InvalidParams,
        message:
          'Missing required argument "activity_id" for prompt needs-an-id',
      }),
    );
    expect(
      getPrompt("needs-an-id", { activity_id: "i1" }, prompts).messages[0]
        ?.content.text,
    ).toBe("Use i1.");
  });
});
