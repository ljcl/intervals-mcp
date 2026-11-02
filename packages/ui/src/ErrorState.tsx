import styles from "./ErrorState.module.css";
import { PillButton } from "./Pill";

export interface ErrorStateProps {
  message: string;
  /** When provided, renders a retry control that re-invokes the fetch. */
  onRetry?: () => void;
}

/**
 * Shared in-card error state for the MCP Apps: a themed message
 * plus an optional retry affordance, replacing the four inline-styled
 * error divs that offered no way back short of reloading the iframe.
 */
export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className={styles.errorState} role="alert">
      <div className={styles.message}>{message}</div>
      {onRetry && <PillButton onClick={onRetry}>Try again</PillButton>}
    </div>
  );
}
