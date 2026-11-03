import {
  CardHeader,
  EmptyState,
  type ModelContextApp,
  Pill,
  PillGroup,
  type ViewToolRegistry,
} from "@intervals-mcp/ui";
import { useState } from "react";
import { RouteMap } from "./RouteMap";
import styles from "./SuggestionMap.module.css";
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
  const candidate = candidates[selected] ?? candidates[0];
  const context = (
    <p className={styles.context}>
      {data.date} · {data.name} · from {data.startLabel}
    </p>
  );
  const warnings = (data.warnings ?? []).map((warning) => (
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
        {warnings}
        <EmptyState>
          No route to suggest for {data.name} on {data.date}.
        </EmptyState>
      </div>
    );
  }
  const picker = (
    <div className={styles.suggestions}>
      {context}
      <PillGroup>
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
      <p className={styles.summary}>{candidate.summary}</p>
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
    />
  );
}
