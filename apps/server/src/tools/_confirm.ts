/**
 * Host-rendered confirmation of a write that drops existing text (#417).
 *
 * A replace-mode `update-activity` or `update-wellness` overwrites text the
 * athlete wrote. Without this, the only safeguard is the model following
 * "show the exact change and wait for a yes". When the client advertised
 * form-mode elicitation, the tool instead returns an `input_required` result
 * (protocol revision 2026-07-28, multi-round-trip): the host shows the
 * athlete the current and new text, and retries the same call with the
 * answer in `inputResponses`. Nothing is sent to intervals.icu until an
 * accept comes back for exactly the change that was shown.
 *
 * `requestState` carries a fingerprint of the change. It is not a security
 * control: the client that echoes it is the same client that answers the
 * elicitation, so it could forge either. It binds the answer to the text the
 * athlete saw, so an accept never applies to a change that differs from it
 * (the stored text moved between the rounds, or the retry's arguments
 * changed). A mismatch asks again.
 */

import { createHash } from "node:crypto";
import {
  type InputRequiredResult,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";

/** The `inputRequests` key of the confirmation. */
export const CONFIRM_INPUT_KEY = "confirm_write";

/**
 * The warning every write tool returns when the athlete declined (or
 * dismissed) the host's confirmation. Nothing was sent.
 */
export const DECLINED_WARNING =
  "The athlete declined the change when the host asked to confirm it, so nothing was sent.";

/** Longest text the confirmation quotes for each side of a change. */
const MAX_QUOTED_CHARS = 1500;

/** What a write tool needs from the call to ask for a confirmation. */
export interface WriteConfirmContext {
  /** The client advertised form-mode elicitation. */
  clientElicitation?: boolean;
  /** A retried request's `inputResponses`, as the SDK lifted them. */
  inputResponses?: Record<string, unknown>;
  /** A retried request's echoed `requestState`. */
  requestState?: string;
}

export interface WriteConfirmRequest {
  /** The elicitation message: the before and after the athlete confirms. */
  message: string;
  /** The checkbox label. */
  label: string;
  /** Everything the write would send, so an accept binds to it exactly. */
  change: unknown;
}

export type WriteConfirmOutcome =
  /** The client cannot show a confirmation: behave as before #417. */
  | { status: "unavailable" }
  /** Return this to the client; it asks and retries. */
  | { status: "ask"; result: InputRequiredResult }
  /** The athlete accepted exactly this change. */
  | { status: "accepted" }
  /** The athlete declined or dismissed it: write nothing. */
  | { status: "declined" };

function fingerprint(change: unknown): string {
  return createHash("sha256").update(JSON.stringify(change)).digest("hex");
}

/**
 * A text as the confirmation quotes it: whole up to
 * {@link MAX_QUOTED_CHARS}, else cut with the count of what was left out.
 * An empty text says so, because a blank line in a dialog reads as a bug.
 */
export function quoteForConfirmation(text: string | null | undefined): string {
  const value = text ?? "";
  if (value.trim() === "") return "(empty)";
  if (value.length <= MAX_QUOTED_CHARS) return value;
  return `${value.slice(0, MAX_QUOTED_CHARS)}… (${value.length - MAX_QUOTED_CHARS} more characters)`;
}

/**
 * Decides what a write that drops existing text does in this round: ask,
 * go ahead, or stop. Only an accept whose checkbox is ticked and whose
 * `requestState` matches this change counts as a yes. A decline, a
 * dismissal or an unticked accept is a no. An accept for a different
 * change asks again.
 */
export function confirmWrite(
  context: WriteConfirmContext | undefined,
  request: WriteConfirmRequest,
): WriteConfirmOutcome {
  if (!context?.clientElicitation) return { status: "unavailable" };
  const state = fingerprint(request.change);
  const answer = inputResponse(context.inputResponses, CONFIRM_INPUT_KEY);
  if (answer.kind === "elicit") {
    if (answer.action !== "accept" || answer.content?.confirm !== true) {
      return { status: "declined" };
    }
    if (context.requestState === state) return { status: "accepted" };
  }
  return {
    status: "ask",
    result: inputRequired({
      inputRequests: {
        [CONFIRM_INPUT_KEY]: inputRequired.elicit({
          message: request.message,
          requestedSchema: {
            type: "object",
            properties: {
              confirm: {
                type: "boolean",
                title: request.label,
                default: false,
              },
            },
            required: ["confirm"],
          },
        }),
      },
      requestState: state,
    }),
  };
}
