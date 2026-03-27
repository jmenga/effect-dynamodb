# Spec: Reference Pages & Getting Started

## getting-started.mdx
**Issues**:
1. Line 170: Note says `db.createTable({ billingMode: "PROVISIONED" })` but v2 pattern is `db.tables.MainTable.create({ billingMode: "PROVISIONED" })`. Code example on line 128 is correct.
2. Line 200: Language service example shows `Users.query.byRole(...)` (entity def accessor) — v2 pattern would be `db.entities.UserEntity.byRole(...)`.
**Notes**: Entity.make() correctly uses new `primaryKey` + `indexes` format. Quick start flow is clear.

## reference/api-reference.mdx
**Issues**:
1. Line 174: `Table.make` signature incomplete — missing `entities?` and `aggregates?` params.
2. Lines 188-189: Usage shows `Table.make({ schema })` without entities — should show canonical `Table.make({ schema, entities })`.
3. Lines 222-227: Entity.make config table shows `indexes` as single property containing primary key — should be `primaryKey` (required) + `indexes` (optional GSIs).
4. Lines 348-365: Entity usage uses OLD format: `indexes: { primary: {...}, byEmail: { index: "gsi1", ... } }`. Current: `primaryKey: {...}` + `indexes: { byEmail: { name: "gsi1", ... } }`. **This is a runtime error with current code** (`[EDD-9003]`).
5. Lines 387-388: Query pattern mixes old `bound.collect(entity.query.byEmail(...))` with v2 client.
6. Line 425: `paginate` return type shows `Effect<Stream<Array<A>>>` — BoundQuery.paginate() returns `Stream<A>`.
7. Lines 456-464: Query example uses old patterns.
8. Missing modules: `EventStore` and `@effect-dynamodb/geo` not covered.
9. Line 343: Duplicate `decodeMarshalledItem` entry.
10. Lines 471-508: Collection section shows `Collection.make()` but doesn't mention auto-discovery.
**Notes**: Expression/Expr ADT section is thorough. Errors section lists all 20 tags correctly. Aggregate section is accurate.

## reference/electrodb-comparison.mdx
**Issues**:
1. Line 112: "Nested property updates: Not supported" — **OUTDATED**. Path-based combinators (`Entity.pathSet()`, etc.) now fully support nested updates.
2. Line 178: "18 tagged errors" — now 20 (includes `CascadePartialFailure`, `VersionConflict`).
3. Line 111: "Data callback: Not supported" — partially outdated; variadic combinators cover same use cases.
4. Lines 63, 66: Query/Scan patterns use old API.
5. Line 205: Summary counts stale.
**Notes**: Comparison is comprehensive. "What's Different" section provides useful guidance.

## reference/faq.mdx
**Issues**:
1. Lines 112-127: Entity index examples use OLD format: `indexes: { primary: {...}, byTenant: { index: "gsi1", ... } }`. **This is a runtime error** with current code.
2. Lines 20-25: FAQ destructures `DynamoClient.make(MainTable)` — valid for Table shortcut but inconsistent with other pages using v2 pattern.
**Notes**: Content is comprehensive. Error handling examples are accurate.

## reference/migration-from-electrodb.mdx
**Issues**:
1. Lines 97-117: Entity definition uses OLD format. **Runtime error** with current code.
2. Lines 195-210: Query patterns use old `users.collect(UserEntity.query.byEmail(...))` style.
3. Lines 207-210: Stream pagination example is confused — `Query.paginate` returns `Effect<Stream<Array<A>>>` requiring DynamoClient in context but code treats it as directly yieldable.
4. Lines 282-288: Collection example uses `Collection.make("name", entities)` without mentioning auto-discovery.
5. Line 370: "Fluent chaining" uses old pattern.
**Notes**: Concept mapping table is useful. Error handling comparison is effective.

## index.mdx (Introduction)
**Issues**: None significant. Entity definition correctly uses new format. v2 accessor pattern demonstrated correctly.
**Notes**: Clean, accurate overview.

---

## Cross-Cutting Issues

1. **OLD Entity.make() format causes runtime errors**: The FAQ, migration guide, and API reference use `indexes: { primary: {...}, byEmail: { index: "gsi1" } }` which is rejected by the current runtime with `[EDD-9003]`. This is the most critical reference page issue — users following these pages will get errors.

2. **Client pattern inconsistency**: Getting-started and index use v2 entity-centric (`db.entities.*`). FAQ, migration, and API reference use Table shortcut (`db.EntityName.*`). No explanation of when to use which.

3. **Nested updates now supported**: ElectroDB comparison and migration guide both claim unsupported — needs update.
