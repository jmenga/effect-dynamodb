# @effect-dynamodb/schema

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

### Patch Changes

- Fix aggregate/ref hydration for pure entity definitions and transform-typed date fields ([#71](https://github.com/jmenga/effect-dynamodb/issues/71), [#72](https://github.com/jmenga/effect-dynamodb/issues/72)), and round-trip self-date fields nested inside refs/edges.
  - **[#71](https://github.com/jmenga/effect-dynamodb/issues/71)** — `BoundAggregate.get`/`create` no longer crash with `TypeError: runtimeEntity.get is not a function` when an aggregate edge is authored from a pure `@effect-dynamodb/schema` `EntityDefinition`. Hydration now promotes such pure edge targets to runtime entities (mirroring `DynamoClient.make`'s entity binding).
  - **[#72](https://github.com/jmenga/effect-dynamodb/issues/72)** — Transform-typed date fields (e.g. `Schema.DateTimeUtcFromString`) on an aggregate root, on a hydrated aggregate edge, and on a plain `Entity` ref target are now decoded exactly once instead of double-decoding (`SchemaError: Expected string, got DateTime.Utc`) — across aggregate `create`, `get`, and `update`. Plain-entity ref hydration re-encodes fetched refs to wire form before splicing; the aggregate reads/validates through a single tolerant decode schema (replacing the previous per-field pre-decode); and decomposed edge date fields are serialized to wire on write.
  - **Nested self-date round-trip (Option A)** — `Schema.DateTimeUtc` / `Schema.Date` (and `Schema.RedactedFromValue`) fields nested inside a `DynamoModel.ref` target or an aggregate edge model now round-trip through DynamoDB, with the nested class instance identity preserved. Covers **required and optional** nesting — `Schema.optional` / `Schema.optionalKey` classes (e.g. optional sub-aggregates), arrays of classes, and leaves.

## 1.9.3

### Patch Changes

- fix(client): bind pure `@effect-dynamodb/schema` definitions via `DynamoClient.make` (closes [#69](https://github.com/jmenga/effect-dynamodb/issues/69))

  A pure `EntityDefinition` produced by `@effect-dynamodb/schema`'s `Entity.make` — the AWS-free authoring surface introduced by the schema/runtime split ([#62](https://github.com/jmenga/effect-dynamodb/issues/62)) — was accepted by `DynamoClient.make` but bound to `never`: `db.entities.X` exposed no usable methods, and any call would also have crashed at runtime because pure definitions carry no operations or `_decodeRecord`. The single-source-of-truth goal of the split was unreachable — entities had to be re-authored with the runtime `Entity.make` to get a working client.

  This completes the split's end-to-end path:
  - **Type:** `TypedClient`'s entity mapping now matches a pure `EntityDefinition` (a second conditional branch) in addition to the runtime `Entity`, so `db.entities.X` resolves to the full bound entity (CRUD + index accessors + `scan`) for both authoring styles.
  - **Runtime:** `DynamoClient.make` transparently _promotes_ a pure definition to a full operational entity at bind time via `Entity.fromDefinition` — a thin op-attach over the definition's retained derivation data. This also fixes the silent `db.collections.*` decode crash for pure-authored members. CRUD, index queries, `scan`, collections, and table GSI derivation all work.
  - **Refs:** pure entities with refs are fully supported. Write-time ref hydration calls `.get()` on each ref target, so promotion now promotes ref targets too (one level — a `.get` does not itself hydrate, which also sidesteps cyclic refs). This package's `AnyRefValue` is unified onto the shared structural `RefEntity` carrier (also used by aggregate edges), so ref-derived id composites survive into the bound client and a ref target may be authored in either package.
  - **Derivation unified:** the runtime `Entity.make` now delegates to this package's shared `buildEntityDefinition` instead of re-implementing the EDD-90xx validation/derivation, eliminating drift between the two layers (the class of bug behind [#54](https://github.com/jmenga/effect-dynamodb/issues/54)). Promotion reuses the derived bundle, so there is no double derivation.
  - **Aggregates:** the runtime `Aggregate` now re-exports this package's `TypeId` instead of declaring a nominally-distinct `unique symbol`, closing a dual-package hazard. A pure `AggregateDefinition` remains schema-derivation-only (typed `inputSchema`/`updateSchema` for contracts) and is intentionally not bindable — the decompose/assemble engine is AWS-coupled; author aggregates with `effect-dynamodb`'s `Aggregate.make` to bind them. This is now documented on the type.

  Adds a `pure-authoring` example and type-level + runtime + connected regression tests (including pure entities with refs).

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
