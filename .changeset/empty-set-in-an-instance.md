---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

An empty set inside an `Option`, a `Result`, an `Exit` or a `Cause` is an absent attribute like any other, and the value reads back as it was written.

Leaving out an empty set dropped everything an instance keeps on its prototype, so `put` of `Option.some({ tags: new Set(), name: "x" })` stored `{"value":{"name":"x"}}` and every read of the row failed with `Expected Option`. No release wrote such a row: 1.39.0 died in the marshaller on any empty set, with nothing stored.

- **What's stored** is what the same value with something in the set stores, without the set: the tag, the op and the marker stay. A value holding no empty set is marshalled exactly as before, with nothing extra looked at.
- **What's read** is the value as written, the absent set an empty set, on entity reads, aggregates, events, their metadata, snapshots and outbox effects. That goes for a struct under a declaration, a `Schema.Class` or `Schema.TaggedClass` under one, one nested in another, an `Option.some` of the set itself, and lists and records of them. It also goes for a `Schema.suspend`, a `Schema.Class` with `.check()` or `.annotate()`, and a transformation's stored side, where an absent set used to be a decode failure.
- **A union still tries every member as declared first**, so a member reading an absent set doesn't take a row a later member takes. A `oneOf` union stays whole. A set with a `.check()` refusing an empty one still has to be there.
