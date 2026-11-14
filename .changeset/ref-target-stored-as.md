---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A ref now reads, compares and writes a field in the storage the referenced entity's `DynamoModel.configure` gives it.

When the referenced entity's model sets a date field's stored form with `configure(Model, { field: { storedAs: ... } })` (for example `DateEpochSeconds`), the ref copy already held the field in that form, because the referenced item is stored as that entity encodes it. The referencing entity treated the copy as the default form instead:

- `get`, queries and scans read the date wrong: epoch seconds were taken as milliseconds, giving a date in January 1970. A nullable date stored that way failed every read of the row, and the `put` that wrote it returned a `ValidationError` after writing the row.
- A `.condition()` or `.filter()` on the field (`t.player.born`) sent ISO text, so it never matched.
- `pathSet(["player", "born"], ...)` wrote ISO text into the copy.

All four now use the configured form. What hydration stores is unchanged, and a ref to an entity that configures no storage sends exactly the same requests as before.

Rows written before this release: a ref copy stored by `put`, `update` or a cascade is already in the configured form, and now reads correctly. A copy that `pathSet` wrote as ISO text keeps reading as the date it holds, nullable dates included. Reads accept both the configured form and ISO text, telling them apart by whether a number or text is stored. A condition on that field won't match such a copy, though. To store it in the configured form again, set the ref again (`.set({ playerId })`), or update the referenced entity with `.cascade({ targets: [...] })` naming the referencing entity.
