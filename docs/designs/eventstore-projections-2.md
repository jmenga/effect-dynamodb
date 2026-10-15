# Design: multi-source projections, tombstones and the outbox (#153, #154, #155)

Builds on `eventstore-projections.md` (#151, released in 1.28.0). The polled
change feed (#156) has its own design, `change-feed.md`. The four issues ship
together, in one PR and one release (1.29.0).

## 1. One row engine

A projection row is now written by one engine (`internal/ProjectionEngine.ts`)
for single-source projections (`EventStore.projection`) and multi-source
projections (`EventStore.multiProjection`). The engine works on rows, each fed
by one or more **source instances** (a source stream's stream instance).

Per row, `applyRow(key, work)`:

1. **Reads the row raw.** It uses `GetItem` (strongly consistent) on the key the
   entity composes, so a tombstone (§4) reads as one. It decodes through the
   entity's `decodeMarshalledItem`, so `Hidden` fields come back and `createdAt`
   is kept.
2. **Resolves each instance's checkpoint slot** (§3) and its run:
   - in `fold` mode, its pending events, gap-filled with one bounded strongly
     consistent `readFrom` filtered to the events keyed to this row (none needed
     when the batch's events of the instance cover the gap);
   - in `latest` mode, only the newest pending event; the rest are `superseded`.
3. **Folds** in a deterministic order: sources as declared, then stream id, then
   version.
   - `evolve` may return `EventStore.removeRow` (§4).
   - A `terminal` failure rejects its event.
   - Each applied event may produce outbox effects (§5).
4. **Writes once.**
   - The write is a `put` of the row (through the entity, keeping `createdAt`), a
     tombstone, or either one with outbox items in one `TransactWriteItems`.
   - It is conditioned on the revision read (§2), or, without one, on the
     scalar checkpoint read.
   - A failed condition is a lost race: the attempt is retried under `retry`
     (jittered backoff by default).

The single-source projection is the engine with one source named
`"projection"` and a scalar checkpoint. Its 1.28.0 behaviour and API are
unchanged, apart from the additions below.

## 2. `revision` — one guard for every writer

`revision` names a numeric model field the library owns. Every write sets it one
higher and is conditioned on the value read: `= read`, or `attribute_not_exists`
when the row has none, which covers legacy rows and new ones.
- **One comparison** serialises every writer, whichever source it serves.
  Conditioning on the checkpoints instead would need one clause per instance
  plus `size()`, to catch a writer that added an instance.
- **It closes #151's `rebuild` race.** A rebuild of a row at its head writes the
  same checkpoint, but always a new revision.
- **An existing write counter can serve** as the revision, one readers already
  use.
- **It is required** by `multiProjection` and by `outbox`. It is optional on
  `projection`.

## 3. Checkpoints per source instance (#153)

`checkpoints` declares the layout:

- **`field`:** a `Record<string, number>` model field keyed `<source>#<streamId>`.
  An instance with no entry starts at 0, so a second instance of one source (an
  entity re-identified mid-stream) is never mistaken for stale.
- **`sources: { [name]: { field, offset?, instanceField } }`:** compatibility with
  rows that keep one numeric field per source.
  - `instanceField` records which stream instance owns the scalar.
  - An empty `instanceField` (a new row, or a legacy one) is adopted by the
    first instance that arrives.
  - Another instance goes to the map when `field` is declared too, in the same
    write.
  - Without a map field it is a typed failure, `ProjectionSourceConflict
    { source, recorded, arriving }`, and nothing is written.
  - Within one attempt, a source's field goes to the first instance in fold
    order, so a `rebuild` reassigns a field that the wrong instance owns.

There is **no cap** on instances. Entries are small, and a row that outgrows
400 KB fails in DynamoDB and is diagnosed there, per the library's no-pre-check
policy.

**Modes.**
- **`fold`** (gap-filled, every event): for delta contributions.
- **`latest`** (newest event only, no reads): for full-state contributions.
- The mode is a declaration; the library can't tell a full contribution from a
  partial one.

## 4. Tombstones (#154)

- **Opt-in:** `removal: { ttl? }` lets `evolve` return `EventStore.removeRow`.
- **What a tombstone is:** a raw item at the row's own key with
  `__edd_e__ = <entityType>#tombstone`. It holds:
  - the checkpoint fields;
  - the revision;
  - `__edd_removed__` (ISO time);
  - the TTL attribute, when `ttl` is given (opt-in only).

  It is written conditioned like any write.
- **Why not `softDelete`:** it moves the item to another sort key and would lose
  the checkpoint.
- **Reads:**
  - the projection reads a tombstone as "no row", with its checkpoints;
  - the entity's own `get`, batch and transactional reads report a tombstone
    key as absent;
  - its queries filter on `__edd_e__`;
  - a tombstone carries no index keys.
- **A later event** starts the row from `initial`, at the tombstone's
  checkpoint. A `rebuild` whose fold ends removed writes a tombstone.
- **Refused** (`[EDD-9081]`) on read models with `unique` / `retain` /
  `softDelete` features, whose extra items a raw write can't maintain.
- **TTL caveat:** once a tombstone expires, a very late event recreates the row
  (documented).

## 5. Outbox (#155)

- **Opt-in:** `outbox: { schema, effects, table?, keys?, index?, claimFor? }`.
  It requires `revision`.
- **Writing:** effects are written as items in the same `TransactWriteItems` as
  the row (or tombstone). Writes without effects stay a single `PutItem`.
- **Item layout:**
  - partition key: the row's own partition key value;
  - sort key: `<row sk>#outbox#<revision:12>#<n:4>`;
  - `__edd_e__`: `<entityType>#outbox`;
  - attributes: the encoded effect, the source, the stream id, the version, the
    event type, and the row's raw keys.
- **Where the items live:**
  - by default, in the read model's table, where they show in its change stream
    and full scans (not in entity reads);
  - in `table` (keyed `keys`, default `pk` / `sk`), which keeps them out of the
    read model's table altogether.
- **`drain(key, deliver)`** works on the head item only:
  - **claim:** a conditional update of `__edd_claim__` and
    `__edd_claimed_until__`, allowed when unclaimed or expired;
  - **deliver**, then **delete:** conditioned on the claim;
  - **repeat.**

  A held claim stops the drain, so one row is never delivered out of order,
  even across drainers. A `deliver` failure releases the claim and is reported
  as `undelivered`. A crash leaves the claim to expire (`claimFor`, default
  30 s), so the effect is delivered again: at least once.
- **`deliver` on `applyBatch` / `processBatch`** drains each row that committed
  effects, right after its write. Delivery failures never fail the record,
  because the effects are already committed.
- **`drainPending(deliver)`** sweeps the rows found through `index`, a sparse
  index that only outbox items carry.
- **Order:** one sequence per row, across all of its sources.
- **Limit:** the 100-item transaction cap allows 99 effects per row write. Beyond
  that DynamoDB rejects the write and the failure is diagnosed.

## 6. `multiProjection` (#153)

```ts
EventStore.multiProjection({
  readModel,
  initial: (key) => State,
  sources: {
    name: { stream, key: (streamId, event) => K | Option<K>, evolve, mode?, terminal? },
  },
  checkpoints: { field?, sources? },
  revision,
  toItem?,
  retry?,
  removal?,
  outbox?,
})
```

- `evolve(state, event, { source, streamId })` returns `Effect<State | RemoveRow, E, R>`.
  `R` is captured by `bindProjection`. Every source has its own `terminal`.
- `applyBatch` takes decoded events tagged by source (the decoder's output). It
  groups them by row across sources, then by instance.
- Outcomes are per row: `{ key, instances: [{ source, streamId, applied,
  alreadyApplied, rejected, superseded, version }], state, removed, revision,
  enqueued, undelivered }`.
- `catchUp(rowKey)` applies each instance the row's checkpoints know, up to its
  head. It knows map entries, and field-mapped sources through `instanceField`.
- `rebuild(rowKey, { instances })` (or `sourcesOf(rowKey)` in the config) folds
  every named instance's events keyed to the row, from `initial`. It writes the
  checkpoints from scratch and the next revision.
- `EventStore.processBatch` accepts multi-source projections next to
  single-source ones. Each record is decoded once and routed to every
  projection that reads its stream.

## 7. Tests

- **Unit:** the 1.28.0 projection suite, unchanged in behaviour, plus:
  - revision;
  - tombstones, including entity reads of a tombstone key;
  - the outbox: transactions, a separate table, drain order, claims, failures,
    `drainPending`;
  - multi-source rows: both checkpoint layouts, a second instance, a
    `ProjectionSourceConflict`, `latest` / `superseded`, cross-source order,
    races, `rebuild` / `catchUp`, and `processBatch` across projection kinds.
- **Connected (DynamoDB Local):**
  - a field-mapped source plus a map field, with a second instance arriving
    before and after legacy adoption, and `rebuild` repairing a scalar owned by
    the wrong instance;
  - concurrent writers from different sources serialised by the revision;
  - tombstones and recreation;
  - an outbox in the read model's table and in a separate table, with ordered
    drains under concurrent drainers.

## 8. Review round 1

- **`latest` + `terminal`:** a `latest` instance's candidates are tried newest first. A `terminal` rejection falls back to the next older event, and only the events older than the accepted one are `superseded`. Every candidate counts toward the checkpoint.
- **Per-instance isolation:** an instance whose `evolve` (or `initial`, `key`, gap read, or checkpoint slot) fails non-terminally is set aside. The fold re-runs without it, its checkpoint doesn't move, and it is reported in `RowResult.failed`. `multiProjection.applyBatch` turns it into its own `Failed` outcome with that instance's positions. The row fails only when every instance does, so a single-source row behaves as before.
- **`revision: { field, initial }`:** a row without a revision is written with `initial` (default 1).
- **Drain:** a successful delivery deletes the effect conditioned only on its existence. A claim that expired mid-delivery (and was re-claimed) no longer livelocks overlapping drainers.
- **`unrouted`:** `streams` may name a stream a projection reads. It is decoded once and returned too. The same stream bound and unbound shares its event schema; a different stream with the same marker is still `[EDD-9082]`.
- **`create` over a tombstone:** a projection with `removal` flags its read model, and that entity's `create` guard (single-item and transactional) becomes `attribute_not_exists(pk, sk) OR __edd_e__ = <entityType>#tombstone`. Other entities' guards are unchanged.
- **The change-feed findings** are fixed under `change-feed.md`.
