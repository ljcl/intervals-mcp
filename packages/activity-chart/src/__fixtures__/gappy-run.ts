import { type ActivityStreamData } from "../types";

/**
 * Small synthetic run (15 s sampling, 20 samples = 5 minutes) with
 * deliberate `null` runs in several streams, standing in for real sensor
 * dropouts: a GPS/HR chest-strap disconnect and a missing cadence pod. No
 * real coordinates or personal data; every value is generated.
 *
 * Verifies the null-safe rendering path: gaps must draw as breaks in the
 * line, never a fabricated zero, spike, or interpolated value.
 */
const SAMPLES = 20;
const time = Array.from({ length: SAMPLES }, (_, i) => i * 15);

// Heartrate: a chest-strap dropout for four samples in the middle.
const heartrate: (number | null)[] = time.map((_, i) =>
  i >= 8 && i <= 11 ? null : 130 + i,
);

// Velocity: a GPS dropout for three samples, must not render as a 15
// min/km pace spike.
const velocity_smooth: (number | null)[] = time.map((_, i) =>
  i >= 5 && i <= 7 ? null : 3.2,
);

// Cadence: a missing pod for two samples, must not render as cadence 0.
const cadence: (number | null)[] = time.map((_, i) =>
  i === 14 || i === 15 ? null : 82,
);

// Altitude: a single dropped sample.
const altitude: (number | null)[] = time.map((_, i) =>
  i === 3 ? null : 40 + i,
);

// Distance stays gap-free (server contract): a plain cumulative stream.
const distance = time.map((_, i) => i * 48);

export const gappyRun: ActivityStreamData = {
  activityId: "9990001",
  activityType: "Run",
  name: "Gappy Sensor Run (synthetic)",
  streams: {
    time,
    heartrate,
    velocity_smooth,
    cadence,
    altitude,
    distance,
  },
  laps: [
    {
      name: "Work",
      startIndex: 0,
      endIndex: 9,
      distance: 480,
      elapsedTime: 150,
      averageSpeed: 3.2,
      averageHeartrate: 138,
      lapIndex: 1,
      type: "WORK",
      label: null,
    },
    {
      name: "Recovery",
      startIndex: 10,
      endIndex: SAMPLES - 1,
      // Rest bands can have a null distance: isRest must key off `type`,
      // never off this field or the "Recovery" name.
      distance: null,
      elapsedTime: null,
      averageSpeed: null,
      averageHeartrate: null,
      lapIndex: 2,
      type: "RECOVERY",
      label: null,
    },
  ],
};
