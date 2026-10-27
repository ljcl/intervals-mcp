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

/**
 * Builds a list response from its first `shown` items, shrinking `shown`
 * by the measured overshoot until text plus `structured` fit the budget.
 * `build` renders the first `n` items; the result says how many it kept.
 */
export function fitListToBudget<T>(
  total: number,
  build: (n: number) => { text: string; structured: T },
): { text: string; structured: T; shown: number } {
  let shown = total;
  let result = build(shown);
  for (let pass = 0; pass < 5; pass += 1) {
    const chars = responseSize(result.text, result.structured);
    if (chars <= RESPONSE_BUDGET_CHARS || shown <= 1) break;
    shown = Math.max(
      1,
      Math.min(
        shown - 1,
        Math.floor(shown * (RESPONSE_BUDGET_CHARS / chars) * 0.95),
      ),
    );
    result = build(shown);
  }
  return { ...result, shown };
}
