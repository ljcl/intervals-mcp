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
