import {
  CardHeader,
  EmptyState,
  type ModelContextApp,
  Pill,
  PillGroup,
  SummaryBar,
  useModelContextSync,
  useViewTool,
  type ViewToolRegistry,
} from "@intervals-mcp/ui";
import { useState } from "react";
import { RouteMap } from "./RouteMap";
import styles from "./SuggestionMap.module.css";
import {
  scoreLossText,
  suggestionContext,
  suggestionStats,
} from "./suggestionStats";
import { type RouteSuggestionsData } from "./types";

interface SuggestionMapProps {
  data: RouteSuggestionsData;
  mode?: "mobile" | "desktop";
  app?: ModelContextApp;
  viewToolRegistry?: ViewToolRegistry | null;
  /** Set false to force the offline grid (stories). */
  basemapEnabled?: boolean;
}

/** One planned run's candidate routes: a picker over the activity map. */
export function SuggestionMap({
  data,
  mode = "desktop",
  app,
  viewToolRegistry = null,
  basemapEnabled = true,
}: SuggestionMapProps) {
  const [selected, setSelected] = useState(0);
  const candidates = data.candidates ?? [];
  const index = candidates[selected] ? selected : 0;
  const candidate = candidates[index];
  const warningList = data.warnings ?? [];

  useViewTool(viewToolRegistry, "select-route", (args) => {
    const option = typeof args.option === "number" ? args.option : null;
    const target = option === null ? undefined : candidates[option - 1];
    if (!target)
      return {
        text:
          candidates.length === 0
            ? "There are no suggested routes to show."
            : `Pass option 1 to ${candidates.length}: there ${candidates.length === 1 ? "is 1 suggested route" : `are ${candidates.length} suggested routes`}.`,
        isError: true,
      };
    setSelected(option! - 1);
    return {
      text: `Showing route ${option} of ${candidates.length}: ${target.label}.`,
    };
  });

  // With a route on screen, RouteMap reports what it shows.
  useModelContextSync(
    app,
    () =>
      candidate
        ? null
        : `No suggested route to show for ${data.date ? `planned run "${data.name}" on ${data.date}` : "these arguments"}.${warningList.length > 0 ? ` ${warningList.join(" ")}` : ""}`,
    [candidate === undefined, data.name, data.date, warningList.join("\n")],
  );

  const contextText = suggestionContext(data);
  const context = contextText && (
    <p className={styles.context}>{contextText}</p>
  );
  const routesNote = data.routesNote && (
    <p className={styles.context}>{data.routesNote}</p>
  );
  const warnings = warningList.map((warning) => (
    <p key={warning} className={styles.warning}>
      {warning}
    </p>
  ));
  if (!candidate) {
    // The warnings say why there is no route, so they stay.
    return (
      <div className={styles.suggestions}>
        <CardHeader
          title={data.name}
          subtitle="Suggested route"
          compact={mode === "mobile"}
        />
        {context}
        {routesNote}
        {warnings}
        <EmptyState>
          {data.date
            ? `No route to suggest for ${data.name} on ${data.date}.`
            : "No route to suggest."}
        </EmptyState>
      </div>
    );
  }
  const losses = scoreLossText(candidate.stats);
  const picker = (
    <div className={styles.suggestions}>
      {context}
      <PillGroup label="Route suggestion">
        {candidates.map((c, i) => (
          <Pill
            key={c.map.id}
            active={c === candidate}
            onClick={() => setSelected(i)}
          >
            {c.label}
          </Pill>
        ))}
      </PillGroup>
      <SummaryBar
        stats={suggestionStats(candidate.stats)}
        compact={mode === "mobile"}
      />
      <p className={styles.summary}>{candidate.summary}</p>
      {losses && <p className={styles.context}>{losses}</p>}
      {(candidate.notes ?? []).map((note) => (
        <p key={note} className={styles.context}>
          {note}
        </p>
      ))}
      {routesNote}
      {warnings}
    </div>
  );
  return (
    <RouteMap
      key={candidate.map.id}
      data={candidate.map}
      mode={mode}
      app={app}
      viewToolRegistry={viewToolRegistry}
      basemapEnabled={basemapEnabled}
      beforeMap={picker}
      suggestion={{
        run: data.name,
        date: data.date,
        option: index + 1,
        count: candidates.length,
        label: candidate.label,
      }}
    />
  );
}
