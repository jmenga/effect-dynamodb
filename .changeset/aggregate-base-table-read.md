---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
---

Aggregate assembly no longer requires a secondary index, and can opt into strongly consistent reads (#93).

`collection.index` and `collection.sk` are now optional. Assembly queries the whole partition
with a bare `pk = :pk` condition and discriminates items by `__edd_e__` in memory — it issues
no sort-key condition and depends on no ordering, so when the aggregate is keyed on the table's
primary partition key the query runs against the base table. Omitting the index provisions no
LSI and stops the collection SK mirror attribute (a verbatim copy of `sk` on every non-root item)
from being written.

That removes a 10 GB item-collection cap and a permanent `CreateTable` commitment from the
structure most likely to grow — LSIs cannot be added or removed after the table exists, so an
aggregate previously could not be added to an existing table in this shape at all.

New `consistentRead` option (defaults to `false`, matching DynamoDB and `Entity`). Aggregate
writes are transactional, so an eventually consistent read taken shortly after a write can
observe a torn collection: the root may be missing, or an edge may be missing while the root is
visible — which for optional or empty-able edges assembles into a quietly incomplete aggregate.
Base-table reads can be strongly consistent; GSI reads cannot.

Three `make()`-time validations: `EDD-9041` (omitting the index when the aggregate's PK is not
the table's primary PK), `EDD-9042` (`consistentRead` against a GSI-shaped collection index) and
`EDD-9043` (`collection.index` and `collection.sk` supplied apart).

Fully backward compatible — existing index-backed aggregates keep their index, their mirror
attribute, and their behaviour.
