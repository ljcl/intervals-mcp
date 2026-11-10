import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect } from "storybook/test";
import {
  awaySuggestions,
  homeSuggestions,
  pastRunsOnlySuggestions,
  warnedSuggestions,
} from "./__fixtures__/suggestions";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { SuggestionMap } from "./SuggestionMap";

const meta = preview.meta({ component: SuggestionMap });

const [first, second] = awaySuggestions.candidates;

export const AwayCandidates = meta.story({
  args: { data: awaySuggestions, basemapEnabled: false },
  play: async ({ canvas, userEvent }) => {
    // The card header comes before the picker.
    const title = canvas.getByText("SF: New loop");
    const pill = canvas.getByRole("button", { name: first!.label });
    await expect(
      title.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expect(canvas.getByText("6.1 km (+0.1)")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: second!.label }));
    await expect(canvas.getByText("via Bay Trail, Crissy Field")).toBeVisible();
    await expect(canvas.getByText("5.8 km (-0.2)")).toBeVisible();
  },
});

export const MobileAwayCandidates = meta.story({
  args: { data: awaySuggestions, mode: "mobile", basemapEnabled: false },
  globals: { viewport: { value: "claudeIosCard" } },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});

export const DarkAwayCandidates = meta.story({
  args: { data: awaySuggestions, basemapEnabled: false },
  globals: darkGlobals,
});

export const HomeCandidates = meta.story({
  args: { data: homeSuggestions, basemapEnabled: false },
});

export const WarningsBesideRoutes = meta.story({
  args: { data: warnedSuggestions, basemapEnabled: false },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("button", { name: first!.label }),
    ).toBeVisible();
    for (const warning of warnedSuggestions.warnings)
      await expect(canvas.getByText(warning)).toBeVisible();
  },
});

export const MobileWarningsBesideRoutes = meta.story({
  args: { data: warnedSuggestions, mode: "mobile", basemapEnabled: false },
  globals: { viewport: { value: "claudeIosCard" } },
  parameters: { layout: "fullscreen" },
  decorators: [
    (StoryFn) => (
      <MobileCardShell>
        <StoryFn />
      </MobileCardShell>
    ),
  ],
});

export const PastRunsOnly = meta.story({
  args: { data: pastRunsOnlySuggestions, basemapEnabled: false },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/New routes need ORS_API_KEY/)).toBeVisible();
    await expect(canvas.getByText(/\(HOME_START\)/)).toBeVisible();
    await expect(
      canvas.getByText("Only 1 route: 1 past run fit."),
    ).toBeVisible();
  },
});

export const NoCandidates = meta.story({
  args: {
    data: {
      ...awaySuggestions,
      candidates: [],
      warnings: ["No new loop close to 6.0 km was found from this start."],
    },
    basemapEnabled: false,
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("heading", { name: awaySuggestions.name }),
    ).toBeVisible();
    await expect(canvas.getByText(/No new loop close/)).toBeVisible();
  },
});

/** An argument the athlete must change: a message under the header, no retry. */
export const ArgumentError = meta.story({
  args: {
    data: {
      source: "suggestion",
      date: null,
      name: "Route suggestions",
      startLabel: null,
      startSource: null,
      endLabel: null,
      distance_m: null,
      routesNote: null,
      candidates: [],
      warnings: [
        'No place matched "Nowhere Park". Add the suburb or city, or pass lat,lng.',
      ],
    },
    basemapEnabled: false,
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("heading", { name: "Route suggestions" }),
    ).toBeVisible();
    await expect(canvas.getByText(/No place matched/)).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
});

export const LoadingWithProgress = meta.story({
  args: { data: awaySuggestions },
  render: () => (
    <LoadingSkeleton
      label="Loading route suggestions"
      progress="Routing new loops (2 of 3)"
    />
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Routing new loops (2 of 3)")).toBeVisible();
  },
});
