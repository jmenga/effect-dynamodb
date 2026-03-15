# Changelog

## 0.1.0 (Unreleased)

Initial release of `@effect-dynamodb/core`.

### Modules

- **DynamoModel** — `Immutable` annotation for Schema fields
- **DynamoSchema** — Application namespace with versioned key prefixing
- **Table** — Minimal table definition with Layer-based name injection and `Table.definition()` for CloudFormation/CDK
- **Entity** — Model-to-table binding with 7 derived types, CRUD operations, query accessors, lifecycle management
- **Query** — Pipeable `Query<A>` data type with composable combinators and Stream-based pagination
- **Collection** — Multi-entity queries with isolated/clustered mode and per-entity selectors
- **Transaction** — `transactGet` and `transactWrite` for atomic multi-item operations (up to 100 items)
- **Batch** — `Batch.get` and `Batch.write` with auto-chunking and unprocessed item retry
- **Expression** — Condition, filter, and update expression builders
- **Projection** — ProjectionExpression builder for selecting specific attributes
- **KeyComposer** — Composite key composition from index definitions
- **Marshaller** — Thin wrapper around `@aws-sdk/util-dynamodb`
- **DynamoClient** — Effect `ServiceMap.Service` wrapping AWS SDK DynamoDBClient with `layer()` and `layerConfig()`
- **Errors** — 9 tagged error types: `DynamoError`, `ItemNotFound`, `ConditionalCheckFailed`, `ValidationError`, `TransactionCancelled`, `UniqueConstraintViolation`, `OptimisticLockError`, `ItemDeleted`, `ItemNotDeleted`

### Features

- **Schema-driven modeling** — Pure `Schema.Class`/`Schema.Struct` domain models with Entity-level DynamoDB binding
- **Single-table design** — First-class support with entity type isolation via `__edd_e__`, index overloading, and collections
- **Composite key composition** — ElectroDB-style `{ pk: { field, composite }, sk: { field, composite } }` index definitions
- **7 derived types** — `Model`, `Record`, `Input`, `Update`, `Key`, `Item`, `Marshalled` — all auto-derived from declarations
- **Pipeable Query API** — `Query<A>` with `where`, `filter`, `limit`, `reverse`, `consistentRead` combinators and `execute`/`paginate` terminals
- **Scan** — `Entity.scan()` returns `Query<Entity.Record>` with entity type filtering
- **Consistent reads** — `Entity.consistentRead()` on get, `Query.consistentRead()` on queries and scans
- **Conditional writes** — `Entity.condition()` on put, update, and delete operations
- **Create (insert-only)** — `Entity.create()` with automatic `attribute_not_exists` condition
- **Rich update operations** — `Entity.remove()`, `Entity.add()`, `Entity.subtract()`, `Entity.append()`, `Entity.deleteFromSet()` — all composable
- **Unique constraints** — Sentinel-based uniqueness enforcement with atomic transactions
- **Optimistic locking** — `Entity.expectedVersion()` with automatic version tracking
- **Timestamps** — Automatic `createdAt`/`updatedAt` with configurable field names
- **Versioning** — Auto-increment version with optional snapshot retention
- **Soft delete** — `Entity.delete()` marks as deleted; `Entity.restore()`, `Entity.purge()` for lifecycle management
- **DynamoDB Streams** — `Entity.marshalledSchema()` and `Entity.itemSchema()` for decoding stream records
- **Layer-based DI** — Table names and DynamoClient provided via Effect Layers
- **Config-based setup** — `DynamoClient.layerConfig()` reads from Effect Config providers
- **Dual APIs** — All public functions support data-first and data-last (pipeable) calling conventions
- **Tagged errors** — Fine-grained error discrimination with `catchTag`
- **Stream pagination** — Automatic DynamoDB pagination via `Stream.paginate`
- **Table definition export** — `Table.definition()` for CloudFormation/CDK/testing

### Test Coverage

- 15 test files, 405 tests
- 14 runnable examples against DynamoDB Local
