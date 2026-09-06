---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Composite keys are composed by one rule everywhere — **storage-format change, migration required for two shapes** (#101, #113, #114, #115)

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
