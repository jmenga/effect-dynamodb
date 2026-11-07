---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

`rekey` reports index keys that aren't what their row's values compose, and repairs them on request.

Every run now counts them in `report.indexKeys` and per member, from the row the scan already read: `missing`, `truncated`, `lagging` and `ambiguous`. `rekey({ repairIndexKeys: true })`, off by default, writes them with one `UpdateItem` a row, conditioned on each key and each composite as read, so a writer changing any of them wins. It repairs the rows the update gate damaged from v1.7.2 through 1.38. A `sparse` half with no key and two or more composites outside the primary key is counted `ambiguous` and left, as it can't be told from a writer dropping the row on purpose.

A move no longer writes a key for a half that went without one on purpose, or that holds a composite the library stamps.

A run that didn't read the whole table (`maxPages`, `resume`) now counts an aggregate row with no root in its partition in the new `skipped.rootNotSeen`, not `skipped.unrecognizedKey`, since a later page could bring the root in. A run over the whole table does what it did.
