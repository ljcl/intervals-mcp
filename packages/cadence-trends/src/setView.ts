import { VIEW_LABELS } from "./contextSummary";
import { overlayRunLabel } from "./normalize";
import { type OverlayXMode, type RunSummary, type ViewId } from "./types";

/** `set-view` arguments after the registry has dropped the nulls. */
export interface SetViewArgs {
  view?: ViewId;
  runIds?: string[];
  xAxis?: OverlayXMode;
}

export interface SetViewOk {
  kind: "ok";
  view: ViewId;
  /** The new selection, duplicates removed, in the order given. */
  runIds?: string[];
  xAxis?: OverlayXMode;
}

export type SetViewResult = SetViewOk | { kind: "error"; text: string };

/**
 * Settle a `set-view` call against the chart's runs, before anything on
 * screen changes. The overlay is where a selection or an axis shows, so
 * either one without a view moves there; an empty `runIds` only clears the
 * selection, since an overlay with nothing in it is not somewhere to send
 * anyone.
 */
export function resolveSetView(
  args: SetViewArgs,
  runs: ReadonlyArray<Pick<RunSummary, "id" | "averageCadence">>,
  currentView: ViewId,
): SetViewResult {
  if (
    args.view === undefined &&
    args.runIds === undefined &&
    args.xAxis === undefined
  ) {
    return { kind: "error", text: "Pass view, runIds or xAxis." };
  }

  let runIds: string[] | undefined;
  if (args.runIds) {
    // The overlay plots a cadence stream, so a run without cadence is no more
    // selectable than one that is not in the chart.
    const selectable = new Set(
      runs.filter((r) => r.averageCadence > 0).map((r) => r.id),
    );
    const bad = args.runIds.filter((id) => !selectable.has(id));
    if (bad.length > 0) {
      return {
        kind: "error",
        text: `These runs are not in this chart or have no cadence: ${bad.join(", ")}.`,
      };
    }
    runIds = [...new Set(args.runIds)];
  }

  const view =
    args.view ??
    (runIds?.length || args.xAxis !== undefined ? "overlay" : currentView);
  return { kind: "ok", view, runIds, xAxis: args.xAxis };
}

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * One line telling the model what the view now shows. What the call left
 * alone is read from `current`, so the line describes the overlay as it will
 * be, not only the part that changed. Runs are named the way the overlay
 * legend names them: dated only where a name is shared.
 */
export function describeSetView(
  result: SetViewOk,
  runs: ReadonlyArray<Pick<RunSummary, "id" | "name" | "date">>,
  current: { selectedRunIds: Iterable<string>; xAxis: OverlayXMode },
): string {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const selected = [...(result.runIds ?? current.selectedRunIds)].flatMap(
    (id) => {
      const run = byId.get(id);
      return run ? [run] : [];
    },
  );
  const names = listNames(
    selected.map((run) => overlayRunLabel(run, selected)),
  );

  if (result.view === "overlay") {
    const axis = result.xAxis ?? current.xAxis;
    return selected.length > 0
      ? `Showing the overlay of ${names} by ${axis}.`
      : `Showing the overlay by ${axis}, with no runs selected.`;
  }

  const parts = [`Showing the ${VIEW_LABELS[result.view]}.`];
  if (result.runIds) {
    parts.push(
      selected.length > 0
        ? `Selected ${names} for the overlay.`
        : "Cleared the overlay selection.",
    );
  }
  if (result.xAxis) {
    parts.push(`The overlay x-axis is now ${result.xAxis}.`);
  }
  return parts.join(" ");
}
