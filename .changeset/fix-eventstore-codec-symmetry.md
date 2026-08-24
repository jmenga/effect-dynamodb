---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

fix(eventstore): codec symmetry — encode on write, decode on read

`EventStore.append` previously spread the event instance and marshalled it raw,
so any event schema carrying a transformation (`Schema.DateTimeUtc`,
`Schema.Date`, branded transforms, fields with defaults) stored its **runtime**
representation and then failed or drifted when the read path decoded it.
Events are now run through `Schema.encode` before marshalling, mirroring the
Entity/Aggregate write path.

Metadata had the same asymmetry — validated with `Schema.decode` on write and
returned via a raw cast on read. It is now encoded on write and decoded on
read, so `StreamEvent.metadata` is the decoded schema type.

The persisted event envelope (`streamId`, `version`, `eventType`, `timestamp`)
is decoded through a schema instead of unchecked casts. Encode failures map to
`ValidationError` with `operation: "EventStore.append"` (or
`"EventStore.append.metadata"`).

The injected `_tag` on stored event data keeps working for both `Schema.Class`
and `Schema.TaggedClass` events.
