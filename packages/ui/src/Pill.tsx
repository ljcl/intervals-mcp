import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import styles from "./Pill.module.css";

interface PillGroupProps {
  children: ReactNode;
  /**
   * The group's accessible name, announced as focus enters it: "Load scope",
   * "Zone set". Required: a nameless group tells a screen reader user
   * nothing about what the pills choose.
   */
  label: string;
  /**
   * True when each pill turns on and off on its own (a toggle, such as
   * "Smooth"): the pills are toggle buttons with `aria-pressed`. False, the
   * default, for a one-of-N choice: the group is a `radiogroup` and each
   * pill a `radio` with `aria-checked`, so the choice is announced as
   * single ("Runs only, radio button, checked, 2 of 2").
   */
  multiple?: boolean;
}

export function PillGroup({
  children,
  label,
  multiple = false,
}: PillGroupProps) {
  // Base UI's ToggleGroup gives us roving tabindex + arrow-key navigation
  // (one Tab stop) and `role="group"`. It derives each Toggle's pressed
  // state from the group's controlled `value` array, so we build that array
  // from the children's `active` props and inject a stable index value into
  // each Pill. Its single mode changes only the value handling, not the
  // ARIA, so a one-of-N group sets the radio roles itself. Arrow keys move
  // focus and Space or Enter selects, as before.
  const pills = Children.toArray(children).filter(
    isValidElement,
  ) as ReactElement<PillProps>[];
  const value = pills.flatMap((pill, i) =>
    pill.props.active ? [String(i)] : [],
  );
  return (
    <ToggleGroup
      value={value}
      multiple={multiple}
      aria-label={label}
      // Spread, not `role={undefined}`: an undefined prop would override
      // Base UI's own `role="group"` and leave the group with no role.
      {...(multiple ? {} : { role: "radiogroup" })}
      className={styles.pillGroup}
    >
      {pills.map((pill, i) =>
        cloneElement(pill, { value: String(i), choice: !multiple }),
      )}
    </ToggleGroup>
  );
}

interface PillProps {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  /** Injected by PillGroup to identify the toggle within the group. */
  value?: string;
  /** Injected by PillGroup: true in a one-of-N group, where the pill is a radio. */
  choice?: boolean;
}

export function Pill({ active, onClick, children, value, choice }: PillProps) {
  // A radio states its choice with `aria-checked`; `aria-pressed` is not
  // allowed on it, so the Toggle's own is dropped (external props win in
  // Base UI's merge, `undefined` included).
  const radio = choice
    ? {
        role: "radio",
        "aria-checked": Boolean(active),
        "aria-pressed": undefined,
      }
    : {};
  return (
    <Toggle
      value={value}
      pressed={active}
      onPressedChange={() => onClick?.()}
      className={styles.pill}
      data-active={active || undefined}
      {...radio}
    >
      {children}
    </Toggle>
  );
}

interface PillButtonProps {
  onClick: () => void;
  children: ReactNode;
}

/**
 * A one-shot action with the pill look. A plain button, not a Toggle: a
 * Toggle announces a pressed state the action never has.
 */
export function PillButton({ onClick, children }: PillButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={styles.pill}
      data-action=""
    >
      {children}
    </button>
  );
}
