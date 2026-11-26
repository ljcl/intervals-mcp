---
name: activity-writes
description: Use before you change the athlete's intervals.icu data with update-activity, update-wellness or update-gear. Covers renaming or annotating a run, setting its gear, RPE or feel, logging soreness, fatigue, mood or a niggle for a day, adding or resetting a shoe-mileage reminder, and retiring gear. Says how to confirm the change, which mode keeps existing text, and what to do when a write may already have applied.
---

# Changing the athlete's intervals.icu data

Three tools write to intervals.icu:

| Tool | Changes | Key inputs |
| --- | --- | --- |
| `update-activity` | One activity's name, description, gear, RPE (1 to 10) or feel (1 to 5) | `id`, `name`, `description`, `descriptionMode`, `gearId`, `rpe`, `feel` |
| `update-wellness` | One day's soreness, fatigue, stress, mood, motivation, injury, sleep quality and comments ("log today: legs sore, left calf tight") | `date`, `soreness`, `fatigue`, `stress`, `mood`, `motivation`, `injury`, `sleepQuality`, `comments`, `commentsMode` |
| `update-gear` | One gear item: retire it, put it back in use, add a distance reminder or reset one ("remind me at 700 km on the new pair; retire the old ones") | `gearId`, one of `retired`, `addReminderKm` (+ `reminderName`), `resetReminderId` |

Everything else this server writes (stored routes and corridors) is in its own
route store, not in intervals.icu.

## Rules for every write

1. **Read first.** Get the current values before you draft a change:
   `get-running-summary` or `get-activity` for an activity, `get-wellness`
   for a day, `list-gear` for gear and reminder ids.
2. **Show the exact change and wait for a yes.** Quote the field, the old
   value and the new value. Do not write on an implied yes. If the athlete
   changes the text, show it again.
3. **Keep the athlete's text.** To add a note, use `descriptionMode: "append"`
   (`update-activity`) or `commentsMode: "append"` (`update-wellness`). Use
   `"replace"` only when the athlete asked to overwrite the text.
4. **Send only what changes.** Leave out every field the athlete did not ask
   to change. The tools also skip a field whose value is already the same.
5. **Report what the reply says changed**, with its before and after values,
   not what you asked for.

## When the host asks the athlete to confirm

On a client with form-mode elicitation, some writes first open a
confirmation in the host: a `replace` that would drop existing text (it
shows the current and the new text), and retiring gear with `update-gear`
(it names the item and its distance). Nothing is sent until the athlete
accepts. If the athlete declines,
nothing changed: say so, and do not send the call again unless they ask.

## When a write may already have applied

Each tool reads the data fresh and sends one write, which is never retried.
If the reply says it cannot tell whether the change landed (the write timed
out, or the confirming re-read failed), **do not send the same call again**.
Re-read with `get-activity`, `get-wellness` or `list-gear`, tell the athlete
what the data shows now, and write again only if the change is not there.

## update-activity

- Get the id from `list-activities`. Pass it as a quoted string
  (`"i189807578"`). `update-activity` does not take `"latest"`: resolve the
  run with `list-activities` first.
- **Annotating a run:** read `get-running-summary` (it has the laps), draft a
  short note from what the data shows, show it, then send it with
  `descriptionMode: "append"`. This is also what the `annotate-last-run`
  prompt does.
- **A description needs a mode when one already exists.** If the activity has
  a description that the new text does not contain, a call with no
  `descriptionMode` writes nothing. The error gives the existing text's
  length and its first 120 characters. Ask the athlete whether to append or
  replace, then resend. After a `replace` that drops text, the reply quotes
  what was removed.
- **Gear can be changed, not cleared.** `gearId` must be an id from
  `list-gear`. intervals.icu ignores a request to set no gear.
- `rpe` is 1 (easiest) to 10 (hardest). `feel` is 1 ("Strong") to 5 (the
  weakest feeling).

## update-wellness

- `date` is YYYY-MM-DD and defaults to today in the configured time zone.
- Turn the athlete's words into the 1 to 4 scores in
  [Wellness scores](references/wellness-scores.md). On every
  scale, 1 is the best state. Show the scores you chose before you send them.
- Put free text such as "left calf tight" in `comments`, with
  `commentsMode: "append"` when the day already has comments.
- `null` clears a score. Device values (HRV, resting heart rate, sleep time,
  weight) are never written.
- **A locked day takes no API change.** If the athlete locked the day in
  intervals.icu, the reply warns for each value that was not applied. Tell
  the athlete to unlock the day in intervals.icu, then try again.
  `update-wellness` itself never locks a day, so a device sync later the
  same day still lands.

## update-gear

- `list-gear` shows each item's distance, purchase date, reminders (with
  their ids) and auto-assign rules. Get `gearId` and reminder ids there.
- One change per call: exactly one of `retired`, `addReminderKm` (with an
  optional `reminderName`) or `resetReminderId`. For two changes, make two
  calls, each confirmed.
- `retired: true` retires the item today. Before you retire it, name the item
  and its distance so the athlete can check it is the right pair.
- `addReminderKm` adds a reminder. The reply shows how much usage
  intervals.icu already counts toward it. `resetReminderId` restarts a
  reminder's count from now.
- A reminder with the same name and distance as an existing one is refused,
  so a repeated call adds no duplicate.
