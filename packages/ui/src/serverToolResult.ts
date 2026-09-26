import { type App } from "@modelcontextprotocol/ext-apps";

type ServerToolResult = Awaited<ReturnType<App["callServerTool"]>>;
type ServerToolCallOptions = NonNullable<Parameters<App["callServerTool"]>[1]>;

/** Either the app-data payload, or the message to put in front of the user. */
export type ParsedToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Extract the first text content of a CallToolResult — the server's app-data
 * response convention — as either a parsed payload or an error message.
 * Shared by `useServerToolData` and `useServerToolFetcher` so the two paths
 * cannot disagree about what a well-formed response looks like.
 *
 * `isError` is checked first and its text surfaced verbatim, because that is
 * where every failure the athlete can act on lives: `dispatchToolCall` answers
 * prose for a rejected argument, for a missing key (naming
 * `INTERVALS_API_KEY`), and as `Tool error: <message>` for a thrown handler,
 * which is how a non-subscriber gets told a feature that needs a paid
 * subscription is unavailable. None of it is JSON, so parsing first reported
 * every one of them as a malformed response and threw the only useful
 * sentence away.
 */
export function parseTextContent<T>(
  result: ServerToolResult,
  toolName: string,
): ParsedToolResult<T> {
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (result.isError) {
    return { ok: false, error: text?.trim() || `${toolName} failed` };
  }
  if (text) {
    try {
      return { ok: true, data: JSON.parse(text) as T };
    } catch {
      // Fall through: a success result whose text is not JSON is as unusable
      // as no text at all.
    }
  }
  return { ok: false, error: `Failed to parse ${toolName} response` };
}

/**
 * The call options every app-data tool call passes. Shared by
 * `useServerToolData` and `useServerToolFetcher`, so a slow call gets the
 * same treatment in both. `resetTimeoutOnProgress` restarts the host's
 * request timeout on every progress notification, and each notification's
 * message goes to `onMessage`. A notification without a message only resets
 * the timeout. It must not blank the line the user is reading.
 */
export function progressCallOptions(
  onMessage: (message: string) => void,
): ServerToolCallOptions {
  return {
    resetTimeoutOnProgress: true,
    onprogress: ({ message }) => {
      if (message) onMessage(message);
    },
  };
}
