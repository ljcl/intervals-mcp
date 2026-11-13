import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { expect } from "storybook/test";
import { Pill, PillGroup } from "./Pill";

const meta = preview.meta({
  component: Pill,
});

/**
 * A one-of-N choice: a named radio group whose checked pill is announced as
 * the choice (#398).
 */
export const Default = meta.story({
  render: () => (
    <PillGroup label="Chart view">
      <Pill active>Effort</Pill>
      <Pill>Power</Pill>
      <Pill>Form</Pill>
      <Pill>All</Pill>
    </PillGroup>
  ),
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("radiogroup", { name: "Chart view" }),
    ).toBeVisible();
    await expect(canvas.getByRole("radio", { name: "Effort" })).toBeChecked();
    await expect(
      canvas.getByRole("radio", { name: "Power" }),
    ).not.toBeChecked();
  },
});

export const Dark = meta.story({
  globals: darkGlobals,
  render: () => (
    <PillGroup label="Chart view">
      <Pill active>Effort</Pill>
      <Pill>Power</Pill>
      <Pill>Form</Pill>
      <Pill>All</Pill>
    </PillGroup>
  ),
});

export const AllInactive = meta.story({
  render: () => (
    <PillGroup label="Chart view">
      <Pill>Effort</Pill>
      <Pill>Power</Pill>
      <Pill>Form</Pill>
      <Pill>All</Pill>
    </PillGroup>
  ),
});

/**
 * Pills that turn on and off on their own (`multiple`): a named group of
 * toggle buttons, where several can be pressed at once.
 */
export const MultipleActive = meta.story({
  render: () => (
    <PillGroup label="Shown series" multiple>
      <Pill active>Heart rate</Pill>
      <Pill active>Pace</Pill>
      <Pill>Cadence</Pill>
    </PillGroup>
  ),
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("group", { name: "Shown series" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Pace", pressed: true }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Cadence", pressed: false }),
    ).toBeVisible();
  },
});
