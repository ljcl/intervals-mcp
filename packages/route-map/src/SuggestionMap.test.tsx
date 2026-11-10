// @vitest-environment happy-dom
import { type ModelContextApp, ViewToolRegistry } from "@intervals-mcp/ui";
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
    suggestion,
  }: {
    data: { name: string };
    beforeMap?: ReactNode;
    suggestion?: { option: number; count: number };
  }) => (
    <div>
      {beforeMap}
      <div data-testid="map">{data.name}</div>
      <div data-testid="position">
        {suggestion?.option} of {suggestion?.count}
      </div>
    </div>
  ),
}));

let container: HTMLElement;
let root: Root;
let registry: ViewToolRegistry;
let updates: string[];
const app: ModelContextApp = {
  getHostCapabilities: () => ({ updateModelContext: true }),
  updateModelContext: ({ content }) => {
    updates.push(content[0]!.text);
    return Promise.resolve(undefined);
  },
};

async function mount(data: RouteSuggestionsData) {
  await act(async () => {
    root.render(
      <SuggestionMap
        data={data}
        app={app}
        viewToolRegistry={registry}
        basemapEnabled={false}
      />,
    );
  });
}

const PILL_1 = awaySuggestions.candidates[0]!.label;
const PILL_2 = awaySuggestions.candidates[1]!.label;
const position = () =>
  container.querySelector("[data-testid=position]")?.textContent;

const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === name,
  )!;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  registry = new ViewToolRegistry();
  updates = [];
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
    expect(button(PILL_1).getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain(
      "via The Embarcadero, Marina Green",
    );
    expect(container.textContent).toContain(awaySuggestions.startLabel);
    expect(container.textContent).toContain("Elevation unavailable");
    expect(container.querySelector("[data-testid=map]")?.textContent).toBe(
      "SF: New loop",
    );

    await act(async () => button(PILL_2).click());
    expect(container.textContent).toContain("via Bay Trail, Crissy Field");
    expect(container.querySelector("[data-testid=map]")?.textContent).toBe(
      "SF: New loop 2",
    );
  });

  it("shows the selected route's numbers as the text gives them", async () => {
    await mount(awaySuggestions);
    const text = () => container.textContent ?? "";
    expect(text()).toContain("6.0 km planned");
    expect(text()).toContain(`from ${awaySuggestions.startLabel} (given)`);
    expect(text()).toContain("6.1 km (+0.1)");
    expect(text()).toContain("25 m, 4.2 m/km");
    expect(text()).toContain("62%");
    expect(text()).toContain("1.4/km");
    expect(text()).toContain("Score lost: crossings 8, main roads 6.");

    await act(async () => button(PILL_2).click());
    expect(text()).toContain("5.8 km (-0.2)");
    expect(text()).toContain("2.2/km");
    expect(text()).not.toContain("1.4/km");
    expect(text()).toContain("Retraces 0.4 km along the Marina Green path.");
  });

  it("switches the route on select-route and says which it shows", async () => {
    await mount(awaySuggestions);
    expect(position()).toBe("1 of 2");

    let result!: Awaited<ReturnType<ViewToolRegistry["invoke"]>>;
    await act(async () => {
      result = await registry.invoke("select-route", { option: 2 });
    });

    expect(result).toEqual({ text: `Showing route 2 of 2: ${PILL_2}.` });
    expect(position()).toBe("2 of 2");
    expect(button(PILL_2).getAttribute("aria-pressed")).toBe("true");
  });

  it("refuses a select-route option that is not on the list", async () => {
    await mount(awaySuggestions);
    const result = await registry.invoke("select-route", { option: 3 });
    expect(result).toEqual({
      text: "Pass option 1 to 2: there are 2 suggested routes.",
      isError: true,
    });
    expect(position()).toBe("1 of 2");
  });

  it("tells the model why there is no route", async () => {
    vi.useFakeTimers();
    try {
      await mount({
        ...awaySuggestions,
        candidates: [],
        warnings: ["No new loop close to 6.0 km was found."],
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(updates).toEqual([
      `No suggested route to show for planned run "${awaySuggestions.name}" on ${awaySuggestions.date}. No new loop close to 6.0 km was found.`,
    ]);
  });

  it("shows an argument error under the card header, with no retry", async () => {
    await mount({
      source: "suggestion",
      date: null,
      name: "Route suggestions",
      startLabel: null,
      startSource: null,
      endLabel: null,
      distance_m: null,
      routesNote: null,
      candidates: [],
      warnings: ['No place matched "Nowhere Park".'],
    });
    expect(container.querySelector("h2")?.textContent).toBe(
      "Route suggestions",
    );
    expect(container.textContent).toContain('No place matched "Nowhere Park".');
    expect(container.textContent).toContain("No route to suggest.");
    expect(container.querySelector("button")).toBeNull();
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
