import { describe, expect, it } from "vitest";
import { nearestPointIndex, projectRoute } from "./normalize";

const OPTS = { width: 600, height: 400, padding: 20 };

describe("projectRoute", () => {
  it("returns null for an empty path", () => {
    expect(projectRoute([], OPTS)).toBeNull();
  });

  it("keeps every point inside the padded frame", () => {
    const coords: Array<[number, number]> = [
      [37.81, -122.48],
      [37.82, -122.46],
      [37.8, -122.45],
      [37.79, -122.47],
      [37.81, -122.48],
    ];
    const projected = projectRoute(coords, OPTS)!;
    expect(projected).not.toBeNull();
    for (const p of projected.points) {
      expect(p.x).toBeGreaterThanOrEqual(OPTS.padding - 0.01);
      expect(p.x).toBeLessThanOrEqual(OPTS.width - OPTS.padding + 0.01);
      expect(p.y).toBeGreaterThanOrEqual(OPTS.padding - 0.01);
      expect(p.y).toBeLessThanOrEqual(OPTS.height - OPTS.padding + 0.01);
    }
  });

  it("starts the path with a moveto and exposes start/end", () => {
    const coords: Array<[number, number]> = [
      [10, 20],
      [10.1, 20.1],
      [10.2, 20.0],
    ];
    const projected = projectRoute(coords, OPTS)!;
    expect(projected.path.startsWith("M")).toBe(true);
    expect(projected.path).toContain("L");
    expect(projected.start).toEqual(projected.points[0]);
    expect(projected.end).toEqual(
      projected.points[projected.points.length - 1],
    );
  });

  it("flips latitude so the northern-most point is at the top", () => {
    const coords: Array<[number, number]> = [
      [10, 0], // south
      [20, 0], // north
    ];
    const projected = projectRoute(coords, OPTS)!;
    const [south, north] = projected.points;
    expect(north!.y).toBeLessThan(south!.y);
  });

  it("centres a horizontal route within the frame height", () => {
    // A due-east line has zero north–south span, so it must be vertically
    // centred rather than scaled to fill the frame.
    const coords: Array<[number, number]> = [
      [0, 0],
      [0, 1],
      [0, 2],
    ];
    const projected = projectRoute(coords, OPTS)!;
    for (const p of projected.points) {
      expect(p.y).toBeCloseTo(OPTS.height / 2, 5);
    }
  });

  it("does not throw on a single point", () => {
    const projected = projectRoute([[45, -73]], OPTS)!;
    expect(projected.points).toHaveLength(1);
    expect(projected.start).toEqual(projected.end);
  });

  it("finds the nearest projected point for a pointer position", () => {
    const points = [
      { x: 10, y: 10 },
      { x: 100, y: 10 },
      { x: 100, y: 100 },
    ];
    expect(nearestPointIndex(points, 12, 8)).toBe(0);
    expect(nearestPointIndex(points, 90, 30)).toBe(1);
    expect(nearestPointIndex(points, 105, 95)).toBe(2);
    expect(nearestPointIndex([], 0, 0)).toBe(-1);
  });

  it("preserves aspect ratio (no east–west stretch)", () => {
    // A square in lat/lng near the equator should stay roughly square once
    // projected, because longitude is cos-scaled and the fit is uniform.
    const coords: Array<[number, number]> = [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ];
    const projected = projectRoute(coords, OPTS)!;
    const xs = projected.points.map((p) => p.x);
    const ys = projected.points.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    expect(w).toBeCloseTo(h, 1);
  });
});

describe("projection frame", () => {
  const OPTS_ = { width: 640, height: 380, padding: 28 };
  const coords: Array<[number, number]> = [
    [-33.8625, 151.1715],
    [-33.866, 151.153],
    [-33.8545, 151.152],
  ];

  it("maps a viewBox point back to its lat/lng", () => {
    const projected = projectRoute(coords, OPTS_)!;
    for (const pair of coords) {
      const [lat, lng] = projected.frame.unproject(
        projected.frame.project(pair),
      );
      expect(lat).toBeCloseTo(pair[0], 9);
      expect(lng).toBeCloseTo(pair[1], 9);
    }
  });

  it("fits extra points in the same frame", () => {
    const far: Array<[number, number]> = [[-33.9, 151.25]];
    const alone = projectRoute(coords, OPTS_)!;
    const shared = projectRoute(coords, OPTS_, far)!;
    expect(shared.points).not.toEqual(alone.points);
    const p = shared.frame.project(far[0]!);
    expect(p.x).toBeLessThanOrEqual(OPTS_.width - OPTS_.padding + 1e-9);
    expect(p.y).toBeLessThanOrEqual(OPTS_.height - OPTS_.padding + 1e-9);
  });
});
