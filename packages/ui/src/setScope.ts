/**
 * The whole-body/run-only scope toggle the training-load and fitness-trend
 * cards share: the scope, what a `set-scope` call lands on, and the rules
 * both cards apply the same way. Each card adds its own series and the rules
 * only it has (`setScope.ts` in each package).
 */

/** Which load scope is on screen. */
export type Scope = "wholeBody" | "runOnly";

export const scopeOf = (runOnly: boolean): Scope =>
  runOnly ? "runOnly" : "wholeBody";

/** What `scope` shows as: the pill's label, in lower case. */
export const scopeName = (scope: Scope): string =>
  scope === "runOnly" ? "runs only" : "whole body";

export const capitalised = (text: string): string =>
  `${text[0]!.toUpperCase()}${text.slice(1)}`;

/** `set-scope` arguments after the registry has dropped the nulls. */
export interface SetScopeArgs<K extends string> {
  scope?: Scope;
  show?: K[];
  hide?: K[];
}

export interface SetScopeOk<K extends string> {
  kind: "ok";
  /** Absent when the call left the scope alone. */
  scope?: Scope;
  /** Only the series the call named: true to show it, false to hide it. */
  visible: Partial<Record<K, boolean>>;
}

export type SetScopeResult<K extends string> =
  | SetScopeOk<K>
  | { kind: "error"; text: string };

/**
 * What the scope a call lands on is rendering, which decides what a reply may
 * claim. `drawn` is a chart on screen; `empty` is loaded data with nothing to
 * draw, which the card answers with an EmptyState; `loading` is a scope not
 * yet fetched or still being fetched (the skeleton); `failed` is a fetch that
 * errored (the ErrorState and its retry).
 */
export type Landing =
  | { scope: Scope; status: "drawn" | "empty" | "loading" }
  /** `error` is the fetch error as the card shows it. */
  | { scope: Scope; status: "failed"; error: string };

/**
 * The landing for a scope. `drawn` is whether its loaded payload draws a
 * chart, or null when no payload has loaded; a loaded payload wins over an
 * error.
 */
export function scopeLanding(
  scope: Scope,
  drawn: boolean | null,
  error: string | null,
): Landing {
  if (drawn !== null) return { scope, status: drawn ? "drawn" : "empty" };
  return error
    ? { scope, status: "failed", error }
    : { scope, status: "loading" };
}

/**
 * Settle a `set-scope` call before anything on screen changes. A call that
 * names nothing is refused first, then the card's own `refusal` (a reason that
 * stands alone), then a series both shown and hidden together with the card's
 * `problems`. Any of these refuses the whole call, so a half-applied change
 * never needs explaining. Series are named by the value the schema accepts,
 * which is what the model must send back.
 */
export function settleSetScope<K extends string>(
  args: SetScopeArgs<K>,
  series: readonly K[],
  refusal: string | null,
  problems: string[],
): SetScopeResult<K> {
  const show = [...new Set(args.show)];
  const hide = [...new Set(args.hide)];
  if (args.scope === undefined && show.length === 0 && hide.length === 0) {
    return {
      kind: "error",
      text: `Pass scope (wholeBody or runOnly), or name series (${series.join(", ")}) in show or hide.`,
    };
  }
  if (refusal) return { kind: "error", text: refusal };

  const both = series.filter((s) => show.includes(s) && hide.includes(s));
  const all = [
    ...(both.length > 0
      ? [`Cannot both show and hide ${both.join(", ")}.`]
      : []),
    ...problems,
  ];
  if (all.length > 0) return { kind: "error", text: all.join(" ") };

  const visible: Partial<Record<K, boolean>> = {};
  for (const s of show) visible[s] = true;
  for (const s of hide) visible[s] = false;
  return { kind: "ok", scope: args.scope, visible };
}

/**
 * One line telling the model what the card now shows, with `hidden` the
 * hidden series as the tool names them. It claims "showing" only a scope
 * that is not still loading or failed: one loading is switching to, and one
 * that failed says so, since the card shows its error.
 */
export function describeLanding(landing: Landing, hidden: string[]): string {
  const name = scopeName(landing.scope);
  const head =
    landing.status === "loading"
      ? `Switching to ${name}; it is still loading.`
      : landing.status === "failed"
        ? `${capitalised(name)} failed to load: ${failureReason(landing.error)}. The card shows the error with a retry.`
        : `Showing ${name}.`;
  return hidden.length > 0
    ? `${head} Hidden: ${hidden.join(", ")}.`
    : `${head} Nothing hidden.`;
}

/** The error as the card shows it, without a leading "Error:" or closing stop. */
function failureReason(error: string): string {
  const text = error.replace(/^Error:\s*/, "");
  // A loop, not /\.+$/: that regex backtracks quadratically on a run of dots.
  let end = text.length;
  while (end > 0 && text[end - 1] === ".") end -= 1;
  return text.slice(0, end);
}
