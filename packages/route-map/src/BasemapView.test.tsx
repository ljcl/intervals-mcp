// @vitest-environment happy-dom
/**
 * The basemap style follows the host theme (#319): the map opens on the
 * theme's style, and a theme change swaps the style on the live map and puts
 * the overlays back once it loads. MapLibre is replaced by a fake that records
 * the calls and fires the events the test asks for.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loopActivity } from "./__fixtures__/routes";
import { storedRouteMap } from "./__fixtures__/storedRoute";
import {
  type BasemapEdit,
  type BasemapRouteOverlay,
  BasemapView,
  STYLE_URLS,
} from "./BasemapView";

type Handler = (...args: unknown[]) => void;

// Hoisted: the maplibre mock below is built before the module body runs.
const { FakeMap, maps } = vi.hoisted(() => {
  const maps: InstanceType<typeof FakeMap>[] = [];
  class FakeMap {
    style: string;
    setStyle = vi.fn();
    layers = new Set<string>();
    handlers = new Map<string, Handler[]>();
    constructor(options: { style: string }) {
      this.style = options.style;
      maps.push(this);
    }
    on(type: string, ...rest: unknown[]) {
      const handler = rest.at(-1) as Handler;
      if (rest.length === 1) {
        this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
      }
      return this;
    }
    once(type: string, handler: Handler) {
      const wrapped: Handler = (...args) => {
        this.handlers.set(
          type,
          (this.handlers.get(type) ?? []).filter((h) => h !== wrapped),
        );
        handler(...args);
      };
      return this.on(type, wrapped);
    }
    off(type: string, handler: Handler) {
      this.handlers.set(
        type,
        (this.handlers.get(type) ?? []).filter((h) => h !== handler),
      );
      return this;
    }
    /** What `queryRenderedFeatures` finds under the pointer. */
    features: Array<{ properties: Record<string, unknown> }> = [];
    queryRenderedFeatures() {
      return this.features;
    }
    fire(type: string, event?: unknown) {
      for (const handler of this.handlers.get(type) ?? []) handler(event);
    }
    addSource() {}
    addLayer(spec: { id: string }) {
      this.layers.add(spec.id);
    }
    getLayer(id: string) {
      return this.layers.has(id) ? { id } : undefined;
    }
    getSource() {
      return { setData() {} };
    }
    setLayoutProperty() {}
    isStyleLoaded() {
      return false;
    }
    getZoom() {
      return 12;
    }
    getBounds() {
      return {
        toArray: () => [
          [0, 0],
          [1, 1],
        ],
      };
    }
    getCanvas() {
      return document.createElement("canvas");
    }
    project() {
      return { x: 0, y: 0 };
    }
    fitBounds() {}
    remove() {}
  }
  return { FakeMap, maps };
});

vi.mock("maplibre-gl", () => ({
  setWorkerUrl: vi.fn(),
  Map: FakeMap,
  Popup: class {
    setLngLat() {
      return this;
    }
    setText() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
  },
}));
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?bundled-raw", () => ({
  default: "",
}));

let container: HTMLDivElement;
let root: Root;
const onFail = vi.fn();

async function setTheme(theme: "light" | "dark") {
  await act(async () => {
    document.documentElement.setAttribute("data-theme", theme);
    // Let useDocumentTheme's MutationObserver deliver.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  await act(async () => {
    root.render(
      <BasemapView
        accessibleLabel="Map"
        coordinates={loopActivity.coordinates}
        colorRuns={[]}
        splitMarkers={[]}
        waypointMarkers={[]}
        visibility={{ splits: true, waypoints: true }}
        mode="desktop"
        scrubIndex={null}
        onScrub={() => {}}
        onFail={onFail}
      />,
    );
  });
  return maps.at(-1)!;
}

beforeEach(() => {
  maps.length = 0;
  onFail.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

describe("BasemapView style", () => {
  it("opens on Liberty in a light host and the dark style in a dark one", async () => {
    await setTheme("light");
    expect((await render()).style).toBe(STYLE_URLS.light);
    await act(async () => root.unmount());
    root = createRoot(container);

    await setTheme("dark");
    expect((await render()).style).toBe(STYLE_URLS.dark);
  });

  it("swaps the style on a theme change and re-adds the overlays", async () => {
    await setTheme("light");
    const map = await render();
    await act(async () => map.fire("load"));
    expect(map.layers.has("track-line")).toBe(true);

    map.layers.clear(); // a new style starts without the overlays
    await setTheme("dark");
    expect(map.setStyle).toHaveBeenCalledExactlyOnceWith(STYLE_URLS.dark, {
      diff: false,
    });
    expect(maps).toHaveLength(1); // same map, so the camera stays

    await act(async () => map.fire("style.load"));
    expect(map.layers.has("track-line")).toBe(true);
    expect(map.layers.has("scrub")).toBe(true);
  });

  it("falls back to the grid when the dark style fails to load", async () => {
    await setTheme("light");
    const map = await render();
    await act(async () => map.fire("load"));

    await setTheme("dark");
    await act(async () => map.fire("error", { error: new Error("blocked") }));
    expect(onFail).toHaveBeenCalledOnce();
  });
});

describe("BasemapView with a stored route", () => {
  const edit = () => ({
    addMode: false,
    onPick: vi.fn(),
    onSelectVia: vi.fn(),
    onMoveVia: vi.fn(),
  });

  async function renderRoute(overlayEdit: BasemapEdit | null) {
    const route: BasemapRouteOverlay = {
      compare: storedRouteMap.coordinates.slice(0, 50),
      changed: { startIndex: 10, endIndex: 30 },
      vias: storedRouteMap.route!.vias,
      selectedViaId: null,
      edit: overlayEdit,
    };
    await act(async () => {
      root.render(
        <BasemapView
          accessibleLabel="Map"
          coordinates={storedRouteMap.coordinates}
          colorRuns={[]}
          splitMarkers={[]}
          waypointMarkers={[]}
          stretches={[
            {
              startIndex: 5,
              endIndex: 9,
              kind: "climb",
              color: "#ef4444",
              title: "Climb",
            },
          ]}
          route={route}
          visibility={{ splits: true, waypoints: true }}
          mode="desktop"
          scrubIndex={null}
          onScrub={() => {}}
          onFail={onFail}
        />,
      );
    });
    const map = maps.at(-1)!;
    await act(async () => map.fire("load"));
    return map;
  }

  const lngLat = (lat: number, lng: number) => ({ lat, lng });
  const event = (lat: number, lng: number) => ({
    point: { x: 1, y: 1 },
    lngLat: lngLat(lat, lng),
    preventDefault: vi.fn(),
  });

  it("adds the compare line, the changed halo, stretches and vias", async () => {
    const map = await renderRoute(null);
    for (const id of ["compare-line", "changed-halo", "stretches", "vias"])
      expect(map.layers.has(id)).toBe(true);
  });

  it("selects a tapped via point, and adds a point in add mode", async () => {
    const gestures = edit();
    const map = await renderRoute(gestures);

    map.features = [{ properties: { id: "v2" } }];
    await act(async () => map.fire("click", event(-33.86, 151.17)));
    expect(gestures.onSelectVia).toHaveBeenCalledWith("v2");

    await act(async () => root.unmount());
    root = createRoot(container);
    const adding = { ...edit(), addMode: true };
    const second = await renderRoute(adding);
    second.features = [];
    await act(async () => second.fire("click", event(-33.86, 151.17)));
    expect(adding.onPick).toHaveBeenCalledWith(-33.86, 151.17);
  });

  it("moves a dragged via point to where it is let go", async () => {
    const gestures = edit();
    const map = await renderRoute(gestures);
    map.features = [{ properties: { id: "v1" } }];
    const down = event(-33.8545, 151.152);
    await act(async () => map.fire("mousedown", down));
    expect(down.preventDefault).toHaveBeenCalled();
    await act(async () => map.fire("mousemove", event(-33.855, 151.153)));
    await act(async () => map.fire("mouseup", event(-33.855, 151.153)));
    expect(gestures.onMoveVia).toHaveBeenCalledWith("v1", -33.855, 151.153);
  });

  it("does not drag or select without edit gestures", async () => {
    const map = await renderRoute(null);
    map.features = [{ properties: { id: "v1" } }];
    const down = event(-33.8545, 151.152);
    await act(async () => map.fire("mousedown", down));
    expect(down.preventDefault).not.toHaveBeenCalled();
  });
});
