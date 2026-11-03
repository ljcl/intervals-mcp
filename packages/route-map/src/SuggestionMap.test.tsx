// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaySuggestions } from "./__fixtures__/suggestions";
import { SuggestionMap } from "./SuggestionMap";
import { type RouteSuggestionsData } from "./types";

// The picker is under test, not the map: a probe records which route it got.
vi.mock("./RouteMap", () => ({
  RouteMap: ({
    data,
    beforeMap,
  }: {
    data: { name: string };
    beforeMap?: ReactNode;
  }) => (
    <div>
      {beforeMap}
      <div data-testid="map">{data.name}</div>
    </div>
  ),
}));

let container: HTMLElement;
let root: Root;

async function mount(data: RouteSuggestionsData) {
  await act(async () => {
    root.render(<SuggestionMap data={data} basemapEnabled={false} />);
  });
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === name,
  )!;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SuggestionMap", () => {
  it("shows one pill per candidate and switches the summary and map", async () => {
    await mount({ ...awaySuggestions, warnings: ["Elevation unavailable"] });
    expect(container.querySelectorAll("button")).toHaveLength(2);
    expect(button("New loop").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain(
      "via The Embarcadero, Marina Green",
    );
    expect(container.textContent).toContain(awaySuggestions.startLabel);
    expect(container.textContent).toContain("Elevation unavailable");
    expect(container.querySelector("[data-testid=map]")?.textContent).toBe(
      "SF: New loop",
    );

    await act(async () => button("New loop 2").click());
    expect(container.textContent).toContain("via Bay Trail, Crissy Field");
    expect(container.querySelector("[data-testid=map]")?.textContent).toBe(
      "SF: New loop 2",
    );
  });

  it("shows an empty state with no candidates", async () => {
    await mount({ ...awaySuggestions, candidates: [] });
    expect(container.textContent).toMatch(/No route to suggest/);
    expect(container.querySelector("[data-testid=map]")).toBeNull();
  });

  it("keeps the card header, context and warnings above the empty state", async () => {
    const warning = "No new loop close to 6.0 km was found from this start.";
    await mount({ ...awaySuggestions, candidates: [], warnings: [warning] });
    const heading = container.querySelector("h2");
    expect(heading?.textContent).toBe(awaySuggestions.name);
    expect(container.textContent).toContain("Suggested route");
    expect(container.textContent).toContain(awaySuggestions.startLabel);
    const text = container.textContent ?? "";
    expect(text.indexOf(warning)).toBeGreaterThan(-1);
    expect(text.indexOf(warning)).toBeLessThan(
      text.indexOf("No route to suggest"),
    );
  });

  it("shows an empty state for a payload without candidates", async () => {
    await mount({
      source: "suggestion",
      date: "2026-10-20",
      name: "Run",
    } as RouteSuggestionsData);
    expect(container.textContent).toMatch(/No route to suggest/);
  });

  it("renders without warnings", async () => {
    const { warnings: _w, ...rest } = awaySuggestions;
    await mount(rest as RouteSuggestionsData);
    expect(container.querySelectorAll("button")).toHaveLength(2);
  });
});
