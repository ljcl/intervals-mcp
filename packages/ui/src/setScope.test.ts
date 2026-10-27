import { describe, expect, it } from "vitest";
import { describeLanding, scopeLanding, settleSetScope } from "./setScope";

const SERIES = ["a", "b"] as const;

describe("scopeLanding", () => {
  it("prefers a loaded payload over an error", () => {
    expect(scopeLanding("runOnly", false, "Error: boom")).toEqual({
      scope: "runOnly",
      status: "empty",
    });
    expect(scopeLanding("wholeBody", null, "Error: boom")).toEqual({
      scope: "wholeBody",
      status: "failed",
      error: "Error: boom",
    });
    expect(scopeLanding("wholeBody", null, null).status).toBe("loading");
  });
});

describe("settleSetScope", () => {
  it("refuses a call that names nothing before the card's own refusal", () => {
    const result = settleSetScope({}, SERIES, "refused", []);
    expect(result).toEqual({
      kind: "error",
      text: "Pass scope (wholeBody or runOnly), or name series (a, b) in show or hide.",
    });
  });

  it("joins a both-ways series with the card's problems", () => {
    const result = settleSetScope({ show: ["a"], hide: ["a"] }, SERIES, null, [
      "No b.",
    ]);
    expect(result).toEqual({
      kind: "error",
      text: "Cannot both show and hide a. No b.",
    });
  });

  it("returns only the named series", () => {
    expect(
      settleSetScope({ scope: "runOnly", hide: ["b"] }, SERIES, null, []),
    ).toEqual({ kind: "ok", scope: "runOnly", visible: { b: false } });
  });
});

describe("describeLanding", () => {
  it("quotes a failure without its Error prefix or stop", () => {
    expect(
      describeLanding(
        { scope: "runOnly", status: "failed", error: "Error: down." },
        ["a"],
      ),
    ).toBe(
      "Runs only failed to load: down. The card shows the error with a retry. Hidden: a.",
    );
  });

  it("strips a long run of closing stops", () => {
    expect(
      describeLanding(
        {
          scope: "wholeBody",
          status: "failed",
          error: `down${".".repeat(50_000)}`,
        },
        [],
      ),
    ).toBe(
      "Whole body failed to load: down. The card shows the error with a retry. Nothing hidden.",
    );
  });
});
