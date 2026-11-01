import { type ActivityZonesData, type ZoneSet } from "../types";

// intervals.icu's own recorded zone bounds (icu_hr_zones) give a real upper
// bound even for the top zone, and carry no sensor flag at all: unlike
// Strava's response, sensorBased is always null here, never a boolean.
export const hrZoneSet: ZoneSet = {
  type: "heartrate",
  unit: "bpm",
  sensorBased: null,
  totalSeconds: 4000,
  buckets: [
    { zone: 1, min: 0, max: 120, seconds: 600, pct: 15 },
    { zone: 2, min: 120, max: 145, seconds: 1800, pct: 45 },
    { zone: 3, min: 145, max: 160, seconds: 900, pct: 22.5 },
    { zone: 4, min: 160, max: 175, seconds: 500, pct: 12.5 },
    { zone: 5, min: 175, max: 197, seconds: 200, pct: 5 },
  ],
};

export const powerZoneSet: ZoneSet = {
  type: "power",
  unit: "W",
  sensorBased: false,
  totalSeconds: 4000,
  buckets: [
    { zone: 1, min: 0, max: 180, seconds: 1200, pct: 30 },
    { zone: 2, min: 180, max: 230, seconds: 1400, pct: 35 },
    { zone: 3, min: 230, max: 280, seconds: 800, pct: 20 },
    { zone: 4, min: 280, max: 330, seconds: 400, pct: 10 },
    { zone: 5, min: 330, max: 400, seconds: 150, pct: 3.8 },
    { zone: 6, min: 400, max: null, seconds: 50, pct: 1.3 },
  ],
};

// A run's grade-adjusted pace zones, as mapIntervalsZones builds them from
// the activity-pace-zones fixture: bounds are speeds in m/s (percent of a
// 3.571 m/s threshold), the slowest zone starts at 0 and the open top zone
// has no fast limit.
export const paceZoneSet: ZoneSet = {
  type: "pace",
  unit: "m/s",
  basis: "gap",
  sensorBased: null,
  totalSeconds: 1716,
  buckets: [
    { zone: 1, min: 0, max: 2.768, seconds: 177, pct: 10.3 },
    { zone: 2, min: 2.768, max: 3.132, seconds: 704, pct: 41 },
    { zone: 3, min: 3.132, max: 3.368, seconds: 347, pct: 20.2 },
    { zone: 4, min: 3.368, max: 3.571, seconds: 281, pct: 16.4 },
    { zone: 5, min: 3.571, max: 3.693, seconds: 82, pct: 4.8 },
    { zone: 6, min: 3.693, max: 3.982, seconds: 71, pct: 4.1 },
    { zone: 7, min: 3.982, max: null, seconds: 54, pct: 3.1 },
  ],
};

export const mockZonesData: ActivityZonesData = {
  activityId: "1234567890",
  name: "Threshold Intervals",
  // intervals.icu's start_date_local: the athlete's local time, no offset.
  date: "2026-07-10T06:12:00",
  type: "Run",
  zoneSets: [hrZoneSet, powerZoneSet],
  hrZoneWarning: null,
};

export const hrOnlyData: ActivityZonesData = {
  ...mockZonesData,
  name: "Easy Morning Run",
  zoneSets: [hrZoneSet],
};

/** A run with a heart rate strap and pace zones: HR first, then Pace. */
export const hrAndPaceData: ActivityZonesData = {
  ...mockZonesData,
  name: "Easy Morning Run",
  zoneSets: [hrZoneSet, paceZoneSet],
};

/** A run with no heart rate: the Pace chart stands in for the empty state. */
export const paceOnlyData: ActivityZonesData = {
  ...mockZonesData,
  name: "Treadmill Run",
  zoneSets: [paceZoneSet],
};

export const emptyZonesData: ActivityZonesData = {
  ...mockZonesData,
  name: "Manual Yoga Entry",
  type: "Yoga",
  zoneSets: [],
};

// A run with a working HR strap whose heart rate zones the server dropped:
// the recorded bounds and zone times disagree. The warning is the string
// hrZoneMismatchWarning (apps/server/src/activityZones.ts) sends.
export const hrZoneMismatchData: ActivityZonesData = {
  ...mockZonesData,
  name: "Tempo Run",
  zoneSets: [],
  hrZoneWarning:
    "Heart rate zones omitted: recorded bounds (5 zones) do not match the recorded zone times (6 zones).",
};
