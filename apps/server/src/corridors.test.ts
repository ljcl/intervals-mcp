import { describe, expect, it } from "vitest";
import {
  chooseDirections,
  corridorHint,
  corridorKey,
  coveringRuns,
  followsCorridor,
  foundStretches,
  knownStretches,
  matchCorridor,
} from "./corridors";
import {
  cumulativeDistances,
  type LatLng,
  type RouteTrack,
} from "./mapAnchors";
import { reverseTrack } from "./routeGeometry";
import { lineFollowers } from "./routeScore";
import { type RunStart } from "./startClusters";

const LAT = -33.87;
const LNG = 151.18;
/** Degrees of longitude per metre at LAT. */
const DLNG = 1 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const DLAT = 1 / 110_540;

/** A line east from (LAT + north_m, LNG + from_m), every 5 m. */
function line(from_m: number, to_m: number, north_m = 0): RouteTrack {
  const coordinates: LatLng[] = [];
  for (let m = from_m; m <= to_m; m += 5)
    coordinates.push([LAT + north_m * DLAT, LNG + m * DLNG]);
  return {
    coordinates,
    distance: cumulativeDistances(coordinates),
    altitude: coordinates.map(() => null),
  };
}

function run(
  id: string,
  track: RouteTrack,
  date = `2026-10-${id.padStart(2, "0")}`,
): RunStart {
  return {
    id,
    date,
    name: `Run ${id}`,
    distance_m: track.distance.at(-1)!,
    climb_m: null,
    track,
  };
}

describe("corridor names", () => {
  const corridors = [{ name: "Glebe Foreshore" }, { name: "Bay Run" }];
  it("matches the same words in any case and spacing", () => {
    expect(corridorKey("glebe  Foreshore")).toBe(
      corridorKey("Glebe Foreshore"),
    );
    expect(matchCorridor("glebe foreshore", corridors)?.name).toBe(
      "Glebe Foreshore",
    );
  });
  it("needs every word", () => {
    expect(matchCorridor("Glebe", corridors)).toBeNull();
    expect(corridorHint("Glebe", corridors)?.name).toBe("Glebe Foreshore");
    expect(corridorHint("Glebe Point", corridors)).toBeNull();
  });
  it("never matches lat,lng", () => {
    expect(
      matchCorridor("-33.87,151.18", [{ name: "-33.87,151.18" }]),
    ).toBeNull();
  });
});

describe("knownStretches", () => {
  const known = (n: number) => Array<boolean>(n).fill(true);
  const unknown = (n: number) => Array<boolean>(n).fill(false);
  it("bridges a gap of 3 samples and splits at 4", () => {
    expect(
      knownStretches([...known(120), ...unknown(3), ...known(120)]),
    ).toEqual([[0, 2420]]);
    expect(
      knownStretches([...known(120), ...unknown(4), ...known(120)]),
    ).toEqual([
      [0, 1190],
      [1240, 2430],
    ]);
  });
  it("drops a stretch under 1 km", () => {
    expect(knownStretches([...known(90), ...unknown(10)])).toEqual([]);
  });
});

describe("foundStretches", () => {
  const near: LatLng = [LAT, LNG];
  const three = [
    run("3", line(0, 2000, 3)),
    run("2", line(0, 2000, -3)),
    run("1", line(0, 2000)),
  ];
  it("finds a line run 3 times, once, from the newest run", () => {
    const found = foundStretches(three, [], near);
    expect(found).toHaveLength(1);
    expect(found[0]!.activity_id).toBe("3");
    expect(found[0]!.length_m).toBeGreaterThan(1900);
    expect(found[0]!.runs).toBe(3);
  });
  it("needs 3 runs", () => {
    expect(foundStretches(three.slice(0, 2), [], near)).toEqual([]);
  });
  it("drops a stretch on a saved corridor, either way", () => {
    expect(foundStretches(three, [reverseTrack(line(0, 2000))], near)).toEqual(
      [],
    );
  });
  it("drops stretches far from near", () => {
    expect(foundStretches(three, [], [LAT + 0.1, LNG])).toEqual([]);
  });
});

describe("coveringRuns", () => {
  it("counts a reversed run, not a line 30 m away", () => {
    const corridor = line(0, 1000);
    const followers = lineFollowers([
      reverseTrack(line(0, 1000, 2)),
      line(0, 1000, 30),
      line(0, 1000),
    ]);
    expect(coveringRuns(corridor, followers)).toBe(2);
  });
});

describe("chooseDirections", () => {
  // A corridor east from 1 km to 2 km; point-to-point runs between 0 and 3 km.
  const corridor = { track: line(1000, 2000), one_way: false };
  const west: LatLng = [LAT, LNG];
  const east: LatLng = [LAT, LNG + 3000 * DLNG];
  it("enters at the nearer end", () => {
    // Stored: 1,000 + 1,000 m of joins; reversed: 2,000 + 2,000 m.
    expect(chooseDirections(west, [corridor], east)).toEqual([false]);
    expect(chooseDirections(east, [corridor], west)).toEqual([true]);
  });
  it("keeps a one-way corridor stored", () => {
    expect(
      chooseDirections(east, [{ ...corridor, one_way: true }], west),
    ).toEqual([false]);
  });
  it("keeps stored on a tie", () => {
    // A loop with one corridor: both ways add the same two joins.
    expect(chooseDirections(west, [corridor], west)).toEqual([false]);
  });
  it("leaves points alone", () => {
    expect(chooseDirections(west, [east, corridor], west)).toEqual([
      false,
      true,
    ]);
  });
});

describe("followsCorridor", () => {
  const corridor = line(500, 1500);
  const leg = {
    track: corridor,
    entry: corridor.coordinates[0]!,
    exit: corridor.coordinates.at(-1)!,
  };
  it("is true along the corridor", () => {
    expect(followsCorridor(line(0, 2000, 4), leg)).toBe(true);
  });
  it("is false when the run leaves it midway", () => {
    const off = line(0, 1000);
    const detour: LatLng[] = [
      ...off.coordinates,
      ...line(1000, 1500, 200).coordinates,
      [LAT, LNG + 1500 * DLNG],
    ];
    const track = {
      coordinates: detour,
      distance: cumulativeDistances(detour),
      altitude: detour.map(() => null),
    };
    expect(followsCorridor(track, leg)).toBe(false);
  });
});
