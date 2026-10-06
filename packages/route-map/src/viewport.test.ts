import { describe, expect, it } from "vitest";
import { type ViewBox } from "./panZoom";
import {
  describeView,
  frameForIndexRange,
  gridViewForRange,
  indexRangeForDistance,
  visibleRoute,
} from "./viewport";

/** A 10 km course sampled every 100 m. */
const distance = Array.from({ length: 101 }, (_, i) => i * 100);

describe("indexRangeForDistance", () => {
  it("covers the samples inside the requested window", () => {
    expect(indexRangeForDistance(distance, 2000, 3000)).toEqual({
      from: 20,
      to: 30,
    });
  });

  it("accepts the window either way round", () => {
    expect(indexRangeForDistance(distance, 3000, 2000)).toEqual(
      indexRangeForDistance(distance, 2000, 3000),
    );
  });

  it("clamps a window that overhangs the end", () => {
    // "The last 5 km" of a 10 km course asked for loosely as 8–20 km.
    expect(indexRangeForDistance(distance, 8000, 20000)).toEqual({
      from: 80,
      to: 100,
    });
  });

  it("returns null for a window entirely past the finish", () => {
    // The caller says "this route is only 10 km" rather than silently
    // framing the finish as if the request had been satisfied.
    expect(indexRangeForDistance(distance, 15000, 20000)).toBeNull();
  });

  it("returns null for an empty distance stream", () => {
    expect(indexRangeForDistance([], 0, 1000)).toBeNull();
  });

  it("widens a window narrower than the sample spacing", () => {
    // A single point has no extent to frame; there must be a line to see.
    const range = indexRangeForDistance(distance, 2000, 2010)!;
    expect(range.to).toBeGreaterThan(range.from);
  });

  it("widens backwards at the very end, where there is no next sample", () => {
    const range = indexRangeForDistance(distance, 10000, 10000)!;
    expect(range.to).toBeGreaterThan(range.from);
    expect(range.to).toBe(100);
  });
});

describe("frameForIndexRange", () => {
  const base: ViewBox = { x: 0, y: 0, w: 400, h: 200 };
  /** Points marching left to right across the frame. */
  const points = Array.from({ length: 101 }, (_, i) => ({
    x: i * 4,
    y: 100,
  }));

  it("centres the framed stretch", () => {
    const view = frameForIndexRange(points, { from: 20, to: 30 }, base)!;
    // Points 20..30 span x 80..120, centre 100.
    expect(view.x + view.w / 2).toBeCloseTo(100, 5);
  });

  it("keeps the base aspect ratio so the stretch is not letterboxed", () => {
    const view = frameForIndexRange(points, { from: 20, to: 30 }, base)!;
    expect(view.w / view.h).toBeCloseTo(base.w / base.h, 5);
  });

  it("zooms in: a short stretch gets a smaller window than the whole frame", () => {
    const view = frameForIndexRange(points, { from: 20, to: 30 }, base)!;
    expect(view.w).toBeLessThan(base.w);
  });

  it("never escapes the base frame", () => {
    const view = frameForIndexRange(points, { from: 0, to: 3 }, base)!;
    expect(view.x).toBeGreaterThanOrEqual(base.x);
    expect(view.y).toBeGreaterThanOrEqual(base.y);
    expect(view.x + view.w).toBeLessThanOrEqual(base.x + base.w + 1e-6);
    expect(view.y + view.h).toBeLessThanOrEqual(base.y + base.h + 1e-6);
  });

  it("falls back to the deepest zoom for a stretch with no extent", () => {
    // A lap run on the spot projects to a single point.
    const stacked = [
      { x: 50, y: 50 },
      { x: 50, y: 50 },
    ];
    const view = frameForIndexRange(stacked, { from: 0, to: 1 }, base)!;
    expect(view.w).toBeCloseTo(base.w / 8, 5);
    expect(view.w).toBeGreaterThan(0);
  });

  it("returns null when the range selects nothing", () => {
    expect(frameForIndexRange([], { from: 0, to: 5 }, base)).toBeNull();
  });

  it("framing the whole course comes back to the base frame", () => {
    const view = frameForIndexRange(points, { from: 0, to: 100 }, base)!;
    expect(view.w).toBeCloseTo(base.w, 5);
  });
});

describe("gridViewForRange", () => {
  const base: ViewBox = { x: 0, y: 0, w: 400, h: 200 };
  const points = Array.from({ length: 101 }, (_, i) => ({ x: i * 4, y: 100 }));

  it("frames a stretch as frameForIndexRange does", () => {
    const range = { from: 20, to: 30 };
    expect(gridViewForRange(points, range, base)).toEqual(
      frameForIndexRange(points, range, base),
    );
  });

  it("maps a whole-route frame (no range) to the base view", () => {
    expect(gridViewForRange(points, null, base)).toEqual(base);
  });

  it("falls back to the base view when the range selects nothing", () => {
    expect(gridViewForRange([], { from: 0, to: 5 }, base)).toEqual(base);
  });
});

describe("visibleRoute", () => {
  /** Six points 1 km apart. */
  const km6 = [0, 1000, 2000, 3000, 4000, 5000];
  const only =
    (...indices: number[]) =>
    (i: number) =>
      indices.includes(i);

  it("is the whole route exactly when every point is in view", () => {
    expect(visibleRoute(6, () => true, km6)).toEqual({
      whole: true,
      stretches: [{ fromKm: 0, toKm: 5 }],
    });
    expect(visibleRoute(6, only(0, 1, 2, 3, 4), km6).whole).toBe(false);
  });

  it("names the stretch in view by km", () => {
    expect(visibleRoute(6, only(2, 3, 4), km6)).toEqual({
      whole: false,
      stretches: [{ fromKm: 2, toKm: 4 }],
    });
  });

  it("splits points in view into runs, in route order", () => {
    // Zoomed onto the start of a loop: its first and last kilometres are
    // both in view, the middle is not.
    expect(visibleRoute(6, only(0, 1, 4, 5), km6).stretches).toEqual([
      { fromKm: 0, toKm: 1 },
      { fromKm: 4, toKm: 5 },
    ]);
  });

  it("has no stretches when the route is out of view", () => {
    expect(visibleRoute(6, () => false, km6)).toEqual({
      whole: false,
      stretches: [],
    });
  });

  it("cannot measure stretches without a matching distance stream", () => {
    expect(visibleRoute(6, only(1), undefined)).toEqual({
      whole: false,
      stretches: null,
    });
    expect(visibleRoute(6, only(1), [0, 1000])).toEqual({
      whole: false,
      stretches: null,
    });
    expect(visibleRoute(6, () => true, undefined).whole).toBe(true);
  });
});

describe("describeView", () => {
  const stretch = (fromKm: number, toKm: number) => ({ fromKm, toKm });

  it("says whole route exactly when every point is in view, at any zoom", () => {
    const whole = { whole: true, stretches: [stretch(0, 10)] };
    expect(describeView(whole, 1)).toBe("Showing the whole route");
    // Reset after the frame was resized: zoomed relative to the load-time
    // fit, but still everything in view.
    expect(describeView(whole, 1.2)).toBe("Showing the whole route");
  });

  it("names the stretch in view", () => {
    expect(
      describeView({ whole: false, stretches: [stretch(12, 16)] }, 3.2),
    ).toBe("Showing 12.0–16.0 km of the route");
  });

  it("names a panned stretch at the whole-route zoom too", () => {
    expect(
      describeView({ whole: false, stretches: [stretch(0, 7.43)] }, 1),
    ).toBe("Showing 0.0–7.4 km of the route");
  });

  it("lists up to three stretches", () => {
    expect(
      describeView(
        { whole: false, stretches: [stretch(0, 0.5), stretch(9.5, 10)] },
        4,
      ),
    ).toBe("Showing 0.0–0.5 km and 9.5–10.0 km of the route");
    expect(
      describeView(
        {
          whole: false,
          stretches: [stretch(1, 2), stretch(4, 5), stretch(8, 9)],
        },
        2,
      ),
    ).toBe("Showing 1.0–2.0 km, 4.0–5.0 km and 8.0–9.0 km of the route");
  });

  it("summarises more stretches than that", () => {
    // A track session: the same oval lapped over and over.
    const laps = Array.from({ length: 6 }, (_, i) =>
      stretch(i * 0.4, i * 0.4 + 0.1),
    );
    expect(describeView({ whole: false, stretches: laps }, 2)).toBe(
      "Showing 6 stretches of the route between 0.0 and 2.1 km",
    );
  });

  it("names a stretch too short to show a range as one point", () => {
    expect(
      describeView({ whole: false, stretches: [stretch(3.21, 3.24)] }, 8),
    ).toBe("Showing 3.2 km of the route");
  });

  it("says when the route is out of view", () => {
    expect(describeView({ whole: false, stretches: [] }, 2)).toBe(
      "The route is out of view",
    );
  });

  it("falls back to the zoom factor without a distance stream", () => {
    expect(describeView({ whole: false, stretches: null }, 3.2)).toBe(
      "Zoomed to 3.2×",
    );
    expect(describeView({ whole: false, stretches: null }, 1)).toBe(
      "Showing part of the route",
    );
    expect(describeView({ whole: true, stretches: null }, 1)).toBe(
      "Showing the whole route",
    );
  });
});
