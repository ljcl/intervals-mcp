import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pill, PillGroup } from "./Pill";

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(node: ReactNode): Promise<HTMLElement> {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const pills = (el: HTMLElement) => [...el.querySelectorAll("button")];

describe("PillGroup", () => {
  it("names a one-of-N group and announces it as a radio group", async () => {
    const el = await render(
      <PillGroup label="Load scope">
        <Pill active>Whole body</Pill>
        <Pill>Runs only</Pill>
      </PillGroup>,
    );
    const group = el.firstElementChild!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("Load scope");

    const [first, second] = pills(el);
    expect(first!.getAttribute("role")).toBe("radio");
    expect(first!.getAttribute("aria-checked")).toBe("true");
    expect(second!.getAttribute("role")).toBe("radio");
    expect(second!.getAttribute("aria-checked")).toBe("false");
    // A radio states its choice with aria-checked alone.
    expect(first!.hasAttribute("aria-pressed")).toBe(false);
    expect(second!.hasAttribute("aria-pressed")).toBe(false);
  });

  it("keeps toggle buttons in a multiple group, named all the same", async () => {
    const el = await render(
      <PillGroup label="Chart options" multiple>
        <Pill active>Smooth</Pill>
        <Pill>Markers</Pill>
      </PillGroup>,
    );
    const group = el.firstElementChild!;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("Chart options");

    const [first, second] = pills(el);
    expect(first!.hasAttribute("role")).toBe(false);
    expect(first!.getAttribute("aria-pressed")).toBe("true");
    expect(second!.getAttribute("aria-pressed")).toBe("false");
    expect(first!.hasAttribute("aria-checked")).toBe(false);
  });

  it("calls the pill's onClick when it is chosen", async () => {
    const choose = vi.fn();
    const el = await render(
      <PillGroup label="Load scope">
        <Pill active>Whole body</Pill>
        <Pill onClick={choose}>Runs only</Pill>
      </PillGroup>,
    );
    await act(async () => pills(el)[1]!.click());
    expect(choose).toHaveBeenCalledTimes(1);
  });
});
