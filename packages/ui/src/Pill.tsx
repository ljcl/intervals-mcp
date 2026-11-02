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
}

export function PillGroup({ children }: PillGroupProps) {
  // Base UI's ToggleGroup gives us roving tabindex + arrow-key navigation and
  // `role="group"`. It derives each Toggle's pressed state from the group's
  // controlled `value` array, so we build that array from the children's
  // `active` props and inject a stable index value into each Pill. The public
  // Pill / PillGroup API stays unchanged.
  const pills = Children.toArray(children).filter(
    isValidElement,
  ) as ReactElement<PillProps>[];
  const value = pills.flatMap((pill, i) =>
    pill.props.active ? [String(i)] : [],
  );
  return (
    <ToggleGroup value={value} multiple className={styles.pillGroup}>
      {pills.map((pill, i) => cloneElement(pill, { value: String(i) }))}
    </ToggleGroup>
  );
}

interface PillProps {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  /** Injected by PillGroup to identify the toggle within the group. */
  value?: string;
}

export function Pill({ active, onClick, children, value }: PillProps) {
  return (
    <Toggle
      value={value}
      pressed={active}
      onPressedChange={() => onClick?.()}
      className={styles.pill}
      data-active={active || undefined}
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
