---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Packed storage: store an entity field, an EventStore event's `data` or a snapshot's `state` as one JSON string, compressed over a threshold (#147)

A large object stored as a native DynamoDB map is slow to read and write, and its size counts every attribute name. `DynamoModel.Packed({ format: "json", compression?: { codec, threshold? } })` is one declarative config, shared by entities and EventStore, that stores such a value as one JSON string (`S`) or, when compression is configured, the JSON is at least `threshold` bytes (default 1024) and compressing makes it smaller, as header-prefixed compressed bytes (`B`). Nothing changes for code that does not opt in: the default stays a native map, and no attribute is added to any item.

- **Entity fields.** `DynamoModel.configure(model, { field: { storedAs: DynamoModel.Packed(...) } })`, a sibling of `SparseMap`. Packed on every write path (put / create / upsert / update `.set()` / `Batch.write` / `Transaction.transactWrite` / time-series `append`) and read by stored form on every read path. A packed field cannot be a key or index composite, `timeSeries.orderBy`, a unique-constraint field, a ref, or a vector index partition or filter field (`[EDD-9072]`–`[EDD-9075]`). Conditions and filters take only `exists` / `notExists` on the whole field, updates only a whole-value `.set()` / `.remove()`, projections only the whole field (`[EDD-9076]`, `[EDD-9077]`); PathBuilder callbacks refuse the rest at compile time. Aggregate edges store their edge entity's packed fields packed.
- **EventStore.** `makeStream({ storedAs: { data } })` and `snapshot: { storedAs }`. `append` / `commandHandler` pack each event (and the inline snapshot, inside the append transaction). Every read path decodes by stored form; raw rows (`Query.select`) return `data` as parsed JSON through every stream-index projection; `Query.filterExpr` on `data.*` is refused, pointing to `Query.filterBy`. Metadata stays a map.
- **Self-describing, no migration.** Readers dispatch on the stored value (native, `S`, or `B` whose first byte names the format and codec), never on the current config, so switching a field or stream between map, JSON and compressed needs no rewrite, and a stream or table holding a mix reads correctly.
- **Compression.** Compressors are small synchronous `Compressor` implementations registered on the `Compression` service: `DynamoClient.layer({ compressors })`, `DynamoClient.make({ compressors })`, or `Compression.layer(...)`. Node's gzip, brotli and zstd (Node 22.15 or later) ship from the new `effect-dynamodb/compression/node` entry point, the only module that imports `node:zlib`. Reading or writing a value with a codec that is not registered fails with the new tagged error `CompressorNotRegistered`.
- **Size planning (no pre-checks).** `stream.measureAppend` / `measureSnapshot` and `StorageEncoding.valueBytes` give the exact stored size of what a write would send, for planning chunks against `StorageEncoding.limits`. The write-failure diagnosis measures the stored (packed) bytes.
- **DynamoDB Streams.** `stream.decodeStreamImage(image)` returns the read paths' `StreamEvent` for a stream record image, DynamoDB JSON or unmarshalled, with `B` as bytes or base64 (Lambda, EventBridge Pipes). `StorageEncoding.decode` (an `AttributeValue`) and `decodeUnmarshalled` read one stored value.

Compatibility notes:

- Error channels of entity, aggregate, collection, query and EventStore operations gain `CompressorNotRegistered`. Exhaustive `catchTags` handlers keep compiling; exact error-type assertions in user tests may need updating. `R` is unchanged everywhere.
- `Entity` / `EntityDefinition` gain a trailing, defaulted `TPackedFields` type parameter.
- `DynamoClient.layer` / `layerConfig` return `Layer<DynamoClient | Compression, …>` only when given `compressors`.
- `Entity.decodeMarshalledItem` now applies field renames, sparse maps and base64 `B` values, so stream images that failed to decode before now decode.
- An explicit `DynamoClient.make({ embedder })` now reaches bound entity CRUD and bound aggregates, not only query accessors and collections (as `compressors` does).
- A `Table.make` that throws no longer rebinds its member entities to the rejected table.
- A version without this feature cannot read packed values: deploy readers before writers turn packing on.
