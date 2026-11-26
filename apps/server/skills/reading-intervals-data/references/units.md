# Units

- **Pace** for a run is a bare `m:ss` string per kilometre, in a
  `*_min_per_km` field (`pace_min_per_km`, `gap_min_per_km`,
  `avg_pace_min_per_km`), never miles. Where a tool also needs the number
  for arithmetic, it adds a paired `*_sec_per_km` field in seconds
  (`get-race-prediction`'s `pace_sec_per_km`, `compare-activities`'
  `pace_delta_sec_per_km`).
- A swim's pace is per 100 m, in `pace_min_per_100m` (`units.swim_pace`).
  Other sports get `speed_kmh` (`units.speed`). `get-athlete-zones` also
  gives a swim group's paces per 100 m, in `*_min_per_100m` fields.
- **The `units` object.** Most tool responses include a `units` object that
  names the unit of every field (distance, HR, cadence in spm or rpm, HRV in
  ms, SpO2 in %, respiration in breaths/min), so a unit is never implied.
- **Distance** is in metres or kilometres, named per field.
  `get-race-prediction` gives distance in metres (`units.distance: "m"`,
  `distance_m` fields).
- **Heart rate** is in beats per minute.
- **Load** is intervals.icu's own training-load unit
  (`icu_training_load`), summed or averaged per day or week, depending on
  the tool.
