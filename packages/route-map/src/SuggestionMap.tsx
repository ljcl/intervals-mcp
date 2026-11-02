import {
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
  const candidate = data.candidates[selected] ?? data.candidates[0];
  if (!candidate) {
    return (
      <EmptyState>
        No route to suggest for {data.name} on {data.date}.
      </EmptyState>
    );
  }
  return (
    <div className={styles.suggestions}>
      <p className={styles.context}>
        {data.date} · {data.name} · from {data.startLabel}
      </p>
      <PillGroup>
        {data.candidates.map((c, i) => (
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
      {data.warnings.map((warning) => (
        <p key={warning} className={styles.warning}>
          {warning}
        </p>
      ))}
      <RouteMap
        key={candidate.map.id}
        data={candidate.map}
        mode={mode}
        app={app}
        viewToolRegistry={viewToolRegistry}
        basemapEnabled={basemapEnabled}
      />
    </div>
  );
}
