import { VIEW_LABELS } from "./contextSummary";
import { overlayRunLabel } from "./normalize";
import {
  type OverlayRunStatus,
  type OverlayXMode,
  type RunSummary,
  type ViewId,
} from "./types";

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
    const byKey = new Map(runs.map((run) => [idKey(run.id), run]));
    const chosen = new Map<string, string>();
    const unknown = new Map<string, string>();
    const noCadence = new Map<string, string>();
    for (const id of args.runIds) {
      const key = idKey(id);
      const run = byKey.get(key);
      // The overlay plots a cadence stream, so a run without cadence cannot
      // be overlaid even though the chart has it.
      if (!run) setOnce(unknown, key, id);
      else if (run.averageCadence > 0) setOnce(chosen, key, run.id);
      else setOnce(noCadence, key, run.id);
    }
    if (unknown.size > 0 || noCadence.size > 0) {
      return {
        kind: "error",
        text: badIdsText([...unknown.values()], [...noCadence.values()]),
      };
    }
    runIds = [...chosen.values()];
  }

  const view =
    args.view ??
    (runIds?.length || args.xAxis !== undefined ? "overlay" : currentView);
  return { kind: "ok", view, runIds, xAxis: args.xAxis };
}

/**
 * An id's identity whichever way it is spelled: the server accepts an
 * activity id with or without its `i` prefix (`intervalsActivityIdInput`), so
 * "189807578" and "i189807578" name the same run here too.
 */
function idKey(id: string): string {
  return /^i?(\d+)$/.exec(id)?.[1] ?? id;
}

/** Keeps the first spelling of each id, so a list names every run once. */
function setOnce(map: Map<string, string>, key: string, value: string) {
  if (!map.has(key)) map.set(key, value);
}

/** Why a selection was refused, telling ids the chart lacks from runs it
 * cannot overlay, and where the right ids come from. */
function badIdsText(unknown: string[], noCadence: string[]): string {
  const parts: string[] = [];
  if (unknown.length > 0) {
    parts.push(
      `Not runs in this chart: ${unknown.join(", ")}. Run ids come from list-activities (for example "i189807578") and must fall within the chart's weeks.`,
    );
  }
  if (noCadence.length > 0) {
    parts.push(
      `No recorded cadence, so nothing to overlay: ${noCadence.join(", ")}.`,
    );
  }
  parts.push("Nothing was changed.");
  return parts.join(" ");
}

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What each status a run is not drawn in says about it, in reply order. */
const NOT_DRAWN: ReadonlyArray<
  [Exclude<OverlayRunStatus, "drawn">, (one: boolean) => string]
> = [
  ["loading", (one) => `${one ? "is" : "are"} still loading`],
  ["noStreams", (one) => `${one ? "has" : "have"} no recorded streams`],
  ["failed", () => "failed to load"],
  ["hidden", (one) => `${one ? "is" : "are"} hidden in the legend`],
];

/**
 * One line telling the model what the view now shows. What the call left
 * alone is read from `current`, so the line describes the overlay as it will
 * be, not only the part that changed. Runs are named the way the overlay
 * legend names them: dated only where a name is shared.
 *
 * The overlay is claimed as showing only the runs `runStatus` says are drawn,
 * the same rule `set-scope` follows: a run still loading, with no streams,
 * that failed or that the legend hides is named as such instead. The reply
 * goes out before a newly selected run's fetch starts, so it says "still
 * loading" for it; the context summary follows as it arrives.
 */
export function describeSetView(
  result: SetViewOk,
  runs: ReadonlyArray<Pick<RunSummary, "id" | "name" | "date">>,
  current: {
    selectedRunIds: Iterable<string>;
    xAxis: OverlayXMode;
    /** Each selected run's place in the overlay once the call applies. */
    runStatus: (id: string) => OverlayRunStatus;
  },
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
    if (selected.length === 0) {
      return `Showing the overlay by ${axis}, with no runs selected.`;
    }
    const label = (run: (typeof selected)[number]) =>
      overlayRunLabel(run, selected);
    const withStatus = (status: OverlayRunStatus) =>
      selected.filter((run) => current.runStatus(run.id) === status);
    const drawn = withStatus("drawn");
    const parts = [
      drawn.length > 0
        ? `Showing the overlay of ${listNames(drawn.map(label))} by ${axis}.`
        : `Showing the overlay by ${axis}, with no run drawn.`,
    ];
    for (const [status, says] of NOT_DRAWN) {
      const these = withStatus(status);
      if (these.length > 0) {
        parts.push(
          `${listNames(these.map(label))} ${says(these.length === 1)}.`,
        );
      }
    }
    return parts.join(" ");
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
