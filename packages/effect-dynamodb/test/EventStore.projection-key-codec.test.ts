/**
 * A projection whose read model's key composite is a codec `encode` takes on
 * its own output, over the rows published 1.39.0 wrote (`KeyCodecProjection`),
 * under `escapeKeys` off and on, and the rows of the first moved to
 * `escapeKeys: true`. 1.39.0 keyed each read model's row by its stored text
 * encoded once more; one `rekey` pass moves it to the stored text's key, where
 * a fresh write of the same events puts it, and the engine reads it, updates
 * it, tombstones it and keys its outbox items there.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import type * as Table from "../src/Table.js"
import * as P from "./helpers/KeyCodecProjection.js"
import * as Shapes from "./helpers/KeyCodecShapes.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Recording = ReturnType<typeof makeRecordingTable>

const ZERO = { item: 0, snapshot: 0, tombstone: 0, outbox: 0, event: 0, aggregate: 0, stream: 0 }

/** Rows in key order, with what a write stamps afresh (times, write tokens) masked. */
/**
 * Rows as compared: volatile values replaced, and no outbox item's read-model tag (`__edd_rm__`,
 * #237), which a fresh item carries from 1.41.0 and one 1.39.0 wrote doesn't: `rekey` moves an
 * item as it is.
 */
const comparable = (rows: Iterable<P.Row>) => {
  const keyOf = (row: P.Row) => `${row.pk?.S}|${row.sk?.S}`
  return [...rows]
    .map(({ __edd_rm__: _tag, ...row }) => row as P.Row)
    .map(
      (row): P.Row => ({
        ...row,
        ...(row.timestamp !== undefined && { timestamp: { S: "<time>" } }),
        ...(row.__edd_wt__ !== undefined && { __edd_wt__: { S: "<token>" } }),
        ...(row.__edd_removed__ !== undefined && { __edd_removed__: { S: "<time>" } }),
      }),
    )
    .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
}

describe.each([
  ["escapeKeys off", "off", "off"],
  ["escapeKeys on", "on", "on"],
  ["escapeKeys off, then on, in one pass", "off", "on"],
] as const)("a projection's rows 1.39.0 wrote for a codec-keyed read model, %s", (_label, written, now) => {
  const f = P.fixture[written]
  const w = P.world(now)
  const then = P.world(written)

  /** The physical tables the two definitions name: two, or one both share. */
  type Names = { readonly events: string; readonly read: string }
  const TWO: Names = { events: "events", read: "read" }
  const ONE: Names = { events: "shared", read: "shared" }

  /** The stream's rows in the events table, the read model's in the read table. */
  const holding = (
    rows: { readonly events: ReadonlyArray<P.Row>; readonly read: ReadonlyArray<P.Row> },
    names: Names = TWO,
  ) => {
    const table = makeRecordingTable()
    for (const row of rows.events) table.seed(names.events, row)
    for (const row of rows.read) table.seed(names.read, row)
    return table
  }
  const seeded = () => holding(f.seed)
  const on = <A>(table: Recording, body: Effect.Effect<A, unknown, any>, names: Names = TWO) =>
    body.pipe(
      Effect.provide(
        Layer.mergeAll(
          table.layer,
          w.EventsTable.layer({ name: names.events }),
          w.ReadTable.layer({ name: names.read }),
        ),
      ),
    ) as Effect.Effect<A, unknown, never>
  /** `rekey` of the read model's table, then of the stream's. */
  const rekey = (table: Recording, names: Names = TWO) =>
    on(
      table,
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Removable: w.Removable, Effected: w.Effected },
          tables: { EventsTable: w.EventsTable, ReadTable: w.ReadTable },
        })
        const read: Table.RekeyReport = yield* db.tables.ReadTable.rekey()
        const events: Table.RekeyReport = yield* db.tables.EventsTable.rekey({
          streams: [w.Orders],
        })
        return { read, events }
      }),
      names,
    )
  const at = (table: Recording, key: { readonly pk: string; readonly sk: string }) => {
    const row = table.items.get(`${key.pk}|${key.sk}`)
    return row === undefined ? undefined : (fromAttributeMap(row) as Record<string, unknown>)
  }
  const outboxItems = (table: Recording) =>
    [...table.items.values()]
      .filter((row) => row.__edd_e__?.S === "Effected#outbox")
      .map((row) => fromAttributeMap(row) as Record<string, unknown>)

  if (written === now)
    it("1.39.0 failed every event after the first, and tombstoned a key the row was not at", () => {
      expect(P.fixture.writtenBy["effect-dynamodb"]).toBe("1.39.0")
      expect(f.id).toEqual(P.id)
      const keys = (rows: ReadonlyArray<P.Row>) =>
        rows.map((row) => [row.pk!.S, row.sk!.S, row.__edd_e__!.S, row.__edd_kt__?.N])
      // An outbox item, or a tombstone, under the text of `escapeKeys: true` is marked.
      const mark = written === "on" ? "2" : undefined
      expect(keys(f.seed.read)).toEqual([
        [w.outboxPk, "$kp#v1#effected#outbox#000000000001#0000", "Effected#outbox", mark],
        [w.doubledKey.Effected.pk, w.doubledKey.Effected.sk, "Effected", undefined],
        [w.doubledKey.Removable.pk, w.doubledKey.Removable.sk, "Removable", undefined],
      ])
      const [, added, cancelled] = f.steps
      expect(added).toMatchObject({
        A: { failed: "ConcurrentModification" },
        B: { failed: "ConcurrentModification" },
      })
      expect(cancelled).toMatchObject({ A: { ok: { removed: true } } })
      expect(keys(f.final.read).slice(2)).toEqual([
        [w.rowKey.Removable.pk, w.rowKey.Removable.sk, "Removable#tombstone", mark],
        [w.doubledKey.Removable.pk, w.doubledKey.Removable.sk, "Removable", undefined],
      ])
      expect(f.gets.A).toEqual({ ok: { orderId: "o 1", total: 5, version: 1 } })
    })

  it.effect("before rekey, the read model's get finds its row no more", () =>
    Effect.gen(function* () {
      const got = yield* on(seeded(), Effect.exit(w.Removable.get(P.id).asEffect()))
      expect(Exit.isFailure(got) && JSON.stringify(got.cause)).toContain("ItemNotFound")
    }),
  )

  it.effect("rekey moves each row to the key a fresh write gives it; a rerun moves nothing", () =>
    Effect.gen(function* () {
      const table = seeded()
      const { read, events } = yield* rekey(table)
      // The rows move; the outbox item holds the stored text, which 1.39.0 keyed once, so it
      // moves only to escape it, as the stream's event does.
      expect(read.moved).toEqual({ ...ZERO, item: 2, outbox: written === now ? 0 : 1 })
      expect(read.conflicts).toEqual([])
      expect(read.byMember.Removable?.moved.item).toBe(1)
      expect(read.byMember.Effected?.moved.item).toBe(1)
      // Two tables: each run reads its own table's rows alone.
      expect(read.skipped).toMatchObject({ unregistered: 0 })
      expect(read.unchanged).toBe(written === now ? 1 : 0)
      expect(events.moved).toEqual({ ...ZERO, stream: written === now ? 0 : 1 })
      expect(events.skipped).toMatchObject({ unregistered: 0 })
      expect(events.conflicts).toEqual([])
      expect(at(table, w.rowKey.Removable)).toMatchObject({ orderId: "x:o 1", total: 5 })
      expect(at(table, w.doubledKey.Removable)).toBeUndefined()

      const fresh = makeRecordingTable()
      yield* on(
        fresh,
        Effect.gen(function* () {
          yield* w.Orders.append(P.id, [new P.Placed({ amount: 5 })], 0)
          yield* w.A.catchUp(P.id)
          yield* w.B.catchUp(P.id)
        }),
      )
      expect(comparable(table.items.values())).toEqual(comparable(fresh.items.values()))

      const again = yield* rekey(table)
      expect(again.read.moved).toEqual(ZERO)
      expect(again.read.conflicts).toEqual([])
      expect(again.events.moved).toEqual(ZERO)
    }),
  )

  it.effect("after rekey, the engine updates the row, tombstones it, and drains every effect", () =>
    Effect.gen(function* () {
      const table = seeded()
      yield* rekey(table)
      const notes: Array<string> = []
      const result = yield* on(
        table,
        Effect.gen(function* () {
          yield* w.Orders.append(P.id, [new P.Added({ amount: 3 })], 1)
          const a = yield* w.A.catchUp(P.id)
          const b = yield* w.B.catchUp(P.id)
          const updated = {
            Removable: at(table, w.rowKey.Removable),
            Effected: at(table, w.rowKey.Effected),
          }
          yield* w.Orders.append(P.id, [new P.Cancelled()], 2)
          const removed = yield* w.A.catchUp(P.id)
          yield* w.B.catchUp(P.id)
          const got = yield* Effect.exit(w.Removable.get(P.id).asEffect())
          const outbox = outboxItems(table).map((o) => [o.pk, o.__edd_row_pk__, o.__edd_kt__])
          const drained = yield* w.B.drain(P.id, (effect) =>
            Effect.sync(() => {
              notes.push(effect.note)
            }),
          )
          return { a, b, updated, removed, got, outbox, drained }
        }),
      )
      expect(result.a.applied.map((e) => e.version)).toEqual([2])
      expect(result.b.applied.map((e) => e.version)).toEqual([2])
      expect(result.updated.Removable).toMatchObject({ orderId: "x:o 1", total: 8, version: 2 })
      expect(result.updated.Effected).toMatchObject({ orderId: "x:o 1", total: 8, rev: 2 })
      expect(result.removed.removed).toBe(true)
      expect(at(table, w.rowKey.Removable)).toMatchObject({
        __edd_e__: "Removable#tombstone",
        version: 3,
      })
      expect(Exit.isFailure(result.got) && JSON.stringify(result.got.cause)).toContain(
        "ItemNotFound",
      )
      const mark = now === "on" ? 2 : undefined
      expect(result.outbox).toEqual([
        [w.outboxPk, w.outboxPk, mark],
        [w.outboxPk, w.outboxPk, mark],
        [w.outboxPk, w.outboxPk, mark],
      ])
      expect(result.drained.delivered).toBe(3)
      expect(notes).toEqual(["Placed v1", "Added v2", "Cancelled v3"])
      expect(outboxItems(table)).toEqual([])
    }),
  )

  it.effect("over one physical table, each definition's rekey passes over the other's rows", () =>
    Effect.gen(function* () {
      const table = holding(f.seed, ONE)
      const { read, events } = yield* rekey(table, ONE)
      expect(read.moved).toEqual({ ...ZERO, item: 2, outbox: written === now ? 0 : 1 })
      expect(read.conflicts).toEqual([])
      // The stream's rows are in the read model's table too, and no member of it.
      expect(read.skipped).toMatchObject({ unregistered: f.seed.events.length })
      expect(events.moved).toEqual({ ...ZERO, stream: written === now ? 0 : 1 })
      expect(events.conflicts).toEqual([])
      expect(events.skipped).toMatchObject({ unregistered: f.seed.read.length })
      expect(at(table, w.rowKey.Removable)).toMatchObject({ orderId: "x:o 1", total: 5 })
      expect(at(table, w.doubledKey.Removable)).toBeUndefined()

      const again = yield* rekey(table, ONE)
      expect(again.read.moved).toEqual(ZERO)
      expect(again.events.moved).toEqual(ZERO)
    }),
  )

  it.effect("rekey leaves a row whose key 1.39.0's removal tombstoned, and reports it", () =>
    Effect.gen(function* () {
      const table = holding(f.final)
      const { read } = yield* rekey(table)
      expect(read.conflicts).toEqual([
        {
          member: "Removable",
          kind: "item",
          reason: "taken",
          key: then.doubledKey.Removable,
          target: w.rowKey.Removable,
          message: expect.any(String),
        },
      ])
      expect(read.byMember.Effected?.moved.item).toBe(1)
      expect(at(table, w.rowKey.Removable)).toMatchObject({ __edd_e__: "Removable#tombstone" })
      expect(at(table, then.doubledKey.Removable)).toMatchObject({ __edd_e__: "Removable" })
    }),
  )

  /** `rekey` of the read model's table, one row at a time, its scan handing `first`'s rows first. */
  const rekeyInOrder = (table: Recording, first: (row: P.Row) => boolean, dryRun = false) =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Removable: w.Removable, Effected: w.Effected },
        tables: { EventsTable: w.EventsTable, ReadTable: w.ReadTable },
      })
      const report: Table.RekeyReport = yield* db.tables.ReadTable.rekey({
        concurrency: 1,
        dryRun,
      })
      return { ...report, capacity: undefined }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Shapes.scanningFirst(table.layer, first),
          w.EventsTable.layer({ name: "events" }),
          w.ReadTable.layer({ name: "read" }),
        ),
      ),
    ) as Effect.Effect<Omit<Table.RekeyReport, "capacity">, unknown, never>

  for (const [order, first] of P.removalOrders) {
    it.effect(
      `rekey puts the removal tombstone at the row's key, ${order}, and a rerun agrees`,
      () =>
        Effect.gen(function* () {
          const table = holding(f.final)
          const report = yield* rekeyInOrder(table, first)
          const leftover = {
            member: "Removable",
            kind: "item",
            reason: "taken",
            key: then.doubledKey.Removable,
            target: w.rowKey.Removable,
            message: "Another row holds its current key.",
          }
          expect(report.conflicts).toEqual([leftover])
          expect(report.byMember.Removable?.moved).toEqual({
            ...ZERO,
            tombstone: written === now ? 0 : 1,
          })
          expect(report.byMember.Effected?.moved.item).toBe(1)
          expect(at(table, w.rowKey.Removable)).toMatchObject({ __edd_e__: "Removable#tombstone" })
          expect(at(table, then.doubledKey.Removable)).toMatchObject({ __edd_e__: "Removable" })
          if (written !== now) expect(at(table, then.rowKey.Removable)).toBeUndefined()

          const again = yield* rekeyInOrder(table, first)
          expect(again.conflicts).toEqual([leftover])
          expect(again.moved).toEqual(ZERO)
        }),
    )
  }

  it.effect("rekey reports and leaves the same in either order, and a dry run agrees", () =>
    Effect.gen(function* () {
      const [a, b] = P.removalOrders.map(() => holding(f.final))
      const dry = [
        yield* rekeyInOrder(a!, P.removalOrders[0][1], true),
        yield* rekeyInOrder(b!, P.removalOrders[1][1], true),
      ]
      const reports = [
        yield* rekeyInOrder(a!, P.removalOrders[0][1]),
        yield* rekeyInOrder(b!, P.removalOrders[1][1]),
      ]
      expect(reports[0]).toEqual(reports[1])
      expect(comparable(a!.items.values())).toEqual(comparable(b!.items.values()))
      for (const run of dry) {
        expect(run.conflicts).toEqual(reports[0]!.conflicts)
        expect(run.moved).toEqual(reports[0]!.moved)
      }
    }),
  )
})
