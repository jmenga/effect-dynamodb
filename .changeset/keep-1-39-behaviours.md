---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Keeps three things 1.39.0 did that this release had taken away.

**A time-series `appendInput` that may leave a sharded index's composite out loads again.** `EDD-9113` refused any `appendInput` carrying a sharded index's `by` attribute without the composites its key needs, on the grounds that every append carrying it fails with `EDD-9100`. It also refused an input where the attribute, or a composite after a gap in the sort key, is optional, and on 1.39.0 an append that left it out was written. `Entity.make` now refuses only when no append the input allows can compose the key, judged by composing each one. Otherwise the definition loads, the appends that compose are written as 1.39.0 wrote them, and one that can't compose fails with `EDD-9100` when it's made. An input every append of which failed on 1.39.0 is still refused, a required `by` and an optional one alike.

**A `Schema.NumberFromString` key composite holding `NaN` works again with `escapeKeys` off.** Such a field stores `NaN` as `"NaN"`, and up to 1.39.0 its row was keyed by 1.36's text, `0000000000000nan`, and written, read, queried, updated and deleted by it. This release refused it with `EDD-9096` on every path, so a row stored that way came back from a query or a scan but couldn't be read, updated or deleted by its key. It now composes that text again on every path that takes a key: `put`, `create`, `get`, `update`, `delete`, index and primary accessors, `.where()`, `.within()`, `Batch`, `Transaction`, an aggregate's partition key and a `many` edge's sort key, and `rekey`, which finds such a row in place. A `Schema.Number`'s `NaN` is still refused, as no row can hold it (1.39.0's `put` died in the marshaller), and with `escapeKeys: true` every `NaN` is refused, as on 1.39.0. Every other value of these fields composes what it did on 1.39.0: `±Infinity`, `-0`, negatives, fractions and `1e21`, and a `Schema.BigIntFromString`'s negatives, `10^38` and values of more than 1,000 digits.
