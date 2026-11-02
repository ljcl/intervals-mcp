import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { expect } from "storybook/test";
import { ErrorState } from "./ErrorState";

const noop = () => {};

const meta = preview.meta({
  component: ErrorState,
});

export const Default = meta.story({
  args: { message: "No activity data available" },
});

export const WithRetry = meta.story({
  args: { message: "No activity data available", onRetry: noop },
  play: async ({ canvas }) => {
    // A one-shot action: a plain button, not a toggle in a group (#316).
    const retry = canvas.getByRole("button", { name: "Try again" });
    await expect(retry).not.toHaveAttribute("aria-pressed");
    await expect(retry.closest('[role="group"]')).toBeNull();
  },
});

export const LongMessage = meta.story({
  args: {
    message:
      "Error: MCP error -32603: intervals.icu API rate limit exceeded. The " +
      "15-minute read limit resets at 10:45 UTC; try again after that, or " +
      "reduce the number of activities requested in a single call.",
    onRetry: noop,
  },
});

export const Dark = meta.story({
  globals: darkGlobals,
  args: { message: "No activity data available", onRetry: noop },
});
