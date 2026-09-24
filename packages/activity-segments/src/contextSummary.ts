import { formatClock } from "@intervals-mcp/data";
import { selectHighlights, summaryLine } from "./segments";
import { type SegmentEffortRow } from "./types";

/** Cap listed names so a segment-dense activity stays a summary, not a dump. */
const MAX_LISTED = 3;

export interface SegmentsContextInput {
  activityName: string | null;
  segments: SegmentEffortRow[];
  /** Efforts whose detail rows are currently expanded, in run order. */
  expanded: SegmentEffortRow[];
}

function tierLabel(e: SegmentEffortRow): string | null {
  if (e.prRank != null) return `PR ${e.prRank}`;
  if (e.komRank != null) return `top ${e.komRank}`;
  return null;
}

function listNames(
  efforts: SegmentEffortRow[],
  describe: (e: SegmentEffortRow) => string,
): string {
  const listed = efforts.slice(0, MAX_LISTED).map(describe);
  const overflow = efforts.length - listed.length;
  return overflow > 0
    ? `${listed.join(", ")}, and ${overflow} more`
    : listed.join(", ");
}

/**
 * One-line summary of the visible segment list, reported to the host's model
 * context so the assistant can reference the view without re-fetching.
 */
export function buildSegmentsContextSummary(
  input: SegmentsContextInput,
): string | null {
  const { activityName, segments, expanded } = input;
  if (!activityName) return null;

  const parts = [`Viewing segment efforts for "${activityName}".`];
  if (segments.length === 0) {
    parts.push("No segments in this activity.");
    return parts.join(" ");
  }

  parts.push(`${summaryLine(segments)}.`);

  const highlights = selectHighlights(segments);
  if (highlights.length) {
    parts.push(
      `Highlights: ${listNames(highlights, (e) => `${e.name} (${tierLabel(e)})`)}.`,
    );
  }

  if (expanded.length) {
    parts.push(
      `Expanded: ${listNames(expanded, (e) => `${e.name} (${formatClock(e.elapsedTime)})`)}.`,
    );
  } else {
    parts.push("No efforts expanded.");
  }

  return parts.join(" ");
}
