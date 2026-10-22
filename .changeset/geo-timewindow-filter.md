---
"@effect-dynamodb/geo": patch
---

`GeoIndex.nearby()` now filters results to the `timeWindow`, not just the time partitions it touches. Each item is kept only when its `timePartition.source` timestamp lies in `[start, end]` (inclusive). Before, an hourly bucket returned everything written in that hour, so a 30-second window could return items up to an hour older (or newer than `end`). The default 15-minute window is filtered the same way. Closes #169.
