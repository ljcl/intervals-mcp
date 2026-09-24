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

  it("references official-connector discovery when no activity_id is given", () => {
    const withoutId = getPrompt("annotate-last-run");
    const withId = getPrompt("annotate-last-run", { activity_id: "12345" });

    expect(withoutId.messages[0]?.content.text).toContain("list_activities");
    expect(withId.messages[0]?.content.text).toContain("activity 12345");
  });

  it("throws on unknown prompt names", () => {
    expect(() => getPrompt("not-a-prompt")).toThrow(
      "Unknown prompt: not-a-prompt",
    );
  });
});
