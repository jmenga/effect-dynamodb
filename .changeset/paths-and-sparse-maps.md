---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A `.select()` naming a sparse map field returns the map. A `ProjectionExpression` can't name a map's entries (`<prefix>#<key>`), so the select projected the field's own name, which no row holds, and the map came back absent, on an entity's queries and scans and on a collection, as on 1.39.0. Such a select now sends its request without a projection and hands back each row rebuilt as a read rebuilds it, trimmed to the paths selected as a projection trims them. So it reads what an unprojected query of those rows reads. A select naming no sparse map sends the projection it always sent, and `.filterBy()` after any select is still refused (`EDD-9054`).

A model field whose own name holds `#` and is stored under another name (`field:`) is named by that name in path writes and conditions, as filters and projections already named it. A path write and a condition took such a first segment as a literal attribute name, so `pathSet(["a#b"])` on a field `a#b` stored as `stored` set a top-level `a#b` that no read looks at, and a condition on `t["a#b"]` tested an attribute `put` never stores, failing whatever the row held, as on 1.39.0. The refusal of a `pathRemove` of a sparse map's entry asks about the attribute the path names after that rename, as `.remove()`'s does, so a field named like an entry (`data#x#y`, stored as `counter`) is removed where it's stored. 1.39.0 removed the entry `x#y` instead, and 1.40.0 refused the removal. A sparse map's entry names no model field, so its path is named as before.

A `pathRemove` that leaves a row no read can decode is refused in more places, with a `ValidationError` and nothing sent, and each was sent on 1.39.0 and 1.40.0:

- Below a sparse map's entry (`pathRemove(["data#2026-01", "views"])`): judged against the map's own schema, as a read rebuilds the map. A map a `field:` rename stores whole isn't judged.
- A list position whose removal moves a value where its position can't hold it: `f[0]` of a `[string, number?]` leaves the number where the string was.
- A list position whose shortened list only a member its tag rules out reads: `p[0]` of `{ kind: "a", p: [string, string] }` beside `{ kind: "b", p: [string] }`.
- Below a record with several index signatures, judged by the signatures its key matches: on `{ [open-*]: [string, string?], [fixed-*]: [string, string] }`, `["fixed-k", 0]` is refused and `["open-k", 0]` is sent. A record keyed by a template literal of strings is judged too.

Anything the guard can't model exactly is still sent, as before.

A condition or filter comparing the path builder itself (`eq(t, 1)`, `t.size()`) is refused with a `ValidationError` before anything is sent (`EDD-9149`), as an empty part under `or()` is. It names the whole item, not an attribute. 1.40.0 sent it as `( = :e0)` and DynamoDB rejected it with a `DynamoValidationError`. 1.39.0 did the same for a condition, and its filter died with a `TypeError`.
