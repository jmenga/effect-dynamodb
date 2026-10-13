---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

EventStore GSI stream indexes can derive their partition, so several streams share one partition of a GSI, and their snapshots can be in it (#149).

- `partition: (streamId, event) => string | undefined` on a `type: "gsi"` index replaces the stream's partition key with a derived value, stored raw. Streams that declare the same GSI write one partition of it, and one query reads the group. The partition can come from the event, for a stream keyed by something other than the group. Both `partition` and `key` run for every appended event, and an event is indexed only when both return a string.
- `snapshot: (state, streamId, asOfVersion) => { partition, key } | undefined` puts the snapshot item in the index. It requires `partition` and a stream `snapshot` config. The attributes are written by the same `Put`: an inline snapshot enters the index in the append's own transaction, and `writeSnapshot` and `commandHandler` snapshots carry them too. `undefined` leaves the snapshot out, and takes it out of the index.
- Within one append, every event's partition and the inline snapshot's must be the same. Otherwise the append fails with `ValidationError` before anything is written. An empty or over-long partition is DynamoDB's to reject, and is reported as a `ValidationError` naming the index and the item.
- `key` also receives the stream id: `key(event, version, streamId)`.
- `readIndex` and `query.index` take `{ partition }` for such an index and return the given stream id's events in that partition. The types require it, through a new trailing `TPartitionedIndexName` type parameter on `EventStream` and `BoundEventStream`. `query.index` throws `[EDD-9080]` for a missing partition, or for one passed to a stream-scoped index.
- `indexDefinitions` emits a GSI that several streams declare alike once. A derived partition or snapshot entry is not part of the definition, and a `"withoutMetadata"` index that holds snapshots also projects `asOfVersion` and `state`. `StreamIndexSettings` gains `partition` (`"stream" | "derived"`) and `snapshot` (`boolean`).

Existing indexes are unchanged: their write layout, reads and `indexDefinitions` output stay the same.
