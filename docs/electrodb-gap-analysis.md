# ElectroDB Feature Gap Analysis

> Phase 7, Group 1 — Competitive analysis for effect-dynamodb v1.0 publish readiness.

## Overview

ElectroDB is the most feature-rich existing DynamoDB ORM for TypeScript. This analysis maps its features against effect-dynamodb to identify gaps, advantages, and prioritized recommendations.

**Methodology:** Complete feature inventory of ElectroDB (from electrodb.dev documentation) compared against effect-dynamodb source code (16 modules, 13,400 lines of test code). Updated after Phase 8 (DynamoModel + ElectroDB gap resolution).

---

## Feature Comparison Matrix

### 1. Data Modeling

| Feature | ElectroDB | effect-dynamodb | Status |
|---------|-----------|-----------------|--------|
| Schema definition | Inline JS objects with type inference | Effect Schema (Schema.Class/Struct) | **Advantage** — richer validation, bidirectional transforms, branded types |
| Attribute types | string, number, boolean, map, list, set, any, CustomAttributeType | All Effect Schema types | **Advantage** — full Schema ecosystem |
| Required attributes | `required: true` property | Schema-level required/optional | Parity |
| Default values | `default: value \| () => value` | Schema defaults | Parity |
| Attribute validation | `validate: RegExp \| callback` | Schema `.check()` with named factories | **Advantage** — composable, named checks |
| Read-only after creation | `readOnly: true` | `DynamoModel.Immutable` annotation | Parity |
| Field aliasing | `field: "dbFieldName"` | `DynamoModel.configure(model, { field: { field: "dbName" } })` | Parity |
| Hidden attributes | `hidden: true` (excluded from responses) | `DynamoModel.Hidden` annotation | Parity |
| Attribute labels for keys | `label: "customPrefix"` | Not supported (attribute name used) | **Gap** |
| Attribute padding in keys | `padding: { length, char }` | Not supported | **Gap** |
| Getter/setter hooks | `get`/`set` callbacks per attribute | Not supported | **Gap** (see note 1) |
| Watch attribute changes | `watch: ["attr1"] \| "*"` | Not supported | **Gap** (see note 1) |
| Calculated attributes | Via watch + set | Not supported | **Gap** (see note 1) |
| Virtual attributes | Via watch + get (never persisted) | Not supported | **Gap** (see note 1) |
| Enum attributes | Array of allowed values | `Schema.Literals([...])` | Parity |
| DynamoDB native Set type | `type: "set"`, items: "string"/"number" | Not supported | **Gap** |
| Opaque/branded types | `CustomAttributeType<T>` | Effect Schema branded types | **Advantage** — first-class support |

> **Note 1:** ElectroDB's getter/setter/watch/calculated/virtual attributes are a different paradigm from Effect Schema transforms. Effect Schema provides `Schema.transform`, `Schema.transformOrFail`, and custom annotations that cover most of the same use cases through a composable, declarative approach. These are not a gap in capability so much as a different design philosophy.

### 2. Indexes

| Feature | ElectroDB | effect-dynamodb | Status |
|---------|-----------|-----------------|--------|
| Named access patterns | Yes | Yes (index names on Entity) | Parity |
| Composite key composition | Attribute arrays | ElectroDB-style attribute arrays | Parity |
| Custom key templates | `template: "${attr}_suffix"` | Not supported (attribute-list only) | **Gap** (intentional) |
| Key casing | `"upper"/"lower"/"none"` | `"lowercase"/"uppercase"/"preserve"` | Parity |
| Isolated indexes | `type: "isolated"` (default) | Supported | Parity |
| Clustered indexes | `type: "clustered"` | Supported (default for collections) | Parity |
| Composite indexes (multi-attr keys) | `type: "composite"` (Nov 2025 feature) | Not supported | **Gap** |
| Sparse indexes | `condition` callback | `tryComposeIndexKeys` (auto-sparse) | Parity |
| Index scope | `scope` string for entity isolation | Not supported | Minor gap |
| Attributes as indexes | When attribute field matches index field | Not supported | **Gap** |
| Sub-collections | `collection: ["parent", "child"]` | `collection: ["parent", "child"]` | Parity |

### 3. Read Operations

| Feature | ElectroDB | effect-dynamodb | Status |
|---------|-----------|-----------------|--------|
| Get (single item) | `entity.get(pk).go()` | `Entity.get(key)` | Parity |
| Query by access pattern | `entity.query.<name>(pk).go()` | `Entity.query.<name>(pk)` | Parity |
| Sort key conditions | begins, between, gt, gte, lt, lte | eq, lt, lte, gt, gte, between, beginsWith | Parity |
| Filter expressions | `.where((attrs, ops) => ...)` callback | `Query.filter(conditions)` object-based | Parity |
| Find (auto index selection) | `entity.find(attrs).go()` | Not supported | **Gap** |
| Match (auto index + filter) | `entity.match(attrs).go()` | Not supported | **Gap** |
| Scan | `entity.scan.go()` | `Entity.scan()` returning `Query<Record>` | Parity |
| Collection query | `service.collections.<name>(pk)` | `Collection.query(pk)` | Parity |
| Batch get | `entity.get([...]).go()` | `Batch.get(items)` | Parity |
| Transact get | `service.transaction.get(cb)` | `Transaction.transactGet(items)` | Parity |
| Cursor-based pagination | `cursor` in response | `Query.paginate` → Stream | **Advantage** — Stream-based pagination is more composable |
| Auto-pagination | `pages: "all"` | `Query.execute` collects all pages | Parity |
| Page count limiting | `pages: N` | `Query.maxPages(n)` | Parity |
| Count mode | `count: N` target items | `Query.count` terminal | Parity |
| Consistent reads | `consistent: true` | `Entity.consistentRead()`, `Query.consistentRead()` | Parity |
| Projection expression | `attributes: [...]` | `Projection.projection(attrs)` | Parity |
| Response data format | `"attributes"/"includeKeys"/"raw"` | 4 decode modes: asModel/asRecord/asItem/asNative | **Advantage** — richer decode options |
| Hydrate (KEYS_ONLY GSI) | `hydrate: true` auto batch-get | Not supported | **Gap** |
| Preserve batch order | `preserveBatchOrder: true` | Positional tuple matching (always ordered) | **Advantage** |

### 4. Write Operations

| Feature | ElectroDB | effect-dynamodb | Status |
|---------|-----------|-----------------|--------|
| Put (create/overwrite) | `entity.put(data).go()` | `Entity.put(input)` | Parity |
| Create (fail if exists) | `entity.create(data).go()` | `Entity.create(input)` | Parity |
| Upsert (create or update) | `entity.upsert(data).go()` | `Entity.upsert(input)` | Parity |
| Update | `entity.update(pk).set({}).go()` | `Entity.update(key).pipe(Entity.set(updates))` | Parity |
| Patch (fail if not exists) | `entity.patch(pk).set({}).go()` | `Entity.patch(key)` | Parity |
| Delete | `entity.delete(pk).go()` | `Entity.delete(key)` | Parity |
| Remove (fail if not exists) | `entity.remove(pk).go()` | `Entity.deleteIfExists(key)` | Parity |
| Conditional writes | `.where()` on any mutation | `Entity.condition(expr)` on put/update/delete | Parity |
| Batch put | `entity.put([...]).go()` | `Batch.write(ops)` | Parity |
| Batch delete | `entity.delete([...]).go()` | `Batch.write(ops)` | Parity |
| Transact write | `service.transaction.write(cb)` | `Transaction.transactWrite(ops)` | Parity |
| Condition check (transaction) | `.check().where().commit()` | `Transaction.check(condition)` | Parity |
| Transaction idempotency | `token` parameter (ClientRequestToken) | Via unique constraints | Different approach |

### 5. Update Expression Builders

| Feature | ElectroDB | effect-dynamodb | Status |
|---------|-----------|-----------------|--------|
| SET (replace values) | `.set({})` | `Entity.set(updates)` | Parity |
| REMOVE (delete attributes) | `.remove([])` | `Entity.remove(fields)` | Parity |
| ADD (increment / add to set) | `.add({})` | `Entity.add(values)` | Parity |
| SUBTRACT (decrement) | `.subtract({})` | `Entity.subtract(values)` | Parity |
| APPEND (add to list) | `.append({})` | `Entity.append(values)` | Parity |
| DELETE (remove from set) | `.delete({})` | `Entity.deleteFromSet(values)` | Parity |
| Data callback | `.data((attrs, ops) => ...)` | Not supported | **Gap** |
| Nested property updates | Dot notation for maps, brackets for lists | Not supported | **Gap** |

> **Note:** All update expression types are now exposed through `Entity.update()` combinators: `Entity.set()`, `Entity.remove()`, `Entity.add()`, `Entity.subtract()`, `Entity.append()`, `Entity.deleteFromSet()`. These compose with each other and with `Entity.expectedVersion()` and `Entity.condition()`.

### 6. System Features

| Feature | ElectroDB | effect-dynamodb | Status |
|---------|-----------|-----------------|--------|
| Entity isolation | `__edb_e__` + `__edb_v__` | `__edd_e__` | Parity |
| Schema versioning | `model.version` | `DynamoSchema.version` | Parity |
| Application namespace | `model.service` | `DynamoSchema.name` | Parity |
| Timestamps | Manual (watch/set/default recipe) | Built-in `timestamps` config | **Advantage** |
| Version tracking | Not built-in | Built-in `versioned` config | **Advantage** |
| Version history/snapshots | Not built-in | Built-in `versioned: { retain: true }` | **Advantage** |
| Soft delete | Not built-in | Built-in `softDelete` config | **Advantage** |
| Restore soft-deleted | Not built-in | Built-in `Entity.restore()` | **Advantage** |
| Purge (full partition delete) | Not built-in | Built-in `Entity.purge()` | **Advantage** |
| Unique constraints | Manual via transactions | Built-in `unique` config | **Advantage** |
| Optimistic locking | Not built-in | Built-in `Entity.expectedVersion()` | **Advantage** |
| Idempotency | Manual via transaction tokens | Built-in via unique constraints | **Advantage** |
| DynamoDB Streams parsing | `entity.parse()` utility | `Entity.decodeMarshalledItem()` | Parity |
| Conversion utilities | Composites ↔ Keys ↔ Cursors | Not supported | **Gap** |
| Ignore ownership | `ignoreOwnership: true` | `Query.ignoreOwnership` | Parity |
| Event listeners/logging | `listeners`/`logger` callbacks | Not built-in (use Effect tracing/logging) | Different approach |
| Custom params merge | `params` option merged into request | Not supported | **Gap** |
| Params-only mode | `.params()` returns request without executing | `Query.asParams` | Parity |
| Return values control | `response: "all_old"/"all_new"/etc.` | `Entity.returnValues(mode)` | Parity |
| Aggregations (count, sum, min, max, avg) | Not built-in | Built-in `Aggregate` module with Stream-based processing | **Advantage** |

### 7. Type System

| Feature | ElectroDB | effect-dynamodb | Status |
|---------|-----------|-----------------|--------|
| Type inference from schema | Inline schemas get inference; external need `as const` | Full inference from Effect Schema | **Advantage** |
| Item type | `EntityItem<E>` | `Entity.Record<E>` | Parity |
| Identity/key type | `EntityIdentifiers<E>` | `Entity.Key<E>` | Parity |
| Create input type | `CreateEntityItem<E>` | `Entity.Input<E>` | Parity |
| Update input type | `UpdateEntityItem<E>` | `Entity.Update<E>` | Parity |
| Marshalled type | Not built-in | `Entity.Marshalled<E>` | **Advantage** |
| Item with keys type | Not separate | `Entity.Item<E>` | **Advantage** |
| 7 derived types from declaration | N/A | Model, Record, Input, Update, Key, Item, Marshalled | **Advantage** |

### 8. Integration & DX

| Feature | ElectroDB | effect-dynamodb | Status |
|---------|-----------|-----------------|--------|
| AWS SDK v2 support | Yes | No (v3 only) | N/A (v2 is deprecated) |
| AWS SDK v3 support | Yes | Yes (via DynamoClient) | Parity |
| Layer-based DI | N/A (plain JS) | Full Effect Layer/Service integration | **Advantage** |
| Resource management | Manual client lifecycle | `Effect.acquireRelease` in DynamoClient | **Advantage** |
| Error handling | `ElectroError` with codes | Tagged errors with `catchTag` | **Advantage** |
| Streaming pagination | Not built-in (cursor loops) | `Stream.paginate` integration | **Advantage** |
| Table definition export | Not built-in | `Table.definition()` for CloudFormation/CDK | **Advantage** |
| Config-based setup | N/A | `DynamoClient.layerConfig()`, `Table.layerConfig()` | **Advantage** |
| Dual APIs (pipe support) | N/A (fluent chaining only) | `Function.dual` on all public functions | **Advantage** |

---

## Summary Counts

| Category | Parity | effect-dynamodb Advantage | ElectroDB Gap |
|----------|--------|---------------------------|---------------|
| Data Modeling | 7 | 3 | 6 (4 philosophical) |
| Indexes | 6 | 0 | 4 (1 intentional) |
| Read Operations | 12 | 3 | 2 |
| Write Operations | 11 | 0 | 1 |
| Update Expressions | 6 | 0 | 2 |
| System Features | 7 | 10 | 2 |
| Type System | 3 | 4 | 0 |
| Integration & DX | 1 | 7 | 0 |
| **Total** | **53** | **27** | **17** |

> **All 5 must-have gaps identified in Group 1 have been addressed** (scan, consistent reads, conditional writes, create, rich update operations). **Phase 8 closed 10 additional gaps** (field aliasing, Hidden, upsert, patch, deleteIfExists, returnValues, ignoreOwnership, count, asParams, maxPages). The remaining 17 gaps are nice-to-have, intentional design differences, or have documented workarounds.

---

## effect-dynamodb Advantages (features ElectroDB lacks)

These are differentiators for positioning:

1. **Built-in lifecycle management** — Timestamps, versioning with snapshot history, soft delete with restore/purge — all declarative config. ElectroDB requires manual implementation for each.

2. **Built-in unique constraints** — Sentinel-based uniqueness enforcement with atomic transactions. ElectroDB requires manual transaction patterns.

3. **Built-in optimistic locking** — `expectedVersion()` combinator with automatic version tracking. ElectroDB has no built-in concurrency control.

4. **Effect integration** — Full Effect ecosystem: Layer-based DI, tagged error handling with `catchTag`, Stream-based pagination, resource management, composable pipelines. This is the primary architectural differentiator.

5. **Built-in aggregations** — `Aggregate` module provides count, sum, min, max, avg operations with Stream-based processing over query results. ElectroDB has no aggregation support — consumers must implement their own reduction logic.

6. **7 derived types** — One entity declaration automatically produces Model, Record, Input, Update, Key, Item, and Marshalled types. ElectroDB has fewer derived types and no marshalled/item distinction.

7. **4 decode modes** — asModel (clean domain), asRecord (with system fields), asItem (with DynamoDB keys), asNative (raw AttributeValue). ElectroDB has 3 data modes.

8. **Table definition export** — `Table.definition()` generates CreateTableCommandInput from entity declarations for CloudFormation/CDK/testing.

9. **Config-based setup** — `DynamoClient.layerConfig()` and `Table.layerConfig()` read from Effect Config providers (environment variables, etc.).

10. **Dual APIs** — All public functions support both data-first and data-last (pipeable) calling conventions via `Function.dual`.

---

## Gap Analysis & Prioritization

### Must-Have (before v1.0 publish) — All Implemented

All 5 must-have gaps have been implemented in Phase 7, Group 2.

#### 1. Scan operation — **Implemented**
`Entity.scan()` returns `Query<Entity.Record>` with `isScan: true`. Shares all Query combinators (filter, limit, consistentRead) and terminals (execute, paginate). Uses `DynamoClient.scan` internally. Entity type filtering via `__edd_e__` ensures scan only returns matching entity items.

#### 2. Rich update operations — **Implemented**
All update expression types exposed through Entity combinators: `Entity.remove(fields)` (REMOVE), `Entity.add(values)` (ADD for atomic increment), `Entity.subtract(values)` (synthesized SET subtraction), `Entity.append(values)` (synthesized list_append), `Entity.deleteFromSet(values)` (DELETE from set). All compose with `Entity.set()`, `Entity.expectedVersion()`, and `Entity.condition()`.

#### 3. Consistent reads — **Implemented**
`Entity.consistentRead()` combinator on `EntityGet`, `Query.consistentRead()` combinator on `Query<A>`. Both pass `ConsistentRead: true` to DynamoDB operations.

#### 4. Conditional writes — **Implemented**
`Entity.condition(expr)` combinator works on `EntityPut`, `EntityUpdate`, and `EntityDelete`. Accepts `ConditionInput` (declarative object from Expression module). For updates, user condition is ANDed with optimistic lock condition. Returns `ConditionalCheckFailed` on failure.

#### 5. Create operation — **Implemented**
`Entity.create(input)` is `Entity.put(input)` with automatic `attribute_not_exists` condition on primary key fields. Returns `ConditionalCheckFailed` on duplicate.

### Nice-to-Have — Status

Features categorized by current status:

#### Implemented in Phase 8

| # | Feature | Implementation |
|---|---------|---------------|
| 7 | Upsert operation | `Entity.upsert(input)` — UpdateItem with `if_not_exists()` for immutable fields, createdAt, version |
| 8 | Patch/Remove | `Entity.patch(key)` (update + `attribute_exists`), `Entity.deleteIfExists(key)` (delete + `attribute_exists`) |
| 9 | Return values control | `Entity.returnValues(mode)` — `"none" \| "allOld" \| "allNew" \| "updatedOld" \| "updatedNew"` |
| 10 | Field aliasing | `DynamoModel.configure(model, { field: { field: "dbName" } })` — rename domain fields to DynamoDB attributes |
| 12 | Params-only mode | `Query.asParams` — returns built DynamoDB command input without executing |
| 13 | Ignore ownership | `Query.ignoreOwnership` — skip `__edd_e__` filter for mixed-table scenarios |

#### Remaining — Workaround Documented

| # | Feature | Workaround | Effort to Implement |
|---|---------|-----------|---------------------|
| 6 | Find/Match (auto index) | Use explicit `entity.query.<indexName>()` — more predictable than auto-selection | Medium |
| 11 | Conversion utilities | Use `KeyComposer.composePk()` / `composeSk()` directly | Low |
| 14 | Hydrate (KEYS_ONLY GSI) | Query GSI → `Batch.get(keys)` — compose in a pipe | Medium |
| 15 | DynamoDB native Set | Use arrays (most common) or `DynamoClient` directly for native Sets | Medium |

See [Advanced Topics — Working Around ElectroDB Gaps](./advanced.md#working-around-electrodb-gaps) for concrete code examples.

### Won't Do (with rationale and workarounds)

| Feature | Rationale | Workaround |
|---------|-----------|------------|
| Custom key templates | Intentional design choice. Attribute-list composition is simpler, more predictable, and less error-prone than template strings. | N/A — attribute-list composition covers all standard patterns |
| Getter/setter hooks | Different paradigm. Effect Schema transforms provide equivalent power through composable, declarative transformations. | `Schema.transform` / `Schema.transformOrFail` on model fields |
| Watch/calculated attributes | Same as above — imperative hooks fight the Effect design philosophy. | Compute at application layer or use `Schema.transform` |
| Virtual attributes | Same as above. | Use `Schema.transform` with a field that has no DynamoDB storage |
| Attribute padding | Very niche. | `Schema.transform` to pad/unpad values |
| Key casting (numeric keys) | All keys are strings by design. DynamoDB sort keys are most commonly strings. | N/A — numeric sort keys are a niche optimization |
| Composite index type | DynamoDB feature from Nov 2025. Too new and niche for v1.0. | Can be added post-v1.0 |
| AWS SDK v2 support | v2 is deprecated. v3 only is the correct choice. | N/A |
| Event listeners/logging | Effect's built-in tracing and logging services provide this capability. | `Effect.tap`, `Effect.log`, Effect tracing spans |
| Custom params merge | Escape hatch that bypasses the ORM's abstractions. | Use `DynamoClient` directly for custom operations |
| Index scope | Very niche entity isolation mechanism. Key namespacing already provides sufficient isolation. | N/A |
| Data callback | Imperative escape hatch. | Pipe composition with Effect operators |
| Nested property updates | Complex and type-unsafe. | Full object via `Entity.set()` or `DynamoClient.updateItem` directly |

See [Advanced Topics — Working Around ElectroDB Gaps](./advanced.md#working-around-electrodb-gaps) for concrete code examples of each workaround.

---

## Implementation Roadmap

### Pre-v1.0 Sprint (Must-Haves) — Complete

All 5 must-have features were implemented in Phase 7, Group 2. See the feature comparison matrix above for current status.

### Phase 8 Sprint — Complete

10 additional features implemented:

| Feature | Implementation |
|---------|---------------|
| Upsert | `Entity.upsert(input)` |
| Patch/Remove | `Entity.patch(key)`, `Entity.deleteIfExists(key)` |
| Return values control | `Entity.returnValues(mode)` |
| Field aliasing | `DynamoModel.configure(model, { field: { field: "dbName" } })` |
| Hidden attributes | `DynamoModel.Hidden` annotation |
| Page count limiting | `Query.maxPages(n)` |
| Count mode | `Query.count` terminal |
| Params-only mode | `Query.asParams` |
| Ignore ownership | `Query.ignoreOwnership` |
| Date schemas | 9 date schemas + `storedAs` modifier + configurable timestamps |

### Post-v1.0 Backlog

| Priority | Feature | Effort | Notes |
|----------|---------|--------|-------|
| P2 | Find/Match (auto index) | Medium | Workaround: explicit `entity.query.<indexName>()` |
| P3 | Conversion utilities | Low | Workaround: `KeyComposer` functions directly |
| P3 | DynamoDB native Set type | Medium | Workaround: arrays or `DynamoClient` directly |
| P4 | Hydrate for KEYS_ONLY GSI | Medium | Workaround: query GSI → `Batch.get(keys)` |
| P4 | Composite index type | Medium | DynamoDB Nov 2025 feature |

---

## Codebase Size Comparison

| | **effect-dynamodb** | **ElectroDB** |
|---|---|---|
| **Source code** | 10,114 lines (TypeScript) | ~13,500 lines (JavaScript) |
| **Type definitions** | Included in source | ~6,100 lines (hand-written `.d.ts`) |
| **Source + types** | **10,114 lines** | **~19,600 lines** |
| **Test code** | 13,423 lines | ~78,700 lines |
| **Examples** | 6,884 lines (16 files) | — |
| **Documentation** | 6,435 lines (14 files) | External site (electrodb.dev) |
| **Source modules** | 16 | 19 |
| **Largest module** | `Entity.ts` (4,142) | `entity.js` (5,374) |
| **Test:source ratio** | 1.3:1 | 4:1 |

**Why ~1.9x less source code for comparable functionality:**

- **Effect Schema** replaces ElectroDB's manual `schema.js` (1,880 lines) and validation logic — transforms, validation, and type derivation are built-in.
- **TypeScript source** eliminates the need for a separate hand-maintained `.d.ts` file (6,100 lines in ElectroDB).
- **Effect primitives** (`Stream.paginate`, `Layer`, `Data.TaggedError`, `Function.dual`) provide infrastructure that ElectroDB implements from scratch in `clauses.js` (1,717 lines) and `service.js` (1,130 lines).

**Why ~6x less test code:**

- TypeScript + Effect Schema catch many classes of errors at compile time that ElectroDB must verify at runtime.
- ElectroDB's hand-written `.d.ts` requires ~9,000 lines of compile-time type tests (`*.test-d.ts`) to verify type definitions match runtime behavior — unnecessary when types are derived from source.
- ElectroDB is plain JavaScript — more runtime test coverage is needed to compensate for the lack of static type checking.

## Positioning Summary

**effect-dynamodb vs ElectroDB:**

| Dimension | Winner |
|-----------|--------|
| Raw feature count | ElectroDB (more operations, more attribute options) |
| Codebase efficiency | effect-dynamodb (~1.9x less code for comparable features) |
| Type safety depth | effect-dynamodb (7 derived types, Schema ecosystem, branded types) |
| Lifecycle management | effect-dynamodb (versioning, soft delete, restore, purge, unique constraints — all built-in) |
| Concurrency control | effect-dynamodb (optimistic locking, atomic unique constraints) |
| Composability | effect-dynamodb (Effect pipelines, Stream pagination, Layer DI, dual APIs) |
| Error handling | effect-dynamodb (tagged errors, catchTag discrimination) |
| DX for simple cases | ElectroDB (fluent chaining, less boilerplate for basic CRUD) |
| DX for complex cases | effect-dynamodb (Effect composition scales better than callback chains) |

**Key message:** effect-dynamodb achieves near feature-parity with ElectroDB for core CRUD, querying, and DX features in roughly half the code — while providing deeper architectural capabilities (lifecycle management, unique constraints, optimistic locking, Effect integration, date schema system). The remaining gaps are niche (native Set type, auto index selection) or intentional design differences (key templates, imperative hooks) with documented workarounds. It is a compelling alternative for teams using Effect TS.
