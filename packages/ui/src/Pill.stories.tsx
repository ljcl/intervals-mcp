import preview, { darkGlobals } from "@intervals-mcp/design-system/preview";
import { Pill, PillGroup } from "./Pill";

const meta = preview.meta({
  component: Pill,
});

export const Default = meta.story({
  render: () => (
    <PillGroup>
      <Pill active>Effort</Pill>
      <Pill>Power</Pill>
      <Pill>Form</Pill>
      <Pill>All</Pill>
    </PillGroup>
  ),
});

export const Dark = meta.story({
  globals: darkGlobals,
  render: () => (
    <PillGroup>
      <Pill active>Effort</Pill>
      <Pill>Power</Pill>
      <Pill>Form</Pill>
      <Pill>All</Pill>
    </PillGroup>
  ),
});

export const AllInactive = meta.story({
  render: () => (
    <PillGroup>
      <Pill>Effort</Pill>
      <Pill>Power</Pill>
      <Pill>Form</Pill>
      <Pill>All</Pill>
    </PillGroup>
  ),
});

export const MultipleActive = meta.story({
  render: () => (
    <PillGroup>
      <Pill active>Effort</Pill>
      <Pill active>Power</Pill>
      <Pill>Form</Pill>
      <Pill>All</Pill>
    </PillGroup>
  ),
});
