# Design: add-only writes through PartiQL `INSERT` (#189)

**Issue:** [#189](https://github.com/jmenga/effect-dynamodb/issues/189)
**Status:** Designed, owner decisions recorded in §10. Implemented in the same PR (single-PR
workflow: this doc is commit 1).
**Merge order:** after #184, which removes the key fallback (§6).
**Affected packages:** `packages/effect-dynamodb`, `packages/schema` (one new tagged error,
one guard), `packages/language-service` (one operation).
**Semver impact:** `minor`. Additive, except that `DynamoClientService` gains two required
methods, which a hand-written full mock of the service must add.

---

## 1. Problem

IAM can't limit `PutItem` to conditional writes, so a role that can put can overwrite. PartiQL's
`INSERT` fails when the key exists, and IAM grants it separately as `dynamodb:PartiQLInsert`. A
role with only that action, limited to a key prefix by `dynamodb:LeadingKeys`, can add items and
never change them: an append-only log enforced by IAM rather than by application code.

Today an application has to bypass the library for this: marshal the entity's item itself and
send `ExecuteStatement` with its own SDK client, losing spans, capacity reporting and error
classification.

## 2. The constraint that shapes the design

**`insert` sends one write and no reads.** A role with only `PartiQLInsert` can do nothing else.

The issue asks for "exactly what `put` would" write. The item is the same, but `put` and `create`
are not always one write: depending on the entity they read the item, query retained versions,
read referenced items, or run a transaction. §5 says what `insert` does in each case.

## 3. API

```ts
const entry = yield* db.entities.AuditLog.insert({ logId, at, action })
```

- `Entity.insert(input)` returns `EntityInsert`. `db.entities.X.insert(input)` returns
  `BoundInsert`. Both are yieldable and pipeable, and `EntityInsert` takes `asRecord`, `asItem` and
  `asNative`, as `put` does.
- `.withVector()` is available, because an embedding is computed before the write.
- `.condition()` is not. PartiQL `INSERT` has no conditions, so offering one would silently do
  nothing.
- `EntityInsert` carries `_putKind: "insert"` and `EntityPut`'s `_putKind` excludes it, because
  `EntityPut` otherwise has no members of its own and any op would be assignable to it. So
  `Entity.condition(op, ...)`, `Batch.write([op])` and `Transaction.transactWrite([op])` are compile
  errors. `BoundInsert._boundOpType` is `"insert"`, which `BoundWriteOp` excludes likewise.
- At runtime the multi-item paths refuse it through `rejectUnsupportedOp`, the mechanism they
  already use for `upsert` (#100), because they would send a `PutItem` the role can't run.

The operation is named `Entity.insert` in spans and capacity reports.

## 4. What is sent

`insert` shares `put`'s item building: validation, generated ids, key composition, timestamps,
version and incarnation, `__edd_e__`, vector attributes, renames, sparse fields and packing. It
branches after `packFields`, before any guard, read or write.

```
INSERT INTO "<table>" VALUE {'pk': ?, 'sk': ?, '__edd_e__': ?, ...}
```

Every value is a parameter. Attribute names are inline, with `'` doubled, because `VALUE ?` is
rejected ("Unsupported format in item expression").

- **One item:** `DynamoClient.executeStatement`.
- **With `unique` constraints:** `DynamoClient.executeTransaction`, the item's `INSERT` first and
  one `INSERT` per sentinel. Sentinels are built directly, not through `planPut`, so nothing in the
  guarded-put path (reads, `ConditionCheck`s) can reach this one.

Both methods join `Capacity.DATA_PLANE`, so tracing, capacity reporting and `classifyError` apply.

### Capacity

`tablesOf` reads `TableName`, which statements don't have, so it reads the table from the statement
text. `CapacityUnits` without a read/write split counts as a write, so a `SELECT` sent through the
raw `executeStatement` is recognised as a read.

### Errors

| Failure | Result |
|---|---|
| Duplicate primary key, one statement | `ItemAlreadyExists { entityType, key }` |
| Duplicate at position 0 of the transaction | `ItemAlreadyExists` |
| Duplicate at a sentinel's position | `UniqueConstraintViolation { entityType, constraint, fields }` |
| Anything else | Unchanged: `DynamoClientError`, or a diagnosed `ValidationError` |

`key` holds the primary key composites only. `ItemAlreadyExists` carries no current item, because
DynamoDB returns none, even with `ReturnValuesOnConditionCheckFailure: ALL_OLD`.

A role missing the sentinel prefix gets `TransactionCanceledException` with reason `AccessDenied`,
not `AccessDeniedException`. It passes through unchanged, and nothing is written.

An SDK retry after a lost response reports `ItemAlreadyExists` for the caller's own write, exactly
as `create` reports `ConditionalCheckFailed` in that case.

### The statement length limit

`Statement` is limited to 8,192 characters, and the statement lists every attribute name. An item
with 400 attributes (8,749 characters) was refused while `PutItem` accepted the same item. That is
about 370 attributes with 14-character names. Sparse maps are the realistic way there, because they
flatten into top-level attributes.

There is no pre-check. On a validation failure, the library measures the statements it sent and, if
one is over the limit, reports `ValidationError` naming the limit and the item. The other diagnoses
(400 KB, key length, empty key) work as they do for `PutItem`, against the item that was sent.

## 5. Behaviour by entity configuration

| Configuration | What `create` does | What `insert` does |
|---|---|---|
| Plain, GSIs, sparse, packed, vectors | One write | Same item, one `INSERT` |
| `versioned` without retain | One write, version 1 | Same item, one `INSERT` |
| `unique` | Transaction with sentinels | `INSERT`-only transaction (§4) |
| `versioned: { retain: true }` | Queries retained versions, writes a snapshot | Refused, `EDD-9110` |
| Refs | Reads each referenced item | Same reads; the role also needs `GetItem` on those items |
| `softDelete` | No special handling | Same as plain |
| `timeSeries` | Writes the current row only | Same as `create`: current row, no event |
| Projection tombstone at the key | Reads it and replaces it | `ItemAlreadyExists` |

`retain` is refused because the version number comes from a query the role can't run, and writing a
v1 snapshot would collide with any history already there.

## 6. Existing rows and the key fallback

`INSERT` checks only the exact primary key it writes. On a table with rows under an older key text,
it can add a second row beside one of them. The docs say to run `rekey` on existing data first.

There is no refusal or schema flag for this. #184 removes the key fallback and `legacyKeys`, so
there is nothing to refuse. **This PR merges after #184.** Merged first, `main` would still have the
fallback on by default, and `insert` could add a second row where `create` would fail.

## 7. IAM

```json
{
  "Effect": "Allow",
  "Action": "dynamodb:PartiQLInsert",
  "Resource": "arn:aws:dynamodb:<region>:<account>:table/<table>",
  "Condition": {
    "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["<prefix>*"] },
    "Null": { "dynamodb:LeadingKeys": "false" }
  }
}
```

The prefix matches composed key text. An entity with `unique` constraints needs its sentinel prefix
listed too. The policy worked with and without the `Null` check; the check refuses any request
that lacks the key, which `ForAllValues` alone would allow.

## 8. Measured

All on real AWS unless marked, with the resources deleted afterwards.

| Fact | Result |
|---|---|
| `LeadingKeys` limits `PartiQLInsert` | Inside the prefix accepted; outside `AccessDeniedException`, nothing written |
| Same role, other actions | `PutItem`, `UpdateItem`, `DeleteItem`, `GetItem`, `Query`, PartiQL `UPDATE`, `DELETE`, `SELECT` all refused |
| Duplicate | `DuplicateItemException`, no item, no capacity even when requested |
| Stored item | Identical to `PutItem`'s, including BS and a binary GSI key |
| Capacity | Same as `PutItem`: 3 units for a row in two GSIs |
| Duplicate in a transaction | `TransactionCanceledException`, reason `DuplicateItem` at the failing position, rolled back |
| Outside the prefix in a transaction | Same exception, reason `AccessDenied`, rolled back |
| Awkward names | `'`, `"`, `#`, `.`, space and `?` all accepted |

DynamoDB Local differs in three ways, so the code and tests handle both:

| | AWS | DynamoDB Local |
|---|---|---|
| Duplicate error name | `DuplicateItemException` | `DuplicateItem` |
| Duplicate reason in a transaction | `DuplicateItem` | `ValidationError`, same message |
| `ConsumedCapacity` on statements | Returned | Not returned, so asserted with a stub |

## 9. Testing

- **Unit:** statement text and quoting, exactly one request and no reads for each configuration in
  §5, both duplicate forms, attribution by position, `AccessDenied` passing through, the `retain`
  refusal, the multi-item refusals, capacity reporting, the length diagnosis, and compile errors for
  `.condition()` and the multi-item paths.
- **Connected:** insert then insert again gives `ItemAlreadyExists`; the item reads back through
  `get` as a `put`'s does, and appears in its GSIs; sentinels roll back with the item.
- DynamoDB Local doesn't enforce IAM, so the suite can't prove the IAM claim. §8 is the evidence.

## 10. Scoping decisions

| Item | Status |
|---|---|
| `Entity.insert` (issue) | **Changed:** same item where possible, exceptions in §5 |
| `ItemAlreadyExists` (issue) | In |
| `executeStatement` (issue) | In |
| IAM docs (issue) | In, as a guide with a backing example |
| Issue's test | In, plus §9 |
| `executeTransaction` | **Added.** Owner: `unique` uses an `INSERT`-only transaction |
| `retain` | **Refused.** Owner decision |
| Key fallback | **No refusal.** Owner: #184 removes the fallback, `rekey` existing data, merge after #184 |
| Batch inserts (`BatchExecuteStatement`) | Out, not in the issue |
| EventStore, aggregates | Out, not in the issue |
