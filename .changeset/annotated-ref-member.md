---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A ref declared as a copy of its target's class that changes only its annotations (`team: Team.annotate({ description: "…" })`), or as a `Schema.suspend` of it (or of a suspend of it), now works wherever the class itself does. Nested in a ref's target (`Selection` refs `Player`, whose model declares `team` that way), a `Selection` `put` stored its row and then failed with `Expected DateTime.Utc at player.team.founded`, as did every read of it, and a condition or `pathSet` on `player.team.founded` sent the date in the wrong form; it now sends what the plain class sends, and the rows such a `put` left behind read. Declared nullable (`Schema.NullOr(Team.annotate(…))`), the ref takes `null` as `Schema.NullOr(Team)` does, and so does a ref whose `null` is in a union inside its union (`Schema.UndefinedOr(Schema.NullOr(Team))`, `Schema.Union([Schema.String, Schema.NullOr(Team)])`), whose ID took no `null` up to 1.42.1.

In an aggregate, a ref that an edge entity's model declares in a union (`Schema.NullOr(DynamoModel.ref(Team))`, `Schema.NullOr(Team.annotate(…))`, a union inside one included) or as a `Schema.suspend` of its target now stores a date below it as ISO text and reads it back, and holds `null` where its union takes it. Up to 1.42.1, under an edge entity made with `Entity.make`, the date was stored as a map and read back as a plain object; rows holding such maps read as dates. A ref's union keeps its other members (and so holds `null`) only where none of them can take an object: `null`, `undefined`, a string, a number or a literal beside the target. A union holding another class or a struct, beside the target or in its place, is replaced by the target, as before, and the ref's ID takes no `null`.
