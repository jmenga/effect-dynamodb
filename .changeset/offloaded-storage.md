---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Adds offloaded storage: large and binary attribute values kept in a versioned blob store (S3), with the item holding a pointer that pins the object's version.

**Configuring fields.** `DynamoModel.Packed({ format: "json", external: { threshold } })` stores an object- or array-shaped field inline below its threshold and in the blob store at or above it. `DynamoModel.External({ contentType? })` stores a binary field in the blob store always. Entities, aggregate edges, EventStore event data and snapshot state, and geo entities offload. Offloading requires `escapeKeys: true` on the table's schema: every bind site refuses a member with an offloaded field on any other setting (`EDD-9146`), and `rekey` refuses to move a row holding a pointer.

**Writing and reading.** Writes upload before DynamoDB is sent anything, and an upload ledger settles each upload by DynamoDB's answer: kept when the write committed, deleted when it provably didn't, reported to an observer when the outcome is unknown. `put`, `create`, `upsert`, `insert()`, `update`, `patch`, `Batch.write`, `Transaction.transactWrite`, time-series `append`, aggregate writes, EventStore appends and projections all offload, and an entity's `offload.itemBudget` routes fields when an item would be too large. Reads resolve pointers eagerly or lazily (`BlobHandle`, with `read`, `stream` and `presignedUrl`), per builder with `.offloaded(...)`; binary fields accept a `Uint8Array`, a `Stream`, a `BlobHandle` or `Offload.source(...)`.

**Stores and garbage collection.** `effect-dynamodb/blob/s3` ships the S3 store (`@aws-sdk/client-s3` is an optional peer); `BlobStore.memory()` is an in-memory store for tests. `BlobGc` frees superseded versions: a reaper over DynamoDB Streams records, per-item and per-partition sweeps, a store-wide sweep, and `purge` integration.

See the Offloaded Storage guide.
