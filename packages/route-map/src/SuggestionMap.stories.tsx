import preview from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect } from "storybook/test";
import { awaySuggestions, homeSuggestions } from "./__fixtures__/suggestions";
import { SuggestionMap } from "./SuggestionMap";

const meta = preview.meta({ component: SuggestionMap });

export const AwayCandidates = meta.story({
  args: { data: awaySuggestions, basemapEnabled: false },
  play: async ({ canvas, userEvent }) => {
    // The card header comes before the picker.
    const title = canvas.getByText("SF: New loop");
    const pill = canvas.getByRole("button", { name: "New loop" });
    await expect(
      title.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await userEvent.click(canvas.getByRole("button", { name: "New loop 2" }));
    await expect(canvas.getByText("via Bay Trail, Crissy Field")).toBeVisible();
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

export const HomeCandidates = meta.story({
  args: { data: homeSuggestions, basemapEnabled: false },
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
