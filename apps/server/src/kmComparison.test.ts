import { describe, expect, it } from "vitest";
import { compareKmSplits, formatKmComparison } from "./kmComparison";
import { type Split } from "./splitAnalysis";

/** A full 1 km split at `pace` s/km (GAP `gap`, default the same) and `hr`. */
function split(
  index: number,
  pace: number | null,
  hr: number | null,
  overrides: Partial<Split> = {},
): Split {
  return {
    index,
    startM: (index - 1) * 1000,
    endM: index * 1000,
    distanceM: 1000,
    partial: false,
    movingTimeS: pace ?? 0,
    elapsedTimeS: pace ?? 0,
    paceSecPerKm: pace,
    gapPaceSecPerKm: pace,
    elevationChangeM: 0,
    avgGradePct: 0,
    avgHr: hr,
    avgCadence: null,
    avgWatts: null,
    ...overrides,
  };
}

const run = (hrs: Array<number | null>, pace = 300) =>
  hrs.map((hr, i) => split(i + 1, pace, hr));

describe("compareKmSplits", () => {
  it("pairs only the full km both runs covered", () => {
    const a = [
      ...run([150, 150, 150, 150]),
      split(5, 300, 150, { partial: true }),
    ];
    const b = run([155, 155, 155, 155, 155, 155]);
    const result = compareKmSplits(a, b, true);
    expect(result?.rows.map((r) => r.km)).toEqual([1, 2, 3, 4]);
    expect(result?.verdict).toBe("constant offset");
  });

  it("is null when the runs share no full km", () => {
    expect(
      compareKmSplits(
        [split(1, 300, 150, { partial: true })],
        run([150]),
        true,
      ),
    ).toBeNull();
  });

  it("uses moving pace when either run has no elevation data", () => {
    const a = [split(1, 300, 150, { gapPaceSecPerKm: 280 })];
    const b = [split(1, 300, 150, { gapPaceSecPerKm: null })];
    const gap = compareKmSplits(a, a, true);
    const pace = compareKmSplits(a, b, false);
    expect(gap?.basis).toBe("gap");
    expect(pace?.basis).toBe("pace");
    // 1000 m / 300 s = 200 m/min, over 150 bpm.
    expect(pace?.rows[0]?.efficiency_1).toBe(1.333);
  });

  it("gives no verdict with fewer than 3 km of heart rate in both runs", () => {
    const result = compareKmSplits(
      run([150, null, 150, null]),
      run([160, 160, null, 160]),
      true,
    );
    expect(result?.rows).toHaveLength(4);
    expect(result?.rows[1]?.hr_delta_bpm).toBeNull();
    expect(result?.rows[1]?.efficiency_delta_pct).toBeNull();
    expect(result?.verdict).toBeNull();
    expect(result?.interpretation).toBe(
      "No verdict: fewer than 3 full km have heart rate in both runs after the warm-up (km 1 to 1 left out).",
    );
  });

  it("calls a slower but proportionally lower heart rate no difference at all", () => {
    // 10% lower speed (3.0 m/s against 3.33) at 10% lower HR: the same
    // metres per beat.
    const result = compareKmSplits(
      run([150, 150, 150, 150]),
      run([135, 135, 135, 135], 1000 / 3),
      true,
    );
    expect(result?.rows[0]?.pace_delta_sec_per_km).toBe(33);
    expect(result?.rows[0]?.efficiency_delta_pct).toBe(0);
    expect(result?.verdict).toBe("constant offset");
  });

  it("calls a change of 3 points or more in the fitted efficiency gap growing drift, and less a constant offset", () => {
    // Activity 1 drifts: its HR climbs 3 bpm a km while activity 2 holds.
    const drifting = compareKmSplits(
      run([150, 153, 156, 159, 162]),
      run([150, 150, 150, 150, 150]),
      true,
    );
    expect(drifting?.verdict).toBe("growing drift");
    expect(drifting?.efficiency_gap_first_km_pct).toBeLessThan(3);
    expect(drifting?.efficiency_gap_last_km_pct).toBeGreaterThan(7);
    expect(drifting?.interpretation).toContain(
      "Activity 1 lost efficiency as the run went on",
    );

    const steady = compareKmSplits(
      run([150, 150, 150, 150, 150]),
      run([152, 151, 153, 152, 154]),
      true,
    );
    expect(steady?.verdict).toBe("constant offset");
  });

  it("fits the line against the km number, so a km without HR does not shift the rest", () => {
    const result = compareKmSplits(
      run([150, null, 150, 150, 150, 150]),
      run([150, 160, 154, 156, 158, 160]),
      true,
    );
    // Fit from km 3 (km 1 is warm-up, km 2 has no HR): +4 a km 3, +10 at km 6.
    expect(result?.hr_gap_first_km_bpm).toBe(4);
    expect(result?.hr_gap_last_km_bpm).toBe(10);
  });

  it("leaves a cold first km out of the fit, so a warm-up gap reads as a constant offset (#299)", () => {
    for (const km of [10, 5]) {
      const cold = run([135, ...Array(km - 1).fill(150)]);
      const warm = run([148, ...Array(km - 1).fill(150)]);
      const result = compareKmSplits(cold, warm, true);
      expect(result?.verdict).toBe("constant offset");
      expect(result?.rows).toHaveLength(km);
      expect(result?.rows[0]?.hr_delta_bpm).toBe(13);
      expect(result?.interpretation).toContain(
        "from km 2, the warm-up km 1 to 1 left out",
      );
    }
  });

  it("still reads a drift that starts at km 3 as growing drift", () => {
    const hrs = [150, 150, 150, 154, 158, 162, 166, 170];
    const result = compareKmSplits(run(hrs), run(Array(8).fill(150)), true);
    expect(result?.verdict).toBe("growing drift");
    expect(result?.interpretation).toContain("from km 2");
  });

  it("leaves out the km that cover the larger warm-up", () => {
    // 600 s warm-up at 300 s/km: km 1-2 are warm-up, the fit starts at km 3.
    const result = compareKmSplits(
      run([130, 140, 150, 150, 150, 150]),
      run([148, 148, 150, 150, 150, 150]),
      true,
      600,
    );
    expect(result?.verdict).toBe("constant offset");
    expect(result?.interpretation).toContain(
      "from km 3, the warm-up km 1 to 2 left out",
    );
    // A warm-up shorter than km 1 still leaves out km 1.
    expect(
      compareKmSplits(
        run([150, 150, 150, 150]),
        run([150, 150, 150, 150]),
        true,
        60,
      )?.interpretation,
    ).toContain("from km 2");
  });

  it("gives no verdict when the warm-up leaves fewer than 3 km to fit", () => {
    const result = compareKmSplits(
      run([150, 150, 150]),
      run([150, 150, 150]),
      true,
    );
    expect(result?.rows).toHaveLength(3);
    expect(result?.verdict).toBeNull();
    expect(result?.interpretation).toBe(
      "No verdict: fewer than 3 full km have heart rate in both runs after the warm-up (km 1 to 1 left out).",
    );
  });
});

describe("formatKmComparison", () => {
  it("prints one row per km and the verdict, with n/a for a missing value", () => {
    const result = compareKmSplits(
      run([150, null, 150, 150, 150]),
      run([155, 155, 155, 155, 155]),
      false,
    )!;
    const lines = formatKmComparison(result);
    expect(lines[0]).toBe(
      "Per km at the same distance (activity 2 minus activity 1; efficiency on moving pace):",
    );
    expect(lines[1]).toBe(
      "  1.   pace 5:00 vs 5:00 (0 s), HR 150 vs 155 (+5), efficiency -3.2%",
    );
    expect(lines[2]).toBe(
      "  2.   pace 5:00 vs 5:00 (0 s), HR n/a vs 155 (n/a), efficiency n/a",
    );
    expect(lines.at(-1)).toMatch(/^Verdict: Constant offset: /);
  });
});
