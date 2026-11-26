# Pacing and caching

The server paces its own calls to intervals.icu, at about one request every
200 ms, because intervals.icu sends no rate-limit headers to react to. A
request that pulls several pieces of data can take a moment longer than a
single lookup. This is normal pacing, not an error.

Reads are cached for a short time, so the same data is not fetched again:

| Data | Cached for |
| ---- | ---------- |
| Activity detail, streams and intervals, and gear | 10 minutes |
| Sport settings | 1 hour (every group at once, as `get-athlete-zones` reads them: 10 minutes) |
| Activity list | 1 minute |
| Wellness | 5 minutes |
| Pace and heart rate curves | 10 minutes |

After a write, the server clears the entries the write changed:

- `update-activity` clears that activity and the related list and gear
  entries.
- `update-wellness` clears the wellness entries.
- `update-gear` clears the gear list.

So a read after the write (for example `get-activity`) shows the change at
once. Everything else stays on its normal schedule. A change made outside
this chat, directly on intervals.icu, can take up to the time above to show
here.
