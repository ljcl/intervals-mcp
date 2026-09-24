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
write(
  "wellness.json",
  wellness.map((w) => ({
    ...w,
    weight: w.weight == null ? null : 70,
    comments: null,
  })),
);
function scrubAthleteId(r: Rec): Rec {
  const out: Rec = { ...r };
  if ("athlete_id" in out) out.athlete_id = "i0";
  if ("icu_athlete_id" in out) out.icu_athlete_id = "i0";
  return out;
}

write(
  "sport-settings-run.json",
  scrubAthleteId((await get("/athlete/0/sport-settings/Run")) as Rec),
);
const gear = (await get("/athlete/0/gear")) as Rec[];
write("gear.json", gear.map(scrubAthleteId));
console.error(`wrote fixtures to ${OUT}`);
