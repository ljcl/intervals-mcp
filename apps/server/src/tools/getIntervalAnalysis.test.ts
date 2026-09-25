/**
 * Handler tests for get-interval-analysis: dispatch-level, with
 * intervalsClient mocked. Classification and reconstruction math is covered
 * in intervalAnalysis.test.ts; these pin the fetch wiring (streams +
 * icu_intervals), cadence doubling, degradation paths, and text shape, using
 * the intervals.icu multi-lap fixtures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledNotFound, handledRateLimit } from "../__fixtures__";
import activityMultilap from "../__fixtures__/intervals/activity-multilap.json";
import activityMultilapIntervals from "../__fixtures__/intervals/activity-multilap-intervals.json";
import streamsMultilap from "../__fixtures__/intervals/streams-multilap.json";
import {
  getActivity,
  getActivityStreams,
  type IntervalsActivity,
  type IntervalsInterval,
  type IntervalsStream,
} from "../intervalsClient";
import { getIntervalAnalysisTool } from "./getIntervalAnalysis";
import { IntervalAnalysisOutputSchema } from "./outputs";

vi.mock("../intervalsClient", async () => {
  const actual =
    await vi.importActual<typeof import("../intervalsClient")>(
      "../intervalsClient",
    );
  return { ...actual, getActivity: vi.fn(), getActivityStreams: vi.fn() };
});

const mockedGetActivity = vi.mocked(getActivity);
const mockedGetActivityStreams = vi.mocked(getActivityStreams);

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
      { id: "i189757183" },
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
      { id: "i189757183" },
      "test-key",
    );

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      confidence: string;
      warnings: string[];
      rests: Array<{ duration_s: number }>;
    };
    expect(structured.rests.some((r) => r.duration_s >= 70)).toBe(true);
    // Derived moving found the stop, so this is not the "no moving stream"
    // low-confidence path; a lone unclassified stop still downgrades from
    // high.
    expect(structured.confidence).toBe("medium");
    expect(structured.warnings).toEqual([]);
  });

  it("requests the intervals.icu stream types and fetches icu_intervals via getActivity", async () => {
    mockedGetActivity.mockResolvedValue(multilapActivity);
    mockedGetActivityStreams.mockResolvedValue(multilapStreams);

    await getIntervalAnalysisTool.execute({ id: "i189757183" }, "test-key");

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
      { id: "i189757183" },
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
      { id: "i189757183" },
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
      { id: "i189757183" },
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
      { id: "i999" },
      "test-key",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not found");
  });
});
