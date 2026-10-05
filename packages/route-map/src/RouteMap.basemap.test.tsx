// @vitest-environment happy-dom
/**
 * The glue between RouteMap and the basemap (#53): `set-viewport` and reset
 * reach the basemap camera as a `frame`, and the camera's reports feed the
 * live region and the model context. BasemapView is mocked to a probe that
 * captures its props, so no MapLibre map is created; the camera itself is
 * covered by `basemapCamera.test.ts`.
 */
import {
  type ModelContextApp,
  ViewToolRegistry,
  type ViewToolResult,
} from "@intervals-mcp/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamLoopActivity } from "./__fixtures__/routes";
import { type BasemapView } from "./BasemapView";
import { frameBoundsForRange, trackBounds } from "./basemapData";
import { RouteMap } from "./RouteMap";
import { indexRangeForDistance } from "./viewport";

type BasemapProps = Parameters<typeof BasemapView>[0];

const basemap = vi.hoisted(() => ({
  props: null as BasemapProps | null,
}));
vi.mock("./BasemapView", () => ({
  BasemapView: (props: BasemapProps) => {
    basemap.props = props;
    return null;
  },
}));

const DEBOUNCE_MS = 600;
const data = streamLoopActivity;
const distance = data.streams!.distance!;
const routeKm = (data.distance / 1000).toFixed(1);

function fakeApp(): ModelContextApp & { updates: string[] } {
  const updates: string[] = [];
  return {
    updates,
    getHostCapabilities: () => ({ updateModelContext: true }),
    updateModelContext: ({ content }) => {
      updates.push(content[0]!.text);
      return Promise.resolve(undefined);
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let app: ReturnType<typeof fakeApp>;
let registry: ViewToolRegistry;

async function render(basemapEnabled = true) {
  await act(async () => {
    root.render(
      <RouteMap
        data={data}
        app={app}
        viewToolRegistry={registry}
        basemapEnabled={basemapEnabled}
      />,
    );
  });
}

async function setViewport(
  args: Record<string, unknown>,
): Promise<ViewToolResult> {
  let result!: ViewToolResult;
  await act(async () => {
    result = await registry.invoke("set-viewport", args);
  });
  return result;
}

async function cameraReports(camera: {
  zoomFactor: number;
  bounds: [[number, number], [number, number]];
}) {
  await act(async () => {
    basemap.props!.onCamera!(camera);
  });
}

/** The model context as last reported, once the debounce has run. */
async function lastContext(): Promise<string | undefined> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  });
  return app.updates.at(-1);
}

const liveRegion = () =>
  container.querySelector("[aria-live='polite']")?.textContent;

/** Bounds of the 1.0 to 1.2 km stretch, as the tool frames it. */
const stretchBounds = frameBoundsForRange(
  data.coordinates,
  indexRangeForDistance(distance, 1000, 1200)!,
)!;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  basemap.props = null;
  app = fakeApp();
  registry = new ViewToolRegistry();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("RouteMap on the basemap", () => {
  it("frames the requested stretch on the basemap camera, not the grid", async () => {
    await render();
    expect(basemap.props).not.toBeNull();
    expect(basemap.props!.frame).toBeUndefined();

    const reply = await setViewport({ fromKm: 1, toKm: 1.2 });

    expect(reply).toEqual({ text: `Framed 1.0–1.2 km of ${data.name}.` });
    expect(basemap.props!.frame?.bounds).toEqual(stretchBounds);
    expect(container.querySelector("svg[aria-keyshortcuts]")).toBeNull();
  });

  it("frames the whole route on reset, with a fresh nonce", async () => {
    await render();
    await setViewport({ fromKm: 1, toKm: 1.2 });
    const first = basemap.props!.frame!.nonce;

    const reply = await setViewport({ reset: true });

    expect(reply).toEqual({
      text: `Showing the whole route (${routeKm} km).`,
    });
    expect(basemap.props!.frame?.bounds).toEqual(trackBounds(data.coordinates));
    expect(basemap.props!.frame!.nonce).toBeGreaterThan(first);
  });

  it("describes what the camera reports, in the live region and the model context", async () => {
    await render();

    await cameraReports({ zoomFactor: 6, bounds: stretchBounds });

    const said = liveRegion();
    expect(said).toMatch(/^Showing 1\.\d–1\.\d km of the route$/);
    expect(await lastContext()).toContain(` ${said}.`);
  });

  it("says whole route once the camera shows every point again", async () => {
    await render();
    await cameraReports({ zoomFactor: 6, bounds: stretchBounds });

    // A user zoom back out past the route, at a zoom the load-time fit would
    // call zoomed in: every point is in view, so it is the whole route.
    await cameraReports({
      zoomFactor: 1.2,
      bounds: [
        [-180, -85],
        [180, 85],
      ],
    });

    expect(liveRegion()).toBe("Showing the whole route");
    expect(await lastContext()).not.toContain("Showing");
  });

  it("starts the fallback grid from the whole route", async () => {
    await render();
    await setViewport({ fromKm: 1, toKm: 1.2 });
    await cameraReports({ zoomFactor: 6, bounds: stretchBounds });

    await act(async () => basemap.props!.onFail());

    expect(container.querySelector("svg[aria-keyshortcuts]")).not.toBeNull();
    expect(liveRegion()).toBe("");
    expect(await lastContext()).not.toContain("Showing");
  });
});

describe("RouteMap on the grid", () => {
  it("describes the stretch the viewBox shows, in the same words", async () => {
    await render(false);

    const reply = await setViewport({ fromKm: 1, toKm: 1.2 });

    expect(reply).toEqual({ text: `Framed 1.0–1.2 km of ${data.name}.` });
    expect(basemap.props).toBeNull();
    const said = liveRegion();
    expect(said).toMatch(/^Showing .*km of the route$/);
    expect(await lastContext()).toContain(` ${said}.`);
  });
});
