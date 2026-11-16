# Design: aggregate concurrency (#168, with #132's aggregate items)

**Status:** decided. Written before the code against release 1.43.0 (`9ec9bb63`), reviewed, then amended
with the owner's decisions (§0), which override the recommendations below wherever they differ.
**Semver impact:** minor, the four packages in lockstep, shipped with #132 as **1.44.0**. `Aggregate.update`
gains errors on its error channel (it can now fail where it used to lose a write), an opt-in `versioned`
option, an opt-in `fence` option and an `expectedVersion` argument. Nothing changes for a stored row unless
`versioned` is turned on.

Every decision is listed in §5, each marked **owner** (decided in §0) or **precedent** (the library already
does exactly this elsewhere, cited). §1 is the problem as it stands, §2 every fix weighed with its mechanism
and cost, §3 the approach and what it touches, §4 the tests, §6 the scope.

## 0. The owner's decisions (binding)

Recorded 2026-11-15. Where §2–§6 say otherwise, this section wins; the sections are amended to match.

- **Accepted as recommended:** D1 (row guards always on; `update`'s error union gains
  `ConcurrentModification`), D2 (send only the rows that changed), D3 (one transaction when it fits, no mode
  option), D5 (opt-in `versioned` with the incarnation token), D6 (`update(key, fn, { expectedVersion })`
  checked before `fn` on a consistent read, and `UpdateContext.version`), D8 (root-first delete, in the
  fenced case), D9 (an optional `committed` on `ConcurrentModification` / `OptimisticLockError`), D10 (the
  `ownsRows` cleanup guarded and joined to the update's transactions), D15 (member-path attribute names),
  D17, D18. The precedent decisions D12, D13, D14 and D16 stand.
- **D7: surface conflicts.** `update` fails with `ConcurrentModification`, or `OptimisticLockError` when
  `versioned`. Nothing inside the library re-runs `fn`. The guide shows a bounded, jittered `Effect.retry`.
- **D11 is reversed.** On a base-table collection, `update`'s partition read is strongly consistent
  **by default**, whatever `consistentRead` says, as read-first entity ops and `commandHandler` (#139) read.
  A collection index is read as `consistentRead` says, as on 1.43.0: eventually consistent by default, a
  named limit (an update made within the index's propagation delay of an earlier write can surface a
  conflict). The docs that said aggregates read eventually consistently by default for `update` are
  corrected.
  - **Amended after review, confirmed by the owner on 2026-11-16.** The decision first told an LSI from a
    GSI as `Table.tableDefinition` does: a collection index keyed on the table's own partition key was taken
    as an LSI and read consistently by default. A GSI may be keyed on the table's partition key too (one
    added to a table after it was created, since an LSI can only be created with the table), and DynamoDB
    refuses a consistent read of it: every `update` failed, and `delete` failed after deleting the
    aggregate, where 1.43.0 succeeded. Nothing the library holds tells the two apart, so only
    `consistentRead: true`, the caller's statement that the index can be read consistently, makes an index
    collection's `update` and `delete` reads consistent. The cost falls on an aggregate collection on an LSI
    without `consistentRead`: its `update` reads eventually consistently, so a write within the index's
    propagation delay surfaces as a conflict (retryable, never a lost write), and `delete`'s second read can
    miss a row committed just before it, which then stays (as on a GSI). The owner confirmed this over the
    alternative, an explicit per-collection setting naming the index kind.
- **D4, the root fence, is an opt-in `Aggregate.make` setting, `fence: true`, off by default** and costing
  nothing when off. `versioned` implies it, because the version `Update` on the root is itself the fence;
  `versioned` with `fence: false` is refused at `make` (`EDD-9179`).
  - **Fence on (or `versioned`):** every update request that doesn't `Put` the root (or carry its version
    `Update`) checks the root; `delete` deletes the root first, then reads the partition once,
    consistently, and deletes the aggregate's rows it finds (D8, D17).
  - **Fence off (the default):** an update racing a delete can leave root-less rows when the update sends
    only new rows (a named limit: every row it sends that existed is guarded, so a deleted aggregate
    cancels any update that rewrites or deletes an existing row). `delete` keeps its read-then-delete
    order, plus **one consistent sweep `Query`** after its batches: the sweep deletes the aggregate's rows it
    finds, unless it finds a root (a `create` reused the key), in which case it deletes nothing. This closes
    the row-added-after-read window (R8) for one `Query`.
- **#132's aggregate items** (aggregate update guards and the delete sweep) moved to this issue: this branch
  owns all aggregate concurrency work.
- **Codes:** `EDD-9177` (`versioned` refused at `make`), `EDD-9178` (`expectedVersion` without `versioned`),
  `EDD-9179` (`versioned` with `fence: false`, or a `fence` that isn't a boolean). `EDD-9180` stays reserved.
- **Changeset:** minor; #132 and #168 ship together as 1.44.0.

## 1. The problem on 1.43.0

### 1.1 The write path today

`Aggregate.update(key, fn)` (`updateCore`, `packages/effect-dynamodb/src/Aggregate.ts:4294`):

1. One partition `Query` (paged, `fetchPartition` → `readPartitionRaw` → `queryAllItems`, `Aggregate.ts:7417`),
   eventually consistent unless the aggregate sets `consistentRead` (`Aggregate.ts:2725`), through the
   collection index when the aggregate names one.
2. Assemble, run `fn`, decode, decompose old and new into transaction groups.
3. A group is written when anything in it changed (`groupChanged`, `deepEqualGroups`); a no-op update writes
   nothing.
4. Each changed group is **one `TransactWriteItems`**: a `Put` of **every row of the group** (rebuilt whole
   from the state read) plus `Delete`s of the rows the new state dropped (`writeTransactionGroups`,
   `Aggregate.ts:10380`). Neither carries a condition: the only condition `writeTransactionGroups` ever sends
   is `create`'s root guard (`Aggregate.ts:10414`), and `update` doesn't pass one (`Aggregate.ts:4619`).
5. With `ownsRows`, the cleanup `Delete`s go in requests of their own after the groups
   (`deleteOwnedRows`, `Aggregate.ts:10549`), each conditioned `attribute_not_exists(#pk) OR #e = :e`
   (the row is gone or still of the type read).

A transaction group is the root plus every `one` / `many` edge hanging off it, and each **sub-aggregate**
(a `BoundSubAggregate` edge, nested ones by path) is its own group (`decomposeNode`, `Aggregate.ts:9460`).
A plain `many` or `one` edge is never a group of its own: it is written in its parent's transaction.

`create` decomposes the same way and writes the groups in the same function, root group first with the root
`Put` conditioned `attribute_not_exists(#pk)` (#134, `Aggregate.ts:5923`). `delete` reads the partition and
deletes every row of the aggregate's types it read with `BatchWriteItem` (`deleteAllItems`,
`Aggregate.ts:10669`), which takes no condition.

### 1.2 What reproduces

`packages/effect-dynamodb/test/Issue168.races.test.ts` (uncommitted; run with
`npx vitest run test/Issue168.races.test.ts` in `packages/effect-dynamodb`) forces each interleaving over a
recording in-memory table (`makeRecordingTable`) with `gatedClient` (`test/helpers/GatedClient.ts`). The
fixture is a match: a root and two team sub-aggregates (three transaction groups), each team holding a
`many` edge of lines. Each test asserts serialisability: a writer told it succeeded has its change stored,
or it failed; a failed write changed nothing. All nine fail on 1.43.0; the control (the same writes one
after the other) passes.

| # | Path | What happens on 1.43.0 |
|---|------|------------------------|
| R1 | Two `update`s read the same state and change different fields of the **root row** | Both succeed; the later `Put` of the whole root puts the earlier writer's field back. |
| R2 | Two `update`s change **different lines of one group** | Both succeed; a changed group is rewritten whole, so the later writer re-puts the other's line from its stale read. |
| R3 | Two `update`s each change all three groups; their transactions interleave | Both succeed; the stored aggregate holds B's root and A's teams, a state neither produced (torn). |
| R4 | A later group's transaction fails after the root group's committed | The update fails, but the root group's rows stay: no cross-group atomicity. |
| R5 | A **non-aggregate writer** (a raw, per-row conditional `UpdateItem` on a line's denormalised copy) lands between `update`'s read and its write; `update` changes another line of that group | `update` succeeds and puts the stale copy back. This is the issue's real case. |
| R6 | The aggregate is deleted between `update`'s read and its write | `update` succeeds and writes the changed group's rows into the deleted partition: root-less rows. Not in the issue's text; the same missing guard. |
| R7 | `create`: a later group's transaction fails after the guarded root group committed | The root stays; a retried `create` is refused by its own root guard, so no `create` can complete the aggregate. |
| R8 | `delete`: a row is added between its read and its `BatchWriteItem` | `delete` succeeds and the row stays as an orphan. |
| R9 | `ownsRows` cleanup: another writer changes a row the update read as hidden (to be cleaned) before the cleanup | The cleanup's condition matches on entity type only, and deletes the row the other writer just made visible. `DESIGN.md` §11 already says "Aggregate updates have no concurrency control" here. |

Not reproduced, because a guard already covers them (no new test):

- **`rekey`** (`rekeyCore`, `Aggregate.ts:4752`) is a read-then-write over the same rows, and is guarded: the
  `Delete` of each moved row carries the whole row as read (`guardOf`, `Aggregate.ts:5105`, through
  `wholeRowGuard` / `preferredGuard` / `asReadGuard` in `internal/ExpressionLimits.ts`), the `Put` at the new
  key is `attribute_not_exists(#pk)` (`Aggregate.ts:5183`), and a cancelled transaction is read again up to
  `REKEY_ATTEMPTS` (3). What it can't prove is reported (`leftAsIs`, `guardGap`).
- **Entity writes** never `Put` a stale whole row: a versioned update is a version CAS, an unversioned one is
  a partial `UpdateItem` guarded on the inputs it read (`Entity.ts:12325`–`12358`, failing with
  `ConcurrentModification`), read-first puts and deletes guard on the item read and retry a lost race
  (`GUARDED_PUT_ATTEMPTS`). Restore, reembed, the time-series append and projections have their own guards.
- An **entity op cannot address an aggregate row**: an entity composes each key composite with its field's
  name and an aggregate never does (`entityWriters`, `Aggregate.ts:9031`–`9046`). So the "non-aggregate
  writer" of the issue is necessarily a writer outside the library's members (a raw `UpdateItem`, another
  service), which no version kept by the library can see unless it cooperates. This shapes §2.1.

### 1.3 The issue's claims, checked

- "No compare-and-set; `Aggregate.make` accepts no `versioned` option": still true.
- "The only conditional write is the create-time root guard": no longer exactly true. Since 1.40.0 the
  `ownsRows` cleanup `Delete`s are conditioned (`Aggregate.ts:10556`) and `rekey`'s moves are guarded (above).
  It stays true of `update`'s own writes, which is what the issue means.
- "One `TransactWriteItems` per changed group (root, each `many`/`one` edge group)": the count is right for
  sub-aggregates only. A `many` / `one` edge is written in its parent's transaction (§1.1), so a mutation of
  the root and two of its plain edges is one transaction. The issue's match has team sub-aggregates, so its
  three transactions are real.
- Lost update and torn aggregate: both reproduce (R1–R4), and the lost update is wider than the issue says:
  two writers lose each other's changes even when they change **different fields of one row** (R1) or
  **different rows of one group** (R2), because a changed group is rewritten whole from the read.
- "Observed on 1.24.0; 1.25.0 is the same": 1.43.0 is the same.

## 2. The fixes weighed

Costs below use DynamoDB's billing: a transactional write is 2 WCU per KB of the item, a `Put` / `Update` is
billed on the larger of the item before and after, a strongly consistent read costs twice an eventually
consistent one, and a condition on a write adds no capacity (it is evaluated as part of the write). Request
bytes matter only against DynamoDB's request limits (16 MB body; the transaction's 4 MB; each expression's
4,096 characters and 300 operators, `internal/ExpressionLimits.ts`).

### 2.1 Lost update (R1, R2, R5)

**A. An aggregate version on the root.** The root row holds a number. `update` reads it as `v`; its write
carries `#ver = :v` (or `attribute_not_exists(#ver)` for a root written before the option) and sets `v + 1`.
Every update that writes anything must move it, so a write that doesn't change the root adds an `Update` of
the root to its transaction.
- Catches: every other aggregate writer, whatever rows it touched (it moved the version), so aggregate
  writers whose writes fit one transaction are serialised, write skew included (a decision on rows it didn't
  write, §3.11). Past one transaction, see §2.3.
- Misses: R5. A raw per-row writer doesn't move the version unless it is written to (a second item in its own
  transaction, or a raw `UpdateItem` of the root beside its own write). The issue's job would have to change.
- Cost: a stored attribute (an opt-in flag, per the stored-format rule); one more item per update whose root
  didn't change, billed as a transactional write of the **root's** size (an `Update` is billed on the whole
  item); one more stream record (the root's `MODIFY`) per update. `DESIGN.md` §11, timestamps rule 3,
  records that a forced write of the root on every update was turned down for exactly this cost, so it can't
  be the default. Measured against `fence: true` (§2.4, §0), the item is not extra: a fenced update
  transaction already carries one item on the root (a `ConditionCheck` billed as a transactional write of
  the root's size), and `versioned` turns it into an `Update` of the same root, billed the same. Against the
  default (no fence), `versioned` adds that one item per update whose root didn't change, plus the stored
  attributes, the root's `MODIFY` stream record and the rewritten root image.
- **A version alone repeats across incarnations.** `delete` removes the root and a later `create` writes
  version 1 again, so a writer that read version 1 of the old aggregate passes `#ver = :v` on the new one
  (ABA): rows it sends that the new aggregate doesn't hold pass `attribute_not_exists`, and its decision was
  made on another aggregate. Entities met the same problem and answer it with a hidden incarnation token,
  `__edd_i__`, a random UUID written when the item is created and checked beside the version on every
  version-conditioned write (`incarnationGuard`, `Entity.ts:8335`; `createdAt` doesn't do, since two
  creates in one millisecond, or a caller-supplied value, repeat it). The aggregate's version needs the same
  token on its root (§3.5).
- Caller sees: `OptimisticLockError` (as entities), and can pass an expected version (If-Match).

**B. Per-row conditions on what was read.** Each row the write sends is conditioned on what the read saw:
- a `Put` of a row that was read: the whole row as read (`wholeRowGuard`, the guard `rekey` puts on a move:
  it exists, every attribute holds the value read, and each attribute a write could add that the read didn't
  have is still absent);
- a `Put` of a row that wasn't read: `attribute_not_exists(#pk)`;
- a `Delete` of a row read: the row as read.
- Catches: any writer, the library's or not, that changed, added or removed a row this write sends. R1, R2
  (the second writer's `Put` of the line the first changed fails), R5, R6 (the rows are gone).
- Misses: a writer that changed only rows this write doesn't send, where `fn`'s result depended on them
  (write skew), and, on a row too wide for one expression (more than about 150 attributes: 300 operators,
  two per clause), whatever attributes don't fit.
- Cost: no stored attribute, no extra request, no extra capacity. Each guarded `Put` carries the row's values
  twice (item and condition). The 16 MB body limit is far away, but **the 4 MB transaction limit is not**:
  the library's model of that limit, measured on DynamoDB Local at its boundaries, counts each action's
  condition with its values (`transactItemBytes`, `internal/ItemSize.ts:151`). A row guarded whole therefore
  counts about twice its size, so one transaction carries about half the bytes of rows it carried unguarded.
  A write that fit one transaction at 2.5 MB of rows on 1.43.0 now takes two, and a single unit (a group
  sent whole, §3.3) over about 2 MB of rows no longer fits any transaction (§2.3, D18).
- **What a row guard proves.** That the row is as it was read, by value. A row changed and changed back
  between the read and the write (ABA) passes, and that is harmless for the row: the `Put` is derived from a
  value equal to the one stored, so no write to that row is lost. What it can't prove is the reason the
  update read the row (write skew, below) or that the aggregate is the same incarnation: with no timestamps,
  a deleted and re-created aggregate whose rows hold the same values passes, and a row only the new state
  writes passes `attribute_not_exists`. Unversioned, that is a named limit (§3.11); `versioned` closes it with
  the incarnation token.
- Caller sees: `ConcurrentModification` (as an unversioned entity update), naming the rows and attributes.

**C. Both.** B always; A when the aggregate opts in. Each covers what the other misses: A serialises the
library's own writers (write skew included) for those who pay for the root write, B protects every row
sent from every writer, for free.

**D. Condition every row read, written or not** (a `ConditionCheck` per unwritten row). Closes write skew
without a stored attribute, but each check is an item of the transaction (100 per transaction) billed as a
transactional write of that row's size, so a 60-row aggregate pays 60 extra items on every update and
outgrows one transaction. Rejected: A does the same job for the cost of one item.

**E. Partial writes** (`UpdateItem` of the changed attributes instead of a `Put` of the row). A row's
attributes come from the decomposed value as a whole (renames, packing, context copies, stamps, a dropped
optional field needing `REMOVE`), and a wide change splits into several requests, which are not atomic.
Rejected: B gives the same protection without changing how a row is written.

**F. A lock row (pessimistic).** Take a lease item before reading, release after writing. Two more writes per
update, a lease to expire when a writer dies, and a non-library writer still isn't stopped. Rejected.

**Narrowing the write to the rows that changed.** Independent of A/B/C. Today a changed group sends every
one of its rows. Under B each unchanged row sent is a guard that can fail: in R5 the scorer changes line a,
and its unchanged line b, rewritten only because it is in the same group, would fail on the job's
correction. Sending only rows whose decomposed value changed (plus every row of the group when a context
field changed or its copies are stale, as today) means the scorer succeeds and the job's correction stays.
Cost: none; it saves the WCU of every unchanged row (2 WCU per KB each) and re-uploads no offloaded value of
an unchanged row. Observable: an unchanged row in a changed group keeps its stored `updated` stamp (today it
is restamped), which is what timestamps rule 3 ("`updated` records when that row last changed") describes.

### 2.2 Torn aggregate (R3, R4)

**A. One transaction for the whole write when it fits.** All groups' items in one `TransactWriteItems`.
- Mechanism: the items are packed with `packRequests` (`internal/ItemSize.ts:346`–`355`), the function
  `rekey` already packs its moves with (`Aggregate.ts:5283`): whole groups, in order, root group first, into
  as few requests as fit 100 items, 4 MB of item size and the 16 MB body. It picks boundaries and refuses
  nothing; a group alone over a limit is sent alone for DynamoDB to reject and the diagnosis to name, as
  today.
- Cost: fewer requests (one instead of one per changed group), the same items and WCU. A larger transaction
  conflicts with more concurrent writes (`TransactionConflict`), which already maps to
  `TransactionCancelled`.
- Caller sees: an update that fits one transaction is all or nothing (R3 can't interleave, R4 can't leave a
  part). That is a statement about what is **stored**, not about what a reader sees while it commits:
  DynamoDB gives `Query` read-committed isolation item by item, not a snapshot of a transaction, so a
  `get`, a `list` or another `update`'s read that runs while the transaction commits can return some of its
  rows before and some after. A reader's torn view lasts as long as the commit (milliseconds); closing it
  would take `TransactGetItems` over keys a partition read doesn't know in advance. Named limit (§3.11). An
  update that read a torn view is caught by the row guards on the rows it sends and, `versioned`, by the
  version when the root was read before the commit; a decision it took on the rest is write skew.

**B. Fenced transactions.** Keep one transaction per group, and make each later transaction check a fence
the first one set. Only the root's version is such a fence: it makes the **first** writer's later
transaction fail once a second writer has committed in between, but it can't stop the second writer, which
read the first writer's partial state (its first transaction committed, the rest not) and committed a
decision on it. Unversioned there is no fence the first transaction sets (the root's existence is not one),
and each later transaction is guarded only on its own rows as read. Either way a failure partway still
leaves the earlier transactions written (R4). Only worth it past one transaction, where it is what §2.3
does, with these limits.

**C. All groups or none past one transaction** (a write-ahead intent, or writing a shadow copy and switching
a pointer). Every row is written twice and every reader follows the pointer. Rejected as the brute force:
an aggregate over 100 items in one update is rare (a context change on a large aggregate, a large `many`
edge rewritten whole), and today such a write already reports what committed.

### 2.3 Past 100 items or 4 MB (#144)

DynamoDB's limits are diagnosed after the fact, never pre-checked (`CLAUDE.md`). `packRequests` is a strategy
that picks request boundaries and refuses nothing (`internal/ExpressionLimits.ts` and `internal/ItemSize.ts`
name this use), so packing by measure is not a pre-check. Past one transaction the write is split at group
boundaries (a group is never split, so each sub-aggregate stays internally consistent), root group first, and
each later transaction carries the fence of §3.4. A failure partway is reported as today, naming the groups
already committed (`AggregateTransactionOverflow.committed`, or the `committed` text of a diagnosed
`ValidationError`). A group that alone exceeds a limit is rejected and diagnosed exactly as on 1.43.0.

Past one transaction the write is **not isolated** (§2.2 B): between its transactions another writer, or any
reader, sees the first transactions' rows beside the old rest, and can commit a decision on that state.
`versioned` turns the overlap into a failure of this write's later transaction (its fence names the version
its first transaction set), reported with `committed`; it does not undo the other writer's commit. Named
limit (§3.11), as rare as a single update over 100 items or 4 MB.

The fence is an item of the request it is in, so packing counts it: every request but one holding the
root's `Put` or version `Update` is packed against a shape one item and one fence's bytes smaller
(`transactWriteShape` less the `ConditionCheck`), never packed full and then given a 101st item that
DynamoDB would reject for the library's own reason.

**A unit over 4 MB only because it is guarded.** The row guards roughly double the bytes a unit counts
against the 4 MB limit (§2.1 B). A unit that fits 4 MB unguarded but not guarded (a group sent whole, §3.3,
holding more than about 2 MB of rows) would be sent alone, rejected and diagnosed, an update that 1.43.0
made and this design would refuse forever. For such a unit only, each row's guard keeps the cheap terms
whole (existence, `updatedAt` first, every attribute under 1 KB, the absent checks) and compares each larger
attribute by `size(#a) = :n` instead of by value, as many whole values as still fit. A string is compared
by size only when it is ASCII, where UTF-8 bytes, UTF-16 code units and code points agree: DynamoDB documents
`size` of a string as "the length of the string" without saying in what, and DynamoDB Local's count was the
only one measured, so a non-ASCII string is compared by value, whatever its length. Choosing the guard by
measure picks a condition, refuses nothing and sends the write DynamoDB judges, as packing picks boundaries
(not a #144 pre-check). Cost: none. Gap: a non-library writer that changes a large attribute without
changing its size, on a row of such a unit, isn't seen (D18, §3.11).

### 2.4 Update after a delete (R6)

Under §2.1 B every existing row the update sends is guarded on existing, so a deleted aggregate cancels it.
What B alone misses is an update whose transaction holds only new rows (adding a line, with narrowing), which
`attribute_not_exists` lets through into a deleted partition. Fix: every update transaction that doesn't
`Put` the root carries a `ConditionCheck` on the root, `attribute_exists(#pk)` (§3.4). Cost: one item per
transaction, billed as a transactional write of the root's size; no extra request. It is also what makes
a root-first `delete` sound (§2.6).

**Decided (§0):** the fence is opt-in, `fence: true` (implied by `versioned`), because it adds a billed item
to every update that doesn't rewrite the root, which timestamps rule 3 records the owner turning down as a
default. Off, the gap is only the purely additive update (every existing row an update sends is guarded on
existing), named in §3.11.

### 2.5 `create`'s partial failure (R7)

**A.** One transaction when it fits (§2.2 A), the #134 root guard inside it: all or nothing. Fixes R7 for
every aggregate that fits. **B.** Past one transaction, the root group stays first with its guard (#134), a
later group's failure leaves the root, and the error says so (`committed`, and "update or delete the partial
aggregate instead", `Aggregate.ts:10469`). Writing the root last instead (so a partial create leaves
root-less rows a retry overwrites) would let two concurrent creates both pass and interleave their rows, or
make a retry fail on its own orphans if the rows were guarded. Rejected: keep #134's order past one
transaction, a named limit.

### 2.6 `delete` versus a row added after its read (R8)

`BatchWriteItem` takes no condition, so `delete` can't refuse; it can only make sure no aggregate write
lands after its read. With every aggregate write checking the root (§2.4), deleting the root first closes
the aggregate: no write can commit after it.

**A. Root first.** `DeleteItem` of the root (its key is composed, no read needed), then the partition
`Query`, then `BatchWriteItem` of the rest. A write that committed before the root went is in the `Query`;
none commits after. Cost: one more request (the root's `DeleteItem`, 1 WCU per KB of the root, which the
batch no longer carries), so the same capacity. A failure partway leaves root-less rows, which `get` refuses
(`AggregateAssemblyError`) and a retried `delete` removes: better than today's partial delete, which can leave
the root and some edges assembling as a quietly incomplete aggregate. The requests are no longer 1.40.0's
byte for byte (`fixtures/aggregate-delete-1.40.0.json` pins them, #241).

**B. Read again after.** Today's requests, then a second `Query` once every batch is done (the root is gone
by then), deleting what it finds. Same guarantee, one more `Query` (0.5 RCU minimum eventually consistent,
1 RCU consistent) on every delete; a failure partway leaves what today's does.

**A holds only if the `Query` sees every write that committed before the root went, which an eventually
consistent read doesn't promise.** `delete` reads with the aggregate's `consistentRead`, `false` by default,
and a GSI collection index can't be read consistently at all. An update that committed a new row a moment
before the root's `DeleteItem` can be missing from an eventually consistent `Query` and survive as a
root-less orphan: the race R8 closes, reopened by the read. Unlike `update`, where a stale read surfaces as
a conflict (§2.9), a stale read here loses silently. So `delete`'s `Query` after the root's `DeleteItem` is
strongly consistent whenever the collection is on the base table, whatever `consistentRead` says (a
collection index as `consistentRead` says, §0)
(D17). Cost: the read's RCU doubles (a consistent read costs twice an eventually consistent one; a `Query`
is billed on the bytes read, so twice the partition's size in 4 KB units). On a GSI collection the read
stays eventually consistent and a row committed within the index's propagation delay before the root's
delete can survive (§3.11). Option B has the same dependency on its second `Query`.

The root's `DeleteItem` bills 1 WCU even when no root is there (a delete of a missing key is billed as a
1 KB write); 1.43.0's `delete` of a missing aggregate read and wrote nothing.

**Decided (§0):** root-first (A) only with `fence: true` or `versioned`, where every update checks the root.
Without the fence, no update checks the root, so deleting it first closes nothing; `delete` keeps 1.43.0's
read-then-delete and adds **one sweep `Query`** after its batches (B with one read): consistent on a
base-table collection, it deletes the aggregate's rows it finds, unless it finds a root, which means
a `create` reused the key after the batches deleted the old root, and then it deletes nothing (that create
is not this delete's to undo). Cost: one `Query` per `delete` (billed on the bytes read, at least 1 RCU
consistent); a delete that finds nothing new sends no further write.

A raw writer that adds a row after `delete`'s `Query` is out of any delete's reach (it wrote into a deleted
aggregate); named limit. A `create` racing a fenced `delete` of the same key may commit after the root's
`DeleteItem` (its root guard then passes) and before the `Query`. The `Query` then finds a root, which only
such a `create` can have written, and `delete` deletes nothing, as the sweep without the fence does: a create
that reported success keeps its aggregate. Rows of the old aggregate that the create didn't overwrite stay
beside it (§3.11).

### 2.7 `ownsRows` cleanup (R9)

Condition each cleanup `Delete` on `attribute_not_exists(#pk) OR (<the row as read>)` and pack the cleanup
`Delete`s into the update's own transactions (they are `Delete`s of keys read, so they add items only). A row
changed after the read cancels the update instead of being deleted, and the cleanup becomes atomic with the
update when it fits. The 1.40.0 behaviour of resending the cleanup without the `Delete`s whose condition
failed goes: a row changed since the read means the update's decision was made on a stale read. Cost: the
condition bytes; the cleanup no longer needs requests of its own when it fits.

### 2.8 On a conflict: run `fn` again, or surface it?

**Surface it.** `update` fails with the conflict and writes nothing (when the write fits one transaction). The
caller decides; because the bound `update` effect reads again each time it runs, `Effect.retry` on the
conflict's tag re-runs read and `fn`. Precedent: `commandHandler` runs `decide` on loaded state and does not
retry a `VersionConflict` unless given a `retry` schedule, and never retries one when the caller passed an
`expectedVersion` (`EventStore.ts:7559`–`7586`); an unversioned entity `update` surfaces
`ConcurrentModification`.

**Re-run inside the library**, bounded (as a read-first entity delete retries a lost race,
`GUARDED_PUT_ATTEMPTS`). Every conflict costs a full partition read and `fn` again per attempt, and `fn`'s
result on the new state is merged without the caller seeing it: a scorer's save re-applied over the job's
correction is right, a decrement re-applied over another writer's decrement may not be. The read-first entity
retry is invisible because the caller wrote no function of the state.

Recommended and **decided (§0)**: surface, no option. A `retry` option like `commandHandler`'s can be added
later without changing this default.

What a caller's retry costs and how it must be bounded, said in the guide's example: each attempt is a full
partition read, `fn`, the uploads of the rows it sends (a cancelled attempt's are deleted when the ledger's
root exits, §3.9) and the cancelled transaction, which DynamoDB bills as it bills a write whose condition
failed. Two transactions over one item can cancel each other (`TransactionConflict` on both), and a writer
outside the library that keeps changing a row the update sends cancels every attempt, so a retry without a
bound and without jitter can spin. The example uses a jittered exponential schedule with a bounded number of
recurrences (`Schedule.exponential` + `Schedule.jittered`, `Schedule.recurs`), on the conflict tags only.
Nothing inside the library loops, so nothing in it can livelock or run a non-idempotent step twice: an
aggregate write generates no ids and embeds nothing, and an upload of an attempt that didn't commit is
deleted.

### 2.9 The read's consistency

`update` reads eventually consistent unless the aggregate sets `consistentRead`. With guards, a stale read
(including one that misses the caller's own previous update) now fails with a conflict instead of silently
reverting a write. A collection on a GSI is always read eventually consistent (DynamoDB refuses a consistent
read of a GSI), so an update right after another write to the aggregate can conflict until the index catches
up. Options: leave the default and document it (a retry resolves it), or make `update`'s own read consistent
by default where it can be (base table or LSI), as `commandHandler` loads consistently by default (#139) at
twice the read capacity of the partition read. Recommended: leave it, document it; the caller who wants
read-your-writes sets `consistentRead`. This goes against two precedents, said so the owner weighs it: an
entity's read-then-write ops read their item strongly consistent (`Entity.ts:8746`), and `commandHandler`
loads consistently by default (#139). The aggregate's own `consistentRead: false` default is documented, a
stale read is now safe (it costs a cancelled transaction and a retry, never a lost write), and a GSI
collection can't read consistently anyway, so the recommendation keeps the documented default (D11).

**Decided (§0), D11 reversed:** `update`'s partition read is strongly consistent by default on a base-table
or LSI collection, whatever `consistentRead` says, following the entity and `commandHandler` precedents.
Cost: twice the RCU of the partition read on every update. `consistentRead` keeps governing `get` and
`list`. A GSI collection's read stays eventually consistent (named limit, §3.11).

Two reads are different, because there a stale read is not safe:
- **An If-Match update** (`expectedVersion`, D6) compares the version read with the caller's before `fn`
  runs. An eventually consistent read just after the caller's own update returns the older version, and the
  update fails `OptimisticLockError { expectedVersion: 8, actualVersion: 7 }`: a version below the one the
  caller holds, which no writer produced. So an update given `expectedVersion` reads consistently where the
  collection allows it (the base table, §0), as `commandHandler` judges its If-Match on a consistent load
  (#136, #139). Cost: twice the RCU of that read, only on calls that pass `expectedVersion`. On a GSI
  collection a read version below `expectedVersion` is reported as is (the index's lag), a named limit.
- **`delete`'s read after the root is gone** (§2.6, D17).

## 3. Recommended approach

§2.1 C (row guards always, root version opt-in), narrowed writes, one transaction when it fits, a root fence
when `fence: true` or `versioned`, root-first delete with the fence and a sweep `Query` without it, cleanup in
the transaction, conflicts surfaced, `update`'s read consistent where the collection allows.

### 3.1 The write plan

`update` builds a list of **units**, in order: the root group, then each changed sub-aggregate group (in
decomposition order), then the `ownsRows` cleanup `Delete`s. A unit's items are the group's sent rows
(narrowed, §3.3), its `Delete`s (dropped rows, rows under the previous key text, #241) and, in a unit with no
root item, nothing else: the fence goes on each request, not each unit. `packRequests` packs the units into
requests (against a shape that leaves room for the fence, §2.3); each request gets the fence (§3.4) unless it
already holds the root's `Put` or version `Update`.
`writeTransactionGroups` becomes a writer of packed requests, keeping its diagnoses: `RepeatedItem` before
the conditional-failure mapping (a repeat can be reported as a conditional failure), size and count after;
`committed` names the groups of the requests already committed. `create` builds the same units with no
guards but the root's.

A request is never sent holding both the root's `Put` and a `ConditionCheck` on the root (DynamoDB refuses
one item touched twice): the fence is added only to requests without the root.

### 3.2 Guards on each item

| Item | Condition |
|------|-----------|
| `Put` of a row the update read | `wholeRowGuard(read, pk, [updatedAt], [], writableAttributes[type])`; when it doesn't fit one expression, `preferredGuard` (the `updatedAt` stamp first, then as many attributes as fit). The function `rekey` guards its moves with (`Aggregate.ts:5105`). |
| `Put` of a row the update didn't read | `attribute_not_exists(#pk)` |
| `Delete` of a row read (dropped, previous key text) | the row as read, as for a `Put` |
| `ownsRows` cleanup `Delete` | `attribute_not_exists(#pk) OR (<the row as read>)` |
| Fence (§3.4) | `ConditionCheck` of the root, or the root's version `Update` |

Every guarded item asks `ReturnValuesOnConditionCheckFailure: "ALL_OLD"`, so a cancellation carries each
failing row as stored. DynamoDB charges no capacity for returning it. The verdict (§3.6) is computed from
those rows and the rows read, with no further read.

The guard compares stored forms, so packed values (`B`, compared byte for byte), offloaded pointers and
renamed attributes need nothing of their own: what is compared is what was read. "What was read" is the
`AttributeValue` map the `Query` returned, kept as `rekey` keeps it (`queryAllItems`' `stored`,
`Aggregate.ts:7425`), never a row unmarshalled and marshalled again: a number with more digits than a
JavaScript number holds would come back changed, and its guard would fail on every attempt, a conflict no
retry resolves.

A row of a unit over 4 MB only because of its guards takes the lighter guard of §2.3 (D18).

**A collection index that doesn't project every attribute.** Assembly reads the rows the collection index
returns. Under a projection other than `ALL`, an attribute the index leaves out is missing from the row
read, so its absent check (`writableAttributes`) fails against the stored row on every attempt: a
permanent `ConcurrentModification`. On 1.43.0 the same update silently dropped every unprojected attribute
of each row it rewrote. Named, documented beside `collection.index`: a collection index projects `ALL`.

### 3.3 Narrowed writes

A changed group sends only the rows whose decomposed value changed (compared as `deepEqualGroups` compares
groups, item by item, before stamps and packing), the rows the new state adds, and its `Delete`s. Every row of
the group is sent, as today, when a context field changed (`contextChanged`) or the group's copies of a context
attribute are stale (`staleContextGroups`, #241). The result `update` returns is assembled as today from the
rows read and the rows written; `withStoredContextCopies` is judged per row sent instead of per group sent.
An unchanged row keeps its `updated`.

Rows are matched old to new by stored key, not by group, since an item can change group without changing
key. Also observable, and part of D2:
- **Stream records.** An unchanged row is no longer rewritten, so it produces no `MODIFY` record. A stream
  consumer that took a group's records as "the group changed" now sees only the rows that did.
- **`EDD-9160`** (a row under the other `escapeKeys` setting's text) refuses a write that would put the row
  under the new text beside the old. It is judged on the rows sent: an unchanged row under the other text in
  a changed group is not sent, so it no longer refuses the update (it stays for `rekey`). On 1.43.0 the whole
  group was sent, so the update was refused.
- A row whose stored form is older than the current configuration (a native value of a field now packed)
  is no longer brought up to date by a change elsewhere in its group. Packed storage is read by its stored
  form, never by the configuration, so nothing depends on it.

### 3.4 The fence

- **Off** (the default, neither `fence` nor `versioned`): no item is added. Only the rows sent are guarded.
- **Unversioned, `fence: true`:** a `ConditionCheck` of the root, `attribute_exists(#pk)`, in each request that doesn't
  `Put` the root. The root is the aggregate's existence: a deleted aggregate cancels every later write (R6),
  and `delete` can close the aggregate by deleting it (§3.8).
- **Versioned (D5):** the root's version and incarnation, in each request: the first request either `Put`s
  the root with `version = v + 1` conditioned `#ver = :v AND #inc = :inc` (`attribute_not_exists(#ver)` for
  `v = 0`, `attribute_not_exists(#inc)` for a root without a token) or carries an `Update` of the root,
  `SET #ver = :v1` with the same condition; each later request carries a `ConditionCheck`
  `#ver = :v1 AND #inc = :inc`. A later request's check failing reports the version this update read as
  `expectedVersion` (the caller's own when given), never the `v + 1` its first request wrote. A version-only `Update` doesn't stamp the root's `updated` (the root's
  content didn't change). On a root `Put` the version terms are ANDed with the root's row guard, and the
  row guard is built with room left for them (a whole-row guard that can't take them falls back as a wide
  row does, §3.2).

The fence names the root's key as composed (`composeKey(schema, rootType, [])`, as `create`'s guard does,
`Aggregate.ts:5913`). A root has no composites, so its sort key holds none of the composite text the
key-text settings change (`escapeKeys`, 1.36 numeric text, #241's `entity:` edge text): the implementation
pins this with a test under both `escapeKeys` settings, so no root is stored under a key the fence misses. A partition stored under another partition-key
text isn't read by `update` at all (it finds nothing until `rekey` moves it), as on 1.43.0.

### 3.5 `versioned` (D5, D6)

```ts
const Matches = Aggregate.make(Match, {
  …,
  versioned: true,                 // or { field: "rev" }; default attribute "version"
})

db.aggregates.Matches.update({ id }, (c) => ({ ...c.state, status: "live" }), { expectedVersion: 7 })
```

- The version is a number on the **root row only**. `create` writes 1. A root written before the option holds
  none and reads as 0: its first update is conditioned `attribute_not_exists(#ver)` and writes 1. No backfill,
  no extra read, no fallback: one flag.
- **Incarnation token.** Beside the version, the root holds the entity's hidden token, `__edd_i__`
  (`INCARNATION_TOKEN`), a random UUID from the same source entities use (`freshIncarnationToken`,
  `internal/TransactableOps.ts:730`, an `Effect<string>` with no requirement, so the bound op stays
  `R = never`). `create` writes one; the first versioned update of a root without one adds it under
  `attribute_not_exists(#inc)`, as an entity's first versioned write does (`DESIGN.md` "Pre-versioning
  items"). Every version condition also holds `#inc = :inc` (§3.4), so a writer that read version 1 of a
  deleted aggregate fails against a re-created one at version 1. A root holding the token but no version
  (its version removed outside the library) reads as 0 within its incarnation and is guarded on both: an
  entity refuses that item (`versionCorruption`) because its version keys retained history, which an
  aggregate doesn't keep. Cost: about 50 bytes on the root (the name and a 36-character UUID), condition
  bytes on the fence; no request.
- Every update that writes anything moves it by one (the fence above); a no-op update writes nothing and
  leaves it.
- Read: stripped from the assembled value unless the root model declares the field, as a timestamp is
  (`DESIGN.md` §11, Aggregate System Timestamps, rule 5); declared, it holds the stored version (0 for a root
  without one). A value the caller puts there on `create` or in `fn`'s result is ignored. `UpdateContext`
  gains `version: number` on a versioned aggregate.
- `expectedVersion` (third argument, `{ expectedVersion }`): checked against the version read **before** `fn`
  runs; a mismatch fails `OptimisticLockError { expectedVersion, actualVersion }` with nothing written, as
  `commandHandler` checks its If-Match before `decide` (#136). The read of such a call is strongly
  consistent on a base-table collection (§0), whatever `consistentRead` says (§2.9, D6).
  Given to an unversioned aggregate: refused,
  `ValidationError` (`EDD-9178`), nothing read or sent; a typed caller can't write it.
- Refused at `make` (`EDD-9177`): `versioned` with `retain` or `ttl` (aggregates keep no snapshots), or with a
  field that is a context field, a key composite (partition, collection, list), a timestamp field, a root
  model field that isn't a number, or the attribute a root model field is stored under (`Schema.encodeKeys`).
  A typed caller can't write the first; the rest are judged at load. A root of members (a union, a
  suspended schema) declares the field when a member does, each such member as a number; its other
  declared attributes are found the same way, so its rows' absent-attribute guards cover them.
- `ownsRows` / `rekey`: the version attribute and the token join `writableAttributes` for the root type, so
  `rekey`'s absent-attribute guard covers them. A root `rekey` moves to a new key is written from the
  model, which holds the version only where declared and the token never, so `rekey` copies both from the
  row as read onto the moved root (a root without them stays without). Both are stripped on read unless the root model declares the version field; the token never
  reaches the domain value.
- Every update that sends anything moves the version, including one that only repairs stale context copies
  (#241) with the domain value unchanged.
- **Turning it on while an older release still writes.** An older release's `update` `Put`s the root from
  the model and drops both attributes, so the root reads as a pre-option root (version 0, no token) and the
  next versioned write starts again at 1 under a new token. A writer that read the old version fails (the
  version and the token differ); a caller holding an `expectedVersion` from before the reset can match the
  restarted count. Named limit: turn `versioned` on once every writer of the aggregate runs a release that
  has it (the upgrade note says so).

### 3.6 Verdicts and errors

From the cancellation reasons and the `ALL_OLD` rows (no read):

1. A `RepeatedItem` rejection: diagnosed first, as today.
2. The item on the root failed (the fence, the version `Update`, or the root's own guarded `Put`) and the
   root is gone (no `Item`): the aggregate was deleted. `AggregateAssemblyError` ("No items found for
   aggregate key"), the error `update` gives a key whose read finds nothing (`Aggregate.ts:4307`–`4312`).
3. Versioned, the root's version moved or its incarnation token differs: `OptimisticLockError { entityType:
   aggregate, key, expectedVersion: v, actualVersion: stored }`, as an entity reports another incarnation
   (`conditionRejection`, `Entity.ts:8456`).
4. A row guard failed: unversioned `ConcurrentModification { entityType: aggregate, key, attributes,
   current: None }`; versioned `OptimisticLockError` with `expectedVersion = actualVersion = v` and the same
   `attributes` (the entity's form for "changed without the version moving", #238). `attributes` names each
   changed row as `<member path>` and attribute, for example `"team1.lines[b].copy"`, and a row that appeared
   or vanished by its member path alone.
5. Any other cancellation: `TransactionCancelled`, as today. Limits: diagnosed after the mapping, as today.

On a request after the first (past one transaction only), the earlier requests committed: the conflict
error carries `committed` (D9).

`update`'s error channel gains `ConcurrentModification` and `OptimisticLockError`. `create`'s and `delete`'s
don't change.

### 3.7 `create`

The units of §3.1 with the root's `Put` guarded `attribute_not_exists(#pk)` (#134) in the first request, no
other guard. One request when it fits: all or nothing. Past one, as today (root group first, a later failure
leaves the root and says so).

### 3.8 `delete`

**With the fence (`fence: true` or `versioned`):** `DeleteItem` of the root, then the partition `Query`
(strongly consistent on a base-table collection, D17), then `BatchWriteItem` of the aggregate's other
rows (own types only, as today, with the same unprocessed-item retries), unless the `Query` finds a root: a
`create` reused the key after the root went, and nothing is deleted (§2.6).

**Without the fence (the default):** 1.43.0's read and batches, then one sweep `Query` (consistent on a
base-table collection) and, unless it finds a root, a `BatchWriteItem` of the rows of the aggregate's
types it finds (§2.6, §0).

With the fence: The root's `DeleteItem` is not conditioned: `delete` removes whatever is there.
Its key is composed from the root's entity type alone, which no entity composes (an entity's key holds at
least one field-named composite, `entityWriters`, `Aggregate.ts:9031`) and no other node of the aggregate
does. No root and no rows of its types: `AggregateAssemblyError`
as today; no root but rows of its types (a partial write's leftovers): they are deleted, as today.

### 3.9 Interactions

- **Diff narrowing (no-op writes nothing):** kept. No fence, no version move, no request.
- **#134 create guard:** kept, now inside one transaction with every group when they fit.
- **Timestamps:** `updatedAt` is the guard's first attribute (`prefer`), so a wide row's fallback still sees a
  library write. Narrowing keeps an unchanged row's `updated` (§3.3). `created` is carried forward as today.
- **Ref hydration:** `create` reads each referenced entity and stores its copy; that copy is not re-checked at
  write time (a ref is a denormalised snapshot by design; `update` doesn't hydrate). Unchanged.
- **Unique sentinels, entity `versioned`/`retain`, `softDelete`, `timeSeries`:** an aggregate writes none of
  these for its rows (it composes its own rows; `composeUniqueKey` in `Aggregate.ts` is only the `ownsRows`
  writer analysis). No interaction. `retain` / `ttl` on the aggregate's own `versioned` are refused
  (`EDD-9177`).
- **Offloaded fields and the upload ledger (1.43.0):** values are uploaded before the first request, as
  today, but only for the rows sent (narrowing uploads less). A cancelled request's uploads are `rejected` and
  deleted when the ledger's root exits (`BlobLedger.root` wraps `create` / `update` / `delete`,
  `Aggregate.ts:6261`–`6265`); past one transaction, the committed requests' uploads are `committed` and kept.
  A pointer read is compared, never written back, as today. The ledger's own `ClientRequestToken` per request
  is unchanged.
- **Packed fields:** compared in stored form (§3.2). Packing still runs after the diff, so an unchanged packed
  value is never resent.
- **`escapeKeys` and `rekey`:** `EDD-9160` still refuses a write of a group with rows under the other
  setting's text. Rows deleted under 1.40.0's text (#241) are guarded as read. `update` and `rekey` now guard
  against each other symmetrically: `rekey`'s `Put` at the new key is `attribute_not_exists`, its `Delete`
  the row as read; `update`'s rows are guarded as read. Whichever lands second cancels and the other side
  reads again (`rekey`) or surfaces the conflict (`update`).
- **Retries below the library.** The AWS SDK fills a `TransactWriteItems`' `ClientRequestToken` once and
  resends the same request on a transient failure, and DynamoDB answers a resend of a committed transaction
  with success (`EventStore.ts:1787`; the ledger sets its own token, `BlobLedger.ts:1214`). So a guarded
  transaction whose response was lost is not reported as a conflict with its own write. The root's
  `DeleteItem` in `delete` is unconditioned, so a resend is harmless.
- **Sharded `list` (`cardinality`):** the shard is a function of the partition key, written on the root as
  today; a guard compares it like any attribute. `list` writes nothing. No interaction.
- **ConsumedCapacity:** no new operation: every request is inside `Aggregate.create` / `update` / `delete`'s
  existing scope (`Capacity.operation`, `Aggregate.ts:6257`–`6265`), through `Capacity.client`. Reports change
  shape: one `TransactWriteItems` where there were several, and `delete` gains a `DeleteItem`.
  `test/ConsumedCapacity.coverage.test.ts` gains a multi-group update and a delete under the new shapes
  (asserting no implicit `DynamoClient.<Command>` root).
- **`transactWrite` planning (`planWrite`):** aggregates are not transactable ops (`extractTransactable`
  takes entity ops only) and `TransactPlan` never records an aggregate write. No interaction.
- **#144:** nothing is pre-checked. `packRequests` picks boundaries; DynamoDB's rejections are diagnosed in the
  order `writeTransactionGroups` uses today. Guards never exceed an expression's limits (`wholeRowGuard`
  returns nothing rather than a guard that doesn't fit; `preferredGuard` takes what fits).

### 3.10 Costs, summed

| Operation | 1.43.0 | Recommended (unversioned) | Recommended (versioned) |
|-----------|--------|---------------------------|-------------------------|
| `update`, one group changed, one row of it | 1 `Query` + 1 transaction, every row of the group | 1 `Query` + 1 transaction: the changed row + a root `ConditionCheck` (if the root isn't the row) | as unversioned, the `ConditionCheck` replaced by the root's version `Update` (or the root `Put` carries it) |
| `update`, k groups changed, fits | k transactions | 1 transaction | 1 transaction |
| `update`, past one transaction | k transactions, unguarded | n packed transactions, each fenced | the same, each fenced on the version |
| `create`, fits | k transactions | 1 transaction | 1 transaction, root `version = 1` |
| `update` with `expectedVersion` | — | — | as above, the read strongly consistent where the collection allows (2× its RCU) |
| `delete` | `Query` + batches | no fence: `Query` + batches + one sweep `Query` (consistent on a base-table collection); `fence: true`: `DeleteItem` (root) + `Query`, consistent on a base-table collection (2× its RCU) + batches | as `fence: true` |
| `update`'s read | eventually consistent unless `consistentRead` | strongly consistent on a base-table collection (2× its RCU) | the same |
| conflict | none detected | `ConcurrentModification`, nothing written | `OptimisticLockError`, nothing written |

Extra capacity: with `fence: true`, one item per transaction for the fence (a transactional write of the
root's size; none without it), and none for guards; narrowing removes the unchanged rows' 2 WCU per KB each, which on most updates outweighs the
fence. `versioned` costs the same capacity as `fence: true` (the fence's `ConditionCheck` becomes an `Update`
of the root, billed the same); it adds the root's stream record and two stored attributes. Guards cost no
capacity but about double each sent row's count against the 4 MB transaction limit (§2.1 B, §2.3).

### 3.11 Named limits

- **Write skew, unversioned:** a mutation whose result depends on rows it doesn't write (a total on the root
  from lines another writer adds) can commit over that writer. `versioned` closes it for the library's own
  writers.
- **Wide rows:** a row whose whole-row guard doesn't fit one expression (about 150 top-level attributes) is
  guarded on `updatedAt` and as many attributes as fit; a non-library writer changing only what's left out
  isn't seen. Unlike `rekey`, `update` has no report to name the gap; it is documented.
- **Past one transaction:** not atomic and not isolated. A failure partway leaves the committed groups and
  names them; between the transactions another writer or reader sees the partial state, and a writer can
  commit on it (`versioned` then fails this write's later transaction, not the other writer's) (§2.3).
- **Readers during a commit:** a `Query` sees a transaction item by item, so a `get`, `list` or update read
  that overlaps a commit can see part of it, even when the write was one transaction (§2.2 A).
- **Unversioned, a deleted and re-created aggregate:** row guards compare values, so a re-created aggregate
  whose rows equal the old ones (no timestamps) passes, and a row only the new state writes passes
  `attribute_not_exists`. `versioned` closes it with the incarnation token.
- **Non-library writers and `versioned`:** a raw writer that doesn't move the version is caught only on the
  rows the update sends (the row guards).
- **An older release writing a `versioned` aggregate** drops the version and token, restarting the count
  (§3.5).
- **A unit over 4 MB only because of its guards** (D18): a non-library writer changing a large attribute
  of one of its rows without changing its size isn't seen.
- **A collection index not projecting `ALL`:** a row's guard fails on every attempt (§3.2).
- **A raw writer adding a row after `delete`'s `Query`** stays (after the sweep `Query`, without the fence).
- **Fence off, an update racing a delete:** an update that sends only new rows (adding a line) passes
  `attribute_not_exists` in a deleted partition and leaves root-less rows, which `get` refuses and a later
  `delete` removes. Every update that rewrites or deletes an existing row is cancelled by the delete. Turn
  on `fence` (or `versioned`) to close it.
- **A `create` reusing the key during a `delete`:** fence off, the sweep finds its root and deletes
  nothing, so rows of the old aggregate the batches missed (added after the first read) stay beside the new
  one. Fenced, the `Query` after the root's `DeleteItem` finds the new root and deletes nothing, so every row
  of the old aggregate the create didn't overwrite stays beside the new one. Either way the create that
  reported success keeps its aggregate. It takes a `create` of the key being deleted, landing inside the
  delete's few milliseconds.
- **Fence off, a `create` landing between two of `delete`'s 25-row batches, or between the sweep's `Query`
  and its batch,** loses the rows of the new aggregate that batch deletes. The same timing as the case
  above, inside a smaller window.
- **Fenced, a group sent alone holds at most 99 items.** Packing keeps a group whole, and a request
  without the root carries the fence, so a group of 100 changed items (rows and `Delete`s) beside the
  fence is 101 items, which DynamoDB refuses (diagnosed as a request over 100 items, nothing written).
  On 1.43.0 such a group went alone; without the fence it still does.
- **Fence off, the verdict on a deleted aggregate** is `ConcurrentModification` naming the vanished row
  (verdict 4), not `AggregateAssemblyError`: only an item on the root (the fence, the version `Update`,
  the root's own `Put`) tells a deletion from a change (§3.6, verdict 2).
- **GSI collection reads** are eventually consistent: an update made within the index's propagation delay
  of an earlier write (its own included) can surface a conflict until the index catches up; an If-Match update can see a version below the caller's; and a row committed within the
  index's lag before `delete`'s root went can survive the delete.

## 4. Test plan

Unit (recording table + `gatedClient`, `mockDynamoClientLayer` where a request shape is pinned):

- `Issue168.races.test.ts` committed with the implementation and green: R1–R9 as they stand (without the
  fence, R8's raw row added after the read is found by the sweep `Query`), plus a fenced R8 whose
  concurrent writer is an `Aggregate.update` adding a line, interleaved after the root's `DeleteItem`.
- Write plan: packing (one request when it fits; whole groups, root first, when it doesn't; a group over a
  limit alone and diagnosed with `committed`); the fence on requests without the root, never beside the
  root's `Put`; guards per item kind (§3.2), including the `preferredGuard` fallback on a 200-attribute row.
- Narrowing: one changed line sends one `Put`; a context change sends every row; a stale-context group sends
  every row; an unchanged row keeps `updated`; the returned value is unchanged
  (`AggregateUpdateResult.test.ts`'s 1.40.0 pin still holds).
- Verdicts: each row of §3.6 from a cancellation with `ALL_OLD` items, `attributes` naming member paths;
  deleted aggregate → `AggregateAssemblyError`; `TransactionConflict` → `TransactionCancelled`.
- `versioned`: create writes 1; a root without the attribute updates under `attribute_not_exists`; every
  sending update moves it, a no-op doesn't; version-only `Update` when the root didn't change; If-Match
  mismatch fails before `fn` runs (a spy) with nothing sent; `expectedVersion` on an unversioned aggregate
  (`EDD-9178`); `EDD-9177` cases at `make`, with `*.types.test.ts` cases for the typed refusals; the version
  read only where the root model declares it.
- Incarnation: an update reads version 1, the aggregate is deleted and re-created (version 1, new token)
  before its write; the write fails `OptimisticLockError`. Unversioned, the same interleaving is pinned as
  the named limit.
- If-Match after the caller's own update: the read is consistent (`ConsistentRead: true` in the request) on a
  base-table collection, and not on a GSI collection.
- Packing: 99 rows plus the fence in one request, never 100 plus the fence; a group of 2.5 MB of rows sent
  whole takes the D18 guard and is one request, accepted.
- Guards from raw values: a row holding a 20-digit `N` is guarded on its stored text and the update
  succeeds (built from the unmarshalled row it would conflict on every attempt).
- `delete`: the `Query` after the root's `DeleteItem` is consistent on a base-table collection; a row an
  update commits just before the root's delete is deleted.
- Existing tests whose pinned outcome changes, updated with the reason in the commit: the `ownsRows` cleanup
  resend (`AggregateOwnsRows.test.ts`), restamping of unchanged rows (`Aggregate.timestamps.test.ts`),
  request counts of multi-group writes (capacity pins), `delete`'s request sequence
  (`fixtures/aggregate-delete-1.40.0.json` stays the 1.40.0 record; the test compares against the new
  sequence).
- Capacity coverage (§3.9).

Connected (DynamoDB Local; `:8168` for the plain pass, `:8169` with `escapeKeys: true`; MinIO `:9168`; the
concurrent write injected through a decorated `DynamoClient`, `gatedClient` over the real client, configuration
through `effect/Config`):

- R1–R9 against DynamoDB Local, including the raw conditional `UpdateItem` of R5 sent on the real table.
- A three-group update fitting one transaction is one `TransactWriteItems` and atomic under an injected
  failure; a 120-item update splits at group boundaries, and a concurrent update between its requests fails
  the later request on the fence.
- `versioned` end to end, with a pre-option root (written by a 1.43.0-shaped row) updating to version 1 and
  taking a token; delete and re-create between an update's read and its write.
- The D18 guard: a sub-aggregate of 2.5 MB of rows whose context field changes updates in one transaction
  (DynamoDB Local's 4 MB check is what the library's size model was measured on).
- Two updates retried under the guide's jittered, bounded schedule both commit.
- Offload: a conflicting update of an aggregate with an offloaded edge field leaves the stored pointer and its
  object intact and deletes the rejected upload (MinIO).
- `update` racing `rekey` on the escape-on table: one side cancels, nothing lost.
- The doc example for the guide (§ "Concurrency" in the aggregates guide) runs against DynamoDB Local.

## 5. Decisions

| ID | Question | Recommendation | Kind | Decided (§0) |
|----|----------|----------------|------|--------------|
| D1 | Guard every row `update` sends on what was read, and fail with `ConcurrentModification`? | Yes, always on (§3.2, §3.6). | owner | As recommended |
| D2 | Send only the rows that changed instead of every row of a changed group? | Yes (§3.3). | owner | As recommended |
| D3 | One transaction for the whole write when it fits (`create` and `update`)? | Yes, by `packRequests`, whole groups, root first (§3.1). | owner | As recommended |
| D4 | A root fence (`ConditionCheck` `attribute_exists`) in every update transaction without the root? | Yes (§3.4). | owner | **Opt-in**, `fence: true`, off by default; implied by `versioned` (`EDD-9179` refuses `versioned` with `fence: false`) |
| D5 | Add `versioned` to `Aggregate.make` (a version and an incarnation token on the root)? | Yes, opt-in (§3.5); the token as entities keep it, so a re-created aggregate's version 1 isn't the old one's. | owner | As recommended |
| D6 | `expectedVersion` as `update(key, fn, { expectedVersion })` and `UpdateContext.version`? | Yes; If-Match checked before `fn`, on a read made strongly consistent where the collection allows (§2.9). | owner | As recommended |
| D7 | On a conflict, surface or re-run `fn`? | Surface, no option (§2.8). | owner | Surface; the guide shows a bounded, jittered `Effect.retry` |
| D8 | `delete`: root first, or a second read after? | Root first (§2.6 A). | owner | Root first with the fence; without it, 1.43.0's order plus one consistent sweep `Query` that deletes nothing when it finds a root |
| D9 | How a conflict in a later transaction (past one) says what committed? | An optional `committed` field on `ConcurrentModification` and `OptimisticLockError`, set only there. | owner | As recommended |
| D10 | `ownsRows` cleanup guarded as read and joined to the update's transactions? | Yes (§2.7). | owner | As recommended |
| D11 | Make `update`'s read consistent by default? | No; document (§2.9). Against the entity and `commandHandler` precedents, stated there. | owner | **Reversed**: consistent by default on a base-table collection; a collection index as `consistentRead` says, a named limit (§0, amended; confirmed 2026-11-16) |
| D12 | Past one transaction, `create` keeps the root first? | Yes, #134's order. | precedent | Stands |
| D13 | Root gone at write time → `AggregateAssemblyError` ("No items found")? | Yes. | precedent | Stands |
| D14 | Wide-row guard falls back to `preferredGuard`? | Yes. | precedent | Stands |
| D15 | Name a conflict from `ALL_OLD` (no re-read, `current: None`), with `attributes` as `<member path>.<attribute>` (`"team1.lines[b].copy"`)? | Yes. | owner | As recommended |
| D16 | Pack by measure (not a pre-check), leaving room for the fence, and keep the diagnosis order? | Yes. | precedent | Stands |
| D17 | `delete`'s `Query` after the root's `DeleteItem` strongly consistent on a base-table collection, whatever `consistentRead` says? | Yes (§2.6): an eventually consistent read there loses a row silently. | owner | As recommended; the fence-off sweep `Query` is consistent the same way |
| D18 | A unit that fits 4 MB unguarded but not guarded: lighter guard (`size()` for attributes over 1 KB) or refuse? | Lighter guard, only for such a unit (§2.3). | owner | As recommended |

Precedent citations: D12 `DESIGN.md` §11 "`create` is guarded on the root (#134)" and `Aggregate.ts:5923`;
D13 `Aggregate.ts:4307`–`4312` (the same error for a key with no aggregate); D14 `rekey`'s `guardOf`
(`Aggregate.ts:5105`–`5122`) over `internal/ExpressionLimits.ts`; D16 `packRequests`
(`internal/ItemSize.ts:346`) as `rekey` uses it (`Aggregate.ts:5283`) and `writeTransactionGroups`' diagnosis
order (`Aggregate.ts:10490`–`10525`).

D15 was listed as precedent in the first draft. Reading `ALL_OLD` with no re-read and `current: None` is
the entity verdict's (`Entity.ts:8509`, `8707`, `8738`), but an entity's `attributes` are domain field names
(`domainNameOf`), and a member path is a new format for a public field, so the format is the owner's.

D17's alternatives: keep `delete`'s read as `consistentRead` says (no extra RCU, a row committed just before
the root's delete can survive as an orphan, R8 reopened by the read); or option B of §2.6 (a second
`Query`, which has the same dependency). D18's alternatives: refuse (the unit is sent whole, rejected and
diagnosed: an update 1.43.0 made, refused forever); split the unit across transactions (a sub-aggregate's
rows no longer change together, which is what a group is for); guard every attribute by `size()` always
(cheaper bytes everywhere, but a same-size correction by a non-library writer, the issue's own case of a
denormalised copy, is missed on every row).

## 6. Scope

**In:**
- The issue's ask 1 (a CAS on `update`: `versioned`, a version on the root, an expected version,
  `OptimisticLockError`).
- The issue's ask 2 (one transaction across the changed groups when they fit, the root's version condition
  in it), as the default rather than a mode (D3).
- The issue's real case, a non-library per-row writer (R5): row guards (D1) and narrowing (D2).
- Lost update (R1, R2), torn aggregate (R3, R4), update after delete (R6), `create`'s partial failure when it
  fits (R7), `delete` versus an added row (R8), the `ownsRows` cleanup (R9).
- With `versioned`, the incarnation token on the root (D5), so a delete and re-create can't pass a version
  check.
- `delete`'s consistent read after the root's delete (D17) and the guard of a unit over 4 MB only because
  of its guards (D18): both close gaps the first draft's mechanisms opened.
- `EDD-9177`, `EDD-9178`, `EDD-9179` (allocated in `DESIGN.md`'s registry).
- The opt-in `fence` setting (D4 as decided) and `delete`'s sweep `Query` without it (§0).
- `update`'s read strongly consistent by default on a base-table collection (D11 as decided).
- #132's aggregate items: guards on `update`'s writes and the delete sweep (§0).
- `DESIGN.md` §11 (write path, #134 paragraph, `delete`, the `ownsRows` limits, timestamps rule 3), the
  aggregates guide and `CLAUDE.md`'s Aggregate Operations bullets.

**Out:**
- All groups or none past one transaction (§2.2 C): a named limit.
- A `retry` option on `update` (§2.8, D7 decided): `Effect.retry` on the tag does it; can be added later.
- `expectedVersion` on `delete`: not asked; a follow-up if wanted.
- Write skew without `versioned`, wide-row gaps, raw writers after `delete`'s read, isolation past one
  transaction, readers overlapping a commit, a re-created aggregate without `versioned`, a collection index
  not projecting `ALL`, older releases writing a `versioned` aggregate: named limits (§3.11).
- Ref copies going stale after `create`: by design.
- `rekey`, entity paths, projections: already guarded (§1.2).
- `list`: writes nothing.

**Changed from the issue's text:**
- "Each `many`/`one` edge group" is its own transaction: only sub-aggregates are (§1.3).
- "The only conditional write is the create root guard": also the `ownsRows` cleanup and `rekey` (§1.3).
- "A documented all-groups-or-none mode": the default when the write fits, a named limit past it.
- "Failing with an `OptimisticLockError` as entity updates do": for a versioned aggregate; an unversioned one
  fails `ConcurrentModification`, as an unversioned entity update does.
- `.expectedVersion(n)` builder or `{ expectedVersion }` argument: the argument (`update` returns an `Effect`
  today, and stays one).
