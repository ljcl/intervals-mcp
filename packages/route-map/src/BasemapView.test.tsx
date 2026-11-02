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
import { BasemapView, STYLE_URLS } from "./BasemapView";

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
