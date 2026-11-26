---
name: route-planning
description: Use to plan where the athlete should run, or to build, change, save, map or export a route. Covers route suggestions from past runs and generated routes, stitched routes, amending a stored route by version, saved running corridors, route maps and GPX or GeoJSON files.
---

# Planning and changing routes

## Tools

| Tool | Answers | Key inputs |
| ---- | ------- | ---------- |
| `suggest-run-route` | Where should I run my planned run? Past runs from that start that fit the distance and terrain, plus a newly generated route, each with a `route_id` to stitch, map or export it. See "How suggestions are chosen" below | `date`, `days`, `distanceKm`, `start`, `end`, `via` (one place or a list, in order), `shape`, `terrain` |
| `stitch-route` | Run my Sunday route, but add a 1 km out-and-back toward Iron Cove at halfway. Joins km ranges of past runs, stored routes, saved corridors, routed sections and out-and-backs into one stored route; gaps over 30 m are routed. Returns a `route_id`, version 1, and each section's km, source, climb and path share | `segments` (`activity`, `route`, `corridor`, `generated`, `out_and_back`), `name` |
| `amend-route` | Move the turnaround 200 m west; go through the park; cut km 3-4; swap a section for a saved corridor (`replace_section` with `corridor`); make it 15 km; undo. Routes only the changed part into a new version, keeps every old one, and says the distance change and the km that changed | `route_id`, `base_version` (must be the latest), `operations` |
| `list-corridors` | Which corridors have I saved near the office? What do I keep running that I have not named? Saved corridors nearest first, and stretches that recent runs repeat; with `through` (one or two places), the recent runs that pass them | `near`, `through` |
| `manage-corridors` | Save km 3-5.4 of Sunday's run as Glebe foreshore; rename it; mark it one-way; re-cut it from another run (`recut`); forget it. A saved corridor can be a `via` in `suggest-run-route`, and a section in `stitch-route` and `amend-route` | `action`, `route_id`, `name`, `one_way`, `activity`, `route` |
| `export-route` | Send me the GPX. A stored route's version, or a past run, as a GPX or GeoJSON file with a waypoint every km | `route_id` + `version`, or `id`; `format`, `waypoints` |

`view-route-suggestions` shows the suggestions on a map with a picker.
`view-route-map` draws a run or a stored route.

## How suggestions are chosen

- The generated route needs `ORS_API_KEY` on the server. Without it, the
  suggestions are past runs and stitched routes only.
- Routes are scored 0 to 100 from a local OpenStreetMap index and the
  athlete's runs: off-road paths, lines the athlete runs often, road
  crossings, main roads, backtracking, green space and fit to the plan. The
  best 3 come back.
- With via points, a route stitched from sections of past runs between them
  is one of the candidates.
- Without via points, when no past run fits the distance, out-and-backs
  along past runs and past loops joined end to end are candidates.
- A via that matches only a suburb or a city is refused. Give `lat,lng` for
  it instead.

## Workflow

1. **Suggest.** `suggest-run-route` (or `view-route-suggestions` for a map)
   with the planned distance and start.
2. **Build.** To combine parts of past runs, stored routes and corridors,
   `stitch-route`. It stores a new route and gives its `route_id`.
3. **Change.** `amend-route` with the route's latest version as
   `base_version`. An older `base_version` is refused, so read the latest
   version from the last result first. Every change is a new version, and
   `undo` goes back.
4. **Check.** `view-route-map` with the `route_id` draws it.
5. **Export.** `export-route` gives the GPX or GeoJSON file as a link.

## Rules

- Results never carry the route's geometry. `export-route` links it as a
  file, and `view-route-map` draws it.
- Each tool call has a budget of routing calls. A stitch that needs more
  stores nothing. An amend that needs more stores nothing and returns
  `applied: false`, a warning and the latest version.
- To save a stretch as a corridor, check it first with `view-route-map`
  with the run's `id`, `from_km` and `to_km`.
- Deleting a corridor cannot be undone. Name the corridor and wait for a yes
  before you call `manage-corridors` with `delete`. A client that can show a
  form also asks the athlete to confirm it.
