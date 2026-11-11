/**
 * An aggregate's `rekey` writes go in transactions DynamoDB accepts. A wave's moves and rewrites go
 * in order, each transaction taking them while it holds at most 100 actions, 4,194,304 bytes by
 * the exact size model and 16,777,216 bytes of request body (`internal/ItemSize.ts`). A move's Put
 * and Delete are never split, and the root still moves last. A wave that fits keeps the
 * transactions it had, 100 actions each.
 */

import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { TRANSACT_WRITE_ITEMS_LIMIT } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import {
  ITEM_MAX_BYTES,
  itemBytes,
  REQUEST_MAX_BYTES,
  TRANSACT_WRITE_MAX_BYTES,
  transactionBytes,
} from "../src/internal/ItemSize.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable, sdkBodyBytes } from "./helpers/RecordingTable.js"
import { rekeyOutcome } from "./helpers/RekeyOutcome.js"

class Line extends Schema.Class<Line>("Line")({
  lid: Schema.String,
  note: Schema.String,
}) {}

class Order extends Schema.Class<Order>("Order")({
  id: Schema.String,
  note: Schema.String,
  lines: Schema.Array(Line),
}) {}

const world = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "sized", version: 1, escapeKeys })
  const MainTable = Table.make({ schema, entities: {} })
  const Orders = Aggregate.make(Order, {
    table: MainTable,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "orders" },
    root: { entityType: "OrderItem" },
    edges: {
      lines: Aggregate.many({ entityType: "OrderLine", sk: { composite: ["lid"] } }),
    },
  })
  const client = DynamoClient.make({ entities: {}, aggregates: { Orders }, tables: { MainTable } })
  return { MainTable, Orders, client }
}

type World = ReturnType<typeof world>

/** The partition key text of order `p q` under the setting. */
const pkOf = (escapeKeys: boolean) => `$sized#v1#orders#${escapeKeys ? "p%20q" : "p q"}`

/**
 * Order `p q` with `count` lines, written under the other setting's key text, each line's note
 * then made `note` characters long in place (the create itself has to fit one transaction).
 * Then a dry run and a run of `rekey` under `escapeKeys`, and the transactions the run sent.
 */
const rekeyed = (escapeKeys: boolean, count: number, note: number, char = "x") =>
  Effect.gen(function* () {
    // Refuses a request body over 16 MiB, as DynamoDB Local does.
    const table = makeRecordingTable({ refuseBodiesOver: REQUEST_MAX_BYTES })
    const on =
      (w: World) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provide(Layer.merge(table.layer, w.MainTable.layer({ name: "t" }))),
        ) as Effect.Effect<A, E>
    const before = world(!escapeKeys)
    const after = world(escapeKeys)
    const lines = Array.from({ length: count }, (_, i) => new Line({ lid: `line${i}`, note: "x" }))
    yield* Effect.gen(function* () {
      const db = yield* before.client
      yield* db.aggregates.Orders.create({ id: "p q", note: "root", lines })
    }).pipe(on(before))
    for (const [key, row] of table.items) {
      if (row.__edd_e__?.S === "OrderLine") {
        table.items.set(key, { ...row, note: { S: char.repeat(note) } })
      }
    }
    const stored = [...table.items.values()]
    table.take()
    return yield* Effect.gen(function* () {
      const db = yield* after.client
      const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
      const dryWrites = table.take().filter((request) => request.command === "TransactWriteItems")
      const real: Table.RekeyReport = yield* db.tables.MainTable.rekey()
      const sent = table
        .take()
        .filter((request) => request.command === "TransactWriteItems")
        .map((request) => request.input.TransactItems as Array<TransactWriteItem>)
      const found = yield* db.aggregates.Orders.get({ id: "p q" })
      return { stored, dry, dryWrites, real, sent, found, rows: [...table.items.values()] }
    }).pipe(on(after))
  })

const entityOf = (action: TransactWriteItem) => action.Put?.Item?.__edd_e__?.S

/** The sort keys a transaction's Puts write and its Deletes delete, as sets. */
const pairs = (actions: ReadonlyArray<TransactWriteItem>) => ({
  puts: new Set(actions.flatMap((action) => (action.Put ? [action.Put.Item!.sk!.S] : []))),
  deletes: new Set(actions.flatMap((action) => (action.Delete ? [action.Delete.Key!.sk!.S] : []))),
})

const SETTINGS = [
  ["to on", true],
  ["to off", false],
] as const

describe.each(SETTINGS)("an aggregate's rekey transactions, %s", (_direction, escapeKeys) => {
  it.effect("rows that together pass 4 MB move in transactions under it", () =>
    Effect.gen(function* () {
      const { stored, dry, dryWrites, real, sent, found, rows } = yield* rekeyed(
        escapeKeys,
        12,
        360_000,
      )
      // Every row is within DynamoDB's item limit, and the lines' moves together are over 4 MB
      // in fewer than 100 actions: by count alone, they'd go in one transaction DynamoDB rejects.
      expect(stored.every((row) => itemBytes(row) < ITEM_MAX_BYTES)).toBe(true)
      const lineMoves = sent.slice(0, -1).flat()
      expect(lineMoves.length).toBe(24)
      expect(lineMoves.length).toBeLessThan(TRANSACT_WRITE_ITEMS_LIMIT)
      expect(transactionBytes(lineMoves)).toBeGreaterThan(TRANSACT_WRITE_MAX_BYTES)

      // Each move holds about 720 KB (its Put, and its Delete's guard on the row as read): five
      // to a transaction, then the root alone.
      expect(sent.map((actions) => actions.length)).toEqual([10, 10, 4, 2])
      for (const actions of sent) {
        expect(actions.length).toBeLessThanOrEqual(TRANSACT_WRITE_ITEMS_LIMIT)
        expect(transactionBytes(actions)).toBeLessThanOrEqual(TRANSACT_WRITE_MAX_BYTES)
        // A move's Put and Delete are in the same transaction.
        const { puts, deletes } = pairs(actions)
        expect(puts).toEqual(deletes)
        expect(puts.size * 2).toBe(actions.length)
      }
      // Each transaction took every move that fit: the next one's first move would pass 4 MB.
      for (let i = 0; i + 1 < sent.length - 1; i++) {
        const next = sent[i + 1]!.slice(0, 2)
        expect(transactionBytes([...sent[i]!, ...next])).toBeGreaterThan(TRANSACT_WRITE_MAX_BYTES)
      }
      // The root moves last, alone.
      expect(sent.at(-1)!.map(entityOf).filter(Boolean)).toEqual(["OrderItem"])
      expect(lineMoves.map(entityOf).filter(Boolean)).toEqual(
        Array.from({ length: 12 }, () => "OrderLine"),
      )

      expect(real.conflicts).toEqual([])
      expect(real.moved.aggregate).toBe(13)
      expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
      expect(dryWrites).toEqual([])
      expect(new Set(rows.map((row) => row.pk!.S))).toEqual(new Set([pkOf(escapeKeys)]))
      expect(found.lines.map((line) => [line.lid, line.note.length]).sort()).toEqual(
        Array.from({ length: 12 }, (_, i) => [`line${i}`, 360_000]).sort(),
      )
    }),
  )

  it.effect("rows within 4 MB but over 16 MB as JSON move in transactions under 16 MB", () =>
    Effect.gen(function* () {
      // A NUL is one byte of item and six of JSON.
      const { real, sent, found, rows } = yield* rekeyed(escapeKeys, 12, 250_000, "\u0000")
      const lineMoves = sent.slice(0, -1).flat()
      // By count and item size, eight moves fit a transaction (24 MB of JSON): five do by body.
      expect(transactionBytes(lineMoves.slice(0, 16))).toBeLessThanOrEqual(TRANSACT_WRITE_MAX_BYTES)
      expect(sent.map((actions) => actions.length)).toEqual([10, 10, 4, 2])
      for (const actions of sent) {
        expect(sdkBodyBytes("TransactWriteItems", { TransactItems: actions })).toBeLessThanOrEqual(
          REQUEST_MAX_BYTES,
        )
        expect(pairs(actions).puts).toEqual(pairs(actions).deletes)
      }
      // Each took every move that fit: the next move would pass 16 MB.
      for (let i = 0; i + 1 < sent.length - 1; i++) {
        expect(
          sdkBodyBytes("TransactWriteItems", {
            TransactItems: [...sent[i]!, ...sent[i + 1]!.slice(0, 2)],
          }),
        ).toBeGreaterThan(REQUEST_MAX_BYTES)
      }
      expect(sent.at(-1)!.map(entityOf).filter(Boolean)).toEqual(["OrderItem"])
      expect(real.conflicts).toEqual([])
      expect(real.moved.aggregate).toBe(13)
      expect(new Set(rows.map((row) => row.pk!.S))).toEqual(new Set([pkOf(escapeKeys)]))
      expect(found.lines.map((line) => line.note.length)).toEqual(Array(12).fill(250_000))
    }),
  )

  it.effect("a wave under 4 MB goes in transactions of 100 actions, as before", () =>
    Effect.gen(function* () {
      const { real, sent, rows } = yield* rekeyed(escapeKeys, 60, 1)
      expect(sent.map((actions) => actions.length)).toEqual([100, 20, 2])
      expect(sent.at(-1)!.map(entityOf).filter(Boolean)).toEqual(["OrderItem"])
      for (const actions of sent) expect(pairs(actions).puts).toEqual(pairs(actions).deletes)
      expect(real.conflicts).toEqual([])
      expect(real.moved.aggregate).toBe(61)
      expect(new Set(rows.map((row: Record<string, AttributeValue>) => row.pk!.S))).toEqual(
        new Set([pkOf(escapeKeys)]),
      )
    }),
  )
})
