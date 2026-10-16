# Design: `evolve` skips an event without writing the row (#162)

Builds on `eventstore-projections-2.md` (the row engine).

## Problem

A projection's `evolve` can't say "this event doesn't count; leave the row
alone". Returning the state unchanged is a fold step like any other. The
instance's checkpoint moves to it, the row is written with the revision one
higher, and the event is reported in `applied`.

A rule like "an event counts only when its version is above a watermark the
row keeps" therefore costs:

- a write per ignored event;
- a revision bump;
- an `applied` entry, so any side effect driven from `applied` fires for a row
  that didn't change.

A `terminal` rejection doesn't help: it also moves the checkpoint and writes an
existing row.

## API

`evolve` may return a sentinel, `EventStore.skipEvent`, as it may return
`removeRow`:

```ts
evolve: (row, event) =>
  Effect.succeed(isStale(row, event) ? EventStore.skipEvent : apply(row, event))
// (state, event, context?) => Effect<S | RemoveRow | SkipEvent, E, R>
```

- No option enables it. `removeRow` needs `removal` because it changes what is
  stored; a skip stores nothing.
- The fold carries on with the state from before the event.
- A skipped event produces no outbox effects: `outbox.effects` is not called.
- Results gain `skipped`, the skipped events in version order. It sits next to
  `applied`, `alreadyApplied`, `rejected` and `superseded`, on:
  - `MultiInstanceResult`, typed as that source's event;
  - `ProjectionApplied`, `ProjectionCaughtUp` and `ProjectionRebuiltRow`, typed
    as the stream's event.

  A skipped event is never in `applied`. The batch-level `ignored` (positions
  whose `key` returned none) keeps its meaning.

The name is kept from the proposal: `skipEvent` / `skipped`. It pairs with
`removeRow`, and says what happens to this delivery. A skip is a "not now":
the event is decided again later (see Checkpoints).

## Writes

A row is written only when its fold changed something, or for `rebuild`. "Changed"
means at least one event was applied (`removeRow` included) or rejected by
`terminal`.

- **Skipped and `alreadyApplied` only:** no write. The outcome is `Applied`, with
  `applied: []`, the row as read, and the revision and checkpoints as read.
  This is the same shape an all-`alreadyApplied` row has today.
- **Skipped events alone never create a row.** On a tombstone they don't
  recreate one.
- **Rejections keep today's behaviour.** A rejection on an existing row still
  writes, and still moves the checkpoint.
- **A batch mixing skipped and applied events for one row** is still one write,
  with the revision bumped once. This holds within one instance or across
  instances and sources.

## Checkpoints

- **An instance's checkpoint is the high-water mark of its applied and rejected
  events.** A skipped event doesn't move it.
  - Skipped events below that mark are covered.
  - A trailing run of skipped events is not.
  - The result doesn't depend on batching. "v3 skipped, then v4 applied" and
    "v3 and v4 in one batch" both end at 4.
- **When none of an instance's events count, its checkpoint stays as read.**
  That is, every event was skipped. On a field-mapped source, the instance
  writes neither `field` nor `instanceField`. On the checkpoint map, it adds no
  entry, and an absent map stays absent when skipped events are all there is.
- **Deciding again.** An uncovered skipped event is read again and passed to
  `evolve` against the row as it is then. This happens on the instance's next
  gap-fill (`fold` mode), on a redelivery, and on `catchUp`.
  - As with `terminal`, the decision should be deterministic: once skipped,
    stays skipped, or the app accepts that a later fold may apply it.
  - The cost matches `terminal` on a never-created row. An instance whose
    events keep being skipped re-reads them from its checkpoint on each
    delivery.
- **`latest` mode.** A skipped newest event falls back to the next older one,
  as a rejection does.
  - Events older than the accepted one are `superseded`.
  - Skipped events newer than the accepted one are not covered. `latest` reads
    nothing on `applyBatch`, though, so such an event is decided again only on
    a redelivery or a `catchUp`. A newer event supersedes it.
- **`rebuild`** always writes the row (when the fold leaves one). Each
  instance's checkpoint is its last non-skipped event. An instance with only
  skipped events gets no map entry and no field.
- **A lost race** re-reads the row and re-runs `evolve`, so skip decisions are
  made again against the row that won.

### Adopting an unowned field

A field-mapped source's `field` / `instanceField` with no recorded owner (a new
row, or one written before the projection) is adopted by the first instance
that claims it. Today the claim is taken while planning, in fold order, before
anything is folded.

The proposal requires: "a skipped-only instance doesn't adopt the field; the
next instance that applies does". That can't be decided before the fold.
Adopting changes where the next instance's checkpoint lives (the field, rather
than the map), and so what it reads and folds. So:

1. Plan and fold as today.
2. If an instance adopted an unowned field but won't write it, release its
   claim. "Won't write it" means every one of its events was skipped, or it
   failed and was left out of the write.
3. When another instance of the same source is in the row's work, plan and fold
   again, with the released instance barred from adopting. It keeps the
   field's value as its read checkpoint, so its own fold is unchanged.
4. Repeat until no claim is released. Each pass bars one more instance, so this
   ends.

Only the fold order decides, so the outcome is deterministic. When no other
instance of the source is present, there is nothing to re-plan. The unwritten
claim simply isn't stored.

**Adjacent fix.** The same gap exists today for an instance that fails (not by
`terminal`) after adopting. Its claim is never written, but the next instance
of its source was planned as if it were. That instance went to the map, which
splits its checkpoint between the map and, on a later adoption, the field. Or,
without a map, it failed with `ProjectionSourceConflict`. Step 2 covers failed
instances for that reason.

## Single-source `projection`

The same engine and the same rules apply:

- a skipped-only batch isn't written;
- `version` stays at the checkpoint read;
- `skipped` is reported on `apply`, `applyBatch`, `catchUp` and `rebuild`.

## Not in scope

- **The optional `written: boolean` result field.** Every case already shows
  whether a write happened. A row with any `applied` event was written. With
  only `skipped` / `alreadyApplied`, it wasn't. A rejection writes an existing
  row (its checkpoint moves) and doesn't create a missing one, as today. Can be
  added later if a caller needs the flag.
- **A per-source `skip?: (state, event) => boolean` predicate.** It's
  equivalent to the return value.
- **Any change to returning the state unchanged, to `terminal`, or to
  `alreadyApplied`**, beyond the adoption fix above.

## Tests

- **Type tests:**
  - `evolve` may return `SkipEvent` in `projection` and in each
    `multiProjection` source, without `removal`;
  - `skipped` is typed per source on instance results, and as the stream's
    event on `ProjectionApplied` / `ProjectionCaughtUp`.
- **Unit (in-memory engine):**
  - skipped-only: no write;
  - mixed: one write;
  - checkpoint at the last non-skipped event;
  - `latest` fallback;
  - no outbox effects for a skipped event;
  - the adoption re-plan;
  - the failed-instance adoption fix.
- **Connected (DynamoDB Local):**
  - **skipped-only batch:** the stored item is byte-identical, and the outcome
    is `Applied` with `applied: []` and `skipped: [event]`;
  - **mixed batch on one row:** exactly one write, with revision +1. The
    applying instance's checkpoint advances; the skipped one's doesn't;
  - **decide again:** v1 is skipped alone. Then v2 is delivered and applied: the
    gap-fill re-reads v1 and skips it again, ending at checkpoint 2;
  - **field-mapped:** a skipped-only instance doesn't adopt an unowned
    `instanceField`. A later instance of the same source in the batch does;
  - **single-source:** a skipped-only batch writes nothing; a mixed batch writes
    once.

## Release

Minor: a new `evolve` result and a new result field.
