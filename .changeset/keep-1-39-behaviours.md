---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Keeps three things 1.39.0 did that this release had taken away.

**A time-series `appendInput` that may leave a sharded index's composite out loads again.** `EDD-9113` refused any `appendInput` carrying a sharded index's `by` attribute without the composites its key needs, on the grounds that every append carrying it fails with `EDD-9100`. It also refused an input where the attribute, or a composite after a gap in the sort key, is optional, and on 1.39.0 an append that left it out was written. `Entity.make` now refuses only when no append the input allows can compose the key, judged by composing each one. Otherwise the definition loads, the appends that compose are written as 1.39.0 wrote them, and one that can't compose fails with `EDD-9100` when it's made. An input every append of which failed on 1.39.0 is still refused, a required `by` and an optional one alike.
