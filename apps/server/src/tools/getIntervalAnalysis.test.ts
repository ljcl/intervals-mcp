/**
 * Handler tests for get-interval-analysis: dispatch-level, with
 * intervalsClient mocked. Classification and reconstruction math is covered
 * in intervalAnalysis.test.ts; these pin the fetch wiring (streams +
 * icu_intervals), cadence doubling, degradation paths, and text shape, using
 * the intervals.icu multi-lap fixtures.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import activitiesSimilar from "../__fixtures__/intervals/activities-similar.json";
import activityMultilap from "../__fixtures__/intervals/activity-multilap.json";
import activityMultilapIntervals from "../__fixtures__/intervals/activity-multilap-intervals.json";
import activityRepeats from "../__fixtures__/intervals/activity-repeats.json";
import intervalSearchRows from "../__fixtures__/intervals/interval-search.json";
import streamsMultilap from "../__fixtures__/intervals/streams-multilap.json";
import { formatSigned } from "../formatters";
import { SEARCH_LIMIT } from "../intervalSimilarity";
import {
  getActivitiesByIds,
  getActivity,
  getActivityStreams,
  type IntervalsActivity,
  type IntervalsInterval,
  type IntervalsStream,
  searchActivitiesByIntervals,
} from "../intervalsClient";
import { getIntervalAnalysisTool } from "./getIntervalAnalysis";
import {
  IntervalAnalysisOutputSchema,
  type SimilarSessionsOutput,
} from "./outputs";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return {
    ...actual,
    getActivity: vi.fn(),
    getActivityStreams: vi.fn(),
    searchActivitiesByIntervals: vi.fn(),
    getActivitiesByIds: vi.fn(),
  };
});

const mockedGetActivity = vi.mocked(getActivity);
const mockedGetActivityStreams = vi.mocked(getActivityStreams);
const mockedSearch = vi.mocked(searchActivitiesByIntervals);
const mockedGetActivitiesByIds = vi.mocked(getActivitiesByIds);

/** The full activity object (type, name, start_date_local) for the multi-lap run. */
const multilapActivity = activityMultilap as unknown as IntervalsActivity;
/** The same run's real icu_intervals (12 WORK, 6 RECOVERY; see intervalAnalysis.test.ts note below). */
const multilapIntervals = (
  activityMultilapIntervals as { icu_intervals: IntervalsInterval[] }
).icu_intervals;
/** Real streams for the run's first ~11 minutes, capped at 600 samples; carries one genuine 74 s auto-pause gap. */
const multilapStreams = streamsMultilap as unknown as IntervalsStream[];

beforeEach(() => {
  mockedGetActivity.mockReset();
  mockedGetActivityStreams.mockReset();
  mockedSearch.mockReset();
  mockedGetActivitiesByIds.mockReset();
});

/**
 * Builds 1 Hz streams shaped by the real fixture's WORK/RECOVERY sequence
 * (type, moving_time, average_heartrate), but with synthetic pace: the real
 * per-interval average_speed values are too close together (the run is a
 * continuous ~57 min effort auto-lapped into 18 pieces, not true hard/easy
 * intervals; confirmed by probing computeIntervalAnalysis directly against
 * the unmodified fixture, which finds 0 reps) to ever read as "fast" without
 * an easy baseline to stand out from. A short easy warm-up/cool-down (absent
 * from the fixture, which starts mid-effort) supplies that baseline, exactly
 * as intervalAnalysis.test.ts's own synthetic "repeats session" does. The
 * four RECOVERY intervals lasting >= 10 s (the MIN_REST_SECONDS floor)
 * become genuine stops; the two under 10 s are omitted (they would be
 * ignored as GPS blips anyway). Sized to the intervals, per the brief.
 */
function buildMultilapDerivedStreams(): IntervalsStream[] {
  const time: number[] = [];
  const distance: number[] = [];
  const heartrate: number[] = [];
  const velocity_smooth: number[] = [];
  let t = 0;
  let d = 0;
  const push = (seconds: number, speedMs: number, hr: number) => {
    for (let s = 0; s < seconds; s++) {
      t += 1;
      d += speedMs;
      time.push(t);
      distance.push(d);
      heartrate.push(hr);
      velocity_smooth.push(speedMs);
    }
  };

  push(600, 2.0, 150); // easy warm-up
  push(30, 0, 145); // stop before the reps start
  let workIndex = 0;
  for (const interval of multilapIntervals) {
    const duration = Math.round(interval.moving_time ?? 0);
    if (interval.type === "WORK") {
      const speed = 4.3 - workIndex * 0.015; // gentle fade across reps
      push(duration, speed, interval.average_heartrate ?? 150);
      workIndex++;
    } else if (duration >= 10) {
      push(duration, 0, interval.average_heartrate ?? 150);
    }
  }
  push(30, 0, 150); // stop after the reps end
  push(600, 2.0, 145); // easy cool-down

  return [
    { type: "time", data: time },
    { type: "distance", data: distance },
    { type: "heartrate", data: heartrate },
    { type: "velocity_smooth", data: velocity_smooth },
  ] as unknown as IntervalsStream[];
}

describe("get-interval-analysis", () => {
  it("reconstructs the multi-lap fixture's WORK/RECOVERY structure with fade and pace strings", async () => {
    mockedGetActivity.mockResolvedValue({
      ...multilapActivity,
      icu_intervals: multilapIntervals,
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue(buildMultilapDerivedStreams());

    const result = await getIntervalAnalysisTool.execute(
      { id: "i189757183", findSimilar: false },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Verdict: interval session");
    expect(text).toContain("Fade: rep");
    expect(text).toMatch(/\d+:\d{2} \/km/);
    expect(text).toContain("Rests:");

    const structured = result.structuredContent as {
      is_intervals: boolean;
      source: string;
      confidence: string;
      reps: Array<{ pace_min_per_km: string | null }>;
      rests: Array<{ kind: string; duration_s: number }>;
      fade: { pace_drift_pct: number; summary: string } | null;
    };
    expect(structured.is_intervals).toBe(true);
    expect(structured.source).toBe("streams");
    // The fixture's four >= 10 s RECOVERY intervals (75, 36, 54, 37 s) each
    // become a "recovery"-classified rest: the WORK/RECOVERY consistency
    // the acceptance criterion asks for.
    const recoveryDurations = structured.rests
      .filter((r) => r.kind === "recovery")
      .map((r) => r.duration_s);
    expect(recoveryDurations).toEqual(expect.arrayContaining([75, 36, 54, 37]));
    expect(structured.reps.some((r) => r.pace_min_per_km != null)).toBe(true);
    expect(structured.fade).not.toBeNull();
    expect(structured.fade!.summary).toContain("slower");
    expect(IntervalAnalysisOutputSchema.safeParse(structured).success).toBe(
      true,
    );
  });

  it("finds a rest at a genuine auto-pause gap via the derived moving stream, with meaningful confidence", async () => {
    // The real capped fixture (first ~11 min) carries one genuine 74 s
    // recording gap with velocity_smooth null throughout; the derived
    // moving stream (intervalsStreams.ts) must catch it from the time gap
    // alone.
    mockedGetActivity.mockResolvedValue(multilapActivity);
    mockedGetActivityStreams.mockResolvedValue(multilapStreams);

    const result = await getIntervalAnalysisTool.execute(
      { id: "i189757183", findSimilar: false },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      confidence: string;
      warnings: string[];
      rests: Array<{ duration_s: number; kind: string }>;
      hr_signal: {
        max_hr: number;
        max_hr_source: string;
        assessment: string;
      } | null;
    };
    expect(structured.rests.some((r) => r.duration_s >= 70)).toBe(true);
    expect(structured.rests.map((r) => r.kind)).toEqual(["other_stop"]);
    // Derived moving found the stop, so this is not the "no moving stream"
    // low-confidence path. With no reps, the unclassified stop leaves the
    // verdict at high; so does the HR signal, now measured against the
    // athlete's 190 bpm max rather than this stretch's own 170 bpm peak
    // (which put 72% of it "near max" and downgraded the verdict, #47).
    expect(structured.confidence).toBe("high");
    expect(structured.hr_signal!.max_hr).toBe(190);
    expect(structured.hr_signal!.max_hr_source).toBe("athlete_max_hr");
    expect(structured.hr_signal!.assessment).not.toContain("hard workout");
    expect(structured.warnings).toEqual([]);
  });

  it("reads the real multi-lap laps, sliver laps and all, as one continuous effort", async () => {
    // The fixture's icu_intervals end with a 26 m / 12 s lap and a 4 s lap
    // with no distance. Those no longer switch the lap path off (#47); the
    // laps are then judged on their own and hold no fast reps.
    mockedGetActivity.mockResolvedValue({
      ...multilapActivity,
      icu_intervals: multilapIntervals,
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue(multilapStreams);

    const result = await getIntervalAnalysisTool.execute(
      { id: "i189757183", findSimilar: false },
      "test-key",
    );

    const structured = result.structuredContent as {
      is_intervals: boolean;
      source: string;
      reps: unknown[];
    };
    expect(structured.is_intervals).toBe(false);
    expect(structured.source).toBe("none");
    expect(structured.reps).toEqual([]);
  });

  it("falls back to the run's own peak with a warning when the activity has no max HR", async () => {
    mockedGetActivity.mockResolvedValue({
      ...multilapActivity,
      athlete_max_hr: null,
      icu_hr_zones: null,
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue(multilapStreams);

    const result = await getIntervalAnalysisTool.execute(
      { id: "i189757183", findSimilar: false },
      "test-key",
    );

    const structured = result.structuredContent as {
      confidence: string;
      warnings: string[];
      hr_signal: { max_hr_source: string } | null;
    };
    expect(structured.hr_signal!.max_hr_source).toBe("activity_peak");
    expect(structured.confidence).toBe("high");
    expect(structured.warnings.join(" ")).toContain("no athlete max HR");
    expect(result.content[0]?.text).toContain("this run's own peak");
    expect(IntervalAnalysisOutputSchema.safeParse(structured).success).toBe(
      true,
    );
  });

  it("requests the intervals.icu stream types and fetches icu_intervals via getActivity", async () => {
    mockedGetActivity.mockResolvedValue(multilapActivity);
    mockedGetActivityStreams.mockResolvedValue(multilapStreams);

    await getIntervalAnalysisTool.execute(
      { id: "i189757183", findSimilar: false },
      "test-key",
    );

    expect(mockedGetActivity).toHaveBeenCalledWith("test-key", "i189757183", {
      intervals: true,
    });
    const requestedTypes = mockedGetActivityStreams.mock.calls[0]![2];
    for (const type of [
      "time",
      "distance",
      "heartrate",
      "velocity_smooth",
      "cadence",
      "watts",
    ]) {
      expect(requestedTypes).toContain(type);
    }
  });

  it("prefers clean structured intervals.icu laps for a jog-recovery session", async () => {
    const lap = (
      distance: number,
      moving_time: number,
      average_heartrate: number,
      average_cadence: number,
    ): IntervalsInterval => ({
      type: "WORK",
      distance,
      moving_time,
      average_speed: distance / moving_time,
      average_heartrate,
      average_cadence,
    });

    mockedGetActivity.mockResolvedValue({
      ...multilapActivity,
      icu_intervals: [
        lap(2000, 700, 138, 82),
        lap(800, 190, 170, 92),
        lap(400, 240, 148, 84),
        lap(800, 192, 174, 92),
        lap(400, 240, 150, 84),
        lap(800, 191, 176, 92),
        lap(1500, 520, 142, 82),
      ],
    } as IntervalsActivity);
    // Continuous easy movement: the stream path sees nothing on its own.
    const time: number[] = [];
    const heartrate: number[] = [];
    const distance: number[] = [];
    for (let s = 0; s < 2400; s++) {
      time.push(s);
      distance.push(s * 3.0);
      heartrate.push(150);
    }
    mockedGetActivityStreams.mockResolvedValue([
      { type: "time", data: time },
      { type: "distance", data: distance },
      { type: "heartrate", data: heartrate },
    ] as unknown as IntervalsStream[]);

    const result = await getIntervalAnalysisTool.execute(
      { id: "i189757183", findSimilar: false },
      "test-key",
    );

    const structured = result.structuredContent as {
      source: string;
      reps: Array<{ avg_cadence: number | null }>;
    };
    expect(structured.source).toBe("laps");
    expect(structured.reps).toHaveLength(3);
    // Run cadence is doubled to spm for display.
    expect(structured.reps[0]!.avg_cadence).toBe(184);
    expect(result.content[0]?.text).toContain("clean structured laps");
  });

  it("errors cleanly for an activity with no recorded streams", async () => {
    mockedGetActivity.mockResolvedValue({
      ...multilapActivity,
      name: "Manual Entry",
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue([]);

    const result = await getIntervalAnalysisTool.execute(
      { id: "i189757183", findSimilar: false },
      "test-key",
    );

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Manual Entry");
    expect(text).toContain("No data streams");
  });

  it("reports an exhausted rate limit instead of claiming there are no streams", async () => {
    mockedGetActivity.mockResolvedValue(multilapActivity);
    mockedGetActivityStreams.mockRejectedValue(
      handledRateLimit("getActivityStreams for ID i189757183"),
    );

    const result = await getIntervalAnalysisTool.execute(
      { id: "i189757183", findSimilar: false },
      "test-key",
    );

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Rate limit");
    expect(text).not.toContain("No data streams");
  });

  it("returns not-found text when the activity does not exist", async () => {
    mockedGetActivity.mockRejectedValue(
      handledNotFound("getActivity for ID i999"),
    );

    const result = await getIntervalAnalysisTool.execute(
      { id: "i999", findSimilar: false },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not found");
  });
});

describe("get-interval-analysis findSimilar (#84)", () => {
  /** A 5 x 1 km session with walk-jog recoveries and device laps. */
  const repeats = activityRepeats as unknown as IntervalsActivity;
  /** Interval-search rows, newest first: 3 later runs, this one, 8 earlier runs, a swim. */
  const searchRows = intervalSearchRows as unknown as IntervalsActivity[];
  /** The bulk read of the 8 earlier runs, oldest first, as intervals.icu sends them. */
  const bulkRows = activitiesSimilar as unknown as IntervalsActivity[];
  /** The 8 earlier runs in the search rows, newest first. */
  const EARLIER_IDS = [
    "i189757863",
    "i189757872",
    "i189757902",
    "i189758125",
    "i189758159",
    "i189758205",
    "i107333750",
    "i106852109",
  ];
  /** The 5 that have the same reps: 2 show no clean reps, 1 has mixed reps. */
  const MATCH_IDS = [
    "i189757872",
    "i189757902",
    "i189758159",
    "i107333750",
    "i106852109",
  ];

  /** The source session; its streams only need time and distance. */
  function givenSource(activity: IntervalsActivity = repeats) {
    mockedGetActivity.mockResolvedValue(activity);
    mockedGetActivityStreams.mockResolvedValue(multilapStreams);
  }

  async function run(activityId = repeats.id) {
    const result = await getIntervalAnalysisTool.execute(
      { id: activityId, findSimilar: true },
      "test-key",
    );
    const structured = result.structuredContent as
      | { similar: SimilarSessionsOutput }
      | undefined;
    return {
      result,
      text: result.content[0]?.text ?? "",
      similar: structured!.similar,
    };
  }

  it("makes no extra request without findSimilar", async () => {
    givenSource();
    const result = await getIntervalAnalysisTool.execute(
      { id: repeats.id, findSimilar: false },
      "test-key",
    );
    expect(mockedSearch).not.toHaveBeenCalled();
    expect(mockedGetActivitiesByIds).not.toHaveBeenCalled();
    expect(result.structuredContent).not.toHaveProperty("similar");
    expect(result.content[0]?.text).not.toContain("Similar");
  });

  it("finds the earlier sessions with the same reps, newest first", async () => {
    givenSource();
    mockedSearch.mockResolvedValue(searchRows);
    mockedGetActivitiesByIds.mockResolvedValue(bulkRows);

    const { result, text, similar } = await run();

    expect(result.isError).toBeUndefined();
    expect(mockedSearch).toHaveBeenCalledTimes(1);
    expect(mockedSearch).toHaveBeenCalledWith(
      "test-key",
      expect.objectContaining({
        minSecs: 225,
        maxSecs: 309,
        minIntensity: 92,
        maxIntensity: 107,
        minReps: 3,
        maxReps: 7,
        limit: 100,
      }),
    );
    expect(mockedGetActivitiesByIds).toHaveBeenCalledTimes(1);
    expect(mockedGetActivitiesByIds).toHaveBeenCalledWith(
      "test-key",
      EARLIER_IDS,
      { intervals: true },
    );

    expect(similar.status).toBe("found");
    expect(similar.reason).toBeNull();
    expect(similar.candidates).toBe(8);
    expect(similar.checked).toBe(8);
    expect(similar.skipped).toEqual({ no_clean_reps: 2, different_reps: 1 });
    expect(similar.sessions.map((s) => s.activity_id)).toEqual(MATCH_IDS);
    expect(similar.this_session).toMatchObject({
      rep_count: 5,
      rep_time_s: 267,
      rep_distance_m: 1005,
      pace_sec_per_km: 266,
      pace_min_per_km: "4:26",
      avg_hr: 174,
      intensity_pct: 100,
    });
    expect(similar.search).toEqual({
      rep_time_min_s: 225,
      rep_time_max_s: 309,
      intensity_min_pct: 92,
      intensity_max_pct: 107,
      rep_count_min: 3,
      rep_count_max: 7,
    });
    expect(similar.sessions[0]).toMatchObject({
      name: "Run 3",
      date: "2026-04-28T18:00:27",
      type: "Run",
      rep_count: 4,
      rep_distance_m: 1004,
      pace_min_per_km: "4:55",
      avg_hr: 165,
      pace_delta_sec_per_km: 29,
      hr_delta_bpm: -9,
      pace_drift_pct: -5,
    });
    expect(
      IntervalAnalysisOutputSchema.safeParse(result.structuredContent).success,
    ).toBe(true);

    // The main analysis: the cool-down lap is no longer a sixth rep.
    const structured = result.structuredContent as {
      reps: Array<{ intensity_pct: number | null }>;
      reasoning: string;
    };
    expect(structured.reps).toHaveLength(5);
    expect(structured.reps.every((rep) => rep.intensity_pct != null)).toBe(
      true,
    );
    expect(structured.reasoning).toContain(
      "1 slow lap at the edge (warm-up, cool-down or a much slower last rep) not counted in a rep",
    );

    expect(text).toContain(
      "Similar earlier sessions (typical rep: 1005 m in 4:27, 5 reps):",
    );
    expect(text).toContain(
      "  This session 2026-05-14: 5 × 1005 m at 4:26 /km, 174 bpm, even pace",
    );
    expect(text).toContain(
      `  2026-04-28 Run 3 (i189757872): 4 × 1004 m at 4:55 /km (${formatSigned(29)} s/km), 165 bpm (${formatSigned(-9)}), last rep 5% faster`,
    );
    expect(text).toContain(
      `  2025-11-17 Run 8 (i107333750): 3 × 1004 m at 4:33 /km (${formatSigned(7)} s/km), 174 bpm (${formatSigned(0)}), last rep 7.9% faster`,
    );
    expect(text).toContain(
      "  Checked 8 of 8 earlier sessions that intervals.icu found (reps of 225-309 s at 92-107% intensity, 3-7 reps): 5 match, 2 show no clean reps in their laps, 1 has different reps.",
    );
    expect(text).not.toContain("not checked");
    // After the HR signal line and a blank line, before any warning.
    expect(text).toMatch(/\nHR signal: [^\n]+\n\nSimilar earlier sessions \(/);
  });

  it("stops at 5 matches and says how many candidates were not checked", async () => {
    // Copies of the 5 matches, newer than every other candidate but older
    // than the source.
    const copies = MATCH_IDS.map((matchId, i) => ({
      ...bulkRows.find((row) => row.id === matchId)!,
      id: `i900000000${i + 1}`,
      start_date_local: `2026-05-12T${14 - i}:00:00`,
    }));
    givenSource();
    mockedSearch.mockResolvedValue([
      ...searchRows.slice(0, 4),
      ...copies,
      ...searchRows.slice(4),
    ]);
    mockedGetActivitiesByIds.mockResolvedValue([...bulkRows, ...copies]);

    const { text, similar } = await run();

    expect(mockedGetActivitiesByIds.mock.calls[0]![1]).toHaveLength(13);
    expect(similar.candidates).toBe(13);
    expect(similar.checked).toBe(5);
    expect(similar.sessions.map((s) => s.activity_id)).toEqual(
      copies.map((copy) => copy.id),
    );
    expect(text).toMatch(
      /: 5 match, 0 show no clean reps in their laps, 0 have different reps\. 8 candidates were not checked\.$/m,
    );
  });

  it("reads at most 20 candidates, newest first", async () => {
    // 25 earlier runs with no laps: none matches, and only 20 are read.
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...bulkRows[0]!,
      id: `i80000000${String(i).padStart(2, "0")}`,
      start_date_local: `2026-03-${String(28 - i).padStart(2, "0")}T07:00:00`,
      icu_intervals: [],
    }));
    givenSource();
    mockedSearch.mockResolvedValue(many);
    mockedGetActivitiesByIds.mockResolvedValue(many.slice(0, 20));

    const { similar } = await run();

    expect(mockedGetActivitiesByIds.mock.calls[0]![1]).toEqual(
      many.slice(0, 20).map((row) => row.id),
    );
    expect(similar.candidates).toBe(25);
    expect(similar.checked).toBe(20);
    expect(similar.status).toBe("none_found");
    expect(similar.reason).toContain(
      "5 older candidates were not checked, so 25 were found in all.",
    );
  });

  it("says so when a full search page held no earlier session", async () => {
    const later = Array.from({ length: SEARCH_LIMIT }, (_, i) => ({
      ...searchRows[0]!,
      id: `i70000${String(i).padStart(4, "0")}`,
      start_date_local: "2027-01-01T07:00:00",
    }));
    givenSource();
    mockedSearch.mockResolvedValue(later);

    const { similar } = await run();

    expect(similar.status).toBe("none_found");
    expect(similar.reason).toContain("older sessions were not searched");
    expect(similar.reason).not.toContain("found no earlier session");
  });

  it("searches any intensity for a session whose reps come from the streams", async () => {
    // 5 efforts of 240 s at 4 m/s, each followed by a 90 s standing rest, and
    // no laps: the reps come from the streams.
    const time: number[] = [];
    const distance: number[] = [];
    const heartrate: number[] = [];
    const velocity: number[] = [];
    let t = 0;
    let d = 0;
    const tick = (speed: number, hr: number) => {
      time.push(t++);
      distance.push(d);
      heartrate.push(hr);
      velocity.push(speed);
      d += speed;
    };
    for (let s = 0; s < 600; s++) tick(2.5, 130);
    for (let rep = 0; rep < 5; rep++) {
      for (let s = 0; s < 240; s++) tick(4, 172);
      for (let s = 0; s < 90; s++) tick(0, 140);
    }
    mockedGetActivity.mockResolvedValue({ ...repeats, icu_intervals: [] });
    mockedGetActivityStreams.mockResolvedValue([
      { type: "time", data: time },
      { type: "distance", data: distance },
      { type: "heartrate", data: heartrate },
      { type: "velocity_smooth", data: velocity },
    ] as unknown as IntervalsStream[]);
    mockedSearch.mockResolvedValue([]);

    const { similar, result } = await run();

    expect((result.structuredContent as { source: string }).source).toBe(
      "streams",
    );
    expect(mockedSearch).toHaveBeenCalledTimes(1);
    expect(similar.search!.intensity_min_pct).toBeNull();
    expect(mockedSearch.mock.calls[0]![1]).toMatchObject({
      minIntensity: 0,
      maxIntensity: 300,
    });
  });

  it("does not search for a session that is not an interval session", async () => {
    // The real multi-lap run: one continuous effort, no reps.
    mockedGetActivity.mockResolvedValue({
      ...multilapActivity,
      icu_intervals: multilapIntervals,
    } as IntervalsActivity);
    mockedGetActivityStreams.mockResolvedValue(multilapStreams);

    const { text, similar } = await run("i189757183");

    expect(mockedSearch).not.toHaveBeenCalled();
    expect(similar).toMatchObject({
      status: "not_intervals",
      this_session: null,
      search: null,
      candidates: 0,
      sessions: [],
    });
    expect(text).toContain(
      "Similar earlier sessions: none. This activity is not an interval session, so there are no reps to search for.",
    );
  });

  it("does not search when the reps differ in length", async () => {
    // 2 clean reps of 120 s and 240 s: each is 33% from their median.
    const lap = (distance: number, moving_time: number): IntervalsInterval => ({
      distance,
      moving_time,
      average_speed: distance / moving_time,
    });
    givenSource({
      ...repeats,
      icu_intervals: [
        lap(2000, 720),
        lap(504, 120),
        lap(666, 180),
        lap(1008, 240),
        lap(1500, 540),
      ],
    } as IntervalsActivity);

    const { result, similar } = await run();

    expect(
      (result.structuredContent as { is_intervals: boolean }).is_intervals,
    ).toBe(true);
    expect(similar.status).toBe("mixed_reps");
    expect(similar.reason).toContain("The reps differ in length");
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it("names the band when the search finds nothing", async () => {
    givenSource();
    mockedSearch.mockResolvedValue([]);

    const { text, similar } = await run();

    expect(similar.status).toBe("none_found");
    expect(similar.reason).toBe(
      "intervals.icu found no earlier session of the same sport with 3-7 reps of 225-309 s at 92-107% intensity.",
    );
    expect(similar.this_session).not.toBeNull();
    expect(mockedGetActivitiesByIds).not.toHaveBeenCalled();
    expect(text).toContain(
      "Similar earlier sessions: none. intervals.icu found no earlier session",
    );
  });

  it("searches any intensity when the laps carry none, and prints a session with no HR", async () => {
    const withoutIntensity = (activity: IntervalsActivity) => ({
      ...activity,
      icu_intervals: activity.icu_intervals?.map((interval) => ({
        ...interval,
        intensity: null,
      })),
    });
    givenSource(withoutIntensity(repeats));
    mockedSearch.mockResolvedValue(searchRows);
    mockedGetActivitiesByIds.mockResolvedValue(
      bulkRows.map((row) =>
        row.id === "i189757872"
          ? {
              ...row,
              icu_intervals: row.icu_intervals?.map((interval) => ({
                ...interval,
                average_heartrate: null,
              })),
            }
          : row,
      ),
    );

    const { text, similar } = await run();

    expect(mockedSearch.mock.calls[0]![1]).toMatchObject({
      minIntensity: 0,
      maxIntensity: 300,
    });
    expect(similar.search).toMatchObject({
      intensity_min_pct: null,
      intensity_max_pct: null,
    });
    expect(similar.this_session?.intensity_pct).toBeNull();
    expect(similar.sessions[0]).toMatchObject({
      activity_id: "i189757872",
      avg_hr: null,
      hr_delta_bpm: null,
    });
    expect(text).toContain(
      `  2026-04-28 Run 3 (i189757872): 4 × 1004 m at 4:55 /km (${formatSigned(29)} s/km), no HR, last rep 5% faster`,
    );
    expect(text).toContain("(reps of 225-309 s at any intensity, 3-7 reps)");
  });

  it("leaves intensity out of the reason when the reps carry none", async () => {
    givenSource({
      ...repeats,
      icu_intervals: repeats.icu_intervals?.map((interval) => ({
        ...interval,
        intensity: null,
      })),
    });
    mockedSearch.mockResolvedValue([]);

    const { similar } = await run();

    expect(similar.reason).toBe(
      "intervals.icu found no earlier session of the same sport with 3-7 reps of 225-309 s.",
    );
  });

  it("reads nothing when the search finds only this session and later ones", async () => {
    givenSource();
    mockedSearch.mockResolvedValue(searchRows.slice(0, 4));

    const { similar } = await run();

    expect(similar.status).toBe("none_found");
    expect(similar.candidates).toBe(0);
    expect(mockedGetActivitiesByIds).not.toHaveBeenCalled();
  });

  it("counts candidates whose laps show no clean reps", async () => {
    givenSource();
    mockedSearch.mockResolvedValue(searchRows);
    mockedGetActivitiesByIds.mockResolvedValue(
      bulkRows.map((row) => ({ ...row, icu_intervals: [] })),
    );

    const { similar } = await run();

    expect(similar.status).toBe("none_found");
    expect(similar.skipped).toEqual({ no_clean_reps: 8, different_reps: 0 });
    expect(similar.reason).toBe(
      "None of the 8 earlier sessions that intervals.icu found has the same reps in its laps (8 show no clean reps, 0 have different reps).",
    );
  });

  it("words one checked candidate in the singular", async () => {
    givenSource();
    mockedSearch.mockResolvedValue(
      searchRows.filter((row) => row.id === "i189757863"),
    );
    mockedGetActivitiesByIds.mockResolvedValue(
      bulkRows.filter((row) => row.id === "i189757863"),
    );

    const { similar } = await run();

    expect(similar.reason).toBe(
      "The 1 earlier session that intervals.icu found does not have the same reps in its laps (1 shows no clean reps, 0 have different reps).",
    );
  });

  it("skips a candidate the bulk read no longer returns", async () => {
    givenSource();
    mockedSearch.mockResolvedValue(searchRows);
    mockedGetActivitiesByIds.mockResolvedValue(
      bulkRows.filter((row) => row.id !== "i189757872"),
    );

    const { text, similar } = await run();

    expect(similar.checked).toBe(7);
    expect(similar.sessions.map((s) => s.activity_id)).toEqual(
      MATCH_IDS.slice(1),
    );
    expect(text).toContain("1 candidate was not checked.");
  });

  it("says when no candidate could be read", async () => {
    givenSource();
    mockedSearch.mockResolvedValue(searchRows);
    mockedGetActivitiesByIds.mockResolvedValue([]);

    const { similar } = await run();

    expect(similar.status).toBe("none_found");
    expect(similar.checked).toBe(0);
    expect(similar.reason).toBe(
      "The earlier sessions that intervals.icu found could not be read.",
    );
  });

  it("keeps the analysis when the interval search fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    givenSource();
    mockedSearch.mockRejectedValue(
      handledRateLimit("searchActivitiesByIntervals for 225-309 s"),
    );

    const { result, text, similar } = await run();

    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { reps: unknown[] }).reps).toHaveLength(
      5,
    );
    expect(similar).toMatchObject({
      status: "unavailable",
      reason:
        "The interval search failed: the intervals.icu rate limit was reached.",
      candidates: 0,
      checked: 0,
      sessions: [],
    });
    expect(similar.this_session?.rep_count).toBe(5);
    expect(similar.search?.rep_time_min_s).toBe(225);
    expect(mockedGetActivitiesByIds).not.toHaveBeenCalled();
    expect(text).toContain(
      "Similar earlier sessions: unavailable. The interval search failed: the intervals.icu rate limit was reached.",
    );
    // The operator log keeps the raw message.
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("find sessions like activity i189757858"),
    );
    expect(
      IntervalAnalysisOutputSchema.safeParse(result.structuredContent).success,
    ).toBe(true);
    consoleError.mockRestore();
  });

  it("keeps the analysis when the bulk read fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    givenSource();
    mockedSearch.mockResolvedValue(searchRows);
    mockedGetActivitiesByIds.mockRejectedValue(
      handledNotFound("getActivitiesByIds for 8 ids"),
    );

    const { result, similar } = await run();

    expect(result.isError).toBeUndefined();
    expect(similar).toMatchObject({
      status: "unavailable",
      reason:
        "The candidate sessions could not be read: intervals.icu answered HTTP 404.",
      candidates: 8,
      checked: 0,
    });
    consoleError.mockRestore();
  });
});
