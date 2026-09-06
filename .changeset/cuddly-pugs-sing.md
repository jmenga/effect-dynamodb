---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Filtered pagination for `Aggregate.list` (#104)

`list` now takes the paging vocabulary the rest of the library settled on in
1.16.0, plus a server-side predicate:

- **`filter`** — a `FilterExpression` on the **root-item** query, in the same
  callback and shorthand forms `BoundQuery.filter()` takes. This is a
  performance fix as much as an ergonomic one: `list` assembles each surviving
  root item with its own partition read, so filtering the result afterwards paid
  a full assembly for every aggregate it then discarded.
- **`limit` means "this many aggregates"** even under a filter — the query
  accumulates across as many requests as it takes, and **`pageSize`** sets
  DynamoDB's `Limit` (rows examined per request). Once a request over-reads, the
  returned cursor is rebuilt from the last item actually returned, so
  `cursor: null` still means genuinely exhausted.
- **`reverse`** — walk the list index descending (`ScanIndexForward: false`),
  which `list` previously could not express at all.

The sharded (`list.cardinality`) branch no longer discards paging options in
silence: `limit` now truncates the merged fan-out, and a `cursor` is rejected
with a `ValidationError` (**`EDD-9051`**) because a fan-out across N partitions
has no resumable position — previously it was accepted and the list silently
restarted from the beginning.

Also fixes an empty shorthand filter (`.filter({})`) compiling to
`FilterExpression: ""`, which DynamoDB rejects; it is now a no-op.
