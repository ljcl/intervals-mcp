# Wellness scores for update-wellness

Every score is an integer from 1 to 4. On every scale, 1 is the best state.
`null` clears a score.

| Field | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- |
| `soreness` | low | average | high | extreme |
| `fatigue` | low | average | high | extreme |
| `stress` | low | average | high | extreme |
| `mood` | great | good | OK | grumpy |
| `motivation` | extreme | high | average | low |
| `injury` | none | niggle | poor | injured |
| `sleepQuality` | great | good | average | poor |

## Turning words into scores

| The athlete says | Send |
| --- | --- |
| "legs are a bit sore" | `soreness: 2` |
| "legs are trashed" | `soreness: 3` or `4`: ask which |
| "slept badly" | `sleepQuality: 4` |
| "left calf is tight" | `injury: 2` and `comments: "left calf tight"` |
| "can't wait to run" | `motivation: 1` |

When a word fits two scores, ask; do not guess. Show the scores and any
comment text before you send them.

## After logging

`get-wellness` over a range shows when a niggle started. `get-training-load`
for the same weeks shows the load around it.
