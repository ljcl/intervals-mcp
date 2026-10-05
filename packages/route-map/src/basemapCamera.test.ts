import { describe, expect, it, vi } from "vitest";
import { createBasemapCamera, describeZoom, isZoomedIn } from "./basemapCamera";

function fakeMap(zoom = 12) {
  const handlers: Record<string, Array<() => void>> = {};
  const map = {
    zoom,
    fitBounds: vi.fn(),
    getZoom: () => map.zoom,
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

describe("describeZoom", () => {
  it("names the whole route near 1x and the factor otherwise", () => {
    expect(describeZoom(1)).toBe("Showing the whole route");
    expect(describeZoom(1.02)).toBe("Showing the whole route");
    expect(describeZoom(0.5)).toBe("Showing the whole route");
    expect(describeZoom(3.2)).toBe("Zoomed to 3.2×");
  });
});

describe("isZoomedIn", () => {
  it("agrees with describeZoom's whole-route wording", () => {
    for (const factor of [0.5, 1, 1.02, 1.05, 1.4, 3.2]) {
      expect(isZoomedIn(factor)).toBe(
        describeZoom(factor) !== "Showing the whole route",
      );
    }
  });
});
