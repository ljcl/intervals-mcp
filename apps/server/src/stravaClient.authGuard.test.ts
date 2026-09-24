/**
 * `stravaClient.ts` is transitional (see the architecture doc's "Stream reads
 * go through the `stravaClient.ts` wrappers" invariant): it sends no
 * `Authorization` header on purpose, so every call fails with a 401 mapped to
 * a not-yet-ported message until Phases 1 and 2 land. That is asserted
 * behaviourally in `stravaClient.errors.test.ts`, but a mocked-fetch test
 * cannot catch a change that adds real auth-header construction without ever
 * exercising the mocked path in a way that would fail.
 *
 * This is a source-level guard in the style of `envScaffolding.test.ts`:
 * strip comments, then assert the file contains no `Authorization` header
 * construction. A future contributor porting a tool to send real auth must
 * do it somewhere other than this file, or must delete this guard
 * deliberately; either way it cannot happen by accident.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STRAVA_CLIENT_URL = new URL("./stravaClient.ts", import.meta.url);

/** Comments are stripped so the guard cannot be satisfied by mentioning the
 * header in prose (this file, and stravaClient.ts's own module doc, both do). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const NEEDLES = [/Authorization\s*:/, /["']Authorization["']/, /Bearer\s/];

describe("stravaClient.ts sends no Authorization header", () => {
  it("has no Authorization header construction outside comments", () => {
    const source = stripComments(readFileSync(STRAVA_CLIENT_URL, "utf8"));

    const offenders = NEEDLES.filter((needle) => needle.test(source)).map(
      (needle) => needle.toString(),
    );

    expect(offenders).toEqual([]);
  });

  it("still finds the phrase in the file, so a rewrite cannot turn this into a no-op", () => {
    const raw = readFileSync(STRAVA_CLIENT_URL, "utf8");
    expect(raw).toContain("Authorization");
  });
});
