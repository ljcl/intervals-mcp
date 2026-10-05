import { describe, expect, it, vi } from "vitest";
import { createBasemapCamera } from "./basemapCamera";

function fakeMap(zoom = 12) {
  const handlers: Record<string, Array<() => void>> = {};
  const map = {
    zoom,
    bounds: [
      [151.2, -33.87],
      [151.22, -33.85],
    ] as [[number, number], [number, number]],
    fitBounds: vi.fn(),
    getZoom: () => map.zoom,
    getBounds: () => ({ toArray: () => map.bounds }),
    on: (type: string, fn: () => void) => {
      handlers[type] = [...(handlers[type] ?? []), fn];
    },
    fire: (type: string) => {
      for (const fn of handlers[type] ?? []) fn();
    },
  };
  return map;
}

describe("createBasemapCamera", () => {
  it("holds a frame until load, then fits once", () => {
    const map = fakeMap();
    const camera = createBasemapCamera(map, () => {});
    camera.frame({
      bounds: [
        [1, 2],
        [3, 4],
      ],
      nonce: 1,
    });
    expect(map.fitBounds).not.toHaveBeenCalled();
    map.fire("load");
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [1, 2],
        [3, 4],
      ],
      { padding: 36, maxZoom: 17 },
    );
  });

  it("keeps only the latest frame sent before load", () => {
    const map = fakeMap();
    const camera = createBasemapCamera(map, () => {});
    camera.frame({
      bounds: [
        [1, 2],
        [3, 4],
      ],
      nonce: 1,
    });
    camera.frame({
      bounds: [
        [5, 6],
        [7, 8],
      ],
      nonce: 2,
    });
    map.fire("load");
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [5, 6],
        [7, 8],
      ],
      expect.anything(),
    );
  });

  it("applies each nonce once", () => {
    const map = fakeMap();
    const camera = createBasemapCamera(map, () => {});
    map.fire("load");
    const frame = {
      bounds: [
        [1, 2],
        [3, 4],
      ] as [[number, number], [number, number]],
      nonce: 1,
    };
    camera.frame(frame);
    camera.frame(frame);
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    // The same stretch asked for again carries a new nonce, so it still moves.
    camera.frame({ ...frame, nonce: 2 });
    expect(map.fitBounds).toHaveBeenCalledTimes(2);
  });

  it("reports zoom relative to the whole-route fit", () => {
    const map = fakeMap(12);
    const seen: number[] = [];
    createBasemapCamera(map, ({ zoomFactor }) => seen.push(zoomFactor));
    map.fire("load");
    map.zoom = 14;
    map.fire("moveend");
    expect(seen.at(-1)).toBe(4);
  });

  it("reports the bounds in view as plain numbers", () => {
    const map = fakeMap();
    const seen: Array<[[number, number], [number, number]]> = [];
    createBasemapCamera(map, ({ bounds }) => seen.push(bounds));
    map.fire("load");
    // A pan moves the bounds at the same zoom.
    map.bounds = [
      [151.25, -33.9],
      [151.27, -33.88],
    ];
    map.fire("moveend");
    expect(seen).toEqual([
      [
        [151.25, -33.9],
        [151.27, -33.88],
      ],
    ]);
  });

  it("captures the fit zoom before a pending frame moves the camera", () => {
    const map = fakeMap(12);
    const seen: number[] = [];
    const camera = createBasemapCamera(map, ({ zoomFactor }) =>
      seen.push(zoomFactor),
    );
    camera.frame({
      bounds: [
        [1, 2],
        [3, 4],
      ],
      nonce: 1,
    });
    map.fitBounds.mockImplementation(() => {
      map.zoom = 13;
    });
    map.fire("load");
    map.fire("moveend");
    expect(seen).toEqual([2]);
  });

  it("reports nothing before load", () => {
    const map = fakeMap();
    const seen: number[] = [];
    createBasemapCamera(map, ({ zoomFactor }) => seen.push(zoomFactor));
    map.fire("moveend");
    expect(seen).toEqual([]);
  });
});
