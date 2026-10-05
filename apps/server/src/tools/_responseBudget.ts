/**
 * Upper bound on one tool response: the text plus the `structuredContent`
 * JSON, in characters. Some hosts forward both to the model, and Claude Code
 * refuses a result over 25,000 tokens (a 61 KB streams payload hit it,
 * #40), so the two together stay under this. `responseSize.test.ts` holds
 * every tool to it on its largest fixture.
 */
export const RESPONSE_BUDGET_CHARS = 40_000;

/** Characters a tool response costs against {@link RESPONSE_BUDGET_CHARS}. */
export function responseSize(text: string, structured?: unknown): number {
  return (
    text.length +
    (structured === undefined ? 0 : JSON.stringify(structured).length)
  );
}
