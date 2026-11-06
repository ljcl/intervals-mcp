// @vitest-environment happy-dom
/**
 * A stored route on the map: each section in its own colour with a legend
 * entry, the compared version dashed under the line with the changed part
 * marked, the warnings with their km, the version line, and via points.
 * The grid draws it; the basemap is a probe that captures its props, so the
 * map gestures (tap to add, drag to move) are driven through them.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  comparedStoredRouteMap,
  olderStoredRouteMap,
  storedRouteMap,
  warnedStoredRouteMap,
} from "./__fixtures__/storedRoute";
import { type BasemapView } from "./BasemapView";
import { RouteMap } from "./RouteMap";
import { type AmendOperation } from "./routeEdit";
import { SECTION_PALETTE } from "./routeLayers";
import { type RouteMapData } from "./types";
import { type RouteAmend } from "./useRouteAmend";

type BasemapProps = Parameters<typeof BasemapView>[0];
const basemap = vi.hoisted(() => ({ props: null as BasemapProps | null }));
vi.mock("./BasemapView", () => ({
  BasemapView: (props: BasemapProps) => {
    basemap.props = props;
    return null;
  },
}));

let container: HTMLDivElement;
let root: Root;

function fakeEdit() {
  return {
    busy: false,
    notice: null,
    amend: vi.fn<(op: AmendOperation) => void>(),
  } satisfies RouteAmend;
}

async function render(
  data: RouteMapData,
  options: { basemap?: boolean; routeEdit?: RouteAmend | null } = {},
) {
  await act(async () => {
    root.render(
      <RouteMap
        data={data}
        basemapEnabled={options.basemap ?? false}
        routeEdit={options.routeEdit ?? null}
      />,
    );
  });
}

const sectionPaths = () => [
  ...container.querySelectorAll("path[data-layer='section']"),
];

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  basemap.props = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("RouteMap with a stored route", () => {
  it("draws each section in its own colour, with a legend entry", async () => {
    await render(storedRouteMap);
    const segments = storedRouteMap.route!.segments;

    const paths = sectionPaths();
    expect(paths).toHaveLength(segments.length);
    expect(paths.map((p) => p.getAttribute("stroke"))).toEqual(
      segments.map((_, i) => SECTION_PALETTE[i % SECTION_PALETTE.length]!.css),
    );
    // Adjacent sections never share a colour.
    for (let i = 1; i < paths.length; i++) {
      expect(paths[i]!.getAttribute("stroke")).not.toBe(
        paths[i - 1]!.getAttribute("stroke"),
      );
    }

    const legend = container.querySelector("ul[aria-label='Route sections']");
    const items = [...legend!.querySelectorAll("li")].map((li) =>
      li.textContent?.trim(),
    );
    expect(items).toHaveLength(segments.length);
    expect(items[0]).toBe(
      `0.0–${segments[0]!.to_km.toFixed(1)} km · Rozelle to Iron Cove (routed)`,
    );
    expect(items[3]).toContain("Out and back over Anzac Bridge (out and back)");
  });

  it("shows the version, its change and the km markers", async () => {
    await render(storedRouteMap);
    expect(container.textContent).toContain("Version 3 of 3");
    expect(container.textContent).toContain("Added an out and back to Pyrmont");
    expect(container.textContent).toContain("Stored route · version 3 of 3");
    // The metric pills are for activities only.
    const pills = [...container.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(pills).not.toContain("Altitude");
    const titles = [...container.querySelectorAll("circle > title")].map(
      (t) => t.textContent,
    );
    expect(titles).toContain("1 km");
    expect(titles).toContain("12 km");
  });

  it("draws via points, a turnaround as a square", async () => {
    await render(storedRouteMap);
    const vias = [...container.querySelectorAll("g[data-via]")];
    expect(vias.map((g) => g.getAttribute("data-via"))).toEqual([
      "v1",
      "v2",
      "v3",
    ]);
    expect(vias[2]!.querySelector("rect")).not.toBeNull();
    expect(vias[0]!.querySelector("rect")).toBeNull();
    expect(vias[2]!.querySelector("title")?.textContent).toMatch(
      /^Turnaround \(v3\) · \d+\.\d km$/,
    );
  });

  it("highlights a stretch pin along the line", async () => {
    await render(storedRouteMap);
    const stretch = container.querySelector("path[data-layer='stretch']");
    expect(stretch?.querySelector("title")?.textContent).toMatch(
      /^Anzac Bridge climb \+35 m · \d+\.\d–\d+\.\d km$/,
    );
  });

  it("draws the compared version dashed and marks the change", async () => {
    await render(comparedStoredRouteMap);
    const compare = container.querySelector("path[data-layer='compare']");
    expect(compare?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(
      container.querySelector("path[data-layer='changed']"),
    ).not.toBeNull();

    const change = comparedStoredRouteMap.route!.compare!.change;
    const text = container.querySelector(
      "[data-testid='route-compare']",
    )?.textContent;
    expect(text).toBe(
      `Compared with version 2: version 3 is +${(change.distance_change_m / 1000).toFixed(1)} km against version 2; ${change.from_km.toFixed(1)}–${change.to_km.toFixed(1)} km changed.`,
    );
  });

  it("lists section and pin warnings with their km", async () => {
    await render(warnedStoredRouteMap);
    const items = [
      ...container.querySelectorAll("ul[aria-label='Route warnings'] li"),
    ].map((li) => li.textContent);
    const last = warnedStoredRouteMap.route!.segments[4]!;
    expect(items).toEqual([
      `${last.from_km.toFixed(1)}–${last.to_km.toFixed(1)} km` +
        "No altitude for this part, so its climb is not counted.",
      expect.stringContaining("Generated: the path share is an estimate."),
      'Pin "Water, Iron Cove" moved from km 5.6 (version 2) to km 6 (version 3).',
    ]);
  });

  it("narrates the sections and the version for a screen reader", async () => {
    await render(storedRouteMap);
    const desc = container.querySelector("svg[role='img'] desc")?.textContent;
    expect(desc).toMatch(
      /^Map of stored route "Rozelle, Bay Run and Pyrmont \(v3\)", version 3 of 3\./,
    );
    expect(desc).toContain("The line is coloured by section, 5 sections:");
    expect(desc).toContain("3 via points.");
  });

  it("shows edit controls only on the latest version with an edit wiring", async () => {
    await render(storedRouteMap);
    expect(container.textContent).not.toContain("Change this route");

    await render(storedRouteMap, { routeEdit: fakeEdit() });
    expect(container.textContent).toContain("Change this route");

    await render(olderStoredRouteMap, { routeEdit: fakeEdit() });
    expect(container.textContent).not.toContain("Change this route");
    expect(container.textContent).toContain(
      "Only the latest version (version 3) can be changed.",
    );
  });

  it("replaces a km range through a place", async () => {
    const edit = fakeEdit();
    await render(storedRouteMap, { routeEdit: edit });
    const inputs = [...container.querySelectorAll("input")];
    const field = (label: string) =>
      inputs.find((i) => i.closest("label")?.textContent?.startsWith(label))!;
    const type = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type(field("From km"), "3");
    await type(field("To km"), "4.5");
    await type(field("Through"), "Callan Park, Lilyfield");
    const replace = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Replace section",
    )!;
    expect(replace.disabled).toBe(false);
    // happy-dom does not submit a form on a submit button's click.
    await act(async () =>
      replace.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );

    expect(edit.amend).toHaveBeenCalledWith({
      op: "replace_section",
      from_km: 3,
      to_km: 4.5,
      through: "Callan Park, Lilyfield",
    });
  });

  it("refuses a range that runs backwards", async () => {
    await render(storedRouteMap, { routeEdit: fakeEdit() });
    const inputs = [...container.querySelectorAll("input[type='number']")];
    for (const [input, value] of [
      [inputs[0], "5"],
      [inputs[1], "4"],
    ] as const) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value);
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "The start km must be less than the end km.",
    );
  });

  describe("on the basemap", () => {
    it("draws sections, the compare line and the vias", async () => {
      await render(comparedStoredRouteMap, {
        basemap: true,
        routeEdit: fakeEdit(),
      });
      const props = basemap.props!;
      expect(props.colorRuns.map((r) => r.color)).toEqual(
        SECTION_PALETTE.slice(0, 5).map((c) => c.hex),
      );
      expect(props.route?.compare).toBe(
        comparedStoredRouteMap.route!.compare!.coordinates,
      );
      expect(props.route?.changed).toEqual({
        startIndex: comparedStoredRouteMap.route!.compare!.startIndex,
        endIndex: comparedStoredRouteMap.route!.compare!.endIndex,
      });
      expect(props.route?.vias.map((v) => v.id)).toEqual(["v1", "v2", "v3"]);
      expect(props.splitMarkers[0]?.label).toBe("1 km");
      expect(props.stretches).toHaveLength(1);
    });

    it("has no edit gestures without an edit wiring", async () => {
      await render(storedRouteMap, { basemap: true });
      expect(basemap.props?.route?.edit).toBeNull();
    });

    it("adds a point where the map is tapped, at the nearest km", async () => {
      const edit = fakeEdit();
      await render(storedRouteMap, { basemap: true, routeEdit: edit });
      const addPill = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Add point",
      )!;
      await act(async () => addPill.click());
      expect(basemap.props?.route?.edit?.addMode).toBe(true);

      // A point next to the track's 40th sample.
      const [lat, lng] = storedRouteMap.coordinates[40]!;
      await act(async () =>
        basemap.props?.route?.edit?.onPick(lat + 0.0001, lng),
      );
      const km = Math.round(storedRouteMap.streams!.distance![40]!) / 1000;
      expect(edit.amend).toHaveBeenCalledWith({
        op: "insert_via",
        km,
        place: `${(lat + 0.0001).toFixed(5)},${lng.toFixed(5)}`,
      });
      // One point per tap: add mode ends.
      expect(basemap.props?.route?.edit?.addMode).toBe(false);
    });

    it("moves a dragged via point to where it was let go", async () => {
      const edit = fakeEdit();
      await render(storedRouteMap, { basemap: true, routeEdit: edit });
      await act(async () =>
        basemap.props?.route?.edit?.onMoveVia("v1", -33.853216, 151.15),
      );
      expect(edit.amend).toHaveBeenCalledWith({
        op: "move_via",
        via_id: "v1",
        to: "-33.85322,151.15000",
      });
      expect(basemap.props?.route?.selectedViaId).toBe("v1");
    });

    it("removes the via point selected on the map", async () => {
      const edit = fakeEdit();
      await render(storedRouteMap, { basemap: true, routeEdit: edit });
      await act(async () => basemap.props?.route?.edit?.onSelectVia("v3"));
      const remove = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Remove v3",
      )!;
      await act(async () => remove.click());
      expect(edit.amend).toHaveBeenCalledWith({
        op: "remove_via",
        via_id: "v3",
      });
    });

    it("turns the gestures off while a change is with the server", async () => {
      await render(storedRouteMap, {
        basemap: true,
        routeEdit: { busy: true, notice: null, amend: vi.fn() },
      });
      expect(basemap.props?.route?.edit).toBeNull();
      expect(
        container.querySelector("fieldset")?.hasAttribute("disabled"),
      ).toBe(true);
    });
  });
});
