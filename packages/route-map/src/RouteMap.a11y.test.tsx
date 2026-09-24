/**
 * Static-markup assertions on the ARIA wiring (#62): the SVG grid's
 * title/desc pair and the basemap view's visually-hidden narration. SSR
 * render — effects never run, so no MapLibre map is created — but the
 * module-level worker setup still needs the maplibre imports mocked.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { loopActivity } from "./__fixtures__/routes";
import { RouteMap } from "./RouteMap";

vi.mock("maplibre-gl", () => ({
  setWorkerUrl: vi.fn(),
}));
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?bundled-raw", () => ({
  default: "",
}));

describe("RouteMap accessibility wiring", () => {
  it("labels and describes the SVG grid view via title and desc", () => {
    const markup = renderToStaticMarkup(
      <RouteMap data={loopActivity} basemapEnabled={false} />,
    );
    const [, labelledBy] = markup.match(/aria-labelledby="([^"]+)"/) ?? [];
    const [, describedBy] = markup.match(/aria-describedby="([^"]+)"/) ?? [];
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(markup).toContain(
      `<title id="${labelledBy}">Map of Golden Gate Park Loop, 8.23 kilometres</title>`,
    );
    expect(markup).toContain(
      `<desc id="${describedBy}">Map of Run activity &quot;Golden Gate Park Loop&quot;. 8.2 km with 96 m of climbing. A loop returning to its start,`,
    );
  });

  it("renders visually-hidden narration alongside the basemap canvas", () => {
    const markup = renderToStaticMarkup(
      <RouteMap data={loopActivity} basemapEnabled={true} />,
    );
    expect(markup).toMatch(
      /<p class="[^"]*srOnly[^"]*">Map of Run activity &quot;Golden Gate Park Loop&quot;\./,
    );
  });

  it("labels and describes the elevation strip", () => {
    const withAltitude = {
      ...loopActivity,
      streams: {
        altitude: loopActivity.coordinates.map((_, i) => 10 + i),
        distance: loopActivity.coordinates.map((_, i) => i * 400),
      },
    };
    const markup = renderToStaticMarkup(
      <RouteMap data={withAltitude} basemapEnabled={false} />,
    );
    expect(markup).toContain(
      'aria-label="Elevation profile of Golden Gate Park Loop"',
    );
    const [, stripDescribedBy] =
      markup.match(
        /aria-label="Elevation profile[^"]*" aria-describedby="([^"]+)"/,
      ) ?? [];
    expect(stripDescribedBy).toBeTruthy();
    expect(markup).toContain(
      `<desc id="${stripDescribedBy}">Altitude ranges from 10 m to ${10 + loopActivity.coordinates.length - 1} m over 8.2 km.</desc>`,
    );
  });
});
