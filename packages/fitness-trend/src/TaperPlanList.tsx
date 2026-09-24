import { formatShortDate } from "@intervals-mcp/data";
import { signedTsb } from "./normalize";
import styles from "./TaperPlanList.module.css";
import { type TaperPlan } from "./types";

interface TaperPlanListProps {
  plan: TaperPlan;
  compact?: boolean;
}

/**
 * The solved plan in words, under the chart. The dashed curves show the shape;
 * this says what to actually do each week — and the same numbers the
 * get-fitness-trend text prints, since both read one server-side solve.
 */
export function TaperPlanList({ plan, compact }: TaperPlanListProps) {
  return (
    <div className={styles.plan} data-compact={compact || undefined}>
      <div className={styles.header}>
        <span className={styles.title}>
          Plan to {formatShortDate(plan.targetDate)}
        </span>
        <span className={styles.target}>
          target form {signedTsb(plan.targetTsb)}
          {Math.abs(plan.achievedTsb - plan.targetTsb) >= 0.1 &&
            ` · lands ${signedTsb(plan.achievedTsb)}`}
        </span>
      </div>
      <ol className={styles.weeks}>
        {plan.weeks.map((week) => (
          <li key={week.startDate} className={styles.week}>
            <span className={styles.weekLabel}>
              Week {week.week}
              <span className={styles.weekDates}>
                {formatShortDate(week.startDate)} –{" "}
                {formatShortDate(week.endDate)}
              </span>
            </span>
            <span className={styles.weekLoad}>
              {week.dailyLoad}/day
              {week.pctOfRecent !== null && (
                <span className={styles.weekPct}>
                  {week.pctOfRecent}% of recent
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {!plan.feasible && plan.note && (
        <p className={styles.note}>⚠ {plan.note}</p>
      )}
    </div>
  );
}
