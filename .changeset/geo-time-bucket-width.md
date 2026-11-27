---
"@effect-dynamodb/geo": minor
---

Geo time partitions of any width: `fields.timePartition.bucket` takes a `Duration` ([#292](https://github.com/jmenga/effect-dynamodb/issues/292)).

- `bucket` is `"hourly"` or any `Duration` input: `"1 day"`, `"6 hours"`, `Duration.days(1)`, `{ hours: 6 }`, or a number of milliseconds. `GeoIndex.make` resolves it once and uses the one width both to compose each row's partition (`floor(timestamp / width)`) and to enumerate the partitions `nearby()` reads. A 24-hour window on a daily index reads at most two partitions per cell range, where an hourly index reads 24 or 25.
- A width that is not a positive whole number of milliseconds (zero, negative, fractional, infinite, `NaN`, under a millisecond, or not a duration) throws `[EDD-9185]` at `GeoIndex.make`. `GeoIndex.bucketMillis` exposes the resolution.
- `"hourly"`, `"1 hour"`, `Duration.hours(1)` and `3_600_000` compose the same keys and send the same queries as before.
- One entity can carry geo indexes of different widths, each writing its own partition attribute; write through both with `a.put(b.enrich(input))`.
- Partitions count from the Unix epoch, so a daily bucket is a UTC day. The partition value doesn't record the width: changing the width of an index that holds data hides its rows until each item is written again. The geospatial guide describes how to choose a width and how to change one without a gap.
