import { describe, expect, it } from "vitest";
import {
  CONFIRM_INPUT_KEY,
  confirmWrite,
  quoteForConfirmation,
} from "./_confirm";

const REQUEST = {
  message: "Replace it?",
  label: "Replace the description",
  change: { id: "555", patch: { description: "new" } },
};

/** The requestState an ask round mints for {@link REQUEST}. */
function mintedState(): string {
  const outcome = confirmWrite({ clientElicitation: true }, REQUEST);
  if (outcome.status !== "ask") throw new Error("expected an ask");
  return outcome.result.requestState as string;
}

function answer(response: unknown, requestState = mintedState()) {
  return confirmWrite(
    {
      clientElicitation: true,
      inputResponses: { [CONFIRM_INPUT_KEY]: response },
      requestState,
    },
    REQUEST,
  );
}

describe("confirmWrite", () => {
  it("is unavailable without the client's elicitation capability", () => {
    expect(confirmWrite(undefined, REQUEST)).toEqual({
      status: "unavailable",
    });
    expect(confirmWrite({ clientElicitation: false }, REQUEST)).toEqual({
      status: "unavailable",
    });
  });

  it("asks with a form-mode elicitation and a state bound to the change", () => {
    const outcome = confirmWrite({ clientElicitation: true }, REQUEST);
    expect(outcome.status).toBe("ask");
    if (outcome.status !== "ask") return;
    expect(outcome.result.resultType).toBe("input_required");
    expect(outcome.result.inputRequests?.[CONFIRM_INPUT_KEY]).toMatchObject({
      method: "elicitation/create",
      params: {
        message: "Replace it?",
        requestedSchema: {
          type: "object",
          properties: {
            confirm: { type: "boolean", title: "Replace the description" },
          },
          required: ["confirm"],
        },
      },
    });
    expect(outcome.result.requestState).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a ticked accept for the same change", () => {
    expect(answer({ action: "accept", content: { confirm: true } })).toEqual({
      status: "accepted",
    });
  });

  it("treats a decline, a cancel and an unticked accept as no", () => {
    expect(answer({ action: "decline" })).toEqual({ status: "declined" });
    expect(answer({ action: "cancel" })).toEqual({ status: "declined" });
    expect(answer({ action: "accept", content: { confirm: false } })).toEqual({
      status: "declined",
    });
    expect(answer({ action: "accept" })).toEqual({ status: "declined" });
  });

  it("asks again when the accept was for a different change", () => {
    const outcome = answer(
      { action: "accept", content: { confirm: true } },
      "f".repeat(64),
    );
    expect(outcome.status).toBe("ask");
  });

  it("asks again when no state came back", () => {
    const outcome = confirmWrite(
      {
        clientElicitation: true,
        inputResponses: {
          [CONFIRM_INPUT_KEY]: { action: "accept", content: { confirm: true } },
        },
      },
      REQUEST,
    );
    expect(outcome.status).toBe("ask");
  });

  it("asks when the retry carried no answer for its key", () => {
    const outcome = confirmWrite(
      {
        clientElicitation: true,
        inputResponses: { other: { action: "accept" } },
        requestState: mintedState(),
      },
      REQUEST,
    );
    expect(outcome.status).toBe("ask");
  });
});

describe("quoteForConfirmation", () => {
  it("names an empty text", () => {
    expect(quoteForConfirmation(null)).toBe("(empty)");
    expect(quoteForConfirmation("  ")).toBe("(empty)");
  });

  it("keeps a short text whole and cuts a long one with a count", () => {
    expect(quoteForConfirmation("notes")).toBe("notes");
    const long = "a".repeat(1600);
    expect(quoteForConfirmation(long)).toBe(
      `${"a".repeat(1500)}… (100 more characters)`,
    );
  });
});
