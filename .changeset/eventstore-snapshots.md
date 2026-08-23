---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

EventStore: snapshot support and a `commandHandler` retry option (#84).

- **Snapshots** — opt in with `makeStream({ ..., snapshot: { schema, every? } })`. One
  snapshot item per stream lives in the stream partition under a distinct sort key
  (`$<schema>#v<n>#<stream>.snapshot`) that can never collide with an event sort key.
  State round-trips through the supplied schema (encode on write, decode on read), so
  transforming schemas work. New primitives: `writeSnapshot` / `readSnapshot` (also on
  `BoundEventStream`). Snapshot writes are monotonic — losing the race is a no-op, never
  a cache regression.
- **Snapshot-aware `commandHandler`** — when a stream declares `snapshot`, each command
  runs `readSnapshot → readFrom(asOfVersion) → foldFrom → decide → append` instead of a
  full replay. With `every: N`, a fresh snapshot is written (best-effort) after a
  successful append once N events have accumulated since the last one.
- **Retry** — `commandHandler(decider, stream, { retry })` accepts a max-attempts number
  or an Effect `Schedule`. On `VersionConflict` the **full** read-decide-append cycle
  re-runs, so every attempt decides against fresh state; a blind re-append is impossible
  by construction. Domain and infrastructure errors are never retried. Default: no retry.
- **Event reads are SK-range hardened** — `read` / `readFrom` / `currentVersion` /
  `query.events` now bound the key condition to the event sort-key range instead of
  relying on the `__edd_e__` filter alone (DynamoDB applies `Limit` before
  `FilterExpression`). `currentVersion` also switched from `Query.collect` to the
  single-page terminal — it previously walked the whole partition one request per item.
- **Fixed: `commandHandler`'s data-last form.** It was declared with `Function.dual`,
  whose data-last path assumes the data is the *first* parameter — here the stream is the
  second, so `stream.pipe(commandHandler(decider))` passed the arguments swapped and threw.
  Replaced with a dispatch on the stream's `EventStreamTypeId` brand. `EventStream` and
  `BoundEventStream` are now `Pipeable`.
- New: `DynamoSchema.composeEventVersionKeyPrefix` and `DynamoSchema.MAX_EVENT_VERSION`.

Fully backward compatible: streams without `snapshot` and handlers without options behave
exactly as before.
