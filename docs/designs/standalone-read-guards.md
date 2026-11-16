# Design: holding a read to its write (standalone ops, no-op updates, purge, cascade)

**Issue:** [#132](https://github.com/jmenga/effect-dynamodb/issues/132), "Standalone ops don't
guard against the row changing between their read and their write" (filed against 1.24.0).
**Base:** 1.43.0 (`9ec9bb63`).
**Status:** Decided (§6). The owner accepted D1 to D5, D12 and D13 as recommended; D9 and D10
stand as precedent. Every aggregate item (R6, R7, D6, D7, D8, D11) moved to
[#168](https://github.com/jmenga/effect-dynamodb/issues/168), which ships with this change as
1.44.0 under its own design.
**Affected packages:** `packages/effect-dynamodb` (`Entity.ts` update / patch / purge / cascade,
`internal/TransactPlan.ts`), docs. `packages/schema` and `Aggregate.ts` are untouched.
**EDD codes:** none. Every outcome below is an existing tagged error. The reserved block
EDD-9173 to EDD-9176 stays unallocated (D3's "refuse" alternative, which would have taken
EDD-9173, was not picked).

---

## 1. Summary

The issue names three standalone read-then-write paths: the unique hard delete, the soft
delete, and an update touching a unique field. Its comment adds two more: a version CAS with an
ABA at version 1, and retain hard deletes that write no snapshot. **None of the five reproduces
on 1.43.0.** Releases after 1.24.0 added a guard to each write that proves the row is still the
row that was read, plus a retry from a fresh read when that guard fails.

What still reproduces is a smaller set of paths. Each one either writes nothing that carries
the guard, or writes with no condition at all:

| # | Path | Reproduced outcome |
|---|------|--------------------|
| R1 | An update that sets nothing, inside `transactWrite`, whose row is deleted after the plan reads it | The sibling writes commit. Standalone, the same op is `ItemNotFound`. |
| R2 | An update that sets nothing with `returnValues("none")` on a missing row, standalone and in `transactWrite` | Standalone it is `ok`, and in a transaction the siblings commit. With the default return mode, the same op is `ItemNotFound`. This is the issue's related case, as written, in its one remaining form. |
| R3 | A `patch` that sets nothing on a missing row | `ItemNotFound`. The documented outcome is `ConditionalCheckFailed`. |
| R4 | An update that sets nothing, with a `.condition()` that fails, on a present row | `ok`. The condition is never sent. |
| R5 | `purge` of a unique entity racing an update of the unique field after purge has read the live row | The new value's sentinel is orphaned: it reserves the value for a row that no longer exists. |
| R6, R7 | `Aggregate.update` / `Aggregate.delete` racing a concurrent aggregate write | Moved to #168. |
| R8 | An update's `.cascade()` whose target is deleted, or re-pointed at another source, after the cascade's index query | Found by reading the code (§2.2); not yet in the reproduction file. The cascade's `UpdateItem SET #ref = :refData` carries no condition. A deleted target comes back as a partial item holding only its key and the ref. A re-pointed target gets the old source's data written over the new one. |

R1 to R4 are one family: an update that resolves to no write. R5 is the issue's own family
(unique sentinels), on a path the issue didn't name. R8 is the same window on a write the
library makes after its own read of other items. The aggregate paths (R6, R7) are #168's.

The recommended shape reuses machinery the library already has:

- **No-op updates (R1 to R4).** The op establishes what its write would have established. It
  reads its row with a consistent read. A caller condition goes out in the update's own
  `UpdateItem` with no `UpdateExpression`, which changes nothing. The retain-only delete of a
  missing row already sends a condition this way (`Entity.ts:14750-14781`). Inside a
  transaction, `planWrite` records that request as a `ConditionCheck`. An unconditioned no-op
  gets an existence `ConditionCheck` held to the commit. Both are judged by the existing plan
  verdict.
- **`purge` (R5).** The live row and its sentinels are deleted with the transaction a unique
  hard delete already sends: a guarded `Delete` plus ownership-checked releases, retried from a
  fresh read. The partition query becomes consistent.
- **Cascade (R8).** Each cascade update is conditioned on its target still existing and still
  naming this source. A refused target is no longer the source's, so it is skipped.

---

## 2. The issue's claims on 1.43.0

The reproduction is `packages/effect-dynamodb/test/Issue132.races.test.ts`, which is not
committed. It runs the in-memory tables (`test/helpers/InMemoryTables.ts`). A hook runs a
real bound op straight after the op under test's first read or query, and every scenario
asserts that the hook fired. The file had 35 tests: 26 passed and 9 failed. The failures
were R1 to R7. The two aggregate cases (R6, R7) are dropped from this branch; #168 has its own.

### 2.1 Claims that no longer reproduce, and the guard that covers each

| Issue claim | 1.43.0 behaviour | The guard that covers it |
|---|---|---|
| A unique hard delete can release a sentinel the row no longer owns, or delete a row that changed after its read (unversioned, versioned, retain) | The `Delete` carries `deleteGuard`. On a versioned entity that is the version and incarnation. On an unversioned one it is the row's unique attributes as read. Each sentinel release is ownership-checked, and a lost race is retried from a fresh read. A delete racing another delete is `ItemNotFound`. | `deleteGuard` (`Entity.ts:8533`); `ownedSentinels` / `sentinelRelease` (`Entity.ts:9531`, `9564`); retry for `OptimisticLockError \| ConcurrentModification \| DeletedConcurrently`, `GUARDED_PUT_ATTEMPTS - 1` times, when there is no `.condition()` (`Entity.ts:14871-14890`, `GUARDED_PUT_ATTEMPTS` at `Entity.ts:2854`). |
| A soft delete can write a stale tombstone | The live-row `Delete` carries `deleteGuard(row, "item")`. A refused guard is retried, and the tombstone is rebuilt from the fresh read, so it holds the concurrent change. Two racing soft deletes leave one tombstone, and the loser is `ItemNotFound`. | `softGuard` (`Entity.ts:14616`), `guardedDeleteCondition` (`Entity.ts:14488`), the same retry. |
| An update touching a unique field can rotate sentinels from a stale read | The `Update` carries a guard on each field's value as read (unversioned, `Entity.ts:12340-12403`), or the version and incarnation (versioned, `Entity.ts:12334-12335`). Releases are ownership-checked. A race ends in a refusal or a re-plan, never an orphan sentinel or a re-created row. | Per-field read-value guard; `versionIs` + `incarnationGuard` (`Entity.ts:8335`); cancellation mapping at `Entity.ts:12686-12731`. |
| The version CAS has an ABA at version 1, because `put` resets `version` to 1 | `put` over an existing row reads it (`planPut`, `Entity.ts:9705`) and continues the version, `(storedVersion ?? 0) + 1`, keeping the incarnation token (`Entity.ts:9718-9722`). A delete followed by a re-create at version 1 gets a fresh incarnation, which `incarnationGuard` refuses. | `planPut`'s continued version; `incarnationGuard`. The issue's two proposed fixes (continue the version, or add a revision attribute) are both already in place: the incarnation token is that revision attribute. |
| Retain-only and unique + retain hard deletes write no snapshot, contradicting `reference/faq.mdx` | A retain hard delete reads the row, then sends a `TransactWriteItems` holding the guarded `Delete` plus `snapshotPut` at `v#N` (CLAUDE.md, "A retain hard delete snapshots the final state"). The FAQ's sentence ("every write operation (put, update, delete) stores a snapshot") is now true. | `Entity.ts:14818-14848`. No docs change is needed. |
| The related case: an update that sets nothing, inside `transactWrite`, commits when its row is missing | With the default return mode, a missing row is `ItemNotFound` while the plan is built, and nothing is sent. The no-op plans as a `get`, so the row is read. A pinned no-op on a versioned entity is no no-op: the version bump is a `SET`, so it carries the version condition. | `Entity.ts:13581-13587` (the no-op returns `get(key)`), the plan's read. **Only the residual race (R1) and the `returnValues("none")` form (R2) still reproduce.** |

These rows need no code. Their passing tests become regression tests (§5.1).

### 2.2 What still reproduces

**R1: no-op update, row deleted after the plan's read.** `planned()` (`Entity.ts:14070`) runs
the update under `planWrite` (`internal/TransactPlan.ts:121`). A no-op writes nothing, so the
plan has `items = []`. `buildTransactWriteItems` emits nothing for the op, and the transaction
carries only the siblings (`[[Put]]`, with no `ConditionCheck`). Nothing holds the plan's read
to the commit. Standalone, the same op is `ItemNotFound`.

**R2: no-op update with `returnValues("none")`.** The no-op branch returns `undefined` before
any read (`Entity.ts:13583`). Standalone, a missing row is `ok`. In `transactWrite`, which
accepts `returnValues("none")` (EDD-9060 refuses only modes that return an item), the plan has
no read and no item. `planned()` reads the row only when `items.length > 0`
(`Entity.ts:14113`), so the siblings commit. `updatedOld` / `updatedNew` take the same no-read
branch standalone (`decodePartial(undefined, …)`); a transaction refuses them.

The default mode's read is not consistent either. The no-op returns `get(key)._run(mode)`, and
a `get` built without `.consistentRead()` sends `ConsistentRead: false` (`EntityGetImpl`,
`internal/EntityOps.ts:461-492`). So a no-op straight after the write that created its row can
report `ItemNotFound`. Inside a transaction, the plan's existence answer is then only as fresh
as an eventually consistent read. Every other read-first write path reads with
`ConsistentRead: true` (`readCurrent`, `Entity.ts:8747`), as does `planned()`'s own read
(`Entity.ts:14113`).

**R3: no-op `patch`.** `patch` is documented as `ConditionalCheckFailed` on a missing row "on
every path, read-first included" (CLAUDE.md; `Entity.ts:1751-1753`). A no-op `patch` goes
through `get(key)` and reports `ItemNotFound`, both standalone and in a transaction (where
nothing is written).

**R4: no-op update with a failing `.condition()`.** Nothing is sent, so the caller's condition
is never evaluated, and the op returns the current item. `.keepRefs()`'s guard is lost the
same way. In a transaction, the siblings commit even though the op's condition is false.

**R5: `purge` of a unique entity.** `purge` (`Entity.ts:17370`) runs these steps:

1. It queries the item's rows.
2. It `getItem`s the live row and computes the sentinels the row holds.
3. It reads those sentinels (`ownedSentinels`).
4. It releases each one with a `deleteItem` (ownership-guarded).
5. It `batchWriteItem`-deletes the rows, which carries no condition.

An update moving the unique value between step 2 and step 5 reserves the new value's sentinel.
`purge` then deletes the row, and the new sentinel is orphaned. The scout's interleaving (a
hook after the first query) didn't hit this. A hook after the `getItem` does: the test is
"purge of a unique entity, after its row read". Real-world likelihood is low (an erase racing a
change of the same item's unique field), but the outcome is permanent: the value can never be
taken again until the sentinel is removed by hand.

Step 1's query is eventually consistent (no `ConsistentRead`, `Entity.ts:17492`), and step 5
deletes only the rows that query returned. A `purge` straight after the item's last write can
therefore miss the newest rows, with no concurrent writer at all: the live row of a
just-created item, or the snapshot a just-committed retain update wrote. Those rows survive an
erase. Step 2's read is consistent, so on a unique entity the sentinels are released while the
live row they belong to may survive.

**R6, R7: aggregates.** Moved to #168.

**R8: an update's `.cascade()`.** `executeCascade` (`Entity.ts:10381`) finds the targets
through a GSI keyed on the ref's id. That query is eventually consistent by construction. It
then sends, per target, `UpdateItem SET #ref = :refData` (eventual mode,
`Entity.ts:10602-10608`) or the same `Update` in one transaction (transactional mode,
`Entity.ts:10548-10560`), with **no condition**. Two outcomes follow, and neither needs a true
race, only a target change still inside the index's propagation delay:

- **A deleted target comes back.** `UpdateItem` on a missing key creates an item. It holds the
  key and the ref, with no `__edd_e__`, so no query sees it. A `get` fails to decode it, and a
  `create` at that key fails `ConditionalCheckFailed` until it is removed by hand.
- **A re-pointed target is overwritten.** Take a task moved from team A to team B while A is
  renamed with a cascade. The task's ref attribute ends up holding A's data while its id
  attribute names B. The denormalised copy now disagrees with the reference it denormalises.

---

## 3. Options per reproduced path

The costs below are DynamoDB's published rates:

- **A condition** on a write costs nothing extra when it holds.
- **A `GetItem`** costs one RCU per 4 KB of the item with `ConsistentRead`, and half that
  without, whatever its projection.
- **A non-transactional write** (`UpdateItem`, `DeleteItem`) costs one WCU per KB of the item.
  That includes an `UpdateItem` that changes nothing.
- **A `TransactWriteItems` item** costs twice the write rate, because DynamoDB prepares and
  commits each item. A `ConditionCheck` item is billed the same way although it writes nothing:
  two WCU per KB of the item it checks. On DynamoDB Local, a check-only transaction on a
  sub-KB row reported 2 capacity units. Local's figures are not AWS billing (CLAUDE.md), so
  the implementation confirms the rate on AWS, not through Local's `ConsumedCapacity` report.
- **Every item of a `TransactWriteItems`** counts toward the 100-item cap.

DynamoDB Local accepts a `TransactWriteItems` made only of `ConditionCheck` items, and an
`UpdateItem` with a `ConditionExpression` but no `UpdateExpression`. The second changes nothing,
returns the item under `ReturnValues: ALL_NEW`, and fails `ConditionalCheckFailedException` when
its condition is false. Both were checked on the 8132 instance while writing this design.

### 3.1 R1: no-op update, row deleted after the plan read it

| Option | Mechanism | Cost | What a caller observes |
|---|---|---|---|
| **a. `ConditionCheck` held to the commit (recommended)** | When a no-op plan read its row and found it (with the consistent read of §3.2(a)), `planned()` adds one `ConditionCheck { Key: ownKey, ConditionExpression: attribute_exists(#pk), ReturnValuesOnConditionCheckFailure: ALL_OLD }`. It is built by the builder `Transaction.check` already uses (`ConditionCheckOp`, `internal/TransactWriteOps.ts`), not a second one. The plan's role table treats it as the `main` item. A cancelled check with no stored item is a lost race (`lostRace(undefined)`), so the transaction is planned again. The fresh plan's consistent read finds the row missing and fails `ItemNotFound` before anything is sent: the standalone outcome. | One more item in the caller's transaction, billed as a transactional write of the row's size: two WCU per KB of the row (a 40 KB row adds 80 WCU to the transaction). No extra read: the plan already reads the row. No new request. | The transaction fails `ItemNotFound` and nothing commits, where today the siblings commit. A transaction already at 100 items with a no-op among them now has 101 and is diagnosed `TooManyItems`. A no-op beside another op on the same key is now a repeated item, diagnosed by the existing `RepeatedItem` diagnosis (#144). Today that combination commits, and the same pair with a non-empty payload is already refused. |
| b. Whole-row as-read check | The same `ConditionCheck`, but guarded with `deleteGuard(row, "item")`. | As (a), plus a larger expression. Any concurrent change to the row, even to a field the no-op doesn't name, retries the transaction. | Spurious retries. Standalone, a no-op promises only that the row exists, so this check is stronger than the op it stands for. |
| c. Refuse no-op updates in `transactWrite` | `ValidationError` (EDD-9173) pointing the caller at `Transaction.check`. | None at run time. | A dynamically built payload that happens to be empty fails a transaction that works today when the row is present. This is a public behaviour change with no precedent. |
| d. Named limit | Document that a no-op in a transaction is judged at plan time only. | None. | The siblings commit against a row deleted in the window. |

### 3.2 R2: no-op update with `returnValues("none")` (and standalone `updatedOld` / `updatedNew`)

| Option | Mechanism | Cost | Observed |
|---|---|---|---|
| **a. One consistent read in every return mode (recommended)** | The no-op branch reads the row with `readCurrent` (`ConsistentRead: true`, `Entity.ts:8747`), the read every read-first write makes, whatever `returnValues` says. It answers a missing row with the op's own missing-row outcome. The item-returning modes decode what it read, as `get` does today: a projection tombstone (#154) reads as missing, and offloaded values load per the read modes. `none` / `updatedOld` / `updatedNew` decode nothing, so they load no offloaded value from the blob store. The return value is unchanged: `undefined` for `none`, the empty partial for `updatedOld` / `updatedNew`. In a transaction, that read is the plan's read, so §3.1(a) holds it to the commit. | `none` / `updated*`: one consistent `GetItem` (1 RCU per 4 KB) where nothing is sent today. Default and `allOld` modes: the read they already make becomes consistent, so it costs twice as much (1 RCU per 4 KB instead of 0.5). | A missing row is `ItemNotFound` (or `ConditionalCheckFailed` for `patch`, §3.3), as with the default mode. A no-op straight after the write that created its row finds it. In a transaction, nothing commits. |
| b. Named limit | Document that a no-op with `returnValues("none")` doesn't check existence. | None. | Unchanged. |

### 3.3 R3: no-op `patch`

| Option | Mechanism | Cost | Observed |
|---|---|---|---|
| **a. Answer as `patch` answers (recommended)** | The no-op branch maps a missing row to `ConditionalCheckFailed` when the op is `patch` (`mustExist`), as every other `patch` path does. | None. | `ConditionalCheckFailed` instead of `ItemNotFound`. Both are in `patch`'s error union already. |

### 3.4 R4: no-op update with a `.condition()` (or `.keepRefs()`)

| Option | Mechanism | Cost | Observed |
|---|---|---|---|
| **a. The update's own `UpdateItem`, with no `UpdateExpression` (recommended)** | A no-op carrying a caller condition (or `.keepRefs()`'s guard) does not return early. It sends the request the update path already builds, minus its `UpdateExpression`: `UpdateItem { Key, ConditionExpression: attribute_exists(#exists) AND (<condition>), ReturnValues, ReturnValuesOnConditionCheckFailure: ALL_OLD }`. `ReturnValues` is `ALL_NEW` for the item-returning modes, which come back in the same response and need no `get`, and `NONE` otherwise. DynamoDB changes nothing. The update path's existing `ConditionalCheckFailed` mapping answers a refusal (`Entity.ts:13842-13870`): no stored item gives `ItemNotFound` (`ConditionalCheckFailed` for `patch`), and a stored item that fails the condition gives `ConditionalCheckFailed`, exactly what the same update with a payload reports. **Precedent:** the retain-only delete of a missing row sends its caller's condition the same way, in a single-item write that changes nothing (`DeleteItem` with `attribute_not_exists(#dpk) AND (<condition>)`, `Entity.ts:14750-14781`). In `transactWrite`, `planWrite` records an `UpdateItem` with no `UpdateExpression` as a `ConditionCheck` with the same key, condition and `ALL_OLD`. That is the transact form of a write that changes nothing, so standalone and planned stay one code path. The plan's verdict reads it: a present row refused under an unchanged condition is `TransactionCancelled`, as for every planned op with a caller condition. | Standalone: one non-transactional write, one WCU per KB of the row, in place of nothing (`none`) or in place of the `GetItem` the default mode makes. In a transaction: one `ConditionCheck` item, two WCU per KB of the row. | A failing condition fails the no-op, as it fails the same update with a payload. DynamoDB documents that a write that changes no data writes no stream record, so change-feed consumers see nothing; confirmed on AWS during implementation, since Local's streams may differ. |
| b. A one-item `TransactWriteItems [ConditionCheck]` standalone | The same condition sent as a check-only transaction. | Two WCU per KB of the row (transactional), plus a `GetItem` after it for the item-returning modes. That is twice (a)'s write cost and one more request. | The returned item is read after the check, so it can differ from the row the condition held. No outcome (a) lacks. Not recommended. |
| c. `GetItem` and judge the condition locally | Read the row and evaluate the condition client-side. | One read. | Not exact: the library's evaluator does not judge every condition DynamoDB does (`internal/FormGuard.ts` relies on DynamoDB for the caller's condition). Rejected. |
| d. Named limit | Document that a no-op evaluates no condition. | None. | A failed condition reads as success. |

### 3.5 R5: `purge` of a unique entity

| Option | Mechanism | Cost | Observed |
|---|---|---|---|
| **a. The unique hard delete's transaction for the live row (recommended)** | When the entity has `unique` constraints and a live row was read, `purge` sends the live-row `Delete` guarded by `deleteGuard(row, uniqueAttrs)` and every owned sentinel's ownership-checked release in one `TransactWriteItems`. These are the items `delete` builds at `Entity.ts:14789-14848`, built by the same functions. The transaction is sent before the batch, and the live row is left out of the batch. A cancellation restarts `purge` from its partition query, so the batch's rows come from the same fresh read as the transaction's, `GUARDED_PUT_ATTEMPTS` in all (`purge` refuses `.condition()`, so it is always the retried case). The rest of the rows (history, tombstones, sentinels a tombstone keeps under `preserveUnique`) are batch-deleted as today. | The live row and its sentinels move from a `deleteItem` per sentinel plus one batch slot to one transaction: two WCU per KB for those items instead of one, and fewer requests. One partition query and one row read per lost race. | A race ends with the row and its current sentinels deleted together. Once every attempt has lost: see D4. |
| b. Release again after the batch | Re-read sentinels after the row is gone. | — | Not possible: a sentinel is keyed by its value, and the value is on the deleted row. No index leads from the row's key to its sentinels. Rejected. |
| c. Named limit | Document the window. | None. | The orphaned sentinel stays. |

**The partition query (every entity, D13).** Step 1 becomes `ConsistentRead: true`, so a
`purge` straight after the item's last write sees every row it has. The mechanism behind the
cost: a `Query` is billed on the full size of the rows it reads, whatever the projection, at
twice the rate when consistent. So the query costs 1 RCU per 4 KB of the item's rows instead of
0.5. A writer still writing the item while it is purged can add a row after the query, such as
a snapshot or an event. That row survives the purge, and this stays a named limit. A sweep
like §3.7's would close it, but `purge` can't tell a row a racing writer added from the first
row of an item re-created in the window, and a sweep would delete the re-created item.
Erasing an item that is still being written is the caller's to sequence.

### 3.5a R8: cascade updates

| Option | Mechanism | Cost | Observed |
|---|---|---|---|
| **a. Condition each cascade update on its target still being the source's (recommended)** | Each cascade `Update` carries `attribute_exists(#pk) AND #rid = :sourceId`. `#rid` is the target's stored attribute for the ref's id (`matchingRef.idFieldName`, through the target's `field:` rename). `:sourceId` is the id in the target's stored form, the value the cascade query was keyed on. Eventual mode: a refusal means the target was deleted or re-pointed since the query. It is not the source's any more, so it is skipped and counted in neither `succeeded` nor `failed`. Transactional mode: a refused item cancels the transaction. Its cancellation reasons name the refused items, which are dropped, and the rest is sent again, up to `GUARDED_PUT_ATTEMPTS` sends. After the last send it is `CascadePartialFailure` as today. | A condition per update: nothing when it holds. Transactional mode: one more `TransactWriteItems` per round that has a refusal. | No partial item is created at a deleted target's key, and no re-pointed target is overwritten. `CascadePartialFailure` is unchanged, so no error union changes. |
| b. Named limit | Document that a cascade can write to a target that changed in the index's propagation delay. | None. | Partial items that block a later `create` at their key, and denormalised data that disagrees with its reference. |

### 3.6, 3.7 R6, R7: aggregates

Moved to #168.

---

## 4. Recommended approach and its interactions

### 4.1 No-op updates (R1 to R4)

**Rule:** an update that resolves to no write establishes what its write would have
established. Those are the row's existence, `patch`'s existence answer, and the caller's
condition. Standalone, they are established by a consistent read or by the update's own
request. In a transaction, the check is held to the commit. The code is one path. The no-op
branch (`Entity.ts:13581`) runs these steps:

1. **With a caller condition or a `.keepRefs()` guard:** it falls through to the update's
   request with no `UpdateExpression` (§3.4(a)), through `Capacity.client` and wrapped in
   `diagnoseFailure`, as today. The existing refusal mapping answers it, with two things held
   fixed for a no-op. First, a no-op never takes the create fallback (`createsOnMissing` is
   false), so a missing row is `ItemNotFound` (`ConditionalCheckFailed` for `patch`), never
   `MissingForCreate`. Second, `.cascade()` does not run, because nothing changed. The
   item-returning modes decode the item returned in the same response.
2. **Otherwise:** it reads the row with `readCurrent`, consistently (§3.2(a)). The
   item-returning modes decode it. A missing row (or a projection tombstone) is `ItemNotFound`,
   or `ConditionalCheckFailed` for `patch` (§3.3).

In a transaction, `planWrite` records step 1's request as a `ConditionCheck`
(`asConditionCheck`, beside `asPut` / `asUpdate` / `asDelete`, for an `UpdateItem` with no
`UpdateExpression`). After step 2's read finds the row, `planned()` adds the existence
`ConditionCheck` (§3.1(a)). `planWrite`'s `conditionOfItem` and `record`, and `planned()`'s role
and `guarded` lookups, learn the `ConditionCheck` shape, so the existing verdict judges it:

- absent means a lost race and a re-plan;
- an unchanged row under a caller condition means `TransactionCancelled`.

`planned()`'s own read for an op that read nothing (`Entity.ts:14113`) then also covers a
conditioned no-op, whose plan stops at the recorded check. Its `rowMissing` answer reaches step
1's missing-row path.

A named limit: a no-op never creates. A non-empty update whose payload is complete creates a
missing row (`createsOnMissing`), but a no-op's payload names no primary-key composite, so the
only no-op that could count as complete is one on a keyless singleton entity (`pk` and `sk`
both `composite: []`) whose fields are all optional.

| Feature | Interaction |
|---|---|
| unique sentinels | A no-op rotates no sentinel. Nothing changes. |
| versioned / retain | A versioned update always `SET`s the version (`Entity.ts:13168-13177`), so it is never a no-op. Not affected. |
| timestamps | A stamped entity always `SET`s `updatedAt` (`Entity.ts:13159`), so it is never a no-op. Only an entity with neither timestamps nor versioning reaches the branch. |
| softDelete | A soft-deleted item has no live row, so it is `ItemNotFound` as today. |
| timeSeries | `update` on a time-series entity is the plain update. `append` is not touched. |
| refs | A no-op hydrates no ref. `.keepRefs()`'s guard joins the condition (step 1), as the planned verdict already treats it as the caller's (`Entity.ts:14366`). |
| offloaded fields and the upload ledger | Nothing is uploaded: the no-op returns before `OffloadWrite.setValues`. Neither the request with no `UpdateExpression` nor the `ConditionCheck` holds a pointer, so the ledger has nothing to prepare or settle, and `markRecording` (`TransactPlan.ts:188`) is unchanged. `none` / `updated*` decode nothing, so they load no offloaded value. |
| cascade | A no-op cascades nothing, as today. It changed nothing, and falling through to the request must not reach `cascadeFrom`. |
| packed fields, form guards (#238) | Nothing is written. A condition naming a packed field is refused as today, before sending (EDD-9076). |
| escapeKeys / rekey | The check's key is `composePrimaryKey(encodedKey)`, the key the op reads and would write, through `_keyForm`. A row under the other setting's text is `rekey`'s job, as for every key-taking op. |
| ConsumedCapacity | The new requests (the `GetItem` for `none` / `updated*`, and the `UpdateItem` with no `UpdateExpression`) run inside the existing `Entity.update` / `Entity.patch` scope (`_exec`). They need no new `Capacity.operation`. `test/ConsumedCapacity.coverage.test.ts` gains cases for both, so they are proven to report under the op and never as an implicit `DynamoClient.<Command>` root. In a plan, the recorded check is `markNotSent` as every recorded write is. |
| transactWrite planning | As above. Precedence in `judgeCancellation` is unchanged: the check is a `guarded` item of the op's plan. |
| #144 diagnosis | Nothing is pre-checked. One more item can push a full transaction over 100, or repeat a key. Both are diagnosed after DynamoDB rejects them (`TooManyItems`, `RepeatedItem`), naming the no-op's op. |

### 4.2 `purge` (R5)

The live row and its sentinels are written as `delete` writes them for a unique entity. The
item-building functions are shared, not copied. The retry loop is `GUARDED_PUT_ATTEMPTS`, and
each attempt starts again from the partition query. The partition query is consistent for
every entity (D13).

| Feature | Interaction |
|---|---|
| unique sentinels | The point of the change. A sentinel that a tombstone keeps under `preserveUnique` is released as today. |
| versioned / retain | `deleteGuard` guards on the version and incarnation, which is stronger than the unique attributes. Retained snapshots are history rows and stay in the batch. |
| softDelete | Tombstones stay in the batch: no writer changes a tombstone's values. A `restore` racing `purge` is out of scope (a named limit; both are administrative). |
| timeSeries | Event rows stay in the batch. Only the current item joins the transaction. |
| refs, packed | No change: rows are deleted by key. |
| offloaded fields | `purge` deletes the item's blob versions after its rows are gone (#179 §11.6). That runs after the transaction and the batch, as today. |
| escapeKeys / rekey | Keys come from the rows read, as today. |
| ConsumedCapacity | The transaction runs under the existing `Entity.purge` scope. The coverage test gains the raced case. |
| #144 | The transaction is diagnosed as `delete`'s is (`diagnoseFailure`). A unique entity has at most one sentinel per constraint, so it stays far below 100 items. |

### 4.2a Cascade (R8)

| Feature | Interaction |
|---|---|
| refs, `field:` renames (#241) | The condition names the target's stored id attribute and value, through the same `_setOf` / key form the query was keyed by. `refDataOf` is unchanged. |
| sharded cascade index (#183) | The condition is on the base row's attribute, not on the index key, so sharding doesn't affect it. |
| packed / offloaded ref | The condition names the id attribute, never the packed ref value, so EDD-9076 never applies. |
| transactional mode, #144 | No limit is pre-checked. A resend after dropping refused items is smaller than the request DynamoDB already accepted the shape of. |
| ConsumedCapacity | The resend runs under the source update's scope, as the cascade's requests do today. |
| CascadePartialFailure | Unchanged type. A skipped target is neither `succeeded` nor `failed`. |

### 4.3 Aggregates (R6, R7)

Moved to #168.

---

## 5. Test plan

### 5.1 Unit (in-memory tables)

- `test/Issue132.races.test.ts` becomes `test/ReadWriteRaces.test.ts`, named by behaviour, as
  `VectorWriteRaces.test.ts` is. Its 33 entity cases are kept, and the issue number is
  dropped from names.
  - The 26 passing cases are regression tests for §2.1.
  - The 7 failing cases of R1 to R5 flip to green with their decisions: R1, R2 (standalone and
    transaction), R3 (standalone and transaction), R4 and R5. The two aggregate cases are
    dropped (#168).
- New cases:
  - A no-op with `.keepRefs()` whose ref moved.
  - A no-op beside 99 other items, which shows the `TooManyItems` diagnosis names it.
  - A no-op plus `Transaction.check` on the same key, which shows `RepeatedItem`.
  - A conditioned no-op in a transaction whose condition fails on an unchanged row, which is
    `TransactionCancelled`.
  - A `purge` losing every attempt, which gives D4's error.
  - A no-op straight after the put that created its row finds it. Its `GetItem` carries
    `ConsistentRead: true`, asserted on `calls`.
  - A conditioned no-op standalone sends exactly one `UpdateItem` with no `UpdateExpression`
    and returns the item from that response, with no `GetItem` after it. Its planned form
    records a `ConditionCheck` with the same key and condition.
  - A conditioned no-op with `.cascade()` sends no cascade request.
  - `purge`'s partition query is consistent (asserted on `calls`). `purge` straight after a
    retain update deletes that update's snapshot.
  - R8, eventual and transactional mode: a cascade whose target is deleted after the cascade's
    query creates no item at that key. One whose target is re-pointed to another source leaves
    the target's ref untouched. In transactional mode, the other targets are written on the
    resend.
- `Transaction.test.ts:1789` ("a transaction of only no-op updates sends nothing") changes: the
  row is present, so the transaction now sends the existence checks. That is the design's
  intent, and the test is rewritten to assert it.
- `test/ConsumedCapacity.coverage.test.ts`: the cases listed in §4.

### 5.2 Connected (DynamoDB Local)

The concurrent write is injected through a decorated `DynamoClient`. `raceAfterFirstRead`
(`connected.test.ts:2236`) moves to `test/helpers/RaceAfterRead.ts` and gains a query variant.
It wraps the client so that the first `getItem` (or `query`) returns and then runs the
concurrent effect before the op continues. A new `test/connected.read-write-races.test.ts` runs
R1 to R5 and R8 against DynamoDB Local. It also runs the no-op `UpdateItem` with no `UpdateExpression`
and the check-only transaction, whose acceptance by DynamoDB the design relies on, and the §2.1
cases that depend on DynamoDB's own evaluation of conditions:

- an unversioned soft delete;
- a unique hard delete;
- a unique-field update;
- the ABA at version 1.

It runs in both passes:

- `DYNAMODB_ENDPOINT=http://127.0.0.1:8132` (plain);
- `DYNAMODB_ENDPOINT=http://127.0.0.1:8133` (`escapeKeys` on).

Both passes also set `S3_ENDPOINT=http://127.0.0.1:9132`, the MinIO credentials and
`AWS_REGION=us-east-1`. A unique entity with an offloaded field covers the ledger interactions.

The canonical GSI-composite shapes are not affected: no composer or index-policy path changes.

---

## 6. Decisions

| ID | Kind | Question | Recommendation | Owner's decision |
|---|---|---|---|---|
| D1 | owner | What does a no-op `patch` of a missing row report? | `ConditionalCheckFailed`, standalone and in a transaction. The documented contract supports it: CLAUDE.md ("`patch()` of a missing item is `ConditionalCheckFailed` on every path, read-first included") and `patch`'s own doc (`Entity.ts:1751-1753`). Owner because a caller catching today's `ItemNotFound` sees a different tag. Both are in `patch`'s union, so no type changes. | Accepted as recommended. |
| D2 | owner | Does a no-op update read its row consistently, in every return mode? | Yes. One `readCurrent` (`ConsistentRead: true`) in every mode, and a missing row is `ItemNotFound` (§3.2(a)). For `none` / `updated*` this is a `GetItem` where nothing is sent today: 1 RCU per 4 KB. For the default and `allOld` modes, the read they already make becomes consistent and costs twice as much. The reason for the cost: an eventually consistent read can miss the row the caller just wrote, and the plan's existence answer in a transaction is only as fresh as the read. The same op's default mode, and an update of a missing row that can't create it, already answer `ItemNotFound` (`Entity.ts:13586`, `get` at `Entity.ts:11194`). Owner because `ok` becomes `ItemNotFound` for `none` / `updated*`, and every no-op's read cost changes. | Accepted as recommended. |
| D3 | owner | How is a no-op update held to the commit of a transaction (R1)? | A `ConditionCheck attribute_exists(#pk)` on its key, built by `Transaction.check`'s builder and judged by the plan's existing verdict (§3.1(a)). It costs two WCU per KB of the row, billed with the caller's transaction. Alternatives: the whole-row check (b), refusing no-op updates in `transactWrite` (c, EDD-9173), or a named limit (d). Owner because it adds a billed item to the caller's transaction. That can turn a 100-item transaction into a `TooManyItems` failure, or turn a no-op plus another op on the same key into a `RepeatedItem` failure, where both commit today. | Accepted as recommended. |
| D4 | owner | `purge` of a unique entity: guard the live row and its sentinels (R5), and what does it report once every attempt has lost? | Use the unique hard delete's transaction (§3.5(a)), each attempt restarting from the partition query. Once every attempt has lost, report what `delete` reports (`OptimisticLockError` versioned, `ConcurrentModification` otherwise), which widens `purge`'s error union. The alternative that keeps the union is a `DynamoError` carrying the last cancellation. Owner because of the new error members and the transactional rate (two WCU per KB) for those items. | Accepted as recommended. |
| D5 | owner | `.condition()` / `.keepRefs()` on a no-op update (R4)? | Evaluate it with the update's own `UpdateItem`, sent with no `UpdateExpression` (it changes nothing), answered by the update path's existing refusal mapping. `planWrite` records that request as a `ConditionCheck` (§3.4(a)). Standalone it costs one non-transactional write (one WCU per KB of the row) and returns the item in the same response. In a transaction it costs one `ConditionCheck` (two WCU per KB). Precedent for the mechanism: the retain-only delete of a missing row sends its caller's condition in a write that changes nothing (`Entity.ts:14750-14781`). The rejected alternative, a check-only `TransactWriteItems` standalone, costs twice the write plus a `GetItem`. Other alternative: a named limit ("a no-op evaluates no condition"). Owner because it changes an outcome (`ok` becomes `ConditionalCheckFailed` / `TransactionCancelled`) and adds a billed write. | Accepted as recommended. |
| D6 | owner | (aggregates) | — | Moved to #168. |
| D7 | owner | (aggregates) | — | Moved to #168. |
| D8 | owner | (aggregates) | — | Moved to #168. |
| D9 | precedent | Are the issue's three named paths, the ABA and the FAQ item closed without code? | Yes. Each is covered by a guard and retry that already shipped (§2.1, with citations), and their reproduction tests stay as regression tests, as `VectorWriteRaces.test.ts` keeps the vector races. No observable change. | Stands. |
| D10 | precedent | Retry budget for every new retry (purge, cascade resend). | `GUARDED_PUT_ATTEMPTS` (`Entity.ts:2854`), the budget of every read-first delete and guarded put, imported, not redefined. | Stands. |
| D11 | owner | (aggregates) | — | Moved to #168. |
| D12 | owner | Guard cascade updates (R8)? | Yes: `attribute_exists(#pk) AND #rid = :sourceId` on each target. A refused target is skipped in eventual mode, and dropped and resent in transactional mode (§3.5a(a)). No cost when the condition holds. One more `TransactWriteItems` per transactional round that has a refusal. Owner because it changes outcomes: a deleted target is no longer re-created as a partial item, and a re-pointed target is no longer overwritten. | Accepted as recommended. |
| D13 | owner | Make `purge`'s partition query consistent (every entity)? | Yes (§3.5). A `Query` is billed on the full size of the rows it reads, and twice as much when consistent, so the query costs 1 RCU per 4 KB of the item's rows instead of 0.5. Without it, a `purge` straight after a write can leave that write's rows behind. A writer still writing during the purge stays a named limit: a sweep can't tell its rows from a re-created item's. Owner because it changes `purge`'s cost. | Accepted as recommended. |

---

## 7. Scope

**In (decided):**

- R1: a no-op update held to a transaction's commit (D3).
- R2: a no-op update reads its row consistently in every return mode (D2).
- R3: a no-op `patch` reports `ConditionalCheckFailed` (D1).
- R4: a no-op update's condition is evaluated (D5).
- R5: `purge` deletes the live row and its sentinels in one guarded transaction (D4), and
  queries the partition consistently (D13).
- R8: cascade updates are conditioned on the target still naming the source (D12).
- Regression tests for every §2.1 claim (D9).
- The raced connected suite in both passes.
- Doc updates: CLAUDE.md's `patch` / no-op wording, purge and cascade bullets, DESIGN.md, the
  expressions guide's note on conditions, and the refs / cascade guide (a target that changed
  is skipped).
- A minor changeset for the four lockstep packages: #132 and #168 ship together as 1.44.0.

**Moved to #168 (owner's decision):** every aggregate item: R6, R7, D6, D7, D8 and D11, with their
tests and docs. `Aggregate.ts` is not changed on this branch.

**Changed (from the issue's text):**

- The issue's three named paths: from "add a read guard" to "already guarded; regression tests
  only".
- The ABA at version 1: from "make `put` continue the version, or add a revision attribute" to
  "already done (continued version plus incarnation token); tests only".
- Retain hard-delete snapshots and the FAQ: from "fix the FAQ, or snapshot hard deletes" to
  "hard deletes snapshot on 1.43.0; the FAQ is accurate; no change".
- The related case: from "a no-op update in a transaction commits when its row is missing" to
  its two remaining forms, R1 (the race) and R2 (`returnValues("none")`).
- Added beyond the issue's text: R3 and R4 (the same no-op family), R5 (purge), R8 (cascade),
  and the read-consistency decisions D2 and D13.

**Out:**

- A revision attribute for entities: incarnation plus version already serves.
- A `restore` racing `purge`: a named limit; both are administrative.
- `append`, `reembed` and projections: each already has its own CAS or guard
  (`APPEND_GUARD_ATTEMPTS`, `reembedGuard`, the projection row token) and its own race tests.
- A `purge` racing a writer still writing the same item: a named limit (§3.5). A sweep can't
  tell the writer's new rows from those of an item re-created in the window.
- The no-op never creates, even where a complete update would: a named limit (§4.1).
- Write-time ref hydration (`internal/Hydrate.ts`): a write denormalises the referenced row
  as read. If that row changes before the write lands, and its cascade's index query misses
  the target the write is still creating, the target keeps the old copy. A named limit. Closing
  it would put a `ConditionCheck` on the referenced row as read beside every hydrating write,
  which turns every such put or update into a transaction: twice the write rate, plus the
  check at two WCU per KB of the referenced row.
- The change feed's checkpoint commit (`change-feed/CheckpointStore.ts`) is not fenced by the
  lease. A former holder can commit an older sequence, which replays records, and the feed is
  documented at-least-once. That is not a read-then-write of an item, so not this issue.
