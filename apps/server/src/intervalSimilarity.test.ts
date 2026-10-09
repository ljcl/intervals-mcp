import { describe, expect, it } from "vitest";
import intervalSearchRows from "./__fixtures__/intervals/interval-search.json";
import { computeFade, type WorkRep } from "./intervalAnalysis";
import {
  pickCandidates,
  type RepStructure,
  repCountTolerance,
  sameRepStructure,
  sameSportFamily,
  similarSearchBand,
  summariseTypicalReps,
  typicalReps,
} from "./intervalSimilarity";

/** A lap rep with the fields the similarity rules read. */
function rep(
  movingTimeS: number,
  distanceM: number,
  avgHr: number | null = null,
  intensityPct: number | null = null,
): WorkRep {
  return {
    index: 0,
    startKm: 0,
    distanceM,
    movingTimeS,
    paceSecPerKm: Math.round((movingTimeS / distanceM) * 1000),
    avgHr,
    avgCadence: null,
    avgWatts: null,
    intensityPct,
  };
}

/** Reps numbered in order, as the analysis numbers them. */
const numbered = (reps: WorkRep[]) =>
  reps.map((r, i) => ({ ...r, index: i + 1 }));

describe("typicalReps", () => {
  it("drops a cool-down block that was read as a rep", () => {
    const reps = numbered([
      ...Array.from({ length: 10 }, (_, i) => rep(198 + i, 800)),
      rep(824, 2600),
    ]);
    expect(typicalReps(reps)).toEqual(reps.slice(0, 10));
  });

  it("keeps real reps that vary by up to 10%", () => {
    const reps = numbered([254, 263, 265, 268, 280].map((t) => rep(t, 1000)));
    expect(typicalReps(reps)).toEqual(reps);
  });

  it("finds no repeated rep length in a 200 s / 400 s pair", () => {
    // Each is 33% from the 300 s median.
    expect(typicalReps([rep(200, 800), rep(400, 1600)])).toEqual([]);
  });

  it("returns nothing for no reps", () => {
    expect(typicalReps([])).toEqual([]);
  });
});

describe("repCountTolerance", () => {
  it.each([
    [1, 2],
    [2, 2],
    [5, 2],
    [10, 4],
    [20, 8],
  ])("%i reps may differ by %i", (count, tolerance) => {
    expect(repCountTolerance(count)).toBe(tolerance);
  });
});

describe("similarSearchBand", () => {
  const kmReps = [280, 263, 268, 254, 265].map((t, i) =>
    rep(t, 1000, 170, [93, 95, 96, 97, 98][i]!),
  );

  it("widens the reps' time by 15% and their intensity by 5 points", () => {
    expect(similarSearchBand(kmReps)).toEqual({
      minSecs: 215,
      maxSecs: 322,
      minIntensity: 88,
      maxIntensity: 103,
      minReps: 3,
      maxReps: 7,
      limit: 100,
      intensityUsed: true,
    });
  });

  it("searches any intensity when a rep has none", () => {
    const band = similarSearchBand([
      ...kmReps.slice(0, 4),
      rep(265, 1000, 170, null),
    ]);
    expect(band).toMatchObject({
      minIntensity: 0,
      maxIntensity: 300,
      intensityUsed: false,
    });
  });

  it("never sends a negative intensity", () => {
    const band = similarSearchBand([
      rep(200, 800, null, 2),
      rep(200, 800, null, 4),
    ]);
    expect(band.minIntensity).toBe(0);
    expect(band.maxIntensity).toBe(9);
  });

  it("never asks for fewer than 2 reps", () => {
    const band = similarSearchBand([rep(200, 800), rep(202, 800)]);
    expect(band.minReps).toBe(2);
    expect(band.maxReps).toBe(4);
  });
});

describe("summariseTypicalReps", () => {
  it("takes pace from total time over total distance and HR time-weighted", () => {
    const reps = numbered([
      rep(200, 800, 170, 95),
      rep(300, 1000, null, 99),
      rep(100, 400, 180, 101),
    ]);
    const summary = summariseTypicalReps(reps);
    const fade = computeFade(reps)!;
    expect(summary).toEqual({
      repCount: 3,
      repTimeS: 200,
      repDistanceM: 800,
      // 600 s over 2,200 m.
      paceSecPerKm: 273,
      // (170 x 200 + 180 x 100) / 300: the rep with no HR is skipped.
      avgHr: 173,
      // (95 x 200 + 99 x 300 + 101 x 100) / 600.
      intensityPct: 98,
      paceDriftPct: fade.paceDriftPct,
      hrDriftBpm: fade.hrDriftBpm,
    });
  });

  it("has no HR or intensity when no rep has one", () => {
    const summary = summariseTypicalReps([rep(200, 800), rep(201, 800)]);
    expect(summary.avgHr).toBeNull();
    expect(summary.intensityPct).toBeNull();
    expect(summary.hrDriftBpm).toBeNull();
  });

  it("has no pace with no distance", () => {
    const summary = summariseTypicalReps([
      { ...rep(200, 800), distanceM: 0, paceSecPerKm: null },
      { ...rep(200, 800), distanceM: 0, paceSecPerKm: null },
    ]);
    expect(summary.paceSecPerKm).toBeNull();
    expect(summary.paceDriftPct).toBeNull();
  });
});

describe("sameRepStructure", () => {
  const structure = (repTimeS: number, repCount: number): RepStructure => ({
    repCount,
    repTimeS,
    repDistanceM: 1000,
    paceSecPerKm: 265,
    avgHr: 170,
    intensityPct: 98,
    paceDriftPct: 0,
    hrDriftBpm: 5,
  });
  const source = structure(200, 5);

  it("matches a rep time up to 15% away", () => {
    expect(sameRepStructure(structure(230, 5), source)).toBe(true);
    expect(sameRepStructure(structure(170, 5), source)).toBe(true);
    expect(sameRepStructure(structure(232, 5), source)).toBe(false);
  });

  it("matches a rep count within the tolerance", () => {
    expect(sameRepStructure(structure(200, 3), source)).toBe(true);
    expect(sameRepStructure(structure(200, 7), source)).toBe(true);
    expect(sameRepStructure(structure(200, 2), source)).toBe(false);
    expect(sameRepStructure(structure(200, 8), source)).toBe(false);
  });

  it("does not compare intensity", () => {
    expect(
      sameRepStructure({ ...structure(200, 5), intensityPct: 80 }, source),
    ).toBe(true);
  });
});

describe("sameSportFamily", () => {
  it.each([
    ["Run", "TrailRun", true],
    ["Run", "VirtualRun", true],
    ["TrailRun", "Run", true],
    ["Run", "Swim", false],
    ["Ride", "Ride", true],
    ["Ride", "VirtualRide", false],
    ["Run", null, false],
    ["Run", undefined, false],
  ])("%s and %s: %s", (source, candidate, expected) => {
    expect(sameSportFamily(source, candidate)).toBe(expected);
  });
});

describe("pickCandidates", () => {
  it("keeps earlier sessions of the same sport, newest first", () => {
    const { candidates, later, otherSport } = pickCandidates(
      intervalSearchRows,
      {
        id: "i189757858",
        startDateLocal: "2026-05-14T18:29:10",
        type: "Run",
      },
    );
    expect(candidates.map((row) => row.id)).toEqual([
      "i189757863",
      "i189757872",
      "i189757902",
      "i189758125",
      "i189758159",
      "i189758205",
      "i107333750",
      "i106852109",
    ]);
    // The source row itself is dropped and not counted.
    expect(later).toBe(3);
    expect(otherSport).toBe(1);
  });

  it("counts a row that starts at the same time as later", () => {
    const { candidates, later } = pickCandidates(
      [{ id: "i2", start_date_local: "2026-05-14T18:29:10", type: "Run" }],
      { id: "i1", startDateLocal: "2026-05-14T18:29:10", type: "Run" },
    );
    expect(candidates).toEqual([]);
    expect(later).toBe(1);
  });
});
