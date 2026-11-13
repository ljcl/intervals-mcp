import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SERVER_ICON_SRC, SERVER_INFO, SERVER_WEBSITE_URL } from "./serverInfo";
import { SERVER_VERSION } from "./version";

const SERVER_JSON_URL = new URL("../../../server.json", import.meta.url);

/**
 * Every result's `_meta` repeats the server info, icon included, so the icon
 * stays small. Raise this only with a reason.
 */
const MAX_ICON_SRC_CHARS = 600;

describe("SERVER_INFO (#416)", () => {
  it("names the server, its version, and a display title", () => {
    expect(SERVER_INFO).toMatchObject({
      name: "Intervals Extra",
      title: expect.stringMatching(/\S/),
      version: SERVER_VERSION,
    });
  });

  it("gives the same websiteUrl as server.json", () => {
    const serverJson = JSON.parse(readFileSync(SERVER_JSON_URL, "utf8")) as {
      websiteUrl: string;
    };
    expect(SERVER_INFO.websiteUrl).toBe(SERVER_WEBSITE_URL);
    expect(SERVER_WEBSITE_URL).toBe(serverJson.websiteUrl);
  });

  it("carries one inline SVG icon that decodes and stays small", () => {
    expect(SERVER_INFO.icons).toEqual([
      { src: SERVER_ICON_SRC, mimeType: "image/svg+xml", sizes: ["any"] },
    ]);
    const prefix = "data:image/svg+xml;base64,";
    expect(SERVER_ICON_SRC.startsWith(prefix)).toBe(true);
    expect(SERVER_ICON_SRC.length).toBeLessThanOrEqual(MAX_ICON_SRC_CHARS);

    const svg = Buffer.from(
      SERVER_ICON_SRC.slice(prefix.length),
      "base64",
    ).toString("utf8");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg.endsWith("</svg>")).toBe(true);
    // Nothing that runs or loads: a host renders it as an image.
    expect(svg).not.toMatch(/<script|href=|on\w+=/i);
  });
});
