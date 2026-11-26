---
name: fitness-and-racing
description: Use for questions about fitness, fatigue and form, weekly training load and volume spikes, training totals, best efforts, race predictions and goal paces, tapers, heart rate zones and thresholds, and recovery (HRV, resting heart rate, sleep). Covers the weekly review, race readiness and injury check, and the rule for whole-body versus run-only numbers.
---

# Fitness, load and racing

## Tools

| Tool | Answers | Key inputs |
| ---- | ------- | ---------- |
| `get-fitness-trend` | Am I fresh or fatigued? What if I taper for a race? | `days`, `newest`, `runOnly`, `projectDays`/`plannedLoads`/`calendarPlan`, `targetDate`/`targetTsb` |
| `get-training-load` | Weekly volume, volume-spike flags, long run, HR zone split, weekly load | `days`, `newest`, `runOnly` |
| `get-athlete-stats` | Run totals with the longest run, and totals for every sport (strength sessions, swim distance), for this week, month and year to date, last year to date, and any date range | `oldest`, `newest` (an optional range) |
| `get-best-efforts` | My best mile, 5K, 10K, half and marathon times, or grade-adjusted bests; my fastest 100 m or 1500 m swim; my fastest 5K inside one run, and where; how my 5K best and critical speed moved by month, quarter or year | `distances`, `window`, `topN`, `gap`, `sport`, `id`, `progression` |
| `get-race-prediction` | What could I run for X? What pace do I need for a goal time? | `raceDistance` (`5km`, `10km`, `15km`, `10 mile`, `half marathon`, `marathon`, `50km`), `goalTime` |
| `get-athlete-zones` | What are my HR zones? Is 150 bpm zone 2? What is my threshold pace? Is my LTHR out of date? | `sport` (default Run) |
| `get-wellness` | HRV, resting HR, sleep, soreness and how I felt, for a day or a range | `date`, or `oldest`/`newest` |

For a chart of the same numbers, use `view-fitness-trend`,
`view-training-load` or `view-wellness`.

## Whole-body versus run-only numbers

- `get-fitness-trend` and `get-training-load` give whole-body CTL/ATL/TSB
  by default. They read it from intervals.icu's own wellness record, which
  covers every activity type.
- `runOnly: true` gives a separate series that the server computes from
  Run, TrailRun and VirtualRun only.
- The two can give very different numbers for the same athlete, and they
  answer different questions. Do not mix them in one comparison, and say
  which one each number is.
- `get-athlete-stats` gives both side by side: run totals with run-only
  load, and `all_sports` with whole-body load.

## Workflows

### Weekly review

1. `get-training-load` for volume, trend, warnings, the weekly
   easy/moderate/hard split and each week's long run.
2. `list-activities` to find the hardest efforts.
3. `get-running-summary` on those runs (and `compare-activities` for two
   comparable runs).
4. `view-cadence-trends` to explore cadence patterns.

The `weekly-review` prompt runs this sequence.

### Race readiness

- `get-fitness-trend` with `targetDate` and `targetTsb` for race-day form
  and the taper, plus `calendarPlan` for where form lands if the athlete
  follows the workouts planned on the intervals.icu calendar.
- `get-race-prediction` for the time.
- `get-wellness` for the last 7 days.
- `get-training-load` for recent load.

The `race-readiness` prompt runs this sequence.

### Injury check

- `get-training-load` volume-spike warnings (a sharp rise on recent volume,
  not an injury measure).
- The HRV and resting-HR trend from `get-wellness`.
- `get-fitness-trend` flags.
- Shoe mileage from `list-gear` (the athlete's own reminders first).

This is training-load guidance, not a diagnosis. The `injury-check` prompt
runs this sequence.

### Race prediction

Call `get-race-prediction` alone. Pass `raceDistance` for a km split table,
or `goalTime` to pace the splits to a target instead of a prediction. It
uses one pace-curve point per run, and it counts runs marked as races in
intervals.icu twice. So a history of training runs only usually predicts on
the slow side.

### Fitness and taper planning

- `get-fitness-trend` with `targetDate` and `targetTsb` solves a taper.
- `projectDays`/`plannedLoads` projects forward under an assumed plan.
- `calendarPlan` projects from the workouts planned on the intervals.icu
  calendar.
- `view-fitness-trend` shows the same thing as a chart, with a Whole body /
  Runs only toggle.

`targetDate` must be after today and at most 180 days ahead.

## Rules for reading the numbers

### Training-load weeks are whole weeks

- `get-training-load` and `view-training-load` round `days` up to whole
  Monday-to-Sunday weeks, and add the current week so far. `days: 28` is
  the last 4 complete weeks plus this week.
- The current week is marked in progress. Averages and the trend leave it
  out, and it gets a warning only for the volume it already has. Do not read
  a short current week as a drop in volume.
- Weeks with no runs count as zero weeks, including a layoff that is still
  going on.
- With `newest` (a past date, never after today), `days` counts back from
  it. A past Sunday ends the window on a complete week (`days: 84` is
  exactly 12 weeks). Any other past date ends it on a partial week, marked
  "partial" and treated like the current week. Then `period.ends_today` is
  false, and `get-fitness-trend` gives no projection or taper for the past
  window.

### Volume-spike flags compare with the recent average

A week is flagged when its distance is more than 1.5 times the average of
the 4 complete weeks before it. The reason gives the ratio. A normal week
after a recovery or taper week is not flagged. The flag marks a sharp rise,
not a measured injury risk: say so, and do not present it as a diagnosis.

### The LTHR and max HR check is a hint

A heart rate sensor error can also put a best above a setting, so check the
named activity first. The LTHR check uses intervals.icu's own rule: the
higher of the best 60-minute heart rate and 98% of the best 20-minute heart
rate, over the last 90 days. An estimate below a setting does not mean that
the setting is too high.
