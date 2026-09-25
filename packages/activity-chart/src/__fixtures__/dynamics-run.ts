import { type ActivityStreamData } from "../types";

/**
 * Small synthetic run (10 s sampling, 24 samples = 4 minutes) carrying
 * running-dynamics streams (ground contact time, vertical oscillation,
 * vertical ratio, step length) alongside the usual heart rate/pace/cadence/
 * altitude. No real coordinates or personal data; every value is generated.
 *
 * Dynamics carry a two-sample dropout in the middle (a disconnected footpod),
 * standing in for a real sensor gap: the null-safe rendering path (Task 2)
 * must break those lines rather than draw a fabricated zero or spike.
 */
const SAMPLES = 24;
const time = Array.from({ length: SAMPLES }, (_, i) => i * 10);
const distance = time.map((_, i) => i * 47);

const heartrate = time.map((_, i) => 142 + i);
const velocity_smooth = time.map(() => 3.4);
const cadence = time.map(() => 84);
const altitude = time.map((_, i) => 30 + i * 0.5);

// Ground contact time, ms. Trends down slightly as the run warms up.
const stance_time: (number | null)[] = time.map((_, i) =>
  i >= 10 && i <= 11 ? null : Math.round(258 - i * 0.6),
);

// Vertical oscillation, mm.
const vertical_oscillation: (number | null)[] = time.map((_, i) =>
  i >= 10 && i <= 11 ? null : Number((82 - i * 0.15).toFixed(1)),
);

// Vertical ratio, %.
const vertical_ratio: (number | null)[] = time.map((_, i) =>
  Number((7.2 - i * 0.02).toFixed(2)),
);

// Step length, mm.
const step_length: (number | null)[] = time.map((_, i) =>
  Math.round(1180 + i * 2),
);

export const dynamicsRun: ActivityStreamData = {
  activityId: "9990002",
  activityType: "Run",
  name: "Dynamics Pod Run (synthetic)",
  streams: {
    time,
    heartrate,
    velocity_smooth,
    cadence,
    altitude,
    distance,
    stance_time,
    vertical_oscillation,
    vertical_ratio,
    step_length,
  },
  laps: [
    {
      name: "Steady State",
      startIndex: 0,
      endIndex: SAMPLES - 1,
      distance: distance[SAMPLES - 1] ?? 0,
      elapsedTime: time[SAMPLES - 1] ?? 0,
      averageSpeed: 3.4,
      averageHeartrate: 153,
      lapIndex: 1,
      type: "WORK",
      label: null,
    },
  ],
};
