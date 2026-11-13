import { Pill, PillGroup } from "@intervals-mcp/ui";
import { type FormEvent, useId, useState } from "react";
import styles from "./RouteDetails.module.css";
import { type AmendOperation } from "./routeEdit";
import { type RouteMapRoute } from "./types";
import { type EditNotice } from "./useRouteAmend";

interface RouteEditPanelProps {
  route: RouteMapRoute;
  /** Length of the shown version, km: the replace range must fit in it. */
  routeKm: number;
  busy: boolean;
  notice: EditNotice | null;
  addMode: boolean;
  onAddModeChange: (on: boolean) => void;
  selectedViaId: string | null;
  onSelectVia: (id: string | null) => void;
  onAmend: (op: AmendOperation) => void;
  compact: boolean;
}

/** Slack on the route's end, so "to the finish" typed as its rounded km fits. */
const END_SLACK_KM = 0.05;

function viaLabel(via: RouteMapRoute["vias"][number]): string {
  const what = via.kind === "turnaround" ? "Turnaround" : via.label;
  return `${via.id} · ${what} · ${via.km.toFixed(1)} km`;
}

/**
 * The edit controls under a stored route's map, for the latest version
 * only. Each control makes one amend-route operation: add a point (tap the
 * map in add mode), remove or move the selected via point (or drag it on
 * the map), and replace a km range, directly or through a place. Every
 * control has a label, and the form paths work without a pointer. While a
 * change is with the server the fieldset is disabled.
 */
export function RouteEditPanel({
  route,
  routeKm,
  busy,
  notice,
  addMode,
  onAddModeChange,
  selectedViaId,
  onSelectVia,
  onAmend,
  compact,
}: RouteEditPanelProps) {
  const uid = useId();
  const [moveTo, setMoveTo] = useState("");
  const [fromKm, setFromKm] = useState("");
  const [toKm, setToKm] = useState("");
  const [through, setThrough] = useState("");

  const selected = route.vias.find((v) => v.id === selectedViaId) ?? null;

  const from = Number.parseFloat(fromKm);
  const to = Number.parseFloat(toKm);
  const rangeError =
    fromKm === "" || toKm === ""
      ? null
      : !Number.isFinite(from) || !Number.isFinite(to)
        ? "Give the km as numbers."
        : from < 0 || to > routeKm + END_SLACK_KM
          ? `The range must be inside 0–${routeKm.toFixed(1)} km.`
          : from >= to
            ? "The start km must be less than the end km."
            : null;
  const canReplace = fromKm !== "" && toKm !== "" && rangeError === null;

  const submitReplace = (e: FormEvent) => {
    e.preventDefault();
    if (!canReplace) return;
    const place = through.trim();
    onAmend({
      op: "replace_section",
      from_km: from,
      to_km: Math.min(to, routeKm),
      ...(place.length >= 2 ? { through: place } : {}),
    });
  };

  const submitMove = (e: FormEvent) => {
    e.preventDefault();
    const place = moveTo.trim();
    if (!selected || place.length < 2) return;
    onAmend({ op: "move_via", via_id: selected.id, to: place });
    setMoveTo("");
  };

  return (
    <section
      className={styles.edit}
      aria-labelledby={`${uid}-edit-title`}
      data-compact={compact || undefined}
    >
      <h3 id={`${uid}-edit-title`} className={styles.editTitle}>
        Change this route
      </h3>
      {/* A disabled fieldset disables every control in it, the toggles too. */}
      <fieldset
        className={styles.fieldset}
        disabled={busy}
        data-busy={busy || undefined}
      >
        <div className={styles.row}>
          {/* In a group for the pill track behind it, as the other toggles. */}
          <PillGroup label="Map editing" multiple>
            <Pill active={addMode} onClick={() => onAddModeChange(!addMode)}>
              Add point
            </Pill>
          </PillGroup>
          <span className={styles.hint}>
            {addMode
              ? "Tap the map where the route must go. The point joins the route at the nearest km."
              : "Drag a point on the map to move it."}
          </span>
        </div>

        {route.vias.length > 0 && (
          <div className={styles.group}>
            <fieldset className={styles.fieldset}>
              <legend className={styles.groupLabel}>Points</legend>
              <PillGroup label="Points">
                {route.vias.map((via) => (
                  <Pill
                    key={via.id}
                    active={via.id === selectedViaId}
                    onClick={() =>
                      onSelectVia(via.id === selectedViaId ? null : via.id)
                    }
                  >
                    {viaLabel(via)}
                  </Pill>
                ))}
              </PillGroup>
            </fieldset>
            {selected && (
              <form className={styles.row} onSubmit={submitMove}>
                <button
                  type="button"
                  className={styles.button}
                  data-tone="danger"
                  onClick={() => {
                    onAmend({ op: "remove_via", via_id: selected.id });
                    onSelectVia(null);
                  }}
                >
                  Remove {selected.id}
                </button>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>
                    Move {selected.id} to
                  </span>
                  <input
                    className={styles.input}
                    type="text"
                    value={moveTo}
                    placeholder="A place, or lat,lng"
                    onChange={(e) => setMoveTo(e.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  className={styles.button}
                  disabled={moveTo.trim().length < 2}
                >
                  Move
                </button>
              </form>
            )}
          </div>
        )}

        <form className={styles.group} onSubmit={submitReplace}>
          <span className={styles.groupLabel}>Replace a section</span>
          <div className={styles.row}>
            <label className={styles.field} data-size="km">
              <span className={styles.fieldLabel}>From km</span>
              <input
                className={styles.input}
                type="number"
                inputMode="decimal"
                min={0}
                max={routeKm}
                step={0.1}
                value={fromKm}
                onChange={(e) => setFromKm(e.target.value)}
              />
            </label>
            <label className={styles.field} data-size="km">
              <span className={styles.fieldLabel}>To km</span>
              <input
                className={styles.input}
                type="number"
                inputMode="decimal"
                min={0}
                max={routeKm}
                step={0.1}
                value={toKm}
                onChange={(e) => setToKm(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Through (optional)</span>
              <input
                className={styles.input}
                type="text"
                value={through}
                placeholder="A place, or lat,lng"
                onChange={(e) => setThrough(e.target.value)}
              />
            </label>
            <button
              type="submit"
              className={styles.button}
              disabled={!canReplace}
            >
              Replace section
            </button>
          </div>
          {rangeError && (
            <p className={styles.fieldError} role="alert">
              {rangeError}
            </p>
          )}
        </form>
      </fieldset>

      <p
        className={styles.notice}
        data-tone={notice?.tone}
        role={notice?.tone === "error" ? "alert" : "status"}
      >
        {notice?.text}
      </p>
    </section>
  );
}
