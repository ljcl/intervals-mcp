import styles from "./RouteDetails.module.css";
import {
  compareText,
  type RouteWarning,
  type SectionRun,
  sectionLegendText,
  versionText,
} from "./routeLayers";
import { type RouteMapRoute } from "./types";

interface RouteDetailsProps {
  route: RouteMapRoute;
  sections: SectionRun[];
  warnings: RouteWarning[];
}

/**
 * The text beside a stored route's map: which version it is and what made
 * it, what the compared version changed, the sections in their map colours,
 * and the warnings with their km.
 */
export function RouteDetails({ route, sections, warnings }: RouteDetailsProps) {
  const version = versionText(route);
  const compare = compareText(route);
  return (
    <div className={styles.details}>
      <p className={styles.version}>
        <span className={styles.versionTitle}>{version.title}</span>
        {version.change && (
          <span className={styles.versionChange}>{version.change}</span>
        )}
      </p>
      {!route.editable && (
        <p className={styles.note}>
          Only the latest version (version {route.latest_version}) can be
          changed.
        </p>
      )}
      {compare && (
        <p className={styles.compare} data-testid="route-compare">
          <span className={styles.compareSwatch} aria-hidden="true" />
          {compare}
        </p>
      )}

      <ul className={styles.sections} aria-label="Route sections">
        {sections.map((section) => (
          <li key={section.index} className={styles.section}>
            <span
              className={styles.swatch}
              aria-hidden="true"
              // The colour is per section, so it stays inline.
              style={{ background: section.color.css }}
            />
            {sectionLegendText(section)}
          </li>
        ))}
      </ul>

      {warnings.length > 0 && (
        <ul className={styles.warnings} aria-label="Route warnings">
          {warnings.map((warning) => (
            <li
              key={`${warning.range ?? "pin"}-${warning.text}`}
              className={styles.warning}
            >
              {warning.range && (
                <span className={styles.warningRange}>{warning.range}</span>
              )}
              {warning.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
