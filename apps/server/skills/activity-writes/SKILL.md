---
name: activity-writes
description: Use before you change the athlete's intervals.icu data with update-activity, update-wellness or update-gear. Covers renaming or annotating a run, setting its gear, RPE or feel, logging soreness, fatigue, mood or a niggle for a day, adding or resetting a shoe-mileage reminder, and retiring gear. Says how to confirm the change, which mode keeps existing text, and what to do when a write may already have applied.
---

# Changing the athlete's intervals.icu data

Three tools write to intervals.icu:

| Tool | Changes |
| --- | --- |
| `update-activity` | One activity's name, description, gear, RPE (1 to 10) or feel (1 to 5) |
| `update-wellness` | One day's soreness, fatigue, stress, mood, motivation, injury, sleep quality and comments |
| `update-gear` | One gear item: retire it, put it back in use, add a distance reminder or reset one |

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

On a client with form-mode elicitation, a `replace` that would drop existing
text first opens a confirmation in the host, which shows the current and the
new text. Nothing is sent until the athlete accepts. If the athlete declines,
nothing changed: say so, and do not send the call again unless they ask.

## When a write may already have applied

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
  `descriptionMode` writes nothing and the error quotes the start of the
  existing text. Ask the athlete whether to append or replace, then resend.
- **Gear can be changed, not cleared.** `gearId` must be an id from
  `list-gear`. intervals.icu ignores a request to set no gear.
- `rpe` is 1 (easiest) to 10 (hardest). `feel` is 1 ("Strong") to 5 (the
  weakest feeling).

## update-wellness

- `date` is YYYY-MM-DD and defaults to today in the configured time zone.
- Turn the athlete's words into the 1 to 4 scores in
  [references/wellness-scores.md](references/wellness-scores.md). On every
  scale, 1 is the best state. Show the scores you chose before you send them.
- Put free text such as "left calf tight" in `comments`, with
  `commentsMode: "append"` when the day already has comments.
- `null` clears a score. Device values (HRV, resting heart rate, sleep time,
  weight) are never written.
- **A locked day takes no API change.** If the athlete locked the day in
  intervals.icu, the reply warns for each value that was not applied. Tell
  the athlete to unlock the day in intervals.icu, then try again.

## update-gear

- Get `gearId` and reminder ids from `list-gear`.
- One change per call: exactly one of `retired`, `addReminderKm` (with an
  optional `reminderName`) or `resetReminderId`. For two changes, make two
  calls, each confirmed.
- `retired: true` retires the item today. Before you retire it, name the item
  and its distance so the athlete can check it is the right pair.
- A reminder with the same name and distance as an existing one is refused,
  so a repeated call adds no duplicate.
