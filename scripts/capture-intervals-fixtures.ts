import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";

const root = path.resolve(import.meta.dirname, "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const key = process.env.INTERVALS_API_KEY?.trim();
if (!key) throw new Error("INTERVALS_API_KEY missing from .env");

const BASE = "https://intervals.icu/api/v1";
const ACTIVITY = process.argv[2] ?? "i189807578";
const OUT = path.join(root, "apps/server/src/__fixtures__/intervals");
const HEADERS = {
  Authorization: `Basic ${Buffer.from(`API_KEY:${key}`).toString("base64")}`,
  "User-Agent":
    "intervals-mcp fixture capture (+https://github.com/ljcl/intervals-mcp)",
};
const ANCHOR = { lat: -33.8568, lng: 151.2153 };
const MAX_POINTS = 600;

async function get(p: string): Promise<unknown> {
  const res = await fetch(`${BASE}${p}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
  return res.json();
}

type Rec = Record<string, unknown>;

/**
 * Free-text fields nulled on every captured activity, alongside `name` and
 * `description`: none of them are needed to exercise a tool's mapping logic,
 * and any of them could carry athlete-identifying or otherwise personal
 * text (a route name in a comment, a training note in `tags`).
 */
const FREE_TEXT_FIELDS = ["tags", "notes", "comments"];

function scrubActivity(a: Rec, i: number): Rec {
  const out: Rec = { ...a };
  out.name = `${String(a.type ?? "Activity")} ${i + 1}`;
  out.description = null;
  for (const k of FREE_TEXT_FIELDS) if (k in out) out[k] = null;
  delete out.external_id;
  delete out.oauth_client_id;
  for (const k of ["icu_athlete_id", "athlete_id"]) if (k in out) out[k] = "i0";
  if ("icu_weight" in out) out.icu_weight = 70;
  return out;
}

function scrubStreams(streams: Rec[]): Rec[] {
  const ll = streams.find((s) => s.type === "latlng");
  const llData = ll?.data as (number | null)[] | undefined;
  const llData2 = ll?.data2 as (number | null)[] | undefined;
  // Anchor on the first non-null point: leading points can be null (e.g. GPS
  // fix not yet acquired), and anchoring on a null point leaves real
  // coordinates (exact home location) untranslated in the fixture.
  const firstFixIndex = llData?.findIndex(
    (v, i) => v != null && llData2?.[i] != null,
  );
  const lat0 =
    firstFixIndex != null && firstFixIndex >= 0
      ? llData?.[firstFixIndex]
      : undefined;
  const lng0 =
    firstFixIndex != null && firstFixIndex >= 0
      ? llData2?.[firstFixIndex]
      : undefined;
  return streams.map((s) => {
    const cut = (v: unknown) => (Array.isArray(v) ? v.slice(0, MAX_POINTS) : v);
    const out: Rec = { ...s, data: cut(s.data), data2: cut(s.data2) };
    if (s.type === "latlng" && lat0 != null && lng0 != null) {
      out.data = (out.data as (number | null)[]).map((v) =>
        v == null ? null : Math.round((v - lat0 + ANCHOR.lat) * 1e6) / 1e6,
      );
      out.data2 = (out.data2 as (number | null)[]).map((v) =>
        v == null ? null : Math.round((v - lng0 + ANCHOR.lng) * 1e6) / 1e6,
      );
    }
    return out;
  });
}

const STREAM_TYPES =
  "time,distance,heartrate,cadence,velocity_smooth,altitude,latlng,stance_time,vertical_oscillation,vertical_ratio,step_length";

/**
 * Stream set used for named extra captures (multi-lap, hilly): matches the
 * columns those fixtures need to exercise the widened schemas plus the hill
 * and lap analysis tools (grade, power) without pulling in the running-
 * dynamics streams the base fixture already covers.
 */
const EXTRA_STREAM_TYPES =
  "time,distance,altitude,grade_smooth,heartrate,velocity_smooth,cadence,watts,latlng";

/**
 * Deterministic pseudo-random generator (mulberry32): same seed always
 * produces the same sequence, so re-running this script reproduces the same
 * synthetic wellness fixture rather than a new one every capture.
 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draws a synthetic value in `[min, max]` from `rng`, nudged by one step
 * (clamped back into range) if it happens to land exactly on `real`. The
 * range is narrow enough (e.g. restingHR 50-60) that a coincidental match
 * with the real reading is plausible across ~15 days, and every day must
 * read as synthetic, not just most of them.
 */
function synthesizeAvoiding(
  rng: () => number,
  min: number,
  max: number,
  decimals: number,
  real: number | null | undefined,
): number {
  const scale = 10 ** decimals;
  let value = Math.round((min + rng() * (max - min)) * scale) / scale;
  if (real != null && value === real) {
    const step = 1 / scale;
    value = value + step > max ? value - step : value + step;
    value = Math.round(value * scale) / scale;
  }
  return value;
}

/**
 * `[min, max, decimals]` for every wellness field the read tools use and
 * that should carry a synthetic (not real) value. A field absent from this
 * map, and not one of the specially-handled `id`/`comments`/`hrv`/`weight`/
 * `ctl`/`atl` fields below, is nulled outright by {@link synthesizeWellness}:
 * no real wellness reading beyond these named fields is ever committed.
 */
const WELLNESS_SYNTHETIC_RANGES: Record<string, [number, number, number]> = {
  restingHR: [50, 60, 0],
  hrvSDNN: [35, 60, 2],
  sleepSecs: [21000, 28000, 0],
  sleepScore: [50, 95, 0],
  ctlLoad: [0, 100, 0],
  atlLoad: [0, 100, 0],
  rampRate: [-5, 5, 2],
  readiness: [50, 95, 0],
  soreness: [1, 5, 0],
  fatigue: [1, 5, 0],
  stress: [1, 5, 0],
  mood: [1, 5, 0],
  motivation: [1, 5, 0],
  spO2: [94, 99, 0],
  respiration: [12, 20, 0],
};

/**
 * Replaces every wellness record's numeric/subjective fields with
 * deterministic synthetic values (or `null`), so no real wellness reading of
 * any kind is committed to this public repo:
 *
 * - `id` (the record's date) passes through unchanged.
 * - `comments` and `hrv` (rMSSD; always null on this Apple Watch account) are
 *   forced null.
 * - `weight` becomes `70` when the real record had a weight, else `null`.
 * - `ctl`/`atl` follow a deterministic smooth (small-step) synthetic
 *   sequence, independent of the real values.
 * - Every field in {@link WELLNESS_SYNTHETIC_RANGES} (the fields
 *   `get-wellness` and friends actually read, plus `ctlLoad`/`atlLoad`) gets
 *   a synthetic value in a plausible range when the real record had a
 *   reading there, nudged away from that real value (see
 *   {@link synthesizeAvoiding}) so every day reads as synthetic; a real
 *   `null` (no reading that day) stays `null` rather than fabricating one.
 * - Every other field (steps, calories, macros, vo2max, body composition,
 *   blood pressure/glucose/lactate, hydration, menstrual-cycle fields,
 *   avgSleepingHR, baevskySI, tempWeight/tempRestingHR, sportInfo, the sync
 *   `updated` timestamp, etc.) is nulled outright: nothing here is read by
 *   any tool, and none of it should carry a real reading either.
 *
 * Order is preserved (the caller sorts/filters by date), and the seed is
 * fixed so the output is reproducible across captures.
 */
function synthesizeWellness(wellness: Rec[]): Rec[] {
  const rng = mulberry32(20260924);
  let ctl = 35 + rng() * 10;
  let atl = 25 + rng() * 10;
  return wellness.map((w) => {
    ctl += (rng() - 0.5) * 2;
    atl += (rng() - 0.5) * 4;

    const out: Rec = {};
    for (const key of Object.keys(w)) {
      if (key === "id") {
        out[key] = w[key];
      } else if (key === "comments" || key === "hrv") {
        out[key] = null;
      } else if (key === "weight") {
        out[key] = w[key] == null ? null : 70;
      } else if (key === "ctl") {
        out[key] = Math.round(ctl * 100) / 100;
      } else if (key === "atl") {
        out[key] = Math.round(atl * 100) / 100;
      } else if (key in WELLNESS_SYNTHETIC_RANGES) {
        const [min, max, decimals] = WELLNESS_SYNTHETIC_RANGES[key]!;
        const real = w[key] as number | null | undefined;
        out[key] =
          real == null
            ? null
            : synthesizeAvoiding(rng, min, max, decimals, real);
      } else {
        out[key] = null;
      }
    }
    return out;
  });
}

/** A named extra activity capture: `name:id` or `name:id:intervals` to also
 * capture the interval breakdown (only the multi-lap fixture needs it). */
interface NamedCapture {
  name: string;
  id: string;
  captureIntervals: boolean;
}

function parseNamedCaptures(args: string[]): NamedCapture[] {
  return args.map((arg) => {
    const [name, id, flag] = arg.split(":");
    if (!name || !id) {
      throw new Error(
        `invalid extra fixture arg "${arg}"; expected name:id or name:id:intervals`,
      );
    }
    return { name, id, captureIntervals: flag === "intervals" };
  });
}

const namedCaptures = parseNamedCaptures(process.argv.slice(3));

mkdirSync(OUT, { recursive: true });
const write = (file: string, data: unknown) =>
  writeFileSync(path.join(OUT, file), `${JSON.stringify(data, null, 2)}\n`);

const activities = (await get(
  "/athlete/0/activities?oldest=2026-09-01&newest=2026-09-24",
)) as Rec[];
write("activities.json", activities.map(scrubActivity));
write(
  "activity.json",
  scrubActivity((await get(`/activity/${ACTIVITY}`)) as Rec, 0),
);
const intervals = (await get(`/activity/${ACTIVITY}/intervals`)) as Rec;
write("activity-intervals.json", { ...intervals });
write(
  "streams.json",
  scrubStreams(
    (await get(
      `/activity/${ACTIVITY}/streams.json?types=${STREAM_TYPES}`,
    )) as Rec[],
  ),
);
const wellness = (await get(
  "/athlete/0/wellness?oldest=2026-09-10&newest=2026-09-24",
)) as Rec[];
write("wellness.json", synthesizeWellness(wellness));

for (const capture of namedCaptures) {
  write(
    `activity-${capture.name}.json`,
    scrubActivity((await get(`/activity/${capture.id}`)) as Rec, 0),
  );
  if (capture.captureIntervals) {
    const capturedIntervals = (await get(
      `/activity/${capture.id}/intervals`,
    )) as Rec;
    write(`activity-${capture.name}-intervals.json`, { ...capturedIntervals });
  }
  write(
    `streams-${capture.name}.json`,
    scrubStreams(
      (await get(
        `/activity/${capture.id}/streams.json?types=${EXTRA_STREAM_TYPES}`,
      )) as Rec[],
    ),
  );
}

function scrubAthleteId(r: Rec): Rec {
  const out: Rec = { ...r };
  if ("athlete_id" in out) out.athlete_id = "i0";
  if ("icu_athlete_id" in out) out.icu_athlete_id = "i0";
  return out;
}

/**
 * `pace-curves.json` carries real body weight in two places: each
 * `.activities` map entry (keyed by activity id) has `icu_weight`, and each
 * `.list` entry (the `all`/`1y`/`90d`/... curve itself, one per requested
 * window) has its own top-level `weight`, the athlete's current weight,
 * repeated per curve rather than per activity. Both are scrubbed to 70. Each
 * `.activities` entry's `name` is also renamed to `Run N` (the capture
 * always requests `type=Run`, and the map itself carries no `type` field to
 * build the label from). Every other field on both `.activities` entries and
 * `.list` entries (ids, dates, distance/training-load/pace-model numbers) is
 * activity/performance data, not personally identifying, and is left as-is,
 * matching every other captured activity fixture.
 */
function scrubPaceCurves(data: Rec): Rec {
  const activities = (data.activities ?? {}) as Record<string, Rec>;
  const scrubbedActivities: Record<string, Rec> = {};
  let i = 0;
  for (const [id, a] of Object.entries(activities)) {
    i += 1;
    scrubbedActivities[id] = {
      ...a,
      name: `Run ${i}`,
      ...("icu_weight" in a ? { icu_weight: 70 } : {}),
    };
  }

  const list = (data.list ?? []) as Rec[];
  const scrubbedList = list.map((entry) => ({
    ...entry,
    ...("weight" in entry ? { weight: 70 } : {}),
  }));

  return { ...data, activities: scrubbedActivities, list: scrubbedList };
}

/**
 * `activity-pace-curves.json`'s `curves[]` entries carry only an id, a
 * date, a body weight, and the per-distance `secs`: no free text to rename,
 * just the weight scrubbed like every other capture.
 */
function scrubActivityPaceCurves(data: Rec): Rec {
  const curves = (data.curves ?? []) as Rec[];
  return {
    ...data,
    curves: curves.map((c) => ({
      ...c,
      ...("weight" in c ? { weight: 70 } : {}),
    })),
  };
}

write(
  "sport-settings-run.json",
  scrubAthleteId((await get("/athlete/0/sport-settings/Run")) as Rec),
);
const gear = (await get("/athlete/0/gear")) as Rec[];
write("gear.json", gear.map(scrubAthleteId));

write(
  "pace-curves.json",
  scrubPaceCurves(
    (await get(
      "/athlete/0/pace-curves.json?type=Run&curves=all,1y,90d",
    )) as Rec,
  ),
);
// `activity-pace-curves.json` 403s on athlete id 0 (and on an `i`-prefixed
// id); it needs the bare numeric id, resolved from `/athlete/0` and never
// written to a fixture itself (it also carries `icu_api_key`).
const self = (await get("/athlete/0")) as Rec;
const numericAthleteId = String(self.id);
write(
  "activity-pace-curves.json",
  scrubActivityPaceCurves(
    (await get(
      `/athlete/${numericAthleteId}/activity-pace-curves.json?oldest=2026-09-01&newest=2026-09-24&type=Run&distances=400,1000,5000,10000`,
    )) as Rec,
  ),
);

console.error(`wrote fixtures to ${OUT}`);
