# @effect-dynamodb/geo

## 1.16.0

### Minor Changes

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`e1ecfb4`](https://github.com/jmenga/effect-dynamodb/commit/e1ecfb4def8c7d04faa62cf3fc9d3f66002dd7ff) Thanks [@jmenga](https://github.com/jmenga)! - Aggregates round-trip fields with a schema transformation

  An aggregate whose model carried a transformed field could not round-trip: the write path stored Type-side values, so a `bigint` landed as `{"N":"5"}` and assembly's `Schema.BigIntFromString` decode rejected a number. Aggregate attributes are now encoded to their wire form before marshalling, at the root, sub-aggregate roots, `one` edges, `many` elements and propagated context values.

  Two further causes are fixed with it:
  - **`fieldsOf` did not see through `DynamoModel.configure`**, so any edge whose model is configured — which is most, since `identifier: true` requires it — received **no encoders at all**. Dates on those edges were stored as `{"M":{…}}` or `{"M":{}}`, meaning the date handling added in [#72](https://github.com/jmenga/effect-dynamodb/issues/72) was silently not applying to them.
  - **`aggregate.update` recognised only date transforms** when re-decoding mutated state, so a non-date transform was rejected before any item was built — even when the mutation touched only an untransformed field. The tolerance now covers every leaf transform, and remains scoped to the aggregate decode path: entities pass no such option.

  Only `BigIntFromString` and `NumberFromString` attributes change on the wire, and both were unreadable before, so **no migration is required**. Composed keys are byte-identical.

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`1e20c24`](https://github.com/jmenga/effect-dynamodb/commit/1e20c240ab44533495451c65b279f185b2c04e7a) Thanks [@jmenga](https://github.com/jmenga)! - Accept bound-client CRUD builders in `Batch.write`, `Transaction.transactWrite` and `EventStore.append({ additionalItems })`, and stop silently reinterpreting ops ([#100](https://github.com/jmenga/effect-dynamodb/issues/100))

  `db.entities.X.put(...)` returns a `BoundPut`, which the shared transactable-extraction protocol did
  not recognise — every multi-item write path rejected it with `ValidationError { entityType: "unknown" }`.
  This blocked entities authored with the pure, AWS-free `@effect-dynamodb/schema` `Entity.make`
  entirely: a pure definition carries no CRUD ops, so the bound builder is the only write descriptor
  its author can hold, which made "commit a read model atomically with the events that produced it"
  impossible. `extractTransactable` now unwraps bound builders to the intermediate they wrap.

  **Conditions on transact items are no longer silently dropped.** `.condition(...)`,
  `Entity.condition(...)`, and the implicit guards carried by `create()` (`attribute_not_exists`) and
  `deleteIfExists()` (`attribute_exists`) are compiled onto the `Put` / `Delete`. Previously
  `Transaction.transactWrite([Users.create(x)])` degraded to a blind overwrite.
  `ExpressionAttributeValues` is omitted when a condition carries no values, which also fixes
  `Transaction.check` with a value-free condition.

  **Ops the compile path cannot reproduce faithfully are rejected rather than reinterpreted.**
  `upsert` is an `UpdateItem` using `if_not_exists` for `createdAt`, immutable fields and the version
  counter — compiling it as a `Put` reset all three, including silently resetting the optimistic-lock
  counter. It now fails with a `ValidationError` on all three paths, as do entities configured with
  `refs`, `generatedId` or `vectorIndexes`, whose write contracts need a read, `Crypto` or an
  `Embedder`. `Batch.write` additionally rejects any conditioned op (`BatchWriteItem` has no
  `ConditionExpression`) and now reports unsupported ops on the error channel instead of as an
  untyped defect.

  Known gap, unchanged and now documented: entities with `unique`, `versioned: { retain: true }` or
  `softDelete` still write a single item through these paths, so their sentinel, snapshot or tombstone
  is not written. Prefer the entity's own operation for those. Tracked in [#113](https://github.com/jmenga/effect-dynamodb/issues/113).

  `@effect-dynamodb/schema` is unchanged and remains free of any AWS SDK dependency.

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`1e20c24`](https://github.com/jmenga/effect-dynamodb/commit/1e20c240ab44533495451c65b279f185b2c04e7a) Thanks [@jmenga](https://github.com/jmenga)! - `.condition(...)` now declares `ConditionalCheckFailed` on the error channel ([#102](https://github.com/jmenga/effect-dynamodb/issues/102)).

  A conditional write raised `ConditionalCheckFailed` at runtime but did not declare it, so
  `Effect.catchTag("ConditionalCheckFailed", ...)` — the whole reason to write a conditional put —
  was a type error. Callers had to `catchAll` and re-inspect `_tag`, losing exactly the
  exhaustiveness that makes `catchTags` worth using.

  Applying `.condition(...)` now widens the operation's error channel with `ConditionalCheckFailed`,
  on every surface it is exposed:
  - `BoundPut.condition()` — `db.entities.Users.put(input).condition(...)`
  - `BoundUpdate.condition()` — `db.entities.Users.update(key).set(...).condition(...)`
  - `BoundDelete.condition()` — `db.entities.Users.delete(key).condition(...)`
  - the entity-scoped pipeable — `Users.put(input).pipe(Users.condition(...))`, on unbound
    `EntityPut` / `EntityUpdate` / `EntityDelete`

  The widening is precise: an _unconditional_ `put` / `update` / `delete` keeps its narrow channel,
  and operations that already declare the error (`create`, `patch`, `upsert`, `deleteIfExists`) are
  unchanged — the union collapses. `.asEffect()` and every combinator chained after `.condition()`
  carry the widened channel. An update piped through the combinator stays an `EntityUpdate`; its
  update-payload parameter is not flattened.

  `.expectedVersion(...)` deliberately does **not** widen, and never did: `OptimisticLockError` is
  unconditional on `update` because the `versioned` and unique-constraint write paths CAS whether or
  not an expected version was supplied. The two combinators are now consistent in principle — each
  operation declares exactly the failures reachable on it.

  Also fixed on the unique-constraint transaction path: an update on an **unversioned** entity that
  touched a unique field and was rejected by a user `.condition(...)` reported `OptimisticLockError`
  — naming a version conflict that cannot occur on an entity with no version attribute. It now
  reports `ConditionalCheckFailed`. When a version CAS _is_ present, both predicates ride the same
  `ConditionExpression` and DynamoDB does not say which half failed, so the rejection is still
  attributed to the CAS as `OptimisticLockError`.

  **Semver note.** Released as a minor, not a major. Widening an error channel is technically
  breaking for code that matches the union exhaustively (`Effect.catchTags` over every tag, or a
  hand-written exhaustive `switch` on `_tag`), and the unversioned-unique fix changes which tag such
  code sees. Both are narrow, and neither breaks the common `catchTag` / `catchAll` shapes; staying
  within 1.x is the deliberate call.

  **`.condition()` on `delete` now reaches DynamoDB on every path.** The compiled condition was
  attached only in the simple `DeleteItem` branch. On entities configured with `softDelete` or a
  `unique` constraint — both of which delete via `transactWriteItems` — the guard was built and then
  dropped, and the delete proceeded unconditionally. The condition now rides the current item's own
  `Delete` in both transactions, so a rejection rolls the whole transaction back: no tombstone is
  written, no unique sentinel is released. `deleteIfExists` rode the same drop (it is `delete` plus
  `attribute_exists(pk)`) and is fixed with it, closing a read-then-write window in which a
  concurrently-deleted item could be resurrected as a tombstone.

  **`purge()` now rejects `.condition()` instead of ignoring it** — `ValidationError`, `EDD-9047`.
  `purge` deletes a whole partition across batched writes, so no single `ConditionExpression` can
  guard it atomically. Guard the individual write with `delete(key).condition(...)`.

  Without these, the error-channel widening above would declare a `ConditionalCheckFailed` that those
  entity shapes could never raise.

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`e1ecfb4`](https://github.com/jmenga/effect-dynamodb/commit/e1ecfb4def8c7d04faa62cf3fc9d3f66002dd7ff) Thanks [@jmenga](https://github.com/jmenga)! - Composite keys are composed by one rule everywhere — **storage-format change, migration required for two shapes** ([#101](https://github.com/jmenga/effect-dynamodb/issues/101), [#113](https://github.com/jmenga/effect-dynamodb/issues/113), [#114](https://github.com/jmenga/effect-dynamodb/issues/114), [#115](https://github.com/jmenga/effect-dynamodb/issues/115))

  Key composition ran on the encoded value, so a composite whose domain type is a `number` or `bigint` but whose encoded form is a **string** — `Schema.BigIntFromString`, `Schema.NumberFromString` — was written to the key as text, skipping the zero-padding that makes numbers sort correctly. Values 5 / 42 / 100 stored as `seq_5` / `seq_42` / `seq_100` and sorted `100 < 42 < 5`, so `gte(42n)` returned 42 and 5 instead of 42 and 100.

  Composition now follows one rule at every site: compose from the Encoded form, except when the domain type is numeric and the encoded form is a string, where the numeric Type form is used so it pads. `DynamoModel.DateEpochMs` composites use the padded epoch.

  **⚠️ Migration.** Rows keyed on either shape below were written under the old key and will not be found after upgrading — no error, the partition simply does not resolve. Read them by scan and re-`put` before or during the upgrade.
  - **Entity primary keys and GSI keys** with a `Schema.BigIntFromString` or `Schema.NumberFromString` composite. On 1.15.0 `put` **succeeded** and wrote these rows (only `get` was broken), so this data exists.
  - **Aggregate partition and collection keys** with a `DateEpochMs` / `DateEpochSeconds` composite, which move from their ISO form to the padded epoch.

  Composites of every other shape — plain numbers, bigints, strings, `Schema.Date`, `DateTimeUtc`, literals — are byte-identical and need no migration.

  Eleven modules previously decided independently what to hand the key composer, which is what produced the divergence. `test/KeyFormInvariant.test.ts` now reads each module as source text and fails if a `KeyComposer` call receives a record that did not go through the shared form.

  Fixed by the same change, each previously a silent wrong result:
  - `update()` rewrote GSI keys in a different format than `put()` wrote them, evicting the row from its own GSI.
  - `Transaction.transactWrite` / `Batch.write` composed a different primary key than `Entity.put`, producing unreadable orphan rows; `Batch.get`, `transactGet`, `transactWrite(delete)` and `Transaction.check` used the caller's raw key.
  - `purge()` reported success and deleted nothing.
  - `reembed()` skipped every live item — its guard compared a Type-side recompose against a stored key.
  - `getVersion()`, `deleted.get()` and `restore()` raised `ItemNotFound` for rows that exist, while `versions()` and `deleted.list()` worked.
  - `db.collections.*` and `Collections.make()` returned zero rows for values the equivalent entity accessor found.
  - Vector search composed a different partition than the write path.
  - Aggregate `list()` could not find rows `create` had written.

  Key input on `get` / `update` / `delete` and friends now takes the model's **Type** side — the same value the domain model holds and the query path accepts. Passing the wire form fails with a `ValidationError` naming the attribute rather than returning an empty result.

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`0d67a51`](https://github.com/jmenga/effect-dynamodb/commit/0d67a51b1b27907c746c6fe808f929716d12f504) Thanks [@jmenga](https://github.com/jmenga)! - Separate `limit` (results) from `pageSize` (round trips) on queries and scans

  `limit` and page size were two different ideas sharing one word. They are now two combinators:
  - **`limit(n)`** — return **at most `n` items**. A contract on results. It no longer sets DynamoDB's `Limit`; the query accumulates across as many requests as it takes to reach `n` accepted items or exhaust the key range.
  - **`pageSize(n)`** — fetch in **batches of `n` rows**. This is what sets DynamoDB's `Limit` (rows _examined_ per request). A contract on round trips, not on what comes back.
  - **`maxPages(n)`** — unchanged. Still the hard stop on the number of requests, and the escape hatch when a filter is selective enough that `limit` would otherwise walk a large partition.

  Both compose: `.pageSize(50).limit(120)` fetches in requests of at most 50 examined rows, accumulating until 120 items.

  **This is why they had to split.** DynamoDB's `Limit` bounds rows _examined_, and a `FilterExpression` is applied _after_ it — so `Limit` can never express "give me 3 matching items". Under a filter, `limit` is now satisfied by accumulating across requests; `pageSize` (or an unbounded natural page when unset) is what each request asks for. Every entity query and scan therefore gets correct filtered pagination.

  **Cursors.** Once a request can over-read and discard the surplus, `fetch()`'s cursor can no longer be the raw `LastEvaluatedKey` — that points at the last row _examined_, not the last one returned. It is rebuilt from the last item actually handed back (every item carries the table key and the index key), so the next page resumes after what the caller saw. `cursor: null` still means genuinely exhausted. When a `.select()` projection is active alongside a `limit`, the key attributes are added to the request's `ProjectionExpression` and stripped from the items returned, so a truncated page still carries an accurate cursor.

  **`count()`.** `limit(n)` caps the count: `.limit(n).count()` returns `min(matching, n)` and stops counting once `n` is reached, keeping `count()` equal to `collect().length` for the same query — and making `.limit(1).count()` a cheap existence check. `pageSize(n)` sizes each `Select: "COUNT"` request.

  ## Migration — if you used `limit` as a page-size hint, move to `pageSize`

  `limit` changes meaning on `collect()` and `paginate()`. The same call keeps compiling and quietly means something else, so check every call site:

  | Before                                             | After                                         |
  | -------------------------------------------------- | --------------------------------------------- |
  | `.limit(3).collect()` → every item, in pages of 3  | `.limit(3).collect()` → **3 items**           |
  | `.limit(2).paginate()` → everything, in pages of 2 | `.pageSize(2).paginate()`                     |
  | `.limit(100)` to size a scan's requests            | `.pageSize(100)`                              |
  | `.limit(25).fetch()`                               | unchanged — still up to 25 items and a cursor |

  Callers who wrote what the documentation showed (`.limit(3).collect()` for "the first 3") were getting every matching item; they are now correct without a change. This ships as a minor within 1.x rather than waiting for a 2.0 because the old behaviour is a trap the docs already described incorrectly.

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`1e20c24`](https://github.com/jmenga/effect-dynamodb/commit/1e20c240ab44533495451c65b279f185b2c04e7a) Thanks [@jmenga](https://github.com/jmenga)! - Aggregate: honour `sk.composite` on `many` edges, so one entity can appear more than once in an aggregate (closes [#103](https://github.com/jmenga/effect-dynamodb/issues/103))

  `ManyEdgeConfig.sk.composite` was declared, type-checked and stored on the edge, but never read — the decompose walk composed each element's sort key from the referenced entity's identifier alone. Two elements sharing a ref composed one sort key, and DynamoDB rejected the entire aggregate write with `ValidationException: Transaction request cannot include multiple operations on one item`.

  A declared `sk.composite` is now **authoritative**: it replaces the ref-identifier heuristic rather than extending it, so it decides both uniqueness and the order elements sort in. Entries name attributes on the decomposed element and may use a dotted path to reach a hydrated ref (`"umpire.id"` — hydration replaces the id field with the referenced object, so the bare name no longer exists at the top level).

  Two related fixes for the same defect — a `many` edge whose sort key is not derived from anything distinguishing:
  - **"Element IS the ref" edges now compose a sort key.** `Schema.Array(Player)` hydrates each element to the entity's own flat fields, and the identifier fallback only recognised a field literally named `id`. An entity whose identifier is `playerId` produced _no_ composites, so every element collapsed onto one row. The edge entity's declared `DynamoModel.identifier` field is now used.
  - **Colliding sort keys fail as `AggregateDecompositionError`.** Decomposition detects two items composing the same sort key and fails with the aggregate, the edge and the colliding key — instead of an opaque `DynamoValidationError` naming nothing. This is checked before any write, so nothing is persisted.

  A declared composite must resolve to a **scalar** — string, number, bigint, boolean or date. Naming the hydrated ref object itself (`sk: { composite: ["umpire"] }`) rather than a scalar path (`"umpire.id"`) previously serialised the whole object into the sort key; it now fails with `AggregateDecompositionError` pointing at the dotted form.

  **Migration.** Sort keys change for two shapes, both of which could not previously hold more than one element:
  - edges that already declared `sk.composite` (previously ignored)
  - "element IS the ref" edges whose entity identifier is not named `id` — a single-element edge stored as `$app#v1#matchplayer` now stores as `$app#v1#matchplayer#p-1`

  Existing rows in either shape are orphaned on the next update. Entity-less `many` edges over plain structs now require a declared `sk.composite`; without one, a multi-element edge fails with `AggregateDecompositionError` rather than silently writing one row per aggregate.

### Patch Changes

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`1e20c24`](https://github.com/jmenga/effect-dynamodb/commit/1e20c240ab44533495451c65b279f185b2c04e7a) Thanks [@jmenga](https://github.com/jmenga)! - Compose `.where()` sort key conditions into full sort key values (closes [#101](https://github.com/jmenga/effect-dynamodb/issues/101))

  A sort key condition applied through a named-index or primary-key accessor did
  not narrow the query. Stored sort keys are composed as
  `$schema#v1#entity#<name>_<cased value>`, but `.where()` concatenated the raw
  operand onto the entity prefix — so `gte` matched the whole partition (a raw
  value sorts below every `<name>_`-prefixed segment) while `beginsWith`, `eq`,
  `between`, `lt` and `lte` matched nothing.

  The operand is now placed in the position of the SK composite it targets and run
  through the same composer the write path uses, applying value serialization, the
  `<name>_` prefix and the schema casing. Additional behaviour that follows from
  composing correctly:
  - A condition on a **non-terminal** SK composite covers that value's whole
    subtree — `eq` compiles to a subtree `begins_with`, and inclusive upper bounds
    span the subtree.
  - When the accessor has already pinned leading SK composites, one-sided
    operators are clamped to that prefix (`Query.where` replaces the accessor's
    own `begins_with`, so an unclamped `>=` would leak into neighbouring
    composite values).
  - New `EDD-9045` when `.where()` is used on an index whose sort key has no
    composites, and `EDD-9046` for a strict `lt` on the last SK composite while an
    earlier one is pinned — DynamoDB cannot express `begins_with(prefix) AND sk <
value` in a single key condition, so this is refused rather than silently
    returning the boundary item.

## 1.15.0

### Minor Changes

- [`bb71bad`](https://github.com/jmenga/effect-dynamodb/commit/bb71bad064f8f91d8b3a2ff8dffd86baf3454477) Thanks [@mixja](https://github.com/mixja)! - Validate `timestamps` schema overrides, and support `timestamps` on `Aggregate.make`.

  **`timestamps.<slot>.schema` is now validated at make() time ([#97](https://github.com/jmenga/effect-dynamodb/issues/97)).** The `schema` half of a
  `TimestampFieldConfig` is a storage descriptor, not a codec: system timestamps are generated by
  the library, so the only thing readable off the supplied schema is its `DynamoEncoding`
  annotation. A schema without one used to be discarded silently and the field fell back to an ISO
  string — which fails at the service rather than the definition, since a GSI declaring
  `AttributeType: "N"` over that field makes DynamoDB reject the write outright with
  `ValidationException: Type mismatch for Index Key`. `Entity.make` and `Aggregate.make` now throw
  `EDD-9044` naming the offending slot. Pass an annotated `DynamoModel` date schema
  (`DateString`, `DateEpochMs`, `DateEpochSeconds`) or one re-pointed with `storedAs(...)`.

  The bare-schema form (`timestamps: { updated: DynamoModel.DateEpochMs }`) was also inert, for a
  second reason: the internal predicate tested `typeof value === "object"`, but every Effect schema
  has been callable since 4.0.0-rc, so that branch never matched and the config silently fell
  through to the default. It now applies as documented, keeping the default field name.

  **`Aggregate.make({ timestamps })` ([#98](https://github.com/jmenga/effect-dynamodb/issues/98)).** Aggregates compose their DynamoDB rows directly
  rather than routing through Entity write ops, so entity-level `timestamps` never reached them —
  in a single-table design where aggregates hold most of the data, that left the majority of the
  table with no modification timestamp and no way to add one. Aggregates now take the same
  `TimestampsConfig` and stamp every row they write: the root item, `one` and `many` edges, and
  every row inside a sub-aggregate transaction group.
  - `updated` is per row — a diff-based `update` rewrites only the groups whose content changed,
    so rows the mutation leaves alone keep their stored value.
  - `created` is carried forward on rewrite; aggregate writes are `Put`, not `UpdateItem`.
  - Timestamps are stamped downstream of the update diff, so they never widen it.
  - The attributes are stripped on the read path unless the root model declares the field itself.

## 1.14.0

### Minor Changes

- [`cbea2e8`](https://github.com/jmenga/effect-dynamodb/commit/cbea2e816d937ed7c9a7bb8d820c3d7ccdaa26ec) Thanks [@mixja](https://github.com/mixja)! - Make optional properties on definition-time config surfaces strict under `exactOptionalPropertyTypes`.

  `?: T | undefined` and `?: T` mean different things when `exactOptionalPropertyTypes` is on:
  the first permits an explicit `{ field: undefined }`, which is precisely what the flag exists
  to forbid. Declaring `| undefined` on every optional property quietly opts back out of it.

  48 optional properties across the declarative config surfaces — entity config, index
  definitions (`GsiConfig` / `IndexDefinition`), vector index config, aggregate config and edge
  descriptors, and geo index config — are now `?: T`. "Not set" is expressed by omitting the key.

  Construction sites that previously assigned an explicit `undefined` now omit the key instead,
  so absent optionals stay absent rather than becoming present-but-undefined. `VectorIndexDefinition.casing`
  changes from a required `Casing | undefined` to an optional `?: Casing` for the same reason.

  **Possible breaking change for TypeScript consumers.** Code that passes a possibly-undefined
  value into one of these fields — `{ collection: maybeUndefined }` — no longer compiles. Omit the
  key conditionally instead: `...(x !== undefined && { collection: x })`. Runtime behaviour is
  unchanged.

  Types that mirror AWS SDK command inputs (`Query`, `DynamoClient`, vector search emulation),
  runtime plumbing such as `TableConfig.ttlAttributeName`, tagged-error payloads, and the
  incremental builder-state types keep `?: T | undefined` deliberately — those legitimately receive
  computed optional values, and forcing conditional spreads on callers there would cost ergonomics
  for no safety.

## 1.13.0

### Minor Changes

- [`19e2305`](https://github.com/jmenga/effect-dynamodb/commit/19e230519975c4f4465403a8e233819906e23961) Thanks [@mixja](https://github.com/mixja)! - Aggregate assembly no longer requires a secondary index, and can opt into strongly consistent reads ([#93](https://github.com/jmenga/effect-dynamodb/issues/93)).

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

## 1.12.1

### Patch Changes

- [`1f1dd6f`](https://github.com/jmenga/effect-dynamodb/commit/1f1dd6fa911565bff5b006449944ab076d6e7f9d) Thanks [@mixja](https://github.com/mixja)! - Upgrade Effect v4 from `4.0.0-rc.109` to `4.0.0-rc.112` (and `@effect/vitest` to match).

  No source changes were required — rc.110, rc.111 and rc.112 contain no breaking changes
  affecting APIs this library uses. The interface changes in those releases (`Pool.State`,
  `Pool.PoolItem`, `Scope.State.Open`, and the `Matcher` / `ValueMatcher` flavor type
  arguments) touch modules the library does not consume.

  Consumers pick up upstream improvements for free:
  - Faster synchronous `Schema` decode/encode (completed parser exits plus a direct loop for
    common struct parsers) — this library decodes every item it reads.
  - Faster `SchemaError` construction (stack frame capture is now skipped) — validation
    failures are cheaper on hot paths.
  - `Optic` gained dual standalone `get` / `set` / `replace` / `modify` functions, usable
    alongside the cursor API exposed by `Aggregate.update`.

## 1.12.0

### Minor Changes

- [#89](https://github.com/jmenga/effect-dynamodb/pull/89) [`63eaed6`](https://github.com/jmenga/effect-dynamodb/commit/63eaed62a5cad7d57c87e9fe0de5ca52f3388071) Thanks [@jmenga](https://github.com/jmenga)! - EventStore: additional transaction items in `append` + command idempotency (closes [#85](https://github.com/jmenga/effect-dynamodb/issues/85))

  **`append(streamId, events, expectedVersion, { additionalItems })`** — commit caller-owned
  transact items atomically with the event puts. `additionalItems` accepts the same op union
  `Transaction.transactWrite` takes (`Entity.put`, `Entity.delete`, `Transaction.check`),
  compiled through a new shared builder so the two APIs cannot drift. `EntityUpdate` remains
  unsupported in both; it will land for both at once.

  **Position-aware cancellation mapping.** Previously _any_ `ConditionalCheckFailed` in
  `CancellationReasons` became `VersionConflict` — which, with caller-owned items in the
  transaction, would misreport a failed user condition and send callers into a
  read-decide-retry loop that could never succeed. Reasons are now matched by transaction
  index, with precedence `DuplicateCommand` > `VersionConflict` >
  `AdditionalItemConditionFailed` > `TransactionCancelled`.

  **Command idempotency.** `commandHandler(decider, stream, { idempotency: { ttl? } })` plus a
  per-call `commandId` writes a dedup sentinel guarded by `attribute_not_exists` into the same
  transaction, co-located in the stream partition and invisible to `read` / `readFrom` /
  `currentVersion`. A replayed `commandId` is rejected with `DuplicateCommand`. Without
  `idempotency`, command processing remains **at-least-once** — now documented in the tutorial.
  Configuring `idempotency` makes `commandId` required at the type level.

  **Transaction size guard.** `events + additionalItems + sentinel + the version-contiguity
ConditionCheck` is checked against the shared `TRANSACT_WRITE_ITEMS_LIMIT` (100) before any
  AWS call, failing with `AppendTooLarge`.

  New tagged errors: `AdditionalItemConditionFailed`, `DuplicateCommand` (both exported from
  `effect-dynamodb` and `@effect-dynamodb/schema`).

  Also fixes the data-last (pipeable) form of `EventStore.commandHandler`, which passed the
  stream and decider to the implementation in swapped order and could never have worked.

  **Type-level note:** `append`'s error channel now unconditionally includes
  `DuplicateCommand | AdditionalItemConditionFailed | AppendTooLarge`, rather than varying
  with the options passed. `Effect.catchTag` / `catchTags` callers are unaffected; a caller
  exhaustively matching on `append`'s error union will need three more cases.

- [#87](https://github.com/jmenga/effect-dynamodb/pull/87) [`f846367`](https://github.com/jmenga/effect-dynamodb/commit/f846367a541fefb9c29f40684f87f89c8333745b) Thanks [@jmenga](https://github.com/jmenga)! - EventStore: guard `append` against TransactWriteItems limits and expectedVersion-ahead version gaps ([#82](https://github.com/jmenga/effect-dynamodb/issues/82))
  - New `AppendTooLarge` tagged error and `TRANSACT_WRITE_ITEMS_LIMIT` constant, exported from both `@effect-dynamodb/schema` and `effect-dynamodb`. `append` now pre-validates the transact-item count and fails with `AppendTooLarge` before issuing any request instead of surfacing a raw AWS validation error. The batch is deliberately never chunked — chunking would break append atomicity.
  - `append` now enforces version contiguity. When `expectedVersion > 0` the transaction carries a `ConditionCheck` requiring the event at exactly `expectedVersion` to exist, so an _ahead_ expected version fails with `VersionConflict` instead of silently writing past the stream head and leaving a permanent gap in the version sequence. The check occupies one transact item, so a single append holds up to 100 events at `expectedVersion === 0` and up to 99 otherwise.

- [#90](https://github.com/jmenga/effect-dynamodb/pull/90) [`5127a60`](https://github.com/jmenga/effect-dynamodb/commit/5127a606049d89da5de92b44f74dc2182e8b4418) Thanks [@jmenga](https://github.com/jmenga)! - EventStore: snapshot support and a `commandHandler` retry option ([#84](https://github.com/jmenga/effect-dynamodb/issues/84)).
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
    whose data-last path assumes the data is the _first_ parameter — here the stream is the
    second, so `stream.pipe(commandHandler(decider))` passed the arguments swapped and threw.
    Replaced with a dispatch on the stream's `EventStreamTypeId` brand. `EventStream` and
    `BoundEventStream` are now `Pipeable`.
  - New: `DynamoSchema.composeEventVersionKeyPrefix` and `DynamoSchema.MAX_EVENT_VERSION`.

  Fully backward compatible: streams without `snapshot` and handlers without options behave
  exactly as before.

### Patch Changes

- [#88](https://github.com/jmenga/effect-dynamodb/pull/88) [`f903422`](https://github.com/jmenga/effect-dynamodb/commit/f90342267928cdc0cb50d0d4ef522dc54689de1a) Thanks [@jmenga](https://github.com/jmenga)! - fix(eventstore): codec symmetry — encode on write, decode on read

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

## 1.11.0

### Minor Changes

- [`c754d7d`](https://github.com/jmenga/effect-dynamodb/commit/c754d7d4a070090c2968a815486796326e4a722b) Thanks [@mixja](https://github.com/mixja)! - Native DynamoDB vector search (closes [#78](https://github.com/jmenga/effect-dynamodb/issues/78)).

  Declare vector indexes on an entity and the library handles the rest — embedding
  generation on write, partition composition, lifecycle stripping, and a fluent
  search builder:

  ```ts
  const Products = Entity.make({
    model: Product,
    entityType: "Product",
    primaryKey: {
      pk: { field: "pk", composite: ["tenantId", "productId"] },
      sk: { field: "sk", composite: [] },
    },
    vectorIndexes: {
      byDescription: {
        name: "vec1",
        dimensions: 1024,
        distance: "cosine",
        source: { fields: ["name", "description"] },
        partition: ["tenantId"],
        filters: ["category"],
      },
    },
  });

  const hits =
    yield *
    db.entities.Products.byDescription("waterproof hiking boots")
      .partition({ tenantId })
      .filter({ category: "footwear" })
      .topK(25)
      .collect();
  ```

  - **Pure models.** The embedding (`__edd_v_<index>__`) and composed HASH
    partition (`__edd_vp_<index>__`) are library-managed and never surface in a
    decoded record.
  - **Automatic entity + tenant scoping.** The partition value is composed by
    `KeyComposer` as `$schema#v1#<entityType>[#composites]`, so a search on a
    shared physical index cannot cross entity types or tenants.
  - **`Embedder` service** (`@effect-dynamodb/schema`, AWS-free) with an in-library
    `Embedder.layerTest`. Dimension agreement is validated at `DynamoClient.make`.
  - **Write gating.** `put`/`create`/`upsert` always embed; `update`/`patch` embed
    only when the write touches a `source.fields` member — by `set()`, `remove()`,
    a null clear, or a path operation. Clearing every source field removes the item
    from the index. `.withVector()` supplies a pre-computed embedding (its name is
    typed and validated); `reembed({ concurrency })` migrates stale vectors.
  - **Declared filters only.** Only attributes listed in an index's `filters: [...]`
    are filterable — enforced by the accessor types, at runtime, and by the
    emulation layer. Entities sharing a physical index union their filters.
  - **Typed errors.** `EmbeddingError` is in the `put`/`create`/`update`/`patch`/
    `upsert` error channel for entities that declare `vectorIndexes`, and absent
    for those that don't.
  - **Lifecycle-aware.** Version snapshots, soft-delete tombstones and time-series
    event items drop out of the index; the tombstone stashes the embedding so
    `restore()` never re-embeds.
  - **Table ops.** `create()` emits merged `VectorIndexes`; `addVectorIndex`,
    `removeVectorIndex` and `waitForVectorIndex` manage them on a live table.
  - **`VectorSearchEmulation.layer`** stands in for DynamoDB Local, which discards
    `VectorIndexes` and rejects `SearchVectors`.

  Requires `@aws-sdk/client-dynamodb` >= 3.1104.0 (bumped). The raw operation needs
  the new `dynamodb:SearchVectors` IAM action, which existing read policies do not
  cover.

  Also fixes an unrelated pre-existing bug found along the way: `upsert` did not
  store the model fields that compose the primary key (it skipped them as "already
  in the Key", but the Key holds the _composed_ `pk`/`sk` strings, not the
  composite source values). Upserted items were stored without e.g. `productId`,
  so every subsequent read — including `upsert`'s own `ReturnValues: ALL_NEW`
  decode — failed with `Missing key`.

## 1.10.0

### Minor Changes

- [`bfec5f2`](https://github.com/jmenga/effect-dynamodb/commit/bfec5f22ca03961b2bcc13dfa62b323a7bab6375) Thanks [@mixja](https://github.com/mixja)! - Upgrade to Effect 4.0.0-rc.109 (release candidate)

  The workspace moves from `effect@4.0.0-beta.85` to `effect@4.0.0-rc.109` (now published from the main Effect-TS/effect repo). The `effect` peer range is raised to `^4.0.0-rc.109` accordingly. Migrations applied:
  - **`Schema.DateValid` removed** — `Schema.Date` now rejects invalid dates itself; all `DateValid` usages (DynamoModel Unsafe date codecs, date-transform substitution) migrate to `Schema.Date` with identical validation semantics.
  - **AST introspection moved to `representation` identities** — the RC removed the `typeConstructor` / `meta` annotation payloads that date/Redacted detection sniffed via `SchemaAST.resolve`. Detection now reads the stable `representation.id` (`effect/schema/Date`, `effect/schema/DateTimeUtc`, `effect/schema/DateTimeZoned`, `effect/schema/Redacted`) through a shared `matchDateRepresentation` helper (deduplicating the former Aggregate.ts matchers).
  - **`Schema.Struct(...)` is now a function** — the `isSchemaClass` detection gains an AST-tag guard (`Declaration` vs `Objects`); without it, Struct-modeled entities were decoded through `new Struct(...)` and silently returned empty objects. A canary test locks the discriminator down.
  - **`SchemaIssue.InvalidType` signature** — the constructor takes the raw rejected input instead of an `Option`; all five custom-getter call sites updated.
  - **`DateTime.toEpochSeconds`** — replaces hand-rolled `Math.floor(toEpochMillis(...) / 1000)` TTL math in Entity and the DateEpochSeconds codec.

## 1.9.5

## 1.9.4

## 1.9.3

## 1.9.2

### Patch Changes

- fix(schema): make the AWS-free pure-authoring path actually usable (closes #66, closes #67).

  Two follow-ups to the #62 schema/runtime split, both blocking its headline use case
  (deriving a typed aggregate input/create payload from `@effect-dynamodb/schema` with
  no AWS SDK):
  - **#66** — the pure edge constructors (`Aggregate.ref` / `one` / `many`) required a
    `RefEntity` with a runtime `get` method, so aggregate edges could not be authored
    from pure `Entity.make` definitions (which have no `get`). `RefEntity` is now the
    minimal structural bound used only for derivation (`_tag`/`entityType`/`model`/
    `indexes`/`schemas`); the runtime ref-hydration narrows back to a `get`-bearing
    entity at its single call site.
  - **#67** — `deriveAggregateSchemas` (the table-free derivation entry point) returned
    `Schema.Top` members, so `typeof result.inputSchema.Type` collapsed to `unknown`.
    It is now generic and returns `Schema.Codec<AggregateInputType<…>>` (plus a
    `createSchema` alias), so the table-free path is as typed as the top-level
    `Aggregate.make` — no stub `table` tag or GSI key config needed.

  Type-checked regression tests for both land in the schema package's `tsconfig.test.json`
  gate (now wired into `pnpm check`).

## 1.9.1

### Patch Changes

- fix(release): resolve `workspace:` protocol at publish time (closes #64).

  `1.9.0` shipped with an unresolved `workspace:` spec (`effect-dynamodb`'s
  `dependencies."@effect-dynamodb/schema": "workspace:^"`, and `@effect-dynamodb/geo`'s
  `peerDependencies.effect-dynamodb`), making `effect-dynamodb@1.9.0` uninstallable for
  consumers. Root cause: `release.yml` published via `npm publish`, which does not
  rewrite the `workspace:` protocol.

  The publish step now packs each package with `pnpm pack` (which rewrites `workspace:`
  in `dependencies` and `peerDependencies` to concrete ranges) and publishes the
  resulting tarball via `npm publish` (preserving OIDC Trusted Publishing + provenance),
  with a guard that refuses to publish if any `workspace:` spec remains in the packed
  manifest. No runtime/API changes — 1.9.1 republishes 1.9.0 with correctly resolved
  dependency ranges.

## 1.9.0

### Minor Changes

- 0e56c83: feat: split pure schema/relationship-derivation layer into the new @effect-dynamodb/schema package (importable without @aws-sdk); effect-dynamodb re-exports it, non-breaking (closes #62).
  - New `@effect-dynamodb/schema` package owns the AWS-free core: `DynamoModel`, `DynamoSchema`, `KeyComposer`, the tagged `Errors`, `Projection`, the entity/aggregate derivation internals, and pure `Entity.make` / `Aggregate.make` definition builders carrying the derived `inputSchema` / `updateSchema` / `createSchema`. It has ZERO `@aws-sdk` dependency in both its runtime import graph and its emitted `.d.ts` surface — guarded by an automated test.
  - `effect-dynamodb` depends on and re-exports the entire public surface of `@effect-dynamodb/schema`, then adds the AWS runtime (DynamoClient, CRUD/query operations, Batch/Transaction/Collection, Marshaller). Existing consumers (and `@effect-dynamodb/geo`) are unaffected — every import keeps working unchanged.
  - Consumers who only need an entity/aggregate's derived schemas (e.g. HttpApi payloads, validation) can now `import { Entity, Aggregate, DynamoModel, DynamoSchema } from "@effect-dynamodb/schema"` without pulling `@aws-sdk/*` into their dependency graph or type surface.

### Patch Changes

- e0cf0ad: chore(deps): upgrade Effect v4 beta.74 → beta.85. No source changes — type-check, unit, lint all green; no breaking upstream changes affect this codebase.

## 1.8.2

### Patch Changes

- Fix EDD-9002 false positive on ref-derived `<field>Id` composites in the language-service. Closes [#54](https://github.com/jmenga/effect-dynamodb/issues/54).

  Index and primary-key composites that reference a ref's surfaced identifier attribute (e.g. `teamId` for a `team` ref) were incorrectly flagged as unknown attributes. The diagnostic's valid-attribute set was derived only from the model schema's read-side fields and never accounted for the `${field}Id` substitution the runtime applies for `refs`.

  The diagnostic now mirrors the runtime key/input schema: each field listed in the entity's `refs` config is removed from the valid-composite set and replaced by its `<field>Id` form. Referencing the bare ref field name (e.g. `team`) is still reported as an error, matching what `tsc` rejects.

## 1.8.1

### Patch Changes

- Upgrade to Effect v4 beta.74 and fix two breaking changes from the bump.
  - **`Effect.fromYieldable` removal** — `Config<T>` now extends `Effect.Effect<T, ConfigError>` directly, so the `Effect.fromYieldable(config)` wrapper is gone. Config values resolve straight through `Effect.runSync(config)`.
  - **`Schema.Array` element accessor** — beta.71 reintroduced `.value` on `Schema.Array`/`NonEmptyArray`; the element moved off `.schema`. `Aggregate` input-schema derivation read array elements via `.schema`, which silently broke ref→ID field rewriting (many-edge fields were no longer replaced with ID-string arrays). `extractArrayElement` now reads `.value` (with a `.schema` fallback for resilience across beta releases).

## 1.8.0

### Minor Changes

- Add `TableConfig.ttlAttributeName` (default `"_ttl"`) so the library writes TTL values to a configurable attribute name instead of the hardcoded `_ttl`. Closes [#51](https://github.com/jmenga/effect-dynamodb/issues/51).

  A single setting applies to every lifecycle feature on the physical table — `timeSeries: { ttl }`, `softDelete: { ttl }`, and `versioned: { retain, ttl }` write to the same attribute and `Entity.restore()` strips it. This matches DynamoDB's per-table `TimeToLiveSpecification.AttributeName`, which permits exactly one TTL attribute.

  ```ts
  const MainTable = Table.make({ schema, entities: { Users } });

  // Default (unchanged): writes to "_ttl"
  MainTable.layer({ name: "users-prod" });

  // Override: align with a TimeToLiveSpecification.AttributeName = "ttl"
  MainTable.layer({ name: "users-prod", ttlAttributeName: "ttl" });

  // Or from Effect Config
  MainTable.layerConfig({
    name: Config.string("TABLE_NAME"),
    ttlAttributeName: Config.string("TTL_ATTR").pipe(
      Config.withDefault("_ttl"),
    ),
  });
  ```

  This is fully backwards compatible — consumers who don't set the field continue to write to `_ttl`. Use it to align the library's writes with a pre-existing or migrated DynamoDB table whose TTL attribute differs, without the destructive table replacement or multi-deploy DDB rename dance.

## 1.7.4

### Patch Changes

- **`.append(input).remove(attrs)` — atomic SET + REMOVE + CAS on time-series entities (closes [#49](https://github.com/jmenga/effect-dynamodb/issues/49)).**

  `BoundAppend` gains a `.remove(attrs)` combinator that emits `REMOVE` clauses on the same `UpdateItem` that carries the scoped `SET` and CAS predicate. Use it when an event needs to clear one or more `appendInput` attributes atomically — e.g. an IoT status event whose absence of an `alert` field means "no alert this cycle; drop the existing alert state on the current item."

  **Motivating problem.** Before v1.7.4, callers wanting to clear an `appendInput` attribute were stuck with three unsatisfactory workarounds:
  - `.append(...)` then `.update().remove([...])` (two writes) — race window: a concurrent writer between the two writes could clobber the cleared state.
  - Sentinel value (e.g. `alertState: "DISABLED"`) — keeps the attribute set, leaves the item in any `'sparse'`-policied GSI half that composes it.
  - `Schema.NullOr` + null payload — writes a literal `NULL` into the item; downstream readers must tolerate it.

  `.append(input).remove(attrs)` closes the race window structurally: a single `UpdateItem` carries `SET + REMOVE + CAS`, atomic with the event `Put`.

  **GSI cascade.** Any GSI half whose composite list intersects `attrs` follows the v1.7.1 cascade-override semantics — the half evaluates with the removed composite treated as absent. Under `'sparse'` the half drops; under `'preserve'` it's a no-op (the stored key field is left as-is unless overridden). The motivating shape is a sparse-PK GSI keyed on the cleared attribute — the item drops out of that GSI in the same write.

  **Validation.** Names listed in `.remove()` are checked at execution time. The Effect fails with `ValidationError(operation: "append.remove")` if any name:
  - is not declared in `appendInput` (enrichment-preservation contract — use `.update().remove([...])` for fields outside `appendInput`);
  - names `orderBy` (would invalidate the CAS anchor);
  - names a primary-key composite (would orphan the item);
  - names a ref field (refs are create-time denormalisations — reassign via `.update()`);
  - also appears in the encoded payload with a non-`undefined` value (DynamoDB rejects `SET`/`REMOVE` overlap).

  Chained `.remove()` calls accumulate. The combinator composes with `.condition()` and `.skipFollowUp()` in any order.

  **API.** New fluent combinator on `BoundAppend`:

  ```ts
  yield *
    db.entities.Telemetry.append({ channel, deviceId, timestamp }).remove([
      "alertState",
    ]);
  ```

  The entity-level unbound `Entity.append()` also gains an optional fourth positional argument (`removeAttrs?: ReadonlyArray<string>`) — used by `BoundAppend`'s `.remove()` wiring; library consumers should prefer the fluent form on `BoundAppend`.

  **No on-disk impact, no backfill required.** Pure feature add — existing time-series entities and existing items are unaffected.

  See `guides/timeseries.mdx` for the documented usage pattern and the issue [#49](https://github.com/jmenga/effect-dynamodb/issues/49) motivating IoT case.

## 1.7.3

### Patch Changes

- **indexPolicy v1.7.3 — reframe per-half evaluation gate as skip-predicate (closes [#46](https://github.com/jmenga/effect-dynamodb/issues/46)).**

  **What broke.** Under v1.7.0 / v1.7.1 / v1.7.2, `Entity.update()` silently skipped composing GSI keys for halves declared with `composite: []` (the standard "bare entity prefix" pattern, common in single-table-design lookup GSIs like `byDeviceBinding: { pk: [deviceBinding], sk: { composite: [] } }`). Items written via `.put()` were correct — but any subsequent `.update()` that touched the OTHER half left the empty-composite half missing → invisible to the GSI. Worse, an `.update()` that bound a previously-sparse GSI for the first time wrote only the PK half, leaving the SK missing.

  **What was wrong.** The per-half evaluation gate was a "touched" predicate — a chain of `||` clauses each enumerating a shape for which to evaluate the half (payload membership in v1.7.0; `removedSet` in v1.7.1; `keyRecord` in v1.7.2). Each missed shape required another tactical patch — `.some(...)` over an empty composite array trivially returns `false`, so empty-composite halves got classified as untouched and skipped.

  **Fix.** Reframe the gate as a **skip-predicate** keyed on the gate's actual purpose (multi-writer protection): skip iff composites exist (otherwise the half value is a constant prefix), no composite was explicitly removed, and every composite is absent from BOTH `updatePayload` AND `keyRecord`. The skip-predicate's negation is observably equivalent to the cumulative `||`-chain plus `composites.length === 0` — same SET/REMOVE outcomes for every existing input. Closes [#46](https://github.com/jmenga/effect-dynamodb/issues/46) directly and the class of degenerate-case bugs that v1.7.0 → v1.7.2 patches were chasing as separate `||` arms.

  **Affected items.** Items written under v1.7.0 / v1.7.1 / v1.7.2 against entities with empty-composite-half GSIs will repair themselves on the next `Entity.update()` against them under v1.7.3. The next write composes the missing half from the constant prefix and the item rejoins the GSI. No data migration is needed; reads via the GSI start returning these items as their next update lands.

  **No API changes.** Purely an internal gate-logic refactor — same observable behavior for every input the previous gate already handled correctly, plus correct behavior for the empty-composite-half shape that was silently broken.

## 1.7.2

### Patch Changes

- **indexPolicy v1.7.2 — fix PK-composites-only GSI regression (closes [#43](https://github.com/jmenga/effect-dynamodb/issues/43)).**

  v1.7.1 introduced a per-half evaluation gate that — by design — skipped GSI evaluation on halves the writer didn't touch. Unfortunately the gate consulted only `updatePayload` and so silently classified entire GSIs as untouched whenever their composites were entirely entity primary-key composites. Those PK composites never appear in `updatePayload` (writers address the row by key, never restate them in `.set({...})`, and `.append()` filtered them out before passing to the composer). The composer never ran, `gsiNpk` and `gsiNsk` were never written, and items were invisible to the GSI for their lifetime.

  Concretely: an entity with `primaryKey: [channel, deviceId]` and a `byChannel: { pk: [channel], sk: [deviceId] }` GSI saw zero items returned from any channel-scoped query under v1.7.0 / v1.7.1, regardless of whether the writes used `.put()`, `.update()`, or `.append()` — the latter two never composed the keys, and `.update()` only re-composed them on calls that explicitly restated `channel` / `deviceId` in the payload (which no realistic writer does).

  **The fix** (two minimal patches working together):
  1. **`KeyComposer.composeGsiKeysForUpdatePolicyAware`** — the per-half gate now also counts `keyRecord` membership (the entity primary-key attributes carried into the composer alongside the payload). PK-composite-only GSI halves are now correctly classified as touched on every write that has a `keyRecord`.
  2. **`Entity.append()`** — no longer filters PK composites out of the payload it passes to the composer. The filter never solved a real problem (the composer doesn't emit redundant SETs for the underlying composite fields, and idempotent recomposition from immutable PK composites is benign) and combined with the v1.7.1 gate to silently break this pattern.

  The change is idempotent for entity-PK composites (re-composing the same value from immutable PK composites produces the same key) and preserves the v1.7.1 multi-writer fix: stamps' GSI composites are not in `updatePayload` AND not in `keyRecord` either (they're enrichment-owned model attrs), so their halves remain untouched as designed.

  **Affected items:** items written to PK-composites-only GSIs under v1.7.0 or v1.7.1 will repair themselves on the next `Entity.update()` against them. The gate now fires correctly, the structural rule composes the immutable PK values, and the missing GSI keys are SET. **No data migration required** — reads via the GSI start returning these items as their next update lands. If you have items that aren't naturally updated, a one-shot bulk `Entity.update(key).set({ otherField: value })` (or even an empty-payload update touching only `updatedAt` + version) is enough to repair them.

  **No API changes** — same `indexPolicy: { pk, sk }` declaration shape, same `Entity.update` / `Entity.append` signatures, same EDD-9025 invariants. Behavior change is strictly more correct than v1.7.1.

  See `DESIGN.md §7` for the updated decision algorithm and `guides/index-policy.mdx` for the updated walkthrough plus the _byChannel GSI returns 0 items_ pitfall.

## 1.7.1

### Patch Changes

- **indexPolicy v1.7.1 — per-half roll-up corrections (closes [#41](https://github.com/jmenga/effect-dynamodb/issues/41)).**

  v1.7.0 shipped the per-key declaration model (`indexPolicy: { pk, sk }`) but had three connected bugs in how outcomes were rolled up. All three were rooted in the same defect: the model was per-half on declaration but not on evaluation, outcome, or cascade. v1.7.1 makes all four uniformly per-half.

  **Bug fixes** (strictly more correct than v1.7.0):
  1. **GSI-wide cascade on can't-compose → per-key REMOVE.** v1.7.0 REMOVE'd both `gsiNpk` AND `gsiNsk` whenever either half couldn't compose. v1.7.1 REMOVEs only the half that couldn't compose; the other half's stored value persists. Closes the multi-writer enrichment-on-pk + telemetry-on-sk scenario that v1.7.0 was designed to enable but didn't actually enable correctly.
  2. **`CompositeKeyHoleError` (EDD-9024) deprecated — no longer thrown.** The v1.7.0 throw under preserve+hole was a defensive runtime safety net for a case the type system already catches (required composites can't be omitted under `exactOptionalPropertyTypes` since v1.7.0 reverted the NullishOr widening). The class export is preserved for back-compat with consumers who type-imported it for `Effect.catchTag` handlers, but no code path raises it anymore. Hole patterns now collapse into the unified per-half can't-compose rule.
  3. **Per-half evaluation gate (NEW in v1.7.1).** v1.7.0 fired the policy on every update of every GSI declaring `indexPolicy`, regardless of whether the writer touched the half. This made stamps and unrelated writers blow away sparse halves they didn't own. v1.7.1 skips untouched halves entirely — a half is touched iff at least one of its composite names appears in the update payload OR in `Entity.remove([...])`.

  **Behavior change:**
  - **`Entity.remove([attr])` is now per-half** (no longer GSI-wide). Removing a composite REMOVEs only the half(s) whose composite list contains it. Other halves follow the per-half evaluation gate (untouched → noop). Combined with the new "cascade override under preserve" rule, the consumer's explicit signal still gets honored — preserve + can't-compose + composite in `removedSet` → REMOVE that half.

  **No API changes:**
  - Same `indexPolicy: { pk, sk }` declaration shape.
  - Same `Entity.remove([...])` API.
  - Same EDD-9025 invariants (composite attributes can't be `Schema.NullOr`).
  - Same `Schema.optional(...)` pattern for sparse composites.

  **v3 model preserved:** the per-key declaration, two-way payload classification, and EDD-9025 footgun gate from v1.7.0 are all preserved unchanged. v1.7.1 only fixes the roll-up.

  See `DESIGN.md §7` for the full v1.7.1 decision algorithm and the `guides/index-policy.mdx` rewrite for the concept-first walkthrough.

## 1.7.0

### Minor Changes

- [`5825d73`](https://github.com/jmenga/effect-dynamodb/commit/5825d73488a255733b965ab2c8e93e1c92c38517) Thanks [@mixja](https://github.com/mixja)! - **indexPolicy v3 — per-half model, structural composition, EDD-9025 invariant.** Closes [#39](https://github.com/jmenga/effect-dynamodb/issues/39) and supersedes [#38](https://github.com/jmenga/effect-dynamodb/issues/38).

  > **Heads up — breaking changes inside a minor bump.** The 1.6.0 → 1.7.0 transition would normally be a major bump on semver grounds, but in-the-wild consumer count is currently ~1 (the author's own consumer migration), so the bump is shipped as minor to accelerate iteration. Future consumers should treat 1.7.0 as if it were 2.0.0 and read this entry before upgrading.

  The v1.6 per-attribute `indexPolicy` callback model proved unwieldy in practice. The standard `update`/`patch` path has only payload-level information (no read-before-write), so per-attribute granularity within a single composed-key half collapsed to per-half outcomes anyway. v3 simplifies to a per-half declaration with a structural composition rule, and closes the `set({composite: null})` footgun at the type level.

  ### What's new in v1.7.0
  - **Per-half `indexPolicy: { pk, sk }`.** Both halves default to `'preserve'` when omitted. Replaces the v1.6 `indexPolicy: (item) => ({ attr: 'sparse' | 'preserve' })` callback API.
  - **Structural composition (longest valid leading prefix).** Symmetric on PK and SK — the v1.6 PK-clear-degrades-to-sparse asymmetry is gone. Hierarchical PK truncation (e.g. `pk.composite = ['accountId', 'fleetId']` → omit `fleetId` → partition key truncates to `account#A`) is **new and additive**.
  - **Two-way payload classification.** `null` = `undefined` = absent. The v1.6 three-way classification (present / explicit-clear / omitted) collapses; `set({attr: null})` no longer separately cascades GSI keys.
  - **Two coherent drop triggers** — both predictable, both tied to clear caller intent:
    - `Entity.remove([attr])` cascade (per-attribute, explicit, per call) — unchanged.
    - `'sparse'` policy + whole-half-empty (per-half, implicit, declared at the index) — narrower than v1.6's per-composite leakage.
  - **Policy-aware hole detection.** Hole pattern (`[A, _, C]`) under `'preserve'` throws `CompositeKeyHoleError` (EDD-9024); under `'sparse'` truncates to the leading prefix (or, if the leading prefix is empty, collapses to whole-half-empty + drop).
  - **EDD-9025 — `CompositeNullableError`.** New `Entity.make()` validation that walks every composite (across `primaryKey`, every entry in `indexes`, every entry in `unique` constraints) and throws if the composite's Schema includes `null` in its type union (`Schema.NullOr`, `Schema.NullishOr`, `Schema.Union` with a Null branch). Composites participate in string composition; null is not a meaningful slot value.
  - **Append unifies with update.** `.append()` now calls the same composer as `.update().set()` — the v1.6 `appendInput`-policy-filter wrapper is gone. Composites outside `appendInput` are simply absent under the structural rule.
  - **`writerScope` (proposal [#38](https://github.com/jmenga/effect-dynamodb/issues/38)) is superseded.** v3's narrower implicit-drop trigger eliminates the cross-writer leakage that motivated `writerScope`.

  ### Breaking changes — migration

  **Per-attribute callback → per-half object literal.** Take the most-restrictive per-attribute policy on each half:

  ```diff
   indexes: {
     byAlert: {
       name: "gsi1",
       pk: { field: "gsi1pk", composite: ["alertState"] },
       sk: { field: "gsi1sk", composite: ["deviceId"] },
  -    indexPolicy: () => ({ alertState: "sparse" }),
  +    indexPolicy: { pk: "sparse", sk: "preserve" },
     },
   }
  ```

  **`set({attr: null})` no longer cascades GSI drop.** Use `Entity.remove([attr])` for atomic remove + GSI cascade:

  ```diff
  - yield* db.entities.Devices.update(key).set({ alertState: null })
  + yield* db.entities.Devices.update(key).remove(["alertState"])
  ```

  **Update-payload type widening reverted.** v1.6 wrapped each update field in `Schema.NullishOr`. v1.7 reverts this; `set({ attr: null })` only compiles when the model declares the attr as nullable. Combined with EDD-9025, this closes the stale-GSI footgun at the type level — `set({composite: null})` no longer compiles.

  **EDD-9025 — composite attribute schemas can't include `null`.** Convert nullable composites to `Schema.optional(...)` (T | undefined; the sparse pattern):

  ```diff
   class Device extends Schema.Class<Device>("Device")({
     channel: Schema.String,
     deviceId: Schema.String,
  -  tenantId: Schema.NullOr(Schema.String),    // ← composite, EDD-9025 rejects
  +  tenantId: Schema.optional(Schema.String),  // ← T | undefined, allowed
   }) {}
  ```

  **Hierarchical PK truncation is now supported (additive).** If you relied on the v1.6 PK-drop behavior on `set({pkComposite: null})`, declare the PK half as `'sparse'` to keep that semantic. Otherwise, the new behavior — truncate to leading prefix — is the right default for multi-tenant fleet / multi-org-project shapes.

  **Hole detection is now policy-aware.** Under `'preserve'`, holes still throw `CompositeKeyHoleError` (EDD-9024). Under `'sparse'`, holes silently truncate (or drop when the leading prefix is empty). If your code relied on the v1.6 strict throw on a sparse half, restructure so holes can't form (e.g. by putting only one composite on each half).

  **Mixed sparse/preserve attrs in same half → not expressible.** Pick one per half. The half is a single concatenated string; per-attribute mixing within a half had no coherent runtime semantic anyway.

  See `DESIGN.md §7 Policy-Aware GSI Composition` and `guides/index-policy.mdx` for the full v3 model + worked examples.

## 1.6.0

### Minor Changes

- indexPolicy v2 — unified-hierarchy attribute model, three-way payload classification, hierarchical SK pruning, hole detection. Plus the SparseMap opt-in is renamed to a typed callable.

  **indexPolicy v2 — behavior changes (closes [#36](https://github.com/jmenga/effect-dynamodb/issues/36))**
  - The runtime now distinguishes three payload states per composite attribute: present-with-value, explicit clear (`null` or `undefined`), and omitted. `null` and `undefined` collapse — both signal "explicit clear, drop this composite from the key now" — and they cascade unconditionally regardless of policy.
  - Omission still defers to `indexPolicy` (`'sparse'` drops the GSI; `'preserve'` is a no-op).
  - Pre-1.6 collapsed omission and explicit `null`/`undefined`, with `'sparse'` firing on every update regardless of whether the caller touched that composite. **Audit any existing `set({ attr: null })` paths** — intent is now unambiguous (always cascades). Switch any `'sparse'` policies that aren't really membership-driving (hybrid-writer GSIs) to `'preserve'`. See the migration table in the [indexPolicy guide](https://github.com/jmenga/effect-dynamodb/blob/main/packages/docs/src/content/docs/guides/index-policy.mdx#migrating-from-150).

  **Hierarchical SK pruning — new opt-in feature**
  - When a _trailing_ SK composite is explicitly cleared with `'preserve'` policy, `gsiNsk` truncates to the leading prefix instead of dropping the GSI entirely. The item stays queryable at the parent (coarser) hierarchy depth — geographic, org, workflow, content classification, permission scope, order grouping. See DESIGN.md §7.6.

  **Hole detection — new write-time validation**
  - An SK composite cleared at position `i` with another SK composite at position `j > i` still present produces a syntactically invalid prefix that no `begins_with` query would match. The library now throws `CompositeKeyHoleError` (EDD-9024) at write time, naming the GSI, the cleared composite, and the offending trailing composite. Pre-existing latent bugs (silent broken keys) become loud failures.

  **SparseMap API rename — breaking change, low blast radius**
  - `storedAs: 'sparse'` (magic string) → `storedAs: DynamoModel.SparseMap()` (typed callable). The `prefix` option moves from a sibling on `ConfigureAttributes` into the `SparseMap({ prefix })` config object — where it semantically belongs.
  - 1.5.0 was the only release that used the magic string; consumer adoption is minimal. No backward-compat shim — mechanical rename.
  - Two motivations: (1) the magic-string `'sparse'` collided with the `indexPolicy` `'sparse'` value (opposite meanings), confusing consumers; (2) the callable form lets options live where they belong rather than as siblings only meaningful when paired with the right `storedAs` value.

  **Type-level changes**
  - `EntityUpdateType` now widens each field to `T | null | undefined` so consumers can express explicit clears through TypeScript without casting. The runtime already accepted them via `Schema.NullishOr` wrap.
  - `ConfigureAttributes.storedAs` becomes `Schema.Schema<A> | SparseMapConfig`. The `| 'sparse'` literal union is dropped.
  - `ConfigureAttributes.prefix` removed from top level.
  - New exports: `DynamoModel.SparseMap`, `DynamoModel.SparseMapConfig`, `DynamoModel.isSparseMapConfig`, `CompositeKeyHoleError`, `makeCompositeKeyHoleError`, `KeyComposer.composeSkPrefixUpTo`.

## 1.5.0

### Minor Changes

- 7a7e72f: Add **SparseMap** storage primitive (`storedAs: 'sparse'`) — flattened storage for logical `Record<K, V>` fields, with each map entry stored as an independently addressable top-level DynamoDB attribute named `<prefix>#<key>`.

  The headline win is per-bucket atomic counters on a fresh item without parent-map ceremony — `ADD totals#2026-01 :1` works as a single op on a row that has never been touched before. Concurrent writers to disjoint buckets never race.

  **API surface:**
  - `DynamoModel.configure(model, { field: { storedAs: 'sparse' } })` — opt in. Optional `prefix` override.
  - Reads transparent — `get` / `query` / `scan` / batch / streams rebuild the domain `Record<K, V>` from flattened attributes.
  - Record-style writes: `.set({ field: { ... } })` decomposes into one SET per bucket (whole-bucket replace; concurrent disjoint-bucket writes safe).
  - Path-style writes: `PathBuilder.entry(key)` plus `.pathAdd` / `.pathSet` for atomic per-leaf updates within a known bucket. Counter case (scalar buckets) needs no bucket ceremony.
  - `.removeEntries(field, keys)` — explicit per-key REMOVE (`null` in record-style is **not** REMOVE — too footgunny).
  - `.clearMap(field)` — Get-then-Update helper that folds REMOVE clauses into the same final UpdateItem as the rest of the builder's combinators. Atomic for `versioned: { retain: true }` entities; best-effort for non-versioned.
  - Conditional ops: `attribute_exists(<prefix>#<key>)` via the path API.

  **Lifecycle interactions:**
  - `versioned: { retain: true }` — snapshots preserve flattened attrs verbatim.
  - `softDelete` — sparse data is preserved across soft-delete and restore.
  - `timeSeries` — sparse fields are aggregate state, not event state. They live on the current item only and are **not** carried on event items (`#e#<orderBy>`).

  **Validation at `Entity.make()` (EDD-9020..9023):** sparse fields must be `Schema.Record`, must not be nested-sparse, must not participate in primary-key/GSI composites or unique constraints, must have distinct prefixes that don't collide with non-sparse field names. User-supplied keys must not contain `#` (validated at write time; no silent escaping).

  See `docs/guides/sparse-maps` for the full guide and `examples/guide-sparse-maps.ts` for a runnable program.

## 1.4.0

### Minor Changes

- fix(entity): correct codec direction so RedactedFromValue and other transform schemas round-trip ([#29](https://github.com/jmenga/effect-dynamodb/issues/29))

  The write paths (`put`, `create`, `update`, `upsert`, `append`, batch/transaction puts) now run `Schema.encode` end-to-end against the entity's input/update schema so any Effect Schema transform (e.g. `Schema.RedactedFromValue`, `Schema.NumberFromString`, `Schema.DateTimeUtcFromString`, custom `decodeTo` chains) round-trips cleanly. Previously the put path validated against the encoded form, which rejected domain instances like `Redacted.make(...)` with `Invalid data <redacted>`.

  Storage-format substitution: at `Entity.make()` time, self date schemas (`Schema.DateTimeUtc`, `Schema.DateTimeZoned`, `Schema.DateValid`) carrying a `DynamoEncoding` annotation are substituted with bidirectional date transforms whose wire format matches the legacy `serializeDateForDynamo` output byte-for-byte. `Schema.RedactedFromValue(...)` fields are substituted with a tolerant Redacted transform (Effect v4's `RedactedFromValue` forbids encoding by default).

  **Breaking change** (narrow): combining a transform schema with a `DynamoEncoding` storage override now raises a clear error at `Entity.make()` time, e.g.

  ```
  [effect-dynamodb] Field "createdAt": cannot apply DynamoEncoding storage override to a transform schema. Either declare a self schema (Schema.DateTimeUtc) and let the annotation drive storage, OR declare a transform and own the wire format — not both.
  ```

  Migrate by either declaring a self schema (`Schema.DateTimeUtc.pipe(DynamoModel.storedAs(...))`) or dropping the override.

  Closes [#29](https://github.com/jmenga/effect-dynamodb/issues/29).

## 1.3.3

### Patch Changes

- [#28](https://github.com/jmenga/effect-dynamodb/pull/28) [`520035b`](https://github.com/jmenga/effect-dynamodb/commit/520035b844e1c49b06bbaefdeba7d99e522b63b5) Thanks [@jmenga](https://github.com/jmenga)! - Fix: unique-constraint sentinels are now sparse — they are only written when every composing field is present on the record (mirrors GSI sparse semantics). Previously, `Entity.put` / `.create` and the related update / delete / restore / purge paths called `KeyComposer.serializeValue(undefined)`, which coerced missing values to the literal string `"undefined"` and synthesized a sentinel keyed on that string. The first record with the field unset succeeded; every subsequent record collided with a false `UniqueConstraintViolation` (issue [#25](https://github.com/jmenga/effect-dynamodb/issues/25)).

  The sparse rule applies symmetrically across all six sentinel sites: `put`/`create`, `update` rotation, hard-delete cleanup, soft-delete cleanup, `restore` re-establish, and `purge` cleanup. The update path now distinguishes four transition states — `undefined → undefined` (no-op), `undefined → defined` (Put only), `defined → undefined` (Delete only), and `defined → defined, changed` (Delete + Put) — instead of unconditionally rotating both sides.

  Migration: any deployment running 1.3.x with a unique constraint on an optional field may have phantom sentinel rows of the form `<entity>._unique.<name>#undefined`. The new code never reads or writes them, so they are harmless; clean them up with a one-time scan if desired.

## 1.3.2

### Patch Changes

- fix(entity): `decodeMarshalledItem` tolerates missing GSI key attributes on sparse-indexed items. `itemSchema` previously required every GSI pk/sk field as `Schema.String`, so decoding a DynamoDB Stream `NewImage` for an item whose GSI composites haven't been stamped yet (e.g. ingest-before-enrichment patterns) failed with `ValidationError: MissingKey`. GSI key fields are now `Schema.optional(Schema.String)` in `itemSchema`; primary pk/sk remain required. Closes [#16](https://github.com/jmenga/effect-dynamodb/issues/16).

## 1.3.1

### Patch Changes

- Fix: `Entity.update` retain path (`versioned: { retain: true }`) marshalled domain `DateTime.Utc` values as DynamoDB Maps, corrupting writes and breaking subsequent reads.

  **Regression introduced in 1.3.0.** The retain path built `newItem` by spreading `currentRaw` (storage primitives from DynamoDB) with `hydratedUpdates` (decoded via the new `fromSelf` variants, so date fields are domain `DateTime.Utc` instances), then called `toAttributeMap(newItem)` without a `serializeDateFields` pass. AWS SDK's `marshall` with `convertClassInstanceToMap: true` then stored the DateTime class as a Map:

  ```json
  "updatedAt": { "M": { "epochMilliseconds": { "N": "..." }, "~effect/time/DateTime": { "S": "..." }, "_tag": { "S": "Utc" } } }
  ```

  Subsequent reads failed with `deserializeDateFromDynamo: expected string for DateTime.Utc/string, got object`.

  **Fix:** Pre-serialize `hydratedUpdates` to storage primitives before merging into `newItem`, mirroring what the non-retain path already does. The system-field block reads from the serialized map, so user-supplied colliding `updatedAt` values also land as storage primitives (not Maps). Affects any entity with `versioned: { retain: true }` that has model-declared date fields or uses the collision-aware timestamp pattern from 1.3.0.

  Put, upsert, append, and non-retain update paths were already correct — only the retain path was missing the serialization step.

## 1.3.0

### Minor Changes

- Domain-value input decode, timestamp collision handling, and adaptive generation.

  **Fixes [#19](https://github.com/jmenga/effect-dynamodb/issues/19)** — `Entity.put/create/update/upsert` (and `Transaction`/`Batch` put paths) now correctly decode domain values. Previously, TypeScript said "pass me a `DateTime.Utc`" but the runtime decoded via a transform schema that expected an ISO string — callers who followed the TS contract hit a `ValidationError`. The runtime decode now uses `fromSelf` variants for date-annotated fields, matching the TS contract.

  **New: declare system-field-colliding timestamps in your model.** If your domain model declares `createdAt` / `updatedAt` with a date-compatible schema (e.g. `Schema.DateTimeUtcFromString`, `Schema.DateFromString`, `Schema.DateTimeUtc`), and `timestamps: true` is set:
  - The input type marks the colliding fields as optional — caller may omit them (library auto-generates) or supply their own value (user value wins, useful for imports/backfill).
  - The library-generated timestamp respects the model field's storage encoding, so declaring `createdAt: Schema.DateTimeUtcFromString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds))` yields epoch-seconds storage even though the library is generating the value.
  - `createdAt` is treated as immutable in the update schema (stripped entirely).

  **New: user-owned non-date fields that collide with a system field name.** If your model declares e.g. `createdAt: Schema.String` (as a user-managed composite value, not a timestamp), the library detects the non-date collision and yields the field to the user — library timestamp management applies only to non-colliding fields (e.g. `updatedAt`). Preserves existing patterns that use `createdAt` as a plain string SK composite.

  **Errors:**
  - `EDD-9021` — the `version` field cannot be declared in the model alongside `versioned: true`, because optimistic locking requires library-managed increment.

  **Type ergonomics.** The exposed `inputSchema` / `createSchema` / `updateSchema` codec types (and the corresponding `Entity.put` / `create` / `update` call signatures) now flatten into plain object literals in hover tooltips instead of showing as wrapped generic aliases.

## 1.2.0

## 1.1.0

## 1.0.0

### Minor Changes

- [#4](https://github.com/jmenga/effect-dynamodb/pull/4) [`76654b7`](https://github.com/jmenga/effect-dynamodb/commit/76654b7a6d35a361fe74a2733bdfb1ce837504bf) Thanks [@jmenga](https://github.com/jmenga)! - Add `.primary()` query accessor on the bound client

  Every entity now exposes a `.primary(...)` accessor on `db.entities.*` alongside the existing GSI accessors. The primary index is treated symmetrically with GSIs: pass required PK composites (and optionally one or more SK composites) to get back a `BoundQuery` with the full combinator surface (`.where()`, `.filter()`, `.select()`, `.limit()`, `.reverse()`, `.startFrom()`, `.consistentRead()`, `.collect()`, `.fetch()`, `.paginate()`, `.count()`).

  Previously the primary index was deliberately excluded from accessor generation, so the shared-PK join-table pattern (many items under one partition key, distinguished by SK) had no first-class typed query path — only `.get(fullKey)` or a raw `Query.make` escape hatch.

  ```ts
  // List every membership in an organization — PK only, SK composites omitted
  const allMembers =
    yield *
    db.entities.Memberships.primary({
      orgId: "org-acme",
    }).collect();

  // Narrow by partial SK composite (begins_with prefix match)
  const bobs =
    yield *
    db.entities.Memberships.primary({
      orgId: "org-acme",
      userId: "u-bob",
    }).collect();
  ```

  `.get(fullKey)` remains the dedicated `GetItem` path for single-item strongly-consistent reads. Resolves [#2](https://github.com/jmenga/effect-dynamodb/issues/2).

### Patch Changes

- Updated dependencies [[`76654b7`](https://github.com/jmenga/effect-dynamodb/commit/76654b7a6d35a361fe74a2733bdfb1ce837504bf)]:
  - effect-dynamodb@1.0.0
