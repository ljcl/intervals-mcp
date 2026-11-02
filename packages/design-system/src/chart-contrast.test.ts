import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOST_THEMES } from "./host-themes";

// WCAG 1.4.11: chart marks need 3:1 against the card they sit on.
const MIN_CONTRAST = 3;

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function block(selector: string): string {
  const start = css.indexOf(selector);
  return css.slice(start, css.indexOf("}", start));
}

function vars(body: string, prefix: string): [string, string][] {
  return [
    ...body.matchAll(new RegExp(`(${prefix}[\\w-]*):\\s*([^;]+);`, "g")),
  ].map((m) => [m[1]!, m[2]!.trim()]);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const themes = [
  { mode: "light", body: block(":root {") },
  { mode: "dark", body: block('[data-theme="dark"] {') },
] as const;

describe.each(themes)("$mode --chart-* tokens", ({ mode, body }) => {
  const tokens = vars(body, "--chart-");
  // The "none" host renders on tokens.css's own background.
  const backgrounds = [
    ["tokens.css", vars(body, "--color-background-primary")[0]![1]],
    ...Object.values(HOST_THEMES).flatMap((t) =>
      t ? [[t.name, t[mode]["--color-background-primary"]!]] : [],
    ),
  ] as [string, string][];

  it("parses every chart token as a 6-digit hex", () => {
    expect(tokens.length).toBeGreaterThan(10);
    for (const [name, value] of tokens) {
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(tokens)("%s (%s) clears 3:1 on every host card", (name, value) => {
    for (const [host, bg] of backgrounds) {
      expect(
        contrast(value, bg),
        `${name} on ${host} ${bg}`,
      ).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });
});
