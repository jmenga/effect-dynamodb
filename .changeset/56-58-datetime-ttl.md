---
"effect-dynamodb": minor
---

feat: Clock-backed timestamps/TTL via DateTime.now; wire unique.ttl; accept Duration|string for all TTL configs (closes #56, closes #58).

- All write-path timestamps and TTLs now derive from the Clock-backed `DateTime.now` instead of `Date.now()`/`new Date()`, making them deterministic under `TestClock` (`R` stays `never` — Clock is an ambient default service). The two duplicate timestamp generators are unified into one shared helper.
- `unique` constraints now honour `ttl` — when set, the unique sentinel item carries the configured TTL attribute and auto-expires (time-bounded uniqueness reservation). Previously the `ttl` field was typed but never consumed.
- Every framework TTL config (`versioned.ttl`, `softDelete.ttl`, `timeSeries.ttl`, `unique[].ttl`) now accepts a humanized string (e.g. `"7 days"`) as well as a `Duration`. A bare `number` is rejected at the type level (it would be interpreted as milliseconds), and infinite/unparseable durations fail at `Entity.make()` with **EDD-9005**.
