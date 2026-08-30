# @effect-dynamodb/schema

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
