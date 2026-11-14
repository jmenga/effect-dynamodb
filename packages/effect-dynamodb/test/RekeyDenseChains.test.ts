/**
 * Dense random tables (#240): items, unique sentinels (two constraints on one entity, `preserveUnique`
 * soft deletes with re-created items, soft deletes without it), retained versions, a time series, an
 * aggregate and an event stream, all written over a small pool of values whose key texts chain (`a b`
 * escapes to where `a%20b` is stored raw, and so on), in both directions of `escapeKeys`. Each table
 * is generated from a seed, and `rekey` runs a fixed number of times over it, never "until it
 * settles": a table one run doesn't finish fails the test rather than looping.
 *
 * One run must finish every table, whatever order it meets the rows in: its dry run says what it
 * does, it reports no conflict, a second run moves nothing, the rows' values are kept, and every
 * unique sentinel is where its value's key text is now, naming a row of its item that holds that
 * value. Up to 1.40.0 about one table in ten never finished: a sentinel in another item's way moved
 * out with its row, which could be waiting on the moving row's own key, and the two were reported
 * `contended` on every run.
 *
 * Seeds 1–50 a direction (every pool, and at one in ten several tables 1.40.0 never finished);
 * the sweep once ran 400 a direction, eight times the run time.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { gatedLayer } from "./helpers/GatedClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"
import { rekeyOutcome } from "./helpers/RekeyOutcome.js"
import { storedRows } from "./helpers/StoredRows.js"

type Row = Record<string, AttributeValue>

class Counted extends Schema.TaggedClass<Counted>()("Counted", { by: Schema.Number }) {}

const world = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "dense", version: 1, escapeKeys })
  const Rows = Entity.make({
    model: Schema.Struct({ id: Schema.String, note: Schema.String }),
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: [] }, sk: { field: "sk", composite: ["id"] } },
  })
  const Users = Entity.make({
    model: Schema.Struct({
      team: Schema.String,
      id: Schema.String,
      email: Schema.String,
      name: Schema.String,
    }),
    entityType: "User",
    primaryKey: {
      pk: { field: "pk", composite: ["team"] },
      sk: { field: "sk", composite: ["id"] },
    },
    indexes: {
      byName: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["team"] },
        sk: { field: "gsi1sk", composite: ["name"] },
      },
    },
    unique: { email: ["email"] },
    timestamps: true,
    versioned: { retain: true },
    softDelete: { preserveUnique: true },
  })
  const Members = Entity.make({
    model: Schema.Struct({ id: Schema.String, email: Schema.String, nick: Schema.String }),
    entityType: "Member",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    unique: { email: ["email"], nick: ["nick"] },
  })
  const Softs = Entity.make({
    model: Schema.Struct({ id: Schema.String, code: Schema.String }),
    entityType: "Soft",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    unique: { code: ["code"] },
    softDelete: true,
  })
  const Readings = Entity.make({
    model: Schema.Struct({ device: Schema.String, at: Schema.Number, value: Schema.Number }),
    entityType: "Reading",
    primaryKey: { pk: { field: "pk", composite: ["device"] }, sk: { field: "sk", composite: [] } },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({
        device: Schema.String,
        at: Schema.Number,
        value: Schema.Number,
      }),
    },
  })
  const entities = { Rows, Users, Members, Softs, Readings }
  const MainTable = Table.make({ schema, entities })
  const Orders = Aggregate.make(
    Schema.Struct({
      id: Schema.String,
      customer: Schema.String,
      lines: Schema.Array(Schema.Struct({ lid: Schema.String, qty: Schema.Number })),
    }),
    {
      schema,
      table: MainTable,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "orders" },
      root: { entityType: "Order" },
      edges: { lines: Aggregate.many({ entityType: "OrderLine", sk: { composite: ["lid"] } }) },
    },
  )
  const Counters = EventStore.makeStream({
    table: MainTable,
    streamName: "Counter",
    events: [Counted],
    streamId: { composite: ["name"] },
  })
  return {
    MainTable,
    Counters,
    client: DynamoClient.make({ entities, aggregates: { Orders }, tables: { MainTable } }),
  }
}

/** A seeded generator: the same seed gives the same numbers. */
const random = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Values whose key texts chain under escaping: dense pools make every shape likely. */
const POOLS = [
  ["a b", "a%20b", "a%2520b", "a%252520b"],
  ["a b", "a%20b", "c d", "c%20d", "plain"],
  ["a b", "a%20b", "a%2520b", "p#q", "p%23q", "plain", "x y", "x%20y", "q$r", "q%24r"],
] as const

/** The rows a seed's writes leave, written with `escapeKeys` as given. A write refused is skipped. */
const written = (seed: number, escapeKeys: boolean) =>
  Effect.gen(function* () {
    const table = makeRecordingTable()
    const w = world(escapeKeys)
    const next = random(seed)
    const pool = POOLS[seed % POOLS.length]!
    const pick = () => pool[Math.floor(next() * pool.length)]!
    yield* Effect.gen(function* () {
      const db = yield* w.client
      const attempt = (op: any) =>
        Effect.ignore(
          Effect.suspend(
            (): Effect.Effect<unknown, unknown, never> => ("asEffect" in op ? op.asEffect() : op),
          ),
        )
      const writes = 12 + Math.floor(next() * 24)
      for (let i = 0; i < writes; i++) {
        switch (Math.floor(next() * 12)) {
          case 0:
            yield* attempt(db.entities.Rows.put({ id: pick(), note: `n${i}` }))
            break
          case 1:
            yield* attempt(
              db.entities.Users.put({ team: pick(), id: pick(), email: pick(), name: pick() }),
            )
            break
          case 2:
            yield* attempt(
              db.entities.Users.update({ team: pick(), id: pick() }).set({ name: pick() }),
            )
            break
          case 3:
            yield* attempt(db.entities.Users.delete({ team: pick(), id: pick() }))
            break
          case 4:
            yield* attempt(db.entities.Members.put({ id: pick(), email: pick(), nick: pick() }))
            break
          case 5:
            yield* attempt(db.entities.Members.delete({ id: pick() }))
            break
          case 6:
            yield* attempt(db.entities.Softs.put({ id: pick(), code: pick() }))
            break
          case 7:
            yield* attempt(db.entities.Softs.delete({ id: pick() }))
            break
          case 8:
            yield* attempt(db.entities.Readings.append({ device: pick(), at: i, value: i }))
            break
          case 9:
            yield* attempt(
              db.aggregates.Orders.create({
                id: pick(),
                customer: pick(),
                lines: [
                  { lid: pick(), qty: 1 },
                  { lid: `l${i}`, qty: 2 },
                ],
              }),
            )
            break
          case 10:
            yield* attempt(w.Counters.append({ name: pick() }, [new Counted({ by: i })], 0))
            break
          default:
            yield* attempt(db.entities.Members.update({ id: pick() }).set({ nick: pick() }))
        }
      }
    }).pipe(Effect.provide(Layer.merge(table.layer, w.MainTable.layer({ name: "t" }))))
    return [...table.items.values()]
  }) as Effect.Effect<ReadonlyArray<Row>>

/** Scans whose pages come back in an order of `seed`'s (0: as read). */
const scanOrder =
  (seed: number): Parameters<typeof gatedLayer>[1] =>
  (command, _input, send) => {
    if (command !== "scan" || seed === 0) return send
    let page = 0
    return Effect.map(send, (output: any) => {
      const next = random(seed * 7919 + page++)
      const items = [...(output.Items ?? [])]
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[items[i], items[j]] = [items[j], items[i]]
      }
      return { ...output, Items: items }
    })
  }

/** A dry run, a run and a second run with `escapeKeys` as given, over `rows`. */
const runs = (
  rows: ReadonlyArray<Row>,
  escapeKeys: boolean,
  options: { readonly segments: number; readonly concurrency: number; readonly pageSize: number },
  order: number,
) =>
  Effect.gen(function* () {
    const table = makeRecordingTable()
    for (const row of rows) table.items.set(`${row.pk?.S}|${row.sk?.S}`, row)
    const w = world(escapeKeys)
    const run = { ...options, streams: [w.Counters] }
    return yield* Effect.gen(function* () {
      const db = yield* w.client
      const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ ...run, dryRun: true })
      const untouched = storedRows(table.items.values())
      const real: Table.RekeyReport = yield* db.tables.MainTable.rekey(run)
      const after = [...table.items.values()]
      const again: Table.RekeyReport = yield* db.tables.MainTable.rekey(run)
      return { dry, untouched, real, after, again, last: storedRows(table.items.values()) }
    }).pipe(
      Effect.provide(
        Layer.merge(
          gatedLayer(table.client as DynamoClientService, scanOrder(order)),
          w.MainTable.layer({ name: "t" }),
        ),
      ),
    ) as unknown as Effect.Effect<{
      dry: Table.RekeyReport
      untouched: ReadonlyArray<string>
      real: Table.RekeyReport
      after: ReadonlyArray<Row>
      again: Table.RekeyReport
      last: ReadonlyArray<string>
    }>
  })

/** A row's values, without anything composed from the schema's prefix: what a move keeps. */
const contentOf = (rows: Iterable<Row>) =>
  storedRows(
    [...rows].map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([name, value]) => name !== "__edd_kt__" && !value.S?.startsWith("$dense#"),
        ),
      ),
    ),
  )

/** `text` as escaped key text: each code point U+0000–U+0025 as `%` and two hex digits. */
const escaped = (text: string) =>
  [...text]
    .map((c) => {
      const code = c.codePointAt(0)!
      return code <= 0x25 ? `%${code.toString(16).padStart(2, "0")}` : c
    })
    .join("")

/**
 * Each unique sentinel not under its value's key text now (`escapeKeys`), naming a row of its item
 * that holds the value: the item's live row, or under `preserveUnique` (users) one of its
 * tombstones. Said why.
 */
const misplacedSentinels = (rows: ReadonlyArray<Row>, escapeKeys: boolean) => {
  const out: Array<string> = []
  for (const sentinel of rows) {
    const type = sentinel.__edd_e__?.S ?? ""
    const at = type.indexOf("._unique.")
    if (at < 0) continue
    const entityType = type.slice(0, at)
    const field = type.slice(at + "._unique.".length)
    const text = sentinel.pk!.S!.slice(sentinel.sk!.S!.length + 1)
    const ownerPk = sentinel._entity_pk?.S
    const ownerSk = sentinel._entity_sk?.S ?? ""
    const prefix = `$dense#v1#${entityType.toLowerCase()}#`
    const deleted = `${prefix}deleted#${ownerSk.slice(prefix.length)}#`
    const holders = rows.filter(
      (row) =>
        row.__edd_e__?.S === entityType &&
        row.pk?.S === ownerPk &&
        (row.sk?.S === ownerSk || (entityType === "User" && row.sk?.S?.startsWith(deleted))),
    )
    const value = (row: Row) => row[field]?.S
    if (
      !holders.some((row) => {
        const held = value(row)
        return held !== undefined && (escapeKeys ? escaped(held) : held) === text
      })
    ) {
      out.push(
        `${sentinel.pk!.S} names ${ownerPk}|${ownerSk}, which ${holders.length === 0 ? "holds no row of it" : "doesn't hold it"}`,
      )
    }
  }
  return out
}

const ZERO = { item: 0, snapshot: 0, tombstone: 0, outbox: 0, event: 0, aggregate: 0, stream: 0 }

/** What a run decided, conflicts in an order of their own. */
const decided = (report: Table.RekeyReport) => {
  const { conflicts, ...rest } = rekeyOutcome(report)
  return {
    ...rest,
    conflicts: [...conflicts].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
  }
}

describe.each([
  ["to on", true],
  ["to off", false],
] as const)("rekey finishes a dense table in one run, %s", (_direction, escapeKeys) => {
  it.effect(
    "seeds 1–50",
    () =>
      Effect.gen(function* () {
        for (let seed = 1; seed <= 50; seed++) {
          const rows = yield* written(seed, !escapeKeys)
          const serial = yield* runs(
            rows,
            escapeKeys,
            { segments: 1, concurrency: 1, pageSize: 100 },
            0,
          )
          const shuffled = yield* runs(
            rows,
            escapeKeys,
            { segments: 3, concurrency: 4, pageSize: 2 },
            seed,
          )
          for (const [order, r] of [
            ["in order", serial],
            ["shuffled", shuffled],
          ] as const) {
            const at = `seed ${seed}, ${order}`
            expect(r.untouched, at).toEqual(storedRows(rows))
            expect(decided(r.dry), at).toEqual(decided(r.real))
            expect(r.real.conflicts, at).toEqual([])
            expect(r.real.scanned, at).toBe(rows.length)
            expect(r.again.moved, at).toEqual(ZERO)
            expect(r.again.sentinelsMoved, at).toBe(0)
            expect(r.again.conflicts, at).toEqual([])
            expect(contentOf(r.after), at).toEqual(contentOf(rows))
            expect(misplacedSentinels(r.after, escapeKeys), at).toEqual([])
          }
          expect(shuffled.last, `seed ${seed}`).toEqual(serial.last)
        }
      }),
    // 50 seeds, each run in two orders: about 1.5 s here, several times that on CI.
    30_000,
  )
})
