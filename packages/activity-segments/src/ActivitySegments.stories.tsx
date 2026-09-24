import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { MobileCardShell } from "@intervals-mcp/ui";
import { expect } from "storybook/test";
import {
  defaultActivity,
  noHighlights,
  noSegments,
} from "./__fixtures__/segments";
import { ActivitySegments } from "./ActivitySegments";

const meta = preview.meta({ component: ActivitySegments });

export const Default = meta.story({
  args: { data: defaultActivity, mode: "desktop" },
});

export const Dark = meta.story({
  globals: darkGlobals,
  args: { data: defaultActivity, mode: "desktop" },
});

/**
 * Interaction test (#164): expanding a row is the densest layout in this app
 * (the detail grid with HR, cadence, power, max grade, and moving time), and
 * without a play function it never renders. The browser-mode story test runs
 * the play function, so this story exercises the expanded state in a real DOM.
 * "Station Road Tempo" is the fixture effort with device power, so every
 * detail column renders.
 */
export const ExpandedRow = meta.story({
  args: { data: defaultActivity, mode: "desktop" },
  play: async ({ canvas, userEvent }) => {
    const trigger = canvas.getByRole("button", {
      name: /Station Road Tempo/,
    });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    // The full detail grid for the expanded effort: HR, cadence (spm for a
    // run), device power, max grade, and moving time.
    await expect(await canvas.findByText("170/179")).toBeVisible();
    await expect(canvas.getByText("180 spm")).toBeVisible();
    await expect(canvas.getByText("312 W")).toBeVisible();
    await expect(canvas.getByText("1.6%")).toBeVisible();
    await expect(canvas.getByText("3:04")).toBeVisible();
  },
});

export const NoHighlights = meta.story({
  args: { data: noHighlights, mode: "desktop" },
});

export const NoSegments = meta.story({
  args: { data: noSegments, mode: "desktop" },
});

export const Mobile = meta.story({
  args: { data: defaultActivity, mode: "mobile" },
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
