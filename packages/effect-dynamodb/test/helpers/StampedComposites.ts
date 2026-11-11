/**
 * Index keys over values the library stamps: canonical shapes 16 to 18 (CLAUDE.md, `DESIGN.md §7`).
 *
 * A write that stamps `createdAt` or `updatedAt` composes its keys from what it stamps, on every path
 * that builds a whole item; an update moves a half holding `updatedAt` when it can compose it and
 * otherwise leaves it, and the stamp never counts as touching the half. The scenarios run under both
 * `escapeKeys` settings, on a recording table (`IndexPolicyV3.test.ts`) and on DynamoDB Local
 * (`connected.test.ts`). They need the clock to move, so both run them live.
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import * as Batch from "../../src/Batch.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import { fromAttributeMap } from "../../src/Marshaller.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { bothSettings, type RepairScenario, type RepairTable } from "./RekeyRepair.js"

type StoredRow = Record<string, any>

const half = (n: number, composite: ReadonlyArray<string>) => ({
  field: `gsi${n}pk`,
  composite,
})
const sortHalf = (n: number, composite: ReadonlyArray<string>) => ({
  field: `gsi${n}sk`,
  composite,
})

/** Far enough for the next stamp to differ. */
const tick = Effect.sleep("3 millis")

const SUPPLIED = "2020-02-03T04:05:06.000Z"
const supplied = DateTime.makeUnsafe(SUPPLIED)

const rowOf = (rows: ReadonlyArray<StoredRow>, id: string): StoredRow => {
  const row = rows.find((candidate) => candidate.id?.S === id)
  if (row === undefined) throw new Error(`no row "${id}"`)
  return row
}

const updatesOf = (table: RepairTable) =>
  table.requests().filter((request) => request.command === "updateItem")

const commands = (table: RepairTable) => table.requests().map((request) => request.command)

// ---------------------------------------------------------------------------
// One entity holding every shape
// ---------------------------------------------------------------------------

class Happened extends Schema.TaggedClass<Happened>()("Happened", {}) {}

class Ticket extends Schema.Class<Ticket>("Ticket")({
  id: Schema.String,
  owner: Schema.String,
  status: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  price: Schema.optional(Schema.Number),
  note: Schema.optional(Schema.String),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
}) {}

const ticketIndexes = {
  // Shape 18: stable, under either half.
  byCreated: { name: "gsi1", pk: half(1, ["owner"]), sk: sortHalf(1, ["createdAt"]) },
  byCreatedPk: { name: "gsi5", pk: half(5, ["createdAt"]), sk: sortHalf(5, ["id"]) },
  // Shape 16.
  byUpdated: { name: "gsi2", pk: half(2, ["owner"]), sk: sortHalf(2, ["updatedAt"]) },
  // Shape 17, both policies.
  byStatus: { name: "gsi3", pk: half(3, ["owner"]), sk: sortHalf(3, ["status", "updatedAt"]) },
  byStatusSparse: {
    name: "gsi4",
    pk: half(4, ["owner"]),
    sk: sortHalf(4, ["status", "updatedAt"]),
    indexPolicy: { sk: "sparse" },
  },
  // Shape 18a: the existing partial-payload rule.
  byStatusCreated: {
    name: "gsi6",
    pk: half(6, ["owner"]),
    sk: sortHalf(6, ["status", "createdAt"]),
  },
  // Shape 2 analogue: the rest of the half is in the primary key.
  byIdUpdated: { name: "gsi7", pk: half(7, ["owner"]), sk: sortHalf(7, ["id", "updatedAt"]) },
  // Shape 6 analogue: a constant partition key half.
  byUpdatedAll: { name: "gsi8", pk: half(8, []), sk: sortHalf(8, ["updatedAt"]) },
  // Shape 17a: a half with more than one other composite.
  byPlace: {
    name: "gsi9",
    pk: half(9, ["owner"]),
    sk: sortHalf(9, ["status", "region", "updatedAt"]),
    indexPolicy: { sk: "sparse" },
  },
  // Shape 17b: a stamped Z-order dimension.
  byPrice: {
    name: "gsi10",
    pk: half(10, ["owner"]),
    sk: {
      field: "gsi10sk",
      zorder: [
        { field: "price", min: 0, max: 1000 },
        { field: "updatedAt", from: "2024-01-01", unit: "seconds", bits: 32 },
      ],
    },
  },
}

const ticketWorld = (escapeKeys: boolean, extra: Record<string, unknown> = {}) => {
  const schema = DynamoSchema.make({ name: "stamped", version: 1, escapeKeys })
  const Tickets = Entity.make({
    model: Ticket,
    entityType: "Ticket",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    timestamps: true,
    indexes: ticketIndexes,
    ...extra,
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Tickets } })
  const client = DynamoClient.make({ entities: { Tickets }, tables: { MainTable } })
  return { schema, Tickets, MainTable, client } as any
}

/** What a `put` of `row`'s stored values writes. */
const composedFrom = (
  w: any,
  row: StoredRow,
  entity: any = w.Tickets,
  type = "Ticket",
): Record<string, unknown> =>
  KeyComposer.composeAllKeys(
    w.schema,
    type,
    1,
    entity.indexes,
    entity._keyForm(fromAttributeMap(row)),
  )

const keyBytes = (attribute: any): unknown =>
  attribute === undefined ? undefined : (attribute.S ?? [...attribute.B])

/** Every index key on `row` is what a `put` of its values composes, and every composable one is there. */
const expectKeysOfValues = (w: any, row: StoredRow, entity?: any, type?: string): void => {
  const composed = composedFrom(w, row, entity, type)
  for (const [field, value] of Object.entries(composed)) {
    expect(keyBytes(row[field]), field).toEqual(
      typeof value === "string" ? value : [...(value as Uint8Array)],
    )
  }
}

export const writeScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings("a put stamps, then composes every index over what it stamped", (h, on) => {
    const w = ticketWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Tickets.put({
          id: "a",
          owner: "o",
          status: "open",
          region: "r",
          price: 10,
        }).asEffect()
        const row = rowOf(yield* table.rows(), "a")
        expect(row.createdAt?.S).toBeDefined()
        expectKeysOfValues(w, row)
        // Under the attribute's own value, in each half.
        expect(row.gsi1sk.S.toLowerCase()).toContain(`createdat_${row.createdAt.S.toLowerCase()}`)
        expect(row.gsi5pk.S.toLowerCase()).toContain(`createdat_${row.createdAt.S.toLowerCase()}`)
        expect(row.gsi2sk.S.toLowerCase()).toContain(`updatedat_${row.updatedAt.S.toLowerCase()}`)
        expect(row.gsi10sk.B).toBeDefined()
        // And every index reads it.
        yield* Effect.forEach(
          [
            "byCreated",
            "byUpdated",
            "byStatus",
            "byStatusSparse",
            "byIdUpdated",
            "byPlace",
            "byPrice",
          ],
          (accessor) =>
            db.entities.Tickets[accessor]({ owner: "o" })
              .collect()
              .pipe(
                Effect.map((items: ReadonlyArray<unknown>) =>
                  expect(items, accessor).toHaveLength(1),
                ),
              ),
          { discard: true },
        )
      }),
    )
  }),
  ...bothSettings("a value the caller supplies is the key's, on a put", (h, on) => {
    const w = ticketWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Tickets.put({
          id: "a",
          owner: "o",
          createdAt: supplied,
          updatedAt: supplied,
        }).asEffect()
        const row = rowOf(yield* table.rows(), "a")
        expect(row.createdAt.S).toBe(SUPPLIED)
        expect(row.updatedAt.S).toBe(SUPPLIED)
        expect(row.gsi1sk.S).toContain(`createdat_${SUPPLIED.toLowerCase()}`)
        expect(row.gsi2sk.S).toContain(`updatedat_${SUPPLIED.toLowerCase()}`)
      }),
    )
  }),
  ...bothSettings("every other path that writes a whole item composes the same keys", (h, on) => {
    const w = ticketWorld(on)
    const values = (id: string) => ({ id, owner: "o", status: "open", region: "r", price: 10 })
    const Events = EventStore.makeStream({
      table: w.MainTable,
      streamName: "Stream",
      events: [Happened],
      streamId: { composite: ["id"] },
    }) as any
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Tickets.create(values("created")).asEffect()
        yield* db.entities.Tickets.upsert(values("upserted")).asEffect()
        yield* Batch.write([db.entities.Tickets.put(values("batched"))])
        yield* Transaction.transactWrite([db.entities.Tickets.put(values("transacted"))])
        const bound: any = yield* EventStore.bind(Events)
        yield* bound.append({ id: "s" }, [new Happened({})], 0, {
          additionalItems: [db.entities.Tickets.put(values("appended"))],
        })
        const rows = yield* table.rows()
        for (const id of ["created", "upserted", "batched", "transacted", "appended"]) {
          const row = rowOf(rows, id)
          expect(row.gsi1sk, id).toBeDefined()
          expect(row.gsi2sk, id).toBeDefined()
          expect(row.gsi5pk, id).toBeDefined()
          expect(row.gsi10sk, id).toBeDefined()
          expectKeysOfValues(w, row)
        }
      }),
    )
  }),
  ...bothSettings(
    "an unrelated update moves a half it can compose and leaves the rest",
    (h, on) => {
      const w = ticketWorld(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.Tickets.put({
            id: "a",
            owner: "o",
            status: "open",
            region: "r",
            price: 10,
          }).asEffect()
          const before = rowOf(yield* table.rows(), "a")
          yield* tick
          table.clear()
          yield* db.entities.Tickets.update({ id: "a" }).set({ note: "n" }).asEffect()
          const after = rowOf(yield* table.rows(), "a")
          expect(after.updatedAt.S).not.toBe(before.updatedAt.S)
          // Shape 16, its shape 2 and shape 6 analogues: everything else is known.
          expect(after.gsi2sk.S.toLowerCase()).toContain(
            `updatedat_${after.updatedAt.S.toLowerCase()}`,
          )
          expect(after.gsi7sk.S.toLowerCase()).toContain(
            `updatedat_${after.updatedAt.S.toLowerCase()}`,
          )
          expect(after.gsi8sk.S.toLowerCase()).toContain(
            `updatedat_${after.updatedAt.S.toLowerCase()}`,
          )
          // Shape 17, under both policies, and 17a, 17b: the other composites aren't known, so each
          // key stays byte for byte and the row stays in its index. Nothing is removed.
          for (const field of [
            "gsi3sk",
            "gsi4sk",
            "gsi9sk",
            "gsi10sk",
            "gsi1sk",
            "gsi5pk",
            "gsi6sk",
          ]) {
            expect(after[field], field).toEqual(before[field])
          }
          const sent = updatesOf(table)[0]!.input
          expect(sent.UpdateExpression).not.toContain("REMOVE")
          expect(yield* db.entities.Tickets.byStatusSparse({ owner: "o" }).collect()).toHaveLength(
            1,
          )
        }),
      )
    },
  ),
  ...bothSettings("naming the other composites moves the half with the new stamp", (h, on) => {
    const w = ticketWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Tickets.put({
          id: "a",
          owner: "o",
          status: "open",
          region: "r",
        }).asEffect()
        yield* tick
        yield* db.entities.Tickets.update({ id: "a" }).set({ status: "shut" }).asEffect()
        const named = rowOf(yield* table.rows(), "a")
        const stamp = named.updatedAt.S.toLowerCase()
        expect(named.gsi3sk.S).toContain(`status_shut#updatedat_${stamp}`)
        expect(named.gsi4sk.S).toContain(`status_shut#updatedat_${stamp}`)
        // Shape 17a: `region` isn't known, so the half is left, never truncated.
        expect(named.gsi9sk.S).toContain("status_open#region_r#")
        // Shape 18a: `createdAt` isn't known and can't be named: the partial-payload rule.
        expect(named.gsi6sk.S.endsWith("status_shut")).toBe(true)
        yield* tick
        yield* db.entities.Tickets.update({ id: "a" })
          .set({ status: "shut", region: "s" })
          .asEffect()
        const both = rowOf(yield* table.rows(), "a")
        expect(both.gsi9sk.S).toContain(
          `status_shut#region_s#updatedat_${both.updatedAt.S.toLowerCase()}`,
        )
      }),
    )
  }),
  ...bothSettings("a stamped Z-order dimension: all or nothing, on the same rule", (h, on) => {
    const w = ticketWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        // No price: no address, and the update doesn't invent one.
        yield* db.entities.Tickets.put({ id: "a", owner: "o" }).asEffect()
        yield* db.entities.Tickets.update({ id: "a" }).set({ note: "n" }).asEffect()
        expect(rowOf(yield* table.rows(), "a").gsi10sk).toBeUndefined()
        // The price named: the address is every dimension's.
        yield* db.entities.Tickets.update({ id: "a" }).set({ price: 10 }).asEffect()
        const priced = rowOf(yield* table.rows(), "a")
        const composed = KeyComposer.composeZOrderSk(
          w.schema,
          w.Tickets.indexes.byPrice,
          w.Tickets._keyForm(fromAttributeMap(priced)),
        )
        expect([...priced.gsi10sk.B]).toEqual([...(composed as Uint8Array)])
      }),
    )
  }),
  ...bothSettings("`.remove()` still cascades through a half holding the stamp", (h, on) => {
    const w = ticketWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Tickets.put({
          id: "a",
          owner: "o",
          status: "open",
          region: "r",
        }).asEffect()
        yield* db.entities.Tickets.update({ id: "a" }).remove(["status"]).asEffect()
        const row = rowOf(yield* table.rows(), "a")
        expect(row.gsi3sk).toBeUndefined()
        expect(row.gsi4sk).toBeUndefined()
        expect(row.gsi9sk).toBeUndefined()
        // A half without it keeps its text.
        expect(row.gsi2sk).toBeDefined()
      }),
    )
  }),
  ...bothSettings(
    "a supplied `updatedAt` moves what it can, and touches nothing either",
    (h, on) => {
      const w = ticketWorld(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.Tickets.put({ id: "a", owner: "o", status: "open" }).asEffect()
          const before = rowOf(yield* table.rows(), "a")
          yield* db.entities.Tickets.update({ id: "a" }).set({ updatedAt: supplied }).asEffect()
          const after = rowOf(yield* table.rows(), "a")
          expect(after.updatedAt.S).toBe(SUPPLIED)
          expect(after.gsi2sk.S).toContain(`updatedat_${SUPPLIED.toLowerCase()}`)
          expect(after.gsi3sk).toEqual(before.gsi3sk)
          expect(after.gsi4sk).toEqual(before.gsi4sk)
        }),
      )
    },
  ),
  ...bothSettings(
    "an upsert keeps the stored `createdAt`, in the attribute and the key",
    (h, on) => {
      const w = ticketWorld(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.Tickets.upsert({ id: "a", owner: "o", status: "open" }).asEffect()
          const created = rowOf(yield* table.rows(), "a")
          expectKeysOfValues(w, created)
          yield* tick
          table.clear()
          yield* db.entities.Tickets.upsert({ id: "a", owner: "o", status: "open" }).asEffect()
          // Nothing the keys hold changed, so they stay, in the one write.
          expect(commands(table)).toEqual(["updateItem"])
          const again = rowOf(yield* table.rows(), "a")
          expect(again.createdAt).toEqual(created.createdAt)
          expect(again.gsi1sk).toEqual(created.gsi1sk)
          expect(again.gsi5pk).toEqual(created.gsi5pk)
          // A supplied one is the stored value's to lose, as it always was.
          yield* db.entities.Tickets.upsert({
            id: "a",
            owner: "o",
            createdAt: supplied,
          }).asEffect()
          const third = rowOf(yield* table.rows(), "a")
          expect(third.createdAt).toEqual(created.createdAt)
          expect(third.gsi1sk).toEqual(created.gsi1sk)
        }),
      )
    },
  ),
  ...bothSettings("a guarded put over an item carries its `createdAt` into the key", (h, on) => {
    const Versioned = ticketWorld(on, { versioned: true })
    return h.on(Versioned, (table) =>
      Effect.gen(function* () {
        const db = yield* Versioned.client
        yield* db.entities.Tickets.put({ id: "a", owner: "o", status: "open" }).asEffect()
        const first = rowOf(yield* table.rows(), "a")
        yield* tick
        // Through `put`.
        yield* db.entities.Tickets.put({ id: "a", owner: "o", status: "open" }).asEffect()
        const second = rowOf(yield* table.rows(), "a")
        expect(second.version.N).toBe("2")
        expect(second.createdAt).toEqual(first.createdAt)
        expect(second.gsi1sk).toEqual(first.gsi1sk)
        expect(second.gsi6sk).toEqual(first.gsi6sk)
        expect(second.gsi5pk).toEqual(first.gsi5pk)
        expectKeysOfValues(Versioned, second)
        yield* tick
        // Through a transaction.
        yield* Transaction.transactWrite([
          db.entities.Tickets.put({ id: "a", owner: "o", status: "open" }),
        ])
        const third = rowOf(yield* table.rows(), "a")
        expect(third.version.N).toBe("3")
        expect(third.createdAt).toEqual(first.createdAt)
        expect(third.gsi1sk).toEqual(first.gsi1sk)
        expectKeysOfValues(Versioned, third)
        yield* tick
        // A batch refuses to replace it, and its new items hold what it stamped.
        yield* Batch.write([db.entities.Tickets.put({ id: "b", owner: "o", status: "open" })])
        const batched = rowOf(yield* table.rows(), "b")
        expect(batched.gsi1sk).toBeDefined()
        expectKeysOfValues(Versioned, batched)
      }),
    )
  }),
  ...bothSettings(
    "an update that reads the item first composes `[status, createdAt]` whole",
    (h, on) => {
      const w = ticketWorld(on, { versioned: { retain: true } })
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.Tickets.put({ id: "a", owner: "o", status: "open" }).asEffect()
          yield* db.entities.Tickets.update({ id: "a" }).set({ status: "shut" }).asEffect()
          const row = (yield* table.rows()).find(
            (candidate) => candidate.id?.S === "a" && !candidate.sk.S.includes("#v#"),
          )!
          expect(row.gsi6sk.S.toLowerCase()).toContain(
            `status_shut#createdat_${row.createdAt.S.toLowerCase()}`,
          )
          expect(row.gsi3sk.S.toLowerCase()).toContain(
            `status_shut#updatedat_${row.updatedAt.S.toLowerCase()}`,
          )
        }),
      )
    },
  ),
  ...bothSettings(
    "an update that reads first leaves what it can't compose, and doesn't guard on what it stamps",
    (h, on) => {
      const w = ticketWorld(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.Tickets.put({
            id: "a",
            owner: "o",
            status: "open",
            price: 10,
          }).asEffect()
          // A key with no `status` behind it: nothing here can compose it again.
          const { status: _status, ...stored } = rowOf(yield* table.rows(), "a")
          yield* table.seed(stored)
          yield* tick
          table.clear()
          // A computed index composite takes the branch that reads the item first.
          yield* db.entities.Tickets.update({ id: "a" }).add({ price: 1 }).asEffect()
          const after = rowOf(yield* table.rows(), "a")
          expect(after.price.N).toBe("11")
          // Left under either policy, as the standard path leaves it.
          expect(after.gsi3sk).toEqual(stored.gsi3sk)
          expect(after.gsi4sk).toEqual(stored.gsi4sk)
          // And what it can compose moves.
          expect(after.gsi2sk.S.toLowerCase()).toContain(
            `updatedat_${after.updatedAt.S.toLowerCase()}`,
          )
          expect(after.gsi10sk).not.toEqual(stored.gsi10sk)
          // A key over `updatedAt` is written, and a concurrent write moving it changes nothing
          // the key was composed from: the guard names what was read, not what's stamped.
          const write = table.requests().find((request) => request.command === "updateItem")!
          const guarded = Object.entries(write.input.ExpressionAttributeNames as object)
            .filter(([placeholder]) => placeholder.startsWith("#g"))
            .map(([, attribute]) => attribute)
          expect(guarded).toContain("price")
          expect(guarded).not.toContain("updatedAt")
          // Naming the stamp itself doesn't touch what it can't compose either.
          yield* db.entities.Tickets.update({ id: "a" })
            .set({ updatedAt: supplied })
            .add({ price: 1 })
            .asEffect()
          const later = rowOf(yield* table.rows(), "a")
          expect(later.updatedAt.S).toBe(SUPPLIED)
          expect(later.gsi2sk.S).toContain(`updatedat_${SUPPLIED.toLowerCase()}`)
          expect(later.gsi3sk).toEqual(stored.gsi3sk)
          expect(later.gsi4sk).toEqual(stored.gsi4sk)
        }),
      )
    },
  ),
  ...bothSettings("restoring a soft delete writes the keys of the values it restores", (h, on) => {
    const w = ticketWorld(on, { softDelete: true })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Tickets.put({ id: "a", owner: "o", status: "open" }).asEffect()
        const first = rowOf(yield* table.rows(), "a")
        yield* db.entities.Tickets.delete({ id: "a" }).asEffect()
        yield* tick
        yield* db.entities.Tickets.restore({ id: "a" })
        const restored = (yield* table.rows()).find((row) => row.sk.S === first.sk.S)!
        expect(restored.createdAt).toEqual(first.createdAt)
        expect(restored.gsi1sk).toEqual(first.gsi1sk)
        expect(restored.updatedAt.S).not.toBe(first.updatedAt.S)
        expect(restored.gsi2sk.S.toLowerCase()).toContain(
          `updatedat_${restored.updatedAt.S.toLowerCase()}`,
        )
      }),
    )
  }),
]

// ---------------------------------------------------------------------------
// Time-series: an append that creates the row
// ---------------------------------------------------------------------------

class Reading extends Schema.Class<Reading>("Reading")({
  id: Schema.String,
  owner: Schema.String,
  status: Schema.optional(Schema.String),
  at: Schema.Number,
  createdAt: Schema.DateTimeUtc,
}) {}

const readingWorld = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "stamped", version: 1, escapeKeys })
  const Readings = Entity.make({
    model: Reading,
    entityType: "Reading",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    timestamps: true,
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({
        id: Schema.String,
        owner: Schema.String,
        status: Schema.optional(Schema.String),
        at: Schema.Number,
      }),
    },
    indexes: {
      byCreated: { name: "gsi1", pk: half(1, ["owner"]), sk: sortHalf(1, ["createdAt"]) },
      byStatus: { name: "gsi2", pk: half(2, ["owner"]), sk: sortHalf(2, ["status", "createdAt"]) },
    },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Readings } })
  const client = DynamoClient.make({ entities: { Readings }, tables: { MainTable } })
  return { schema, Readings, MainTable, client } as any
}

const currentRow = (rows: ReadonlyArray<StoredRow>, id: string): StoredRow =>
  rows.find((row) => row.id?.S === id && !row.sk.S.includes("#e#"))!

export const appendScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings("an append over `createdAt`: the key holds what the row holds", (h, on) => {
    const w = readingWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        // It creates the row: the key holds what it stamps.
        yield* db.entities.Readings.append({
          id: "a",
          owner: "o",
          status: "s1",
          at: 1,
        }).asEffect()
        const first = currentRow(yield* table.rows(), "a")
        expect(first.gsi1sk.S.toLowerCase()).toContain(
          `createdat_${first.createdAt.S.toLowerCase()}`,
        )
        expect(first.gsi2sk.S.toLowerCase()).toContain(
          `status_s1#createdat_${first.createdAt.S.toLowerCase()}`,
        )
        expect(yield* db.entities.Readings.byCreated({ owner: "o" }).collect()).toHaveLength(1)
        yield* tick
        // A later one keeps it, and moves what else changed.
        yield* db.entities.Readings.append({
          id: "a",
          owner: "o",
          status: "s2",
          at: 2,
        }).asEffect()
        const second = currentRow(yield* table.rows(), "a")
        expect(second.createdAt).toEqual(first.createdAt)
        expect(second.gsi1sk).toEqual(first.gsi1sk)
        expect(second.gsi2sk.S.toLowerCase()).toContain(
          `status_s2#createdat_${first.createdAt.S.toLowerCase()}`,
        )
        // A stale one is still stale.
        const stale = yield* db.entities.Readings.append({ id: "a", owner: "o", at: 1 })
          .asEffect()
          .pipe(Effect.flip)
        expect(stale._tag).toBe("StaleAppend")
      }),
    )
  }),
  ...bothSettings("a put's key survives an append", (h, on) => {
    const w = readingWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Readings.put({ id: "a", owner: "o", at: 1 }).asEffect()
        const put = currentRow(yield* table.rows(), "a")
        expect(put.gsi1sk).toBeDefined()
        yield* tick
        yield* db.entities.Readings.append({ id: "a", owner: "o", at: 2 }).asEffect()
        expect(currentRow(yield* table.rows(), "a").gsi1sk).toEqual(put.gsi1sk)
      }),
    )
  }),
]

// ---------------------------------------------------------------------------
// `version`, where the value is known
// ---------------------------------------------------------------------------

class Revision extends Schema.Class<Revision>("Revision")({
  id: Schema.String,
  owner: Schema.String,
  note: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  version: Schema.Number,
}) {}

const revisionWorld = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "stamped", version: 1, escapeKeys })
  const Revisions = Entity.make({
    model: Revision,
    entityType: "Revision",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    versioned: { retain: true },
    indexes: {
      byVersion: { name: "gsi1", pk: half(1, ["owner"]), sk: sortHalf(1, ["version"]) },
    },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Revisions } })
  const client = DynamoClient.make({ entities: { Revisions }, tables: { MainTable } })
  return { schema, Revisions, MainTable, client } as any
}

const liveRevision = (rows: ReadonlyArray<StoredRow>): StoredRow =>
  rows.find((row) => row.id?.S === "a" && !row.sk.S.includes("#v#"))!

const expectVersionKey = (row: StoredRow): void =>
  expect(Number(/version_0*(\d+)$/.exec(row.gsi1sk.S)?.[1])).toBe(Number(row.version.N))

export const retainScenarios: ReadonlyArray<RepairScenario> = bothSettings(
  "`retain` reads the item on every write, so a key over the version follows it",
  (h, on) => {
    const w = revisionWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Revisions.put({ id: "a", owner: "o" }).asEffect()
        const first = liveRevision(yield* table.rows())
        expect(first.version.N).toBe("1")
        expectVersionKey(first)
        yield* db.entities.Revisions.update({ id: "a" }).set({ note: "n" }).asEffect()
        const updated = liveRevision(yield* table.rows())
        expect(updated.version.N).toBe("2")
        expectVersionKey(updated)
        // A put over it continues the sequence, which it only learns from its read.
        yield* db.entities.Revisions.put({ id: "a", owner: "o" }).asEffect()
        const replaced = liveRevision(yield* table.rows())
        expect(replaced.version.N).toBe("3")
        expectVersionKey(replaced)
        // Path operations take the other update branch, and it has read the item too.
        yield* db.entities.Revisions.update({ id: "a" })
          .pathSet({ segments: ["note"], value: "p", isPath: false })
          .asEffect()
        const pathed = liveRevision(yield* table.rows())
        expect(pathed.version.N).toBe("4")
        expectVersionKey(pathed)
        // Through a transaction, and an upsert.
        yield* Transaction.transactWrite([db.entities.Revisions.put({ id: "a", owner: "o" })])
        expectVersionKey(liveRevision(yield* table.rows()))
        yield* db.entities.Revisions.upsert({ id: "a", owner: "o", note: "u" }).asEffect()
        const upserted = liveRevision(yield* table.rows())
        expect(upserted.version.N).toBe("6")
        expectVersionKey(upserted)
        // Recreated after a delete, it continues above its history.
        yield* db.entities.Revisions.delete({ id: "a" }).asEffect()
        yield* db.entities.Revisions.create({ id: "a", owner: "o" }).asEffect()
        const recreated = liveRevision(yield* table.rows())
        expect(Number(recreated.version.N)).toBeGreaterThan(6)
        expectVersionKey(recreated)
        // A snapshot strips its keys, as ever.
        const snapshots = (yield* table.rows()).filter((row) => row.sk.S.includes("#v#"))
        expect(snapshots.length).toBeGreaterThan(0)
        for (const snapshot of snapshots) {
          expect(snapshot.gsi1pk).toBeUndefined()
          expect(snapshot.gsi1sk).toBeUndefined()
        }
        expect(yield* db.entities.Revisions.byVersion({ owner: "o" }).collect()).toHaveLength(1)
      }),
    )
  },
)

// ---------------------------------------------------------------------------
// Adjacent positions
// ---------------------------------------------------------------------------

const looseWorld = (escapeKeys: boolean, definitions: Record<string, Record<string, unknown>>) => {
  const schema = DynamoSchema.make({ name: "stamped", version: 1, escapeKeys })
  const entities = Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      Entity.make({
        entityType: name,
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
        ...definition,
      } as never),
    ]),
  )
  const MainTable = Table.make({ schema, entities } as never)
  const client = DynamoClient.make({ entities, tables: { MainTable } } as never)
  return { schema, MainTable, client, entities } as any
}

const byOwnerOver = (composite: ReadonlyArray<string>) => ({
  byOwner: { name: "gsi1", pk: half(1, ["owner"]), sk: sortHalf(1, composite) },
})

const OptionalDates = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  note: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.DateTimeUtc),
  updatedAt: Schema.optional(Schema.DateTimeUtc),
})

const typeOf = (rows: ReadonlyArray<StoredRow>, type: string, id = "a"): StoredRow =>
  rows.find((row) => row.__edd_e__?.S === type && row.id?.S === id)!

export const adjacentScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings(
    "an optional date is stamped unless supplied; an optional string isn't",
    (h, on) => {
      const w = looseWorld(on, {
        Created: {
          model: OptionalDates,
          timestamps: true,
          indexes: byOwnerOver(["createdAt"]),
        },
        Updated: {
          model: OptionalDates,
          timestamps: true,
          indexes: byOwnerOver(["updatedAt"]),
        },
        Keyed: {
          model: Schema.Struct({
            id: Schema.String,
            owner: Schema.String,
            createdAt: Schema.optionalKey(Schema.DateTimeUtc),
          }),
          timestamps: true,
          indexes: byOwnerOver(["createdAt"]),
        },
        Text: {
          model: Schema.Struct({
            id: Schema.String,
            owner: Schema.String,
            createdAt: Schema.optional(Schema.String),
          }),
          timestamps: true,
          indexes: byOwnerOver(["createdAt"]),
        },
      })
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.Created.put({ id: "a", owner: "o" }).asEffect()
          yield* db.entities.Created.put({ id: "b", owner: "o", createdAt: supplied }).asEffect()
          yield* db.entities.Updated.put({ id: "a", owner: "o" }).asEffect()
          yield* db.entities.Keyed.put({ id: "a", owner: "o" }).asEffect()
          yield* db.entities.Text.put({ id: "a", owner: "o" }).asEffect()
          yield* db.entities.Text.put({ id: "b", owner: "o", createdAt: "whenever" }).asEffect()
          const rows = yield* table.rows()
          const stamped = typeOf(rows, "Created")
          expect(stamped.createdAt?.S).toBeDefined()
          expect(stamped.gsi1sk.S.toLowerCase()).toContain(stamped.createdAt.S.toLowerCase())
          const given = typeOf(rows, "Created", "b")
          expect(given.createdAt.S).toBe(SUPPLIED)
          expect(given.gsi1sk.S).toContain(SUPPLIED.toLowerCase())
          expect(typeOf(rows, "Updated").gsi1sk.S.toLowerCase()).toContain(
            typeOf(rows, "Updated").updatedAt.S.toLowerCase(),
          )
          expect(typeOf(rows, "Keyed").gsi1sk).toBeDefined()
          // The library can't know a plain string's format: the field stays the caller's.
          expect(typeOf(rows, "Text").createdAt).toBeUndefined()
          expect(typeOf(rows, "Text").gsi1sk).toBeUndefined()
          expect(typeOf(rows, "Text", "b").createdAt.S).toBe("whenever")
          expect(typeOf(rows, "Text", "b").gsi1sk.S).toContain("createdat_whenever")
          // It decodes.
          const read = yield* db.entities.Created.get({ id: "a" })
          expect(DateTime.isDateTime(read.createdAt)).toBe(true)
          // The caller's field, so the caller may name it, and the key follows.
          yield* db.entities.Text.update({ id: "b" }).set({ createdAt: "later" }).asEffect()
          const text = typeOf(yield* table.rows(), "Text", "b")
          expect(text.createdAt.S).toBe("later")
          expect(text.gsi1sk.S).toContain("createdat_later")
        }),
      )
    },
  ),
  ...bothSettings("an epoch-encoded stamp composes the number", (h, on) => {
    const Epoch = Schema.Struct({
      id: Schema.String,
      owner: Schema.String,
      note: Schema.optional(Schema.String),
      createdAt: DynamoModel.DateEpochMs,
      updatedAt: DynamoModel.DateEpochMs,
    })
    const w = looseWorld(on, {
      Created: { model: Epoch, timestamps: true, indexes: byOwnerOver(["createdAt"]) },
      Updated: { model: Epoch, timestamps: true, indexes: byOwnerOver(["updatedAt"]) },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Created.put({ id: "a", owner: "o" }).asEffect()
        yield* db.entities.Updated.put({ id: "a", owner: "o" }).asEffect()
        yield* tick
        yield* db.entities.Updated.update({ id: "a" }).set({ note: "n" }).asEffect()
        const rows = yield* table.rows()
        const created = typeOf(rows, "Created")
        expect(created.createdAt.N).toBeDefined()
        expect(created.gsi1sk.S).toContain(`createdat_${created.createdAt.N.padStart(16, "0")}`)
        const updated = typeOf(rows, "Updated")
        expect(updated.gsi1sk.S).toContain(`updatedat_${updated.updatedAt.N.padStart(16, "0")}`)
      }),
    )
  }),
  ...bothSettings(
    "a renamed timestamp is written under its own attribute, on every path",
    (h, on) => {
      const Renamed = DynamoModel.configure(
        Schema.Struct({
          id: Schema.String,
          owner: Schema.String,
          note: Schema.optional(Schema.String),
          createdAt: Schema.DateTimeUtc,
          updatedAt: Schema.DateTimeUtc,
        }),
        { createdAt: { field: "created_at" }, updatedAt: { field: "updated_at" } },
      )
      const Series = DynamoModel.configure(
        Schema.Struct({
          id: Schema.String,
          owner: Schema.String,
          at: Schema.Number,
          createdAt: Schema.DateTimeUtc,
        }),
        { createdAt: { field: "created_at" } },
      )
      const w = looseWorld(on, {
        Written: { model: Renamed, timestamps: true, indexes: byOwnerOver(["updatedAt"]) },
        Created: { model: Renamed, timestamps: true, indexes: byOwnerOver(["createdAt"]) },
        Appended: {
          model: Series,
          timestamps: true,
          indexes: byOwnerOver(["createdAt"]),
          timeSeries: {
            orderBy: "at",
            appendInput: Schema.Struct({
              id: Schema.String,
              owner: Schema.String,
              at: Schema.Number,
            }),
          },
        },
      })
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.Written.put({ id: "a", owner: "o" }).asEffect()
          yield* tick
          yield* db.entities.Written.update({ id: "a" }).set({ note: "n" }).asEffect()
          yield* db.entities.Written.upsert({ id: "b", owner: "o" }).asEffect()
          yield* db.entities.Created.upsert({ id: "a", owner: "o" }).asEffect()
          yield* db.entities.Appended.append({ id: "a", owner: "o", at: 1 }).asEffect()
          yield* tick
          yield* db.entities.Appended.append({ id: "a", owner: "o", at: 2 }).asEffect()
          const rows = yield* table.rows()
          for (const row of [
            typeOf(rows, "Written"),
            typeOf(rows, "Written", "b"),
            typeOf(rows, "Created"),
          ]) {
            expect(row.updated_at?.S).toBeDefined()
            expect(row.created_at?.S).toBeDefined()
            expect(row.updatedAt).toBeUndefined()
            expect(row.createdAt).toBeUndefined()
          }
          // The value an update stamped is the one a read gets.
          const written = yield* db.entities.Written.get({ id: "a" })
          expect(DateTime.formatIso(written.updatedAt)).toBe(typeOf(rows, "Written").updated_at.S)
          const series = rows.find(
            (row) => row.__edd_e__?.S === "Appended" && !row.sk.S.includes("#e#"),
          )!
          expect(series.createdAt).toBeUndefined()
          expect(series.gsi1sk.S.toLowerCase()).toContain(series.created_at.S.toLowerCase())
        }),
      )
    },
  ),
  ...bothSettings("an upsert moves a key over `updatedAt`, in its one write", (h, on) => {
    const w = looseWorld(on, {
      Upserted: {
        model: Schema.Struct({
          id: Schema.String,
          owner: Schema.String,
          status: Schema.optional(Schema.String),
          updatedAt: Schema.DateTimeUtc,
        }),
        timestamps: true,
        indexes: {
          ...byOwnerOver(["updatedAt"]),
          byStatus: {
            name: "gsi2",
            pk: half(2, ["owner"]),
            sk: sortHalf(2, ["status", "updatedAt"]),
          },
        },
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Upserted.upsert({ id: "a", owner: "o", status: "open" }).asEffect()
        const first = typeOf(yield* table.rows(), "Upserted")
        expect(first.gsi1sk.S.toLowerCase()).toContain(
          `updatedat_${first.updatedAt.S.toLowerCase()}`,
        )
        expect(first.gsi2sk.S.toLowerCase()).toContain(
          `status_open#updatedat_${first.updatedAt.S.toLowerCase()}`,
        )
        yield* tick
        table.clear()
        yield* db.entities.Upserted.upsert({ id: "a", owner: "o" }).asEffect()
        expect(table.requests().map((request) => request.command)).toEqual(["updateItem"])
        const second = typeOf(yield* table.rows(), "Upserted")
        expect(second.updatedAt).not.toEqual(first.updatedAt)
        expect(second.gsi1sk.S.toLowerCase()).toContain(
          `updatedat_${second.updatedAt.S.toLowerCase()}`,
        )
        // No `status` in the input to compose it from, so it stays, as an update leaves it.
        expect(second.status).toEqual(first.status)
        expect(second.gsi2sk).toEqual(first.gsi2sk)
      }),
    )
  }),
  ...bothSettings("a guarded put keeps a renamed `createdAt` in the key", (h, on) => {
    const w = looseWorld(on, {
      Guarded: {
        model: DynamoModel.configure(
          Schema.Struct({
            id: Schema.String,
            owner: Schema.String,
            createdAt: Schema.DateTimeUtc,
          }),
          { createdAt: { field: "created_at" } },
        ),
        timestamps: true,
        versioned: true,
        indexes: byOwnerOver(["createdAt"]),
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Guarded.put({ id: "a", owner: "o" }).asEffect()
        const first = typeOf(yield* table.rows(), "Guarded")
        expect(first.gsi1sk.S.toLowerCase()).toContain(first.created_at.S.toLowerCase())
        yield* tick
        yield* db.entities.Guarded.put({ id: "a", owner: "o" }).asEffect()
        const second = typeOf(yield* table.rows(), "Guarded")
        expect(second.version.N).toBe("2")
        expect(second.created_at).toEqual(first.created_at)
        expect(second.gsi1sk).toEqual(first.gsi1sk)
        yield* tick
        yield* Transaction.transactWrite([db.entities.Guarded.put({ id: "a", owner: "o" })])
        const third = typeOf(yield* table.rows(), "Guarded")
        expect(third.version.N).toBe("3")
        expect(third.created_at).toEqual(first.created_at)
        expect(third.gsi1sk).toEqual(first.gsi1sk)
      }),
    )
  }),
  ...bothSettings("an aggregate's list key holds what its root row holds", (h, on) => {
    const schema = DynamoSchema.make({ name: "stamped", version: 1, escapeKeys: on })
    const Filler = Entity.make({
      model: Schema.Struct({ id: Schema.String, owner: Schema.String }),
      entityType: "Filler",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      indexes: byOwnerOver([]) as never,
    })
    const MainTable = Table.make({ schema, entities: { Filler } })
    const aggregate = (name: string, field: "createdAt" | "updatedAt") => {
      class Root extends Schema.Class<Root>(name)({
        id: Schema.String,
        title: Schema.optional(Schema.String),
        [field]: Schema.DateTimeUtc,
      }) {}
      return Aggregate.make(
        Root as never,
        {
          table: MainTable,
          schema,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: name.toLowerCase() },
          list: {
            index: "gsi1",
            name: `${name.toLowerCase()}s`,
            pk: half(1, []),
            sk: sortHalf(1, [field]),
          },
          root: { entityType: name },
          edges: {},
          timestamps: true,
        } as never,
      ) as any
    }
    const Created = aggregate("Created", "createdAt")
    const Updated = aggregate("Updated", "updatedAt")
    const client = DynamoClient.make({
      entities: { Filler },
      aggregates: { Created, Updated },
      tables: { MainTable },
    } as never) as any
    const stamp = (row: StoredRow, attribute: string) => row[attribute].S.toLowerCase()
    return h.on({ MainTable }, (table) =>
      Effect.gen(function* () {
        const db = yield* client
        // `create` stamps over a value the input holds, as up to 1.39.0, in the row and the key.
        yield* db.aggregates.Created.create({ id: "b", createdAt: supplied })
        const given = typeOf(yield* table.rows(), "Created", "b")
        expect(given.createdAt.S).not.toBe(SUPPLIED)
        expect(given.gsi1sk.S).toContain(stamp(given, "createdAt"))
        // Without one the key follows the stamp too.
        yield* db.aggregates.Created.create({ id: "a" })
        yield* db.aggregates.Updated.create({ id: "a" })
        const created = typeOf(yield* table.rows(), "Created")
        const updated = typeOf(yield* table.rows(), "Updated")
        expect(created.createdAt.S).not.toBe(SUPPLIED)
        expect(created.gsi1sk.S).toContain(stamp(created, "createdAt"))
        expect(updated.gsi1sk.S).toContain(stamp(updated, "updatedAt"))
        expect((yield* db.aggregates.Created.list({})).data).toHaveLength(2)
        yield* tick
        // An update keeps `createdAt` and stamps `updatedAt`, and the keys say the same.
        yield* db.aggregates.Created.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          title: "t",
        }))
        yield* db.aggregates.Updated.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          title: "t",
        }))
        const created2 = typeOf(yield* table.rows(), "Created")
        const updated2 = typeOf(yield* table.rows(), "Updated")
        expect(created2.createdAt).toEqual(created.createdAt)
        expect(created2.gsi1sk).toEqual(created.gsi1sk)
        expect(updated2.updatedAt).not.toEqual(updated.updatedAt)
        expect(updated2.gsi1sk.S).toContain(stamp(updated2, "updatedAt"))
      }),
    )
  }),
  ...bothSettings("an upsert never gives a key a value it didn't store", (h, on) => {
    const w = looseWorld(on, {
      Located: {
        model: DynamoModel.configure(
          Schema.Struct({
            id: Schema.String,
            owner: Schema.String,
            region: Schema.String,
          }),
          { region: { immutable: true } },
        ),
        indexes: byOwnerOver(["region"]),
      },
      Keyed: {
        model: DynamoModel.configure(Schema.Struct({ id: Schema.String, owner: Schema.String }), {
          id: { immutable: true },
        }),
        indexes: byOwnerOver(["id"]),
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Located.upsert({ id: "a", owner: "o", region: "r1" }).asEffect()
        yield* db.entities.Located.upsert({ id: "a", owner: "o", region: "r2" }).asEffect()
        const row = typeOf(yield* table.rows(), "Located")
        expect(row.region.S).toBe("r1")
        expect(row.gsi1sk.S).toContain("region_r1")
        // In the primary key too, it can't differ, so there's nothing to read.
        table.clear()
        yield* db.entities.Keyed.upsert({ id: "a", owner: "o" }).asEffect()
        yield* db.entities.Keyed.upsert({ id: "a", owner: "p" }).asEffect()
        expect(table.requests().map((request) => request.command)).toEqual([
          "updateItem",
          "updateItem",
        ])
      }),
    )
  }),
  ...bothSettings("a primary key over `createdAt` is composed from the stamp", (h, on) => {
    const Created = Schema.Struct({
      id: Schema.String,
      owner: Schema.String,
      createdAt: Schema.DateTimeUtc,
    })
    const w = looseWorld(on, {
      Sorted: {
        model: Created,
        timestamps: true,
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: ["createdAt"] },
        },
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const put = yield* db.entities.Sorted.put({ id: "a", owner: "o" }).asEffect()
        const row = typeOf(yield* table.rows(), "Sorted")
        expect(row.sk.S.toLowerCase()).toContain(row.createdAt.S.toLowerCase())
        const got = yield* db.entities.Sorted.get({ id: "a", createdAt: put.createdAt })
        expect(got.owner).toBe("o")
        // With nothing to name an existing item by, an upsert is a create.
        yield* tick
        const upserted = yield* db.entities.Sorted.upsert({ id: "a", owner: "o" }).asEffect()
        expect(DateTime.formatIso(upserted.createdAt)).not.toBe(DateTime.formatIso(put.createdAt))
        expect((yield* table.rows()).filter((candidate) => candidate.id?.S === "a")).toHaveLength(2)
      }),
    )
  }),
]

// ---------------------------------------------------------------------------
// An upsert over a value it keeps: `createdAt` and immutable fields (`DESIGN.md §7`)
// ---------------------------------------------------------------------------

const LocatedFields = {
  id: Schema.String,
  owner: Schema.String,
  region: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  price: Schema.optional(Schema.Number),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
}
const Located = DynamoModel.configure(Schema.Struct(LocatedFields), {
  region: { immutable: true },
})

const located = (composite: ReadonlyArray<string>, extra: Record<string, unknown> = {}) => ({
  model: Located,
  timestamps: true,
  indexes: byOwnerOver(composite),
  ...extra,
})

/** One entity per shape, the name saying what its one index's sort key holds. */
const SHAPES = {
  Plain: ["status"],
  Immutable: ["region"],
  WithId: ["id", "region"],
  Mixed: ["region", "status"],
  MixedStamp: ["region", "updatedAt"],
  Created: ["createdAt"],
  CreatedMixed: ["status", "createdAt"],
  Updated: ["updatedAt"],
} as const

const shapeWorld = (escapeKeys: boolean) =>
  looseWorld(
    escapeKeys,
    Object.fromEntries(
      Object.entries(SHAPES).map(([name, composite]) => [name, located(composite)]),
    ),
  )

/** The key of the row of `name` is the one a `put` of the row's values writes. */
const expectShapeKeys = (w: any, table: RepairTable, name: string) =>
  Effect.map(table.rows(), (rows) => {
    const row = typeOf(rows, name)
    expectKeysOfValues(w, row, w.entities[name], name)
    return row
  })

const withoutKeys = (row: StoredRow, ...drop: ReadonlyArray<string>): StoredRow =>
  Object.fromEntries(Object.entries(row).filter(([attribute]) => !drop.includes(attribute)))

export const upsertScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings("a second write fills what the row lacks from the input first", (h, on) => {
    const w = shapeWorld(on)
    const given = DateTime.makeUnsafe("2020-02-03T04:05:06.000Z")
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const input = { id: "a", owner: "o", region: "r1", status: "s1" }
        yield* db.entities.Mixed.upsert(input).asEffect()
        const row = typeOf(yield* table.rows(), "Mixed")
        yield* table.seed(withoutKeys(row, "createdAt"))
        table.clear()
        // Rejected over `region`, so the op composes from the row, which holds no `createdAt`.
        yield* db.entities.Mixed.upsert({ ...input, region: "r2", createdAt: given }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        const written = typeOf(yield* table.rows(), "Mixed")
        expect(written.region.S).toBe("r1")
        expect(written.createdAt.S).toBe("2020-02-03T04:05:06.000Z")
      }),
    )
  }),
  ...bothSettings(
    "an immutable primary composite is no value to keep: the key's just written",
    (h, on) => {
      const Fixed = DynamoModel.configure(
        Schema.Struct({
          id: Schema.String,
          owner: Schema.String,
          status: Schema.optional(Schema.String),
        }),
        { id: { immutable: true } },
      )
      const w = looseWorld(on, {
        Alone: { model: Fixed, indexes: byOwnerOver(["id"]) },
        Beside: { model: Fixed, indexes: byOwnerOver(["id", "status"]) },
      })
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          for (const name of ["Alone", "Beside"]) {
            table.clear()
            yield* db.entities[name].upsert({ id: "a", owner: "o", status: "s1" }).asEffect()
            expect(commands(table), name).toEqual(["updateItem"])
            const input = table.requests()[0]!.input as any
            expect(input.ConditionExpression, name).toBeUndefined()
            expect(input.UpdateExpression, name).not.toContain("if_not_exists(#gsi")
            // A row with no key gets one, at no second write: its primary key has the value.
            const row = typeOf(yield* table.rows(), name)
            yield* table.seed(withoutKeys(row, "gsi1pk", "gsi1sk"))
            table.clear()
            yield* db.entities[name].upsert({ id: "a", owner: "o", status: "s1" }).asEffect()
            expect(commands(table), name).toEqual(["updateItem"])
            expectKeysOfValues(w, typeOf(yield* table.rows(), name), w.entities[name], name)
          }
        }),
      )
    },
  ),
  ...bothSettings("every shape: one write, no read, and the key its values compose", (h, on) => {
    const w = shapeWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        for (const name of Object.keys(SHAPES)) {
          const upsert = (input: Record<string, unknown>) =>
            db.entities[name].upsert({ id: "a", owner: "o", ...input }).asEffect()
          const oneWrite = (input: Record<string, unknown>) =>
            Effect.gen(function* () {
              table.clear()
              yield* tick
              yield* upsert(input)
              expect(commands(table), `${name} ${JSON.stringify(input)}`).toEqual(["updateItem"])
              return yield* expectShapeKeys(w, table, name)
            })
          const created = yield* oneWrite({ region: "r1", status: "s1" })
          const again = yield* oneWrite({ region: "r1", status: "s1" })
          expect(again.createdAt).toEqual(created.createdAt)
          expect(again.region).toEqual(created.region)
        }
      }),
    )
  }),
  ...bothSettings("a changed value: the key moves, in one write where it can", (h, on) => {
    const w = shapeWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        // `CreatedMixed` can't write the key without the stored `createdAt`: the write stands only
        // if the status didn't change, and its rejection returns the row, at no read.
        const writes = { CreatedMixed: ["updateItem", "updateItem"] } as Record<
          string,
          ReadonlyArray<string>
        >
        for (const name of Object.keys(SHAPES)) {
          yield* db.entities[name]
            .upsert({ id: "a", owner: "o", region: "r1", status: "s1" })
            .asEffect()
          const before = typeOf(yield* table.rows(), name)
          yield* tick
          table.clear()
          const returned = yield* db.entities[name]
            .upsert({ id: "a", owner: "o", region: "r1", status: "s2" })
            .asEffect()
          expect(commands(table), name).toEqual(writes[name] ?? ["updateItem"])
          const row = yield* expectShapeKeys(w, table, name)
          expect(row.status.S).toBe("s2")
          expect(row.createdAt).toEqual(before.createdAt)
          // What it returns is what it stored.
          expect(returned.status).toBe("s2")
          expect(DateTime.formatIso(returned.createdAt)).toBe(row.createdAt.S)
        }
      }),
    )
  }),
  ...bothSettings(
    "an immutable field the input contradicts stays, in the row and the key",
    (h, on) => {
      const w = shapeWorld(on)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          // The key is written from the input where it holds something else that changes, so the
          // write stands only over the region it names.
          const writes = {
            Mixed: ["updateItem", "updateItem"],
            MixedStamp: ["updateItem", "updateItem"],
          } as Record<string, ReadonlyArray<string>>
          for (const name of Object.keys(SHAPES)) {
            yield* db.entities[name]
              .upsert({ id: "a", owner: "o", region: "r1", status: "s1" })
              .asEffect()
            yield* tick
            table.clear()
            const returned = yield* db.entities[name]
              .upsert({ id: "a", owner: "o", region: "r2", status: "s1" })
              .asEffect()
            expect(commands(table), name).toEqual(writes[name] ?? ["updateItem"])
            const row = yield* expectShapeKeys(w, table, name)
            expect(row.region.S, name).toBe("r1")
            expect(returned.region, name).toBe("r1")
            // It takes the second write once only.
            table.clear()
            yield* db.entities[name]
              .upsert({ id: "a", owner: "o", region: "r1", status: "s1" })
              .asEffect()
            expect(commands(table), name).toEqual(["updateItem"])
          }
        }),
      )
    },
  ),
  ...bothSettings("a supplied `createdAt`: the write stands over the one it names", (h, on) => {
    const w = shapeWorld(on)
    const other = DateTime.makeUnsafe("2021-02-03T04:05:06.000Z")
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const mixed = db.entities.CreatedMixed
        const key = { id: "a", owner: "o" }
        yield* mixed.upsert({ ...key, status: "s1", createdAt: supplied }).asEffect()
        const created = yield* expectShapeKeys(w, table, "CreatedMixed")
        expect(created.createdAt.S).toBe(SUPPLIED)
        // Naming the stored one, a new status is one write: the input has every value.
        table.clear()
        yield* mixed.upsert({ ...key, status: "s2", createdAt: supplied }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        expect((yield* expectShapeKeys(w, table, "CreatedMixed")).status.S).toBe("s2")
        // Naming another, the stored one is kept, and so is the status it names.
        table.clear()
        yield* mixed.upsert({ ...key, status: "s3", createdAt: other }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        const third = yield* expectShapeKeys(w, table, "CreatedMixed")
        expect(third.createdAt.S).toBe(SUPPLIED)
        expect(third.status.S).toBe("s3")
        // A key of `createdAt` alone stays, whatever's named.
        yield* db.entities.Created.upsert({ ...key, createdAt: supplied }).asEffect()
        table.clear()
        yield* db.entities.Created.upsert({ ...key, createdAt: other }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        expect((yield* expectShapeKeys(w, table, "Created")).createdAt.S).toBe(SUPPLIED)
      }),
    )
  }),
  ...bothSettings("a row without the key gets one from its own values, once", (h, on) => {
    const w = shapeWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        for (const name of ["Immutable", "WithId", "Created", "CreatedMixed"]) {
          const input = { id: "a", owner: "o", region: "r1", status: "s1" }
          yield* db.entities[name].upsert(input).asEffect()
          const whole = typeOf(yield* table.rows(), name)
          yield* table.seed(withoutKeys(whole, "gsi1pk", "gsi1sk"))
          yield* tick
          table.clear()
          yield* db.entities[name].upsert(input).asEffect()
          expect(commands(table), name).toEqual(["updateItem", "updateItem"])
          const healed = yield* expectShapeKeys(w, table, name)
          expect(healed.createdAt).toEqual(whole.createdAt)
          expect(healed.gsi1sk).toEqual(whole.gsi1sk)
          table.clear()
          yield* db.entities[name].upsert(input).asEffect()
          expect(commands(table), name).toEqual(["updateItem"])
        }
      }),
    )
  }),
  ...bothSettings("a row without the value takes the input's, or a stamp", (h, on) => {
    const w = shapeWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const input = { id: "a", owner: "o", region: "r1", status: "s1" }
        const seeded = (name: string, ...drop: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            yield* db.entities[name].upsert(input).asEffect()
            yield* table.seed(withoutKeys(typeOf(yield* table.rows(), name), ...drop))
            table.clear()
          })
        // Nothing stored to contradict it: one write.
        yield* seeded("Mixed", "region")
        yield* db.entities.Mixed.upsert({ ...input, region: "r2" }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        expect((yield* expectShapeKeys(w, table, "Mixed")).region.S).toBe("r2")
        // No key to keep: composed from what the row would have held.
        yield* seeded("Immutable", "region", "gsi1pk", "gsi1sk")
        yield* db.entities.Immutable.upsert({ ...input, region: "r2" }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        expect((yield* expectShapeKeys(w, table, "Immutable")).region.S).toBe("r2")
        // No `createdAt`, and so no key: it's stamped, and the key holds the stamp.
        yield* seeded("CreatedMixed", "createdAt", "gsi1pk", "gsi1sk")
        yield* db.entities.CreatedMixed.upsert(input).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        const stamped = yield* expectShapeKeys(w, table, "CreatedMixed")
        expect(stamped.createdAt.S).toBeDefined()
        // Supplied, it's that.
        yield* seeded("Created", "createdAt")
        yield* db.entities.Created.upsert({ ...input, createdAt: supplied }).asEffect()
        const named = typeOf(yield* table.rows(), "Created")
        expect(named.createdAt.S).toBe(SUPPLIED)
      }),
    )
  }),
  ...bothSettings("the caller's condition decides, whichever write it reaches", (h, on) => {
    const w = shapeWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const entity = db.entities.CreatedMixed
        const input = { id: "a", owner: "o", status: "s1" }
        // A new row it rejects stays unwritten: no row came back, so there's nothing to retry with.
        table.clear()
        const unwritten = yield* entity
          .upsert(input)
          .condition({ owner: "nobody" })
          .asEffect()
          .pipe(Effect.flip)
        expect(unwritten._tag).toBe("ConditionalCheckFailed")
        expect(commands(table)).toEqual(["updateItem"])
        expect(typeOf(yield* table.rows(), "CreatedMixed")).toBeUndefined()
        yield* entity.upsert(input).asEffect()
        const before = typeOf(yield* table.rows(), "CreatedMixed")
        for (const status of ["s1", "s2"]) {
          const refused = yield* entity
            .upsert({ ...input, status })
            .condition({ owner: "nobody" })
            .asEffect()
            .pipe(Effect.flip)
          expect(refused._tag, status).toBe("ConditionalCheckFailed")
          expect(typeOf(yield* table.rows(), "CreatedMixed"), status).toEqual(before)
        }
        table.clear()
        yield* entity
          .upsert({ ...input, status: "s2" })
          .condition({ owner: "o" })
          .asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        expect((yield* expectShapeKeys(w, table, "CreatedMixed")).status.S).toBe("s2")
      }),
    )
  }),
  ...bothSettings("a versioned entity counts the write, not the rejection", (h, on) => {
    const w = looseWorld(on, {
      Counted: located(["status", "createdAt"], { versioned: true }),
      CountedMixed: located(["region", "status"], { versioned: true }),
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const input = { id: "a", owner: "o", region: "r1", status: "s1" }
        for (const name of ["Counted", "CountedMixed"]) {
          yield* db.entities[name].upsert(input).asEffect()
          expect(typeOf(yield* table.rows(), name).version.N, name).toBe("1")
          yield* db.entities[name].upsert(input).asEffect()
          expect(typeOf(yield* table.rows(), name).version.N, name).toBe("2")
        }
        table.clear()
        yield* db.entities.Counted.upsert({ ...input, status: "s2" }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        const counted = typeOf(yield* table.rows(), "Counted")
        expect(counted.version.N).toBe("3")
        expect(counted.gsi1sk.S).toContain("status_s2")
        table.clear()
        yield* db.entities.CountedMixed.upsert({ ...input, region: "r2" }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        const mixed = typeOf(yield* table.rows(), "CountedMixed")
        expect(mixed.version.N).toBe("3")
        expect(mixed.region.S).toBe("r1")
        expect(mixed.gsi1sk.S).toContain("region_r1")
      }),
    )
  }),
  ...bothSettings("an upsert that reads for another reason composes the same keys", (h, on) => {
    const unique = { unique: { owner: ["owner"] } }
    const w = looseWorld(on, {
      UniqueMixed: located(["region", "status"], unique),
      UniqueStamp: located(["region", "updatedAt"], unique),
      UniqueCreated: located(["status", "createdAt"], unique),
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        for (const name of ["UniqueMixed", "UniqueStamp", "UniqueCreated"]) {
          const input = { id: "a", owner: `o-${name}`, region: "r1", status: "s1" }
          yield* db.entities[name].upsert(input).asEffect()
          const created = yield* expectShapeKeys(w, table, name)
          yield* tick
          yield* db.entities[name].upsert({ ...input, status: "s2", region: "r2" }).asEffect()
          const row = yield* expectShapeKeys(w, table, name)
          expect(row.region.S, name).toBe("r1")
          expect(row.status.S, name).toBe("s2")
          expect(row.createdAt, name).toEqual(created.createdAt)
        }
      }),
    )
  }),
  ...bothSettings("each half of a key is judged on its own", (h, on) => {
    const w = looseWorld(on, {
      // The sort key can stay while the partition key moves.
      Split: located([], {
        indexes: {
          byStatus: { name: "gsi1", pk: half(1, ["status"]), sk: sortHalf(1, ["createdAt"]) },
        },
      }),
      // Two keys can't stay: either's change takes the second write.
      Twice: located([], {
        indexes: {
          byStatus: {
            name: "gsi1",
            pk: half(1, ["owner"]),
            sk: sortHalf(1, ["status", "createdAt"]),
          },
          byNote: { name: "gsi2", pk: half(2, ["owner"]), sk: sortHalf(2, ["note", "createdAt"]) },
        },
      }),
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Split.upsert({ id: "a", owner: "o", status: "s1" }).asEffect()
        table.clear()
        yield* db.entities.Split.upsert({ id: "a", owner: "o", status: "s2" }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        const split = yield* expectShapeKeys(w, table, "Split")
        expect(split.gsi1pk.S).toContain("s2")
        const input = { id: "a", owner: "o", status: "s1", note: "n1" }
        yield* db.entities.Twice.upsert(input).asEffect()
        for (const next of [{ note: "n2" }, { status: "s2" }]) {
          table.clear()
          yield* db.entities.Twice.upsert({ ...input, ...next }).asEffect()
          expect(commands(table)).toEqual(["updateItem", "updateItem"])
          yield* expectShapeKeys(w, table, "Twice")
        }
      }),
    )
  }),
  ...bothSettings("a shard source or a Z-order half follows the same rule", (h, on) => {
    const indexed = (name: string, index: Record<string, unknown>) =>
      located([], { indexes: { byOwner: { name, ...index } } })
    const pk = half(1, ["owner"])
    const w = looseWorld(on, {
      ShardKept: indexed("gsi1", {
        pk: half(1, []),
        sk: sortHalf(1, ["region"]),
        shards: { count: 4, by: ["region"] },
      }),
      ShardMixed: indexed("gsi1", {
        pk,
        sk: sortHalf(1, ["region"]),
        shards: { count: 4, by: ["region"] },
      }),
      Prefixed: indexed("gsi2", {
        pk: half(2, ["owner"]),
        sk: {
          field: "gsi2sk",
          prefix: ["region"],
          zorder: [{ field: "price", min: 0, max: 1000 }],
        },
      }),
      Dimension: indexed("gsi2", {
        pk: half(2, ["owner"]),
        sk: {
          field: "gsi2sk",
          zorder: [
            { field: "price", min: 0, max: 1000 },
            { field: "createdAt", from: "2024-01-01", unit: "seconds", bits: 32 },
          ],
        },
      }),
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const input = { id: "a", owner: "o", region: "r1", price: 10 }
        const writes = (name: string, next: Record<string, unknown>, sent: number) =>
          Effect.gen(function* () {
            table.clear()
            yield* db.entities[name].upsert({ ...input, ...next }).asEffect()
            expect(commands(table), name).toEqual(Array(sent).fill("updateItem"))
            const row = yield* expectShapeKeys(w, table, name)
            expect(row.region.S, name).toBe("r1")
            return row
          })
        for (const name of ["ShardKept", "ShardMixed", "Prefixed", "Dimension"]) {
          yield* writes(name, {}, 1)
          yield* writes(name, {}, 1)
        }
        // The whole half is kept: nothing to contradict.
        yield* writes("ShardKept", { region: "r2" }, 1)
        // Written from the input: the write stands only over the region it names.
        yield* writes("ShardMixed", { region: "r2" }, 2)
        yield* writes("Prefixed", { region: "r2" }, 2)
        // A new price is in the input: one write. In a half with the unknown `createdAt`, two.
        yield* writes("Prefixed", { price: 20 }, 1)
        yield* writes("Dimension", { price: 20 }, 2)
        yield* writes("Dimension", { price: 20 }, 1)
      }),
    )
  }),
  ...bothSettings("renamed attributes are guarded under the names they're stored as", (h, on) => {
    const Renamed = DynamoModel.configure(Schema.Struct(LocatedFields), {
      region: { immutable: true, field: "reg" },
      status: { field: "st" },
      createdAt: { field: "created_at" },
    })
    const w = looseWorld(on, {
      RenamedMixed: { ...located(["status", "createdAt"]), model: Renamed },
      RenamedRegion: { ...located(["region", "status"]), model: Renamed },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const input = { id: "a", owner: "o", region: "r1", status: "s1" }
        const entity = db.entities.RenamedMixed
        yield* entity.upsert(input).asEffect()
        const first = typeOf(yield* table.rows(), "RenamedMixed")
        expect(first.created_at.S).toBeDefined()
        table.clear()
        yield* entity.upsert(input).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        table.clear()
        yield* tick
        const returned = yield* entity.upsert({ ...input, status: "s2" }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        const moved = typeOf(yield* table.rows(), "RenamedMixed")
        expect(moved.st.S).toBe("s2")
        expect(moved.created_at).toEqual(first.created_at)
        expect(moved.status).toBeUndefined()
        expect(moved.createdAt).toBeUndefined()
        expect(moved.gsi1sk.S.toLowerCase()).toContain(
          `status_s2#createdat_${first.created_at.S.toLowerCase()}`,
        )
        expect(DateTime.formatIso(returned.createdAt)).toBe(first.created_at.S)
        const region = db.entities.RenamedRegion
        yield* region.upsert(input).asEffect()
        table.clear()
        yield* region.upsert({ ...input, region: "r2" }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        const kept = typeOf(yield* table.rows(), "RenamedRegion")
        expect(kept.reg.S).toBe("r1")
        expect(kept.gsi1sk.S).toContain("region_r1")
      }),
    )
  }),
  ...bothSettings("a row deleted between the rejection and the write is created", (h, on) => {
    const w = shapeWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const input = { id: "a", owner: "o", status: "s1" }
        const entity = db.entities.CreatedMixed
        yield* entity.upsert(input).asEffect()
        const before = typeOf(yield* table.rows(), "CreatedMixed")
        yield* tick
        let sent = 0
        table.beforeUpdate(() =>
          Effect.suspend(() => (++sent === 2 ? table.remove(before) : Effect.void)),
        )
        table.clear()
        yield* entity.upsert({ ...input, status: "s2" }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem", "getItem", "putItem"])
        const row = yield* expectShapeKeys(w, table, "CreatedMixed")
        expect(row.status.S).toBe("s2")
        expect(row.createdAt).not.toEqual(before.createdAt)
      }),
    )
  }),
  ...bothSettings("nothing to keep: no condition, as before", (h, on) => {
    // A `createdAt` the model owns as a string is the caller's.
    const Owned = Schema.Struct({
      id: Schema.String,
      owner: Schema.String,
      status: Schema.optional(Schema.String),
      createdAt: Schema.String,
    })
    const w = looseWorld(on, {
      Plain: located(["status"]),
      Owned: { model: Owned, timestamps: true, indexes: byOwnerOver(["status", "createdAt"]) },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        table.clear()
        yield* db.entities.Plain.upsert({ id: "a", owner: "o", status: "s1" }).asEffect()
        yield* db.entities.Owned.upsert({
          id: "a",
          owner: "o",
          status: "s1",
          createdAt: "2020",
        }).asEffect()
        yield* db.entities.Owned.upsert({
          id: "a",
          owner: "o",
          status: "s2",
          createdAt: "2021",
        }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem", "updateItem"])
        for (const request of table.requests()) {
          expect(request.input.ConditionExpression).toBeUndefined()
          expect(request.input.ReturnValuesOnConditionCheckFailure).toBeUndefined()
        }
        const owned = typeOf(yield* table.rows(), "Owned")
        expect(owned.createdAt.S).toBe("2021")
        expect(owned.gsi1sk.S).toContain("status_s2#createdat_2021")
      }),
    )
  }),
]

// ---------------------------------------------------------------------------
// An append over `createdAt`: requests
// ---------------------------------------------------------------------------

export const appendRequestScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings(
    "a primary composite beside `createdAt` needs no guard: it can't differ",
    (h, on) => {
      const Series = Schema.Struct({
        id: Schema.String,
        owner: Schema.String,
        at: Schema.Number,
        createdAt: Schema.DateTimeUtc,
      })
      const w = looseWorld(on, {
        Series: {
          model: Series,
          timestamps: true,
          indexes: byOwnerOver(["id", "createdAt"]),
          timeSeries: {
            orderBy: "at",
            appendInput: Schema.Struct({
              id: Schema.String,
              owner: Schema.String,
              at: Schema.Number,
            }),
          },
        },
      })
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          const append = (at: number) =>
            db.entities.Series.append({ id: "a", owner: "o", at }).asEffect()
          yield* append(1)
          table.clear()
          yield* append(2)
          // The rows' own attribute `id` isn't named by the condition.
          const items = (table.requests()[0]!.input as any).TransactItems
          const update = items.find((item: any) => item.Update !== undefined).Update
          expect(Object.values(update.ExpressionAttributeNames)).toContain("gsi1sk")
          expect(update.ConditionExpression).not.toContain("#_tsk")
          expect(commands(table)).toEqual(["transactWriteItems", "getItem"])
        }),
      )
    },
  ),
  ...bothSettings("no read before the write, on any shape", (h, on) => {
    const w = readingWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const appended = (at: number, status: string) =>
          Effect.gen(function* () {
            table.clear()
            yield* tick
            return yield* db.entities.Readings.append({
              id: "a",
              owner: "o",
              status,
              at,
            }).asEffect()
          })
        yield* appended(1, "s1")
        expect(commands(table)).toEqual(["transactWriteItems", "getItem"])
        const first = currentRow(yield* table.rows(), "a")
        yield* appended(2, "s1")
        expect(commands(table)).toEqual(["transactWriteItems", "getItem"])
        expect(currentRow(yield* table.rows(), "a").gsi2sk).toEqual(first.gsi2sk)
        // The rejection returns the row the key is composed from.
        const moved = yield* appended(3, "s2")
        expect(commands(table)).toEqual(["transactWriteItems", "transactWriteItems", "getItem"])
        const row = currentRow(yield* table.rows(), "a")
        expect(row.createdAt).toEqual(first.createdAt)
        expect(row.status.S).toBe("s2")
        expect(row.gsi1sk).toEqual(first.gsi1sk)
        expect(row.gsi2sk.S.toLowerCase()).toContain(
          `status_s2#createdat_${first.createdAt.S.toLowerCase()}`,
        )
        expect(moved.current.status).toBe("s2")
        expect((yield* table.rows()).filter((r) => r.sk.S.includes("#e#"))).toHaveLength(3)
      }),
    )
  }),
  ...bothSettings("`skipFollowUp` means no read at all", (h, on) => {
    const w = readingWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const appended = (at: number, status: string) =>
          db.entities.Readings.append({ id: "a", owner: "o", status, at }).skipFollowUp().asEffect()
        table.clear()
        yield* appended(1, "s1")
        yield* appended(2, "s1")
        expect(commands(table)).toEqual(["transactWriteItems", "transactWriteItems"])
        table.clear()
        yield* appended(3, "s2")
        expect(commands(table)).toEqual(["transactWriteItems", "transactWriteItems"])
        expect(currentRow(yield* table.rows(), "a").gsi2sk.S).toContain("status_s2")
        table.clear()
        const stale = yield* appended(1, "s2").pipe(Effect.flip)
        expect(stale._tag).toBe("StaleAppend")
        expect(Option.isNone(stale.current)).toBe(true)
        expect(commands(table)).toEqual(["transactWriteItems"])
      }),
    )
  }),
  ...bothSettings("a stale append is stale, without a read, whatever else differs", (h, on) => {
    const w = readingWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Readings.append({ id: "a", owner: "o", status: "s1", at: 5 }).asEffect()
        const before = yield* table.rows()
        for (const status of ["s1", "s2"]) {
          table.clear()
          const stale = yield* db.entities.Readings.append({ id: "a", owner: "o", status, at: 2 })
            .asEffect()
            .pipe(Effect.flip)
          expect(stale._tag, status).toBe("StaleAppend")
          expect((Option.getOrThrow(stale.current) as any).at, status).toBe(5)
          expect(commands(table), status).toEqual(["transactWriteItems"])
          expect(yield* table.rows(), status).toEqual(before)
        }
      }),
    )
  }),
  ...bothSettings("the caller's condition decides, over the key's own guard", (h, on) => {
    const w = readingWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.Readings.append({ id: "a", owner: "o", status: "s1", at: 1 }).asEffect()
        const before = yield* table.rows()
        for (const [status, sent] of [
          // Only the condition rejected it: the row it returned says so.
          ["s1", ["transactWriteItems"]],
          // The key's guard did too: composed from the row, and rejected again.
          ["s2", ["transactWriteItems", "transactWriteItems", "getItem"]],
        ] as const) {
          table.clear()
          const refused = yield* db.entities.Readings.append({
            id: "a",
            owner: "o",
            status,
            at: 2,
          })
            .condition({ owner: "nobody" })
            .asEffect()
            .pipe(Effect.flip)
          expect(refused._tag, status).toBe("ConditionalCheckFailed")
          expect(commands(table), status).toEqual(sent)
          expect(yield* table.rows(), status).toEqual(before)
        }
        table.clear()
        yield* db.entities.Readings.append({ id: "a", owner: "o", status: "s2", at: 2 })
          .condition({ owner: "o" })
          .asEffect()
        expect(currentRow(yield* table.rows(), "a").gsi2sk.S).toContain("status_s2")
      }),
    )
  }),
  ...bothSettings("a row without the keys gets them, once", (h, on) => {
    const w = readingWorld(on)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const appended = (at: number) =>
          db.entities.Readings.append({ id: "a", owner: "o", status: "s1", at }).asEffect()
        yield* appended(1)
        const whole = currentRow(yield* table.rows(), "a")
        yield* table.seed(withoutKeys(whole, "gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk"))
        yield* tick
        table.clear()
        yield* appended(2)
        expect(commands(table)).toEqual(["transactWriteItems", "transactWriteItems", "getItem"])
        const healed = currentRow(yield* table.rows(), "a")
        expect(healed.gsi1sk).toEqual(whole.gsi1sk)
        expect(healed.gsi2sk).toEqual(whole.gsi2sk)
        table.clear()
        yield* appended(3)
        expect(commands(table)).toEqual(["transactWriteItems", "getItem"])
      }),
    )
  }),
  ...bothSettings("an `orderBy` that's a date compares the same way", (h, on) => {
    const Dated = Schema.Struct({
      id: Schema.String,
      owner: Schema.String,
      status: Schema.optional(Schema.String),
      at: Schema.DateTimeUtc,
      createdAt: Schema.DateTimeUtc,
    })
    const w = looseWorld(on, {
      Dated: {
        model: Dated,
        timestamps: true,
        indexes: byOwnerOver(["status", "createdAt"]),
        timeSeries: {
          orderBy: "at",
          appendInput: Schema.Struct({
            id: Schema.String,
            owner: Schema.String,
            status: Schema.optional(Schema.String),
            at: Schema.DateTimeUtc,
          }),
        },
      },
    })
    const at = (seconds: number) =>
      DateTime.makeUnsafe(`2024-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const append = (seconds: number, status: string) =>
          db.entities.Dated.append({ id: "a", owner: "o", status, at: at(seconds) }).asEffect()
        yield* append(10, "s1")
        const first = currentRow(yield* table.rows(), "a")
        yield* append(20, "s2")
        const second = currentRow(yield* table.rows(), "a")
        expect(second.gsi1sk.S.toLowerCase()).toContain(
          `status_s2#createdat_${first.createdAt.S.toLowerCase()}`,
        )
        const stale = yield* append(15, "s3").pipe(Effect.flip)
        expect(stale._tag).toBe("StaleAppend")
        expect(currentRow(yield* table.rows(), "a")).toEqual(second)
      }),
    )
  }),
  ...bothSettings("a renamed composite is guarded under its stored name", (h, on) => {
    const Renamed = DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        owner: Schema.String,
        status: Schema.optional(Schema.String),
        at: Schema.Number,
        createdAt: Schema.DateTimeUtc,
      }),
      { status: { field: "st" }, createdAt: { field: "created_at" } },
    )
    const w = looseWorld(on, {
      Renamed: {
        model: Renamed,
        timestamps: true,
        indexes: byOwnerOver(["status", "createdAt"]),
        timeSeries: {
          orderBy: "at",
          appendInput: Schema.Struct({
            id: Schema.String,
            owner: Schema.String,
            status: Schema.optional(Schema.String),
            at: Schema.Number,
          }),
        },
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const append = (at: number, status: string) =>
          db.entities.Renamed.append({ id: "a", owner: "o", status, at }).asEffect()
        yield* append(1, "s1")
        table.clear()
        yield* append(2, "s1")
        expect(commands(table)).toEqual(["transactWriteItems", "getItem"])
        table.clear()
        yield* append(3, "s2")
        expect(commands(table)).toEqual(["transactWriteItems", "transactWriteItems", "getItem"])
        const row = currentRow(yield* table.rows(), "a")
        expect(row.st.S).toBe("s2")
        expect(row.gsi1sk.S.toLowerCase()).toContain(
          `status_s2#createdat_${row.created_at.S.toLowerCase()}`,
        )
      }),
    )
  }),
  ...bothSettings("nothing to keep: the condition is the one it always was", (h, on) => {
    const Plain = Schema.Struct({
      id: Schema.String,
      owner: Schema.String,
      status: Schema.optional(Schema.String),
      at: Schema.Number,
      createdAt: Schema.DateTimeUtc,
    })
    const w = looseWorld(on, {
      Plain: {
        model: Plain,
        timestamps: true,
        indexes: byOwnerOver(["status"]),
        timeSeries: {
          orderBy: "at",
          appendInput: Schema.Struct({
            id: Schema.String,
            owner: Schema.String,
            status: Schema.optional(Schema.String),
            at: Schema.Number,
          }),
        },
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        table.clear()
        yield* db.entities.Plain.append({ id: "a", owner: "o", status: "s1", at: 1 }).asEffect()
        const sent = table.requests()[0]!.input.TransactItems[0].Update
        expect(sent.ConditionExpression).toBe("attribute_not_exists(#_tspk) OR #_tsob < :_tsNewOb")
        expect(sent.ReturnValuesOnConditionCheckFailure).toBeUndefined()
      }),
    )
  }),
]

// ---------------------------------------------------------------------------
// Aggregates: a date the row's value declares, per row, and what a key does with no value
// ---------------------------------------------------------------------------

const Dates = { createdAt: Schema.DateTimeUtc, updatedAt: Schema.DateTimeUtc }

/** A world of aggregates. The table's definition holds their indexes, as `Table.make` would. */
const aggregateWorld = (
  escapeKeys: boolean,
  build: (
    make: (name: string, model: unknown, extra?: Record<string, unknown>) => any,
  ) => Record<string, any>,
) => {
  const schema = DynamoSchema.make({ name: "stamped", version: 1, escapeKeys })
  const Filler = Entity.make({
    model: Schema.Struct({ id: Schema.String }),
    entityType: "Filler",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const Base = Table.make({ schema, entities: { Filler } })
  const aggregates = build((name, model, extra = {}) =>
    Aggregate.make(
      model as never,
      {
        table: Base,
        schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: name.toLowerCase() },
        root: { entityType: name },
        edges: {},
        timestamps: true,
        ...extra,
      } as never,
    ),
  )
  const MainTable = { ...Base, aggregates }
  const client = DynamoClient.make({
    entities: { Filler },
    aggregates,
    tables: { MainTable },
  } as never) as any
  return { schema, MainTable, client } as any
}

const iso = (value: unknown) => DateTime.formatIso(value as DateTime.Utc)

/** The rows of `type` in the partition of the aggregate `id`, by sort key. */
const rowsOfType = (rows: ReadonlyArray<StoredRow>, type: string, id = "a") =>
  rows.filter((row) => row.__edd_e__?.S === type && row.pk.S.endsWith(`#${id}`))

const onlyRow = (rows: ReadonlyArray<StoredRow>, type: string, id = "a"): StoredRow => {
  const found = rowsOfType(rows, type, id)
  expect(found, `${type} ${id}`).toHaveLength(1)
  return found[0]!
}

/** What a stored row's dates say, and what the value came back with, are the same. */
const expectReturnedAsStored = (value: any, row: StoredRow) => {
  expect(iso(value.createdAt)).toBe(row.createdAt.S)
  expect(iso(value.updatedAt)).toBe(row.updatedAt.S)
}

const SECOND = "2021-02-03T04:05:06.000Z"
const second = DateTime.makeUnsafe(SECOND)

/**
 * The same questions at each place a row can declare the dates: the aggregate's `read` gets the
 * value holding them, `edit` changes something else in it, `named` puts `dates` into it.
 */
const declaredDates = (
  on: boolean,
  type: string,
  build: (make: (name: string, model: unknown, extra?: Record<string, unknown>) => any) => any,
  fields: {
    readonly input: (dates?: Record<string, unknown>) => Record<string, unknown>
    readonly read: (value: any) => any
    readonly edit: (state: any) => any
    readonly named: (state: any, dates: Record<string, unknown>) => any
  },
) => {
  const w = aggregateWorld(on, (make) => ({ Subject: build(make) }))
  return (h: any) =>
    h.on(w, (table: RepairTable) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const subject = db.aggregates.Subject
        // Not supplied: stamped, and returned as stored.
        const made = yield* subject.create({ id: "a", ...fields.input() })
        const row = onlyRow(yield* table.rows(), type)
        expect(row.createdAt.S).not.toBe(SUPPLIED)
        expect(row.createdAt.S).toEqual(row.updatedAt.S)
        expectReturnedAsStored(fields.read(made), row)
        expectReturnedAsStored(fields.read(yield* subject.get({ id: "a" })), row)
        // Supplied to `create`: the stamp is stored all the same, as up to 1.39.0, where the input
        // had to hold a value. What's returned and read back is what's stored.
        const given = yield* subject.create({
          id: "b",
          ...fields.input({ createdAt: supplied, updatedAt: supplied }),
        })
        const givenRow = onlyRow(yield* table.rows(), type, "b")
        expect(givenRow.createdAt.S).not.toBe(SUPPLIED)
        expect(givenRow.updatedAt.S).toBe(givenRow.createdAt.S)
        expectReturnedAsStored(fields.read(given), givenRow)
        expectReturnedAsStored(fields.read(yield* subject.get({ id: "b" })), givenRow)
        // An update of the row keeps `createdAt`, moves `updatedAt`, and returns what it stored.
        yield* tick
        const edited = yield* subject.update({ id: "b" }, ({ state }: any) => fields.edit(state))
        const editedRow = onlyRow(yield* table.rows(), type, "b")
        expect(editedRow.createdAt.S).toBe(givenRow.createdAt.S)
        expect(editedRow.updatedAt.S).not.toBe(givenRow.updatedAt.S)
        expectReturnedAsStored(fields.read(edited), editedRow)
        expectReturnedAsStored(fields.read(yield* subject.get({ id: "b" })), editedRow)
        // An update naming `updatedAt` gives it; `createdAt` isn't the update's to change.
        const named = yield* subject.update({ id: "b" }, ({ state }: any) =>
          fields.named(state, { createdAt: second, updatedAt: second }),
        )
        const namedRow = onlyRow(yield* table.rows(), type, "b")
        expect(namedRow.createdAt.S).toBe(givenRow.createdAt.S)
        expect(namedRow.updatedAt.S).toBe(SECOND)
        expectReturnedAsStored(fields.read(named), namedRow)
        // Nothing changed, nothing written, and what's returned is what's stored.
        table.clear()
        const same = yield* subject.update({ id: "b" }, ({ state }: any) => state)
        expect(commands(table)).not.toContain("transactWriteItems")
        expectReturnedAsStored(fields.read(same), namedRow)
      }),
    )
}

const Listed = Schema.Struct({
  id: Schema.String,
  region: Schema.optional(Schema.String),
  rate: Schema.optional(Schema.Number),
  title: Schema.optional(Schema.String),
})

const listIndex = (
  name: string,
  pk: ReadonlyArray<string>,
  sk: ReadonlyArray<string>,
  extra: Record<string, unknown> = {},
) => ({ index: "gsi1", name, pk: half(1, pk), sk: sortHalf(1, sk), ...extra })

const clearing =
  (...fields: ReadonlyArray<string>) =>
  ({ state }: any) =>
    Object.fromEntries(Object.entries(state).filter(([field]) => !fields.includes(field)))

const expectEdd9123 = (error: any, operation: string) => {
  expect(error._tag).toBe("ValidationError")
  expect(error.operation).toBe(operation)
  expect(String(error.cause)).toContain("EDD-9123")
}

export const aggregateScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings("a root's dates", (h, on) =>
    declaredDates(
      on,
      "Rooted",
      (make) =>
        make(
          "Rooted",
          Schema.Struct({ id: Schema.String, title: Schema.optional(Schema.String), ...Dates }),
        ),
      {
        input: (dates = {}) => dates,
        read: (value) => value,
        edit: (state) => ({ ...state, title: "t" }),
        named: (state, dates) => ({ ...state, ...dates }),
      },
    )(h),
  ),
  ...bothSettings("a sub-aggregate root's dates", (h, on) =>
    declaredDates(
      on,
      "SubRoot",
      (make) =>
        make(
          "WithSub",
          Schema.Struct({
            id: Schema.String,
            sub: Schema.Struct({ name: Schema.String, ...Dates }),
          }),
          {
            edges: {
              sub: (
                Aggregate.make(
                  Schema.Struct({ name: Schema.String, ...Dates }) as never,
                  {
                    root: { entityType: "SubRoot" },
                    edges: {},
                  } as never,
                ) as any
              ).with({ discriminator: { slot: "a" } }),
            },
          },
        ),
      {
        input: (dates = {}) => ({ sub: { name: "n", ...dates } }),
        read: (value) => value.sub,
        edit: (state) => ({ ...state, sub: { ...state.sub, name: "m" } }),
        named: (state, dates) => ({ ...state, sub: { ...state.sub, ...dates } }),
      },
    )(h),
  ),
  ...bothSettings("a one edge's dates", (h, on) =>
    declaredDates(
      on,
      "Venue",
      (make) =>
        make(
          "WithOne",
          Schema.Struct({
            id: Schema.String,
            venue: Schema.Struct({ name: Schema.String, ...Dates }),
          }),
          { edges: { venue: Aggregate.one({ entityType: "Venue" } as never) } },
        ),
      {
        input: (dates = {}) => ({ venue: { name: "n", ...dates } }),
        read: (value) => value.venue,
        edit: (state) => ({ ...state, venue: { ...state.venue, name: "m" } }),
        named: (state, dates) => ({ ...state, venue: { ...state.venue, ...dates } }),
      },
    )(h),
  ),
  ...bothSettings("a many element's dates", (h, on) =>
    declaredDates(
      on,
      "Line",
      (make) =>
        make(
          "WithMany",
          Schema.Struct({
            id: Schema.String,
            lines: Schema.Array(
              Schema.Struct({ sku: Schema.String, qty: Schema.Number, ...Dates }),
            ),
          }),
          { edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["sku"] } }) } },
        ),
      {
        input: (dates = {}) => ({ lines: [{ sku: "s", qty: 1, ...dates }] }),
        read: (value) => value.lines[0],
        edit: (state) => ({ ...state, lines: [{ ...state.lines[0], qty: 2 }] }),
        named: (state, dates) => ({ ...state, lines: [{ ...state.lines[0], ...dates }] }),
      },
    )(h),
  ),
  ...bothSettings("a many element added by an update is stamped", (h, on) => {
    const w = aggregateWorld(on, (make) => ({
      WithMany: make(
        "WithMany",
        Schema.Struct({
          id: Schema.String,
          lines: Schema.Array(Schema.Struct({ sku: Schema.String, ...Dates })),
        }),
        { edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["sku"] } }) } },
      ),
    }))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.aggregates.WithMany.create({
          id: "a",
          lines: [{ sku: "s", createdAt: supplied, updatedAt: supplied }],
        })
        yield* tick
        const updated = yield* db.aggregates.WithMany.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          lines: [...state.lines, { sku: "t" }],
        }))
        const rows = rowsOfType(yield* table.rows(), "Line")
        expect(rows).toHaveLength(2)
        for (const row of rows) {
          const returned = updated.lines.find((line: any) => line.sku === row.sku.S)
          expectReturnedAsStored(returned, row)
        }
        // `create` stamped the first over what the input held; the update stamped the second.
        const first = rows.find((row) => row.sku.S === "s")!.createdAt.S
        expect(first).not.toBe(SUPPLIED)
        expect(rows.find((row) => row.sku.S === "t")!.createdAt.S).not.toBe(SUPPLIED)
        expect(rows.find((row) => row.sku.S === "t")!.createdAt.S).not.toBe(first)
      }),
    )
  }),
  ...bothSettings("an update leaves `updatedAt` alone on a row it doesn't write", (h, on) => {
    // A sub-aggregate with edges of its own is a write group of its own.
    const Edge = Schema.Struct({
      name: Schema.String,
      items: Schema.Array(Schema.Struct({ sku: Schema.String })),
      ...Dates,
    })
    const w = aggregateWorld(on, (make) => ({
      Two: make(
        "Two",
        Schema.Struct({
          id: Schema.String,
          title: Schema.optional(Schema.String),
          ...Dates,
          left: Edge,
        }),
        {
          edges: {
            left: (
              Aggregate.make(
                Edge as never,
                {
                  root: { entityType: "Left" },
                  edges: {
                    items: Aggregate.many({ entityType: "Item", sk: { composite: ["sku"] } }),
                  },
                } as never,
              ) as any
            ).with({ discriminator: { slot: "l" } }),
          },
        },
      ),
    }))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.aggregates.Two.create({ id: "a", left: { name: "n", items: [{ sku: "s" }] } })
        const left = onlyRow(yield* table.rows(), "Left")
        const root = onlyRow(yield* table.rows(), "Two")
        yield* tick
        const updated = yield* db.aggregates.Two.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          title: "t",
        }))
        const nextRoot = onlyRow(yield* table.rows(), "Two")
        expect(nextRoot.updatedAt).not.toEqual(root.updatedAt)
        expect(onlyRow(yield* table.rows(), "Left").updatedAt).toEqual(left.updatedAt)
        expectReturnedAsStored(updated, nextRoot)
        expectReturnedAsStored(updated.left, left)
        // And the other way about.
        yield* tick
        const moved = yield* db.aggregates.Two.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          left: { ...state.left, name: "m" },
        }))
        const nextLeft = onlyRow(yield* table.rows(), "Left")
        expect(nextLeft.updatedAt).not.toEqual(left.updatedAt)
        expect(onlyRow(yield* table.rows(), "Two").updatedAt).toEqual(nextRoot.updatedAt)
        expectReturnedAsStored(moved, nextRoot)
        expectReturnedAsStored(moved.left, nextLeft)
      }),
    )
  }),
  ...bothSettings("a date field on the root may be optional, and is stamped", (h, on) => {
    const w = aggregateWorld(on, (make) => ({
      Optional: make(
        "Optional",
        Schema.Struct({
          id: Schema.String,
          createdAt: Schema.optional(Schema.DateTimeUtc),
          updatedAt: Schema.optional(Schema.DateTimeUtc),
        }),
      ),
    }))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const made = yield* db.aggregates.Optional.create({ id: "a" })
        expectReturnedAsStored(made, onlyRow(yield* table.rows(), "Optional"))
      }),
    )
  }),
  ...bothSettings("an epoch-encoded date on a nested row is stored as it says", (h, on) => {
    const w = aggregateWorld(on, (make) => ({
      Epoch: make(
        "Epoch",
        Schema.Struct({
          id: Schema.String,
          venue: Schema.Struct({ name: Schema.String, updatedAt: DynamoModel.DateEpochMs }),
        }),
        { edges: { venue: Aggregate.one({ entityType: "Venue" } as never) } },
      ),
    }))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const made = yield* db.aggregates.Epoch.create({ id: "a", venue: { name: "n" } })
        const row = onlyRow(yield* table.rows(), "Venue")
        expect(row.updatedAt.N).toBeDefined()
        expect(String(DateTime.toEpochMillis(made.venue.updatedAt))).toBe(row.updatedAt.N)
        // Undeclared on the root's row: stamped there too, and off the value that's read.
        const root = onlyRow(yield* table.rows(), "Epoch")
        expect(root.updatedAt.S).toBeDefined()
        const read = yield* db.aggregates.Epoch.get({ id: "a" })
        expect(read.updatedAt).toBeUndefined()
        expect(read.venue.updatedAt).toBeDefined()
      }),
    )
  }),
  ...bothSettings(
    "a row with no such field is stamped, and it doesn't reach the value",
    (h, on) => {
      const w = aggregateWorld(on, (make) => ({
        Mixed: make(
          "Mixed",
          Schema.Struct({
            id: Schema.String,
            lines: Schema.Array(Schema.Struct({ sku: Schema.String, ...Dates })),
            venue: Schema.Struct({ name: Schema.String }),
          }),
          {
            edges: {
              lines: Aggregate.many({ entityType: "Line", sk: { composite: ["sku"] } }),
              venue: Aggregate.one({ entityType: "Venue" } as never),
            },
          },
        ),
      }))
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          const made = yield* db.aggregates.Mixed.create({
            id: "a",
            lines: [{ sku: "s" }],
            venue: { name: "n" },
          })
          const rows = yield* table.rows()
          expect(onlyRow(rows, "Mixed").createdAt.S).toBeDefined()
          expect(onlyRow(rows, "Venue").updatedAt.S).toBeDefined()
          expect(made.createdAt).toBeUndefined()
          expect(made.venue.createdAt).toBeUndefined()
          const read = yield* db.aggregates.Mixed.get({ id: "a" })
          expect(read.createdAt).toBeUndefined()
          expect(read.venue.updatedAt).toBeUndefined()
          expectReturnedAsStored(read.lines[0], onlyRow(rows, "Line"))
        }),
      )
    },
  ),
  ...bothSettings("a field of that name of another type is the caller's", (h, on) => {
    const w = aggregateWorld(on, (make) => ({
      // On the root: nobody's row is stamped with that name.
      OwnedRoot: make(
        "OwnedRoot",
        Schema.Struct({
          id: Schema.String,
          createdAt: Schema.String,
          venue: Schema.Struct({ name: Schema.String }),
        }),
        { edges: { venue: Aggregate.one({ entityType: "OwnedVenue" } as never) } },
      ),
      // On an edge: only that row's left alone.
      OwnedEdge: make(
        "OwnedEdge",
        Schema.Struct({
          id: Schema.String,
          venue: Schema.Struct({ name: Schema.String, createdAt: Schema.String }),
        }),
        { edges: { venue: Aggregate.one({ entityType: "EdgeVenue" } as never) } },
      ),
    }))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const root = yield* db.aggregates.OwnedRoot.create({
          id: "a",
          createdAt: "the caller's",
          venue: { name: "n" },
        })
        expect(root.createdAt).toBe("the caller's")
        const edge = yield* db.aggregates.OwnedEdge.create({
          id: "a",
          venue: { name: "n", createdAt: "the caller's" },
        })
        expect(edge.venue.createdAt).toBe("the caller's")
        const rows = yield* table.rows()
        expect(onlyRow(rows, "OwnedRoot").createdAt.S).toBe("the caller's")
        expect(onlyRow(rows, "OwnedRoot").updatedAt.S).toBeDefined()
        expect(onlyRow(rows, "OwnedVenue").createdAt).toBeUndefined()
        expect(onlyRow(rows, "EdgeVenue").createdAt.S).toBe("the caller's")
        expect(onlyRow(rows, "OwnedEdge").createdAt.S).toBeDefined()
        const read = yield* db.aggregates.OwnedEdge.get({ id: "a" })
        expect(read.venue.createdAt).toBe("the caller's")
        expect(read.createdAt).toBeUndefined()
      }),
    )
  }),
  ...bothSettings("a collection key over a stamp holds what the row holds", (h, on) => {
    const w = aggregateWorld(on, (make) => ({
      Collected: make(
        "Collected",
        Schema.Struct({
          id: Schema.String,
          title: Schema.optional(Schema.String),
          updatedAt: Schema.optional(Schema.DateTimeUtc),
        }),
        {
          collection: {
            index: "lsi1",
            name: "collected",
            sk: { field: "lsi1sk", composite: ["updatedAt"] },
          },
        },
      ),
    }))
    const holds = (row: StoredRow) =>
      expect(row.lsi1sk.S.toLowerCase()).toContain(row.updatedAt.S.toLowerCase())
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.aggregates.Collected.create({ id: "a" })
        const first = onlyRow(yield* table.rows(), "Collected")
        holds(first)
        yield* tick
        yield* db.aggregates.Collected.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          title: "t",
        }))
        const second = onlyRow(yield* table.rows(), "Collected")
        expect(second.updatedAt).not.toEqual(first.updatedAt)
        holds(second)
        const read = yield* db.aggregates.Collected.get({ id: "a" })
        expect(iso(read.updatedAt)).toBe(second.updatedAt.S)
      }),
    )
  }),
  ...bothSettings("a list key with no value: the row isn't in the list", (h, on) => {
    const none = { timestamps: undefined }
    const w = aggregateWorld(on, (make) => ({
      ListSk: make("ListSk", Listed, { ...none, list: listIndex("listsk", [], ["region"]) }),
      ListPk: make("ListPk", Listed, { ...none, list: listIndex("listpk", ["region"], []) }),
      ListBoth: make("ListBoth", Listed, {
        ...none,
        list: listIndex("listboth", ["region"], ["rate"]),
      }),
      Sharded: make("Sharded", Listed, {
        ...none,
        list: listIndex("sharded", ["region"], ["rate"], { cardinality: 4 }),
      }),
    }))
    const inList = (row: StoredRow) => row.gsi1pk !== undefined || row.gsi1sk !== undefined
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        for (const [name, filter, value] of [
          ["ListSk", {}, { region: "r" }],
          ["ListPk", { region: "r" }, { region: "r" }],
          ["ListBoth", { region: "r" }, { region: "r", rate: 1 }],
          ["Sharded", { region: "r" }, { region: "r", rate: 1 }],
        ] as const) {
          const aggregate = db.aggregates[name]
          const made = yield* aggregate.create({ id: "a" })
          expect(made.id, name).toBe("a")
          expect(inList(onlyRow(yield* table.rows(), name)), name).toBe(false)
          expect((yield* aggregate.get({ id: "a" })).id, name).toBe("a")
          // Given the value, it joins.
          yield* aggregate.create({ id: "b", ...value })
          expect(inList(onlyRow(yield* table.rows(), name, "b")), name).toBe(true)
          expect(
            (yield* aggregate.list(filter)).data.map((one: any) => one.id),
            name,
          ).toEqual(["b"])
          yield* aggregate.update({ id: "a" }, ({ state }: any) => ({ ...state, ...value }))
          expect(inList(onlyRow(yield* table.rows(), name)), name).toBe(true)
          expect((yield* aggregate.list(filter)).data, name).toHaveLength(2)
          // Without it, it leaves.
          yield* aggregate.update({ id: "b" }, clearing(...Object.keys(value)))
          expect(inList(onlyRow(yield* table.rows(), name, "b")), name).toBe(false)
          expect(
            (yield* aggregate.list(filter)).data.map((one: any) => one.id),
            name,
          ).toEqual(["a"])
          expect((yield* aggregate.get({ id: "b" })).id, name).toBe("b")
        }
      }),
    )
  }),
  ...bothSettings("half a list key is no list key", (h, on) => {
    const w = aggregateWorld(on, (make) => ({
      ListBoth: make("ListBoth", Listed, {
        timestamps: undefined,
        list: listIndex("listboth", ["region"], ["rate"]),
      }),
    }))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.aggregates.ListBoth.create({ id: "a", region: "r" })
        yield* db.aggregates.ListBoth.create({ id: "b", rate: 1 })
        for (const id of ["a", "b"]) {
          const row = onlyRow(yield* table.rows(), "ListBoth", id)
          expect(row.gsi1pk).toBeUndefined()
          expect(row.gsi1sk).toBeUndefined()
        }
        // The values themselves are stored.
        expect(onlyRow(yield* table.rows(), "ListBoth", "a").region.S).toBe("r")
        expect(onlyRow(yield* table.rows(), "ListBoth", "b").rate.N).toBe("1")
      }),
    )
  }),
  ...bothSettings("a list key over an optional stamp: stamped and listed", (h, on) => {
    const Fields = {
      id: Schema.String,
      createdAt: Schema.optional(Schema.DateTimeUtc),
    }
    const w = aggregateWorld(on, (make) => ({
      // No `timestamps`: an optional field like any other.
      Unstamped: make("Unstamped", Schema.Struct(Fields), {
        timestamps: undefined,
        list: listIndex("unstamped", [], ["createdAt"]),
      }),
      Stamped: make("Stamped", Schema.Struct(Fields), {
        list: listIndex("stamped", [], ["createdAt"]),
      }),
    }))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.aggregates.Unstamped.create({ id: "a" })
        expect(onlyRow(yield* table.rows(), "Unstamped").gsi1sk).toBeUndefined()
        yield* db.aggregates.Stamped.create({ id: "a" })
        const row = onlyRow(yield* table.rows(), "Stamped")
        expect(row.gsi1sk.S.toLowerCase()).toContain(row.createdAt.S.toLowerCase())
        expect((yield* db.aggregates.Stamped.list({})).data).toHaveLength(1)
      }),
    )
  }),
  ...bothSettings("a list filter that can't compose the partition: refused, no defect", (h, on) => {
    const w = aggregateWorld(on, (make) => ({
      ListPk: make("ListPk", Listed, {
        timestamps: undefined,
        list: listIndex("listpk", ["region"], []),
      }),
      Sharded: make("Sharded", Listed, {
        timestamps: undefined,
        list: listIndex("sharded", ["region"], ["rate"], { cardinality: 4 }),
      }),
    }))
    return h.on(w, () =>
      Effect.gen(function* () {
        const db = yield* w.client
        for (const name of ["ListPk", "Sharded"]) {
          expectEdd9123(yield* db.aggregates[name].list({}).pipe(Effect.flip), "aggregate.list")
        }
      }),
    )
  }),
  ...bothSettings("a collection key with no value: refused before anything's written", (h, on) => {
    const w = aggregateWorld(on, (make) => ({
      Collected: make(
        "Collected",
        Schema.Struct({
          id: Schema.String,
          region: Schema.optional(Schema.String),
          title: Schema.optional(Schema.String),
          lines: Schema.Array(Schema.Struct({ sku: Schema.String })),
        }),
        {
          timestamps: undefined,
          collection: {
            index: "lsi1",
            name: "collected",
            sk: { field: "lsi1sk", composite: ["region"] },
          },
          edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["sku"] } }) },
        },
      ),
    }))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const refused = yield* db.aggregates.Collected.create({
          id: "a",
          lines: [{ sku: "s" }],
        }).pipe(Effect.flip)
        expectEdd9123(refused, "aggregate.create")
        expect(yield* table.rows()).toHaveLength(0)
        yield* db.aggregates.Collected.create({ id: "b", region: "r", lines: [{ sku: "s" }] })
        const before = yield* table.rows()
        expect(rowsOfType(before, "Collected", "b")).toHaveLength(1)
        const cleared = yield* db.aggregates.Collected.update({ id: "b" }, clearing("region")).pipe(
          Effect.flip,
        )
        expectEdd9123(cleared, "aggregate.update")
        expect(yield* table.rows()).toEqual(before)
        expect((yield* db.aggregates.Collected.get({ id: "b" })).region).toBe("r")
      }),
    )
  }),
  ...bothSettings("a partition key with no value: refused on every operation", (h, on) => {
    const w = aggregateWorld(on, (make) => ({
      NoKey: make(
        "NoKey",
        Schema.Struct({
          id: Schema.optional(Schema.String),
          title: Schema.optional(Schema.String),
        }),
        { timestamps: undefined },
      ),
    }))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const aggregate = db.aggregates.NoKey
        expectEdd9123(yield* aggregate.create({}).pipe(Effect.flip), "aggregate.create")
        expectEdd9123(yield* aggregate.get({}).pipe(Effect.flip), "aggregate.key")
        expectEdd9123(
          yield* aggregate.update({}, ({ state }: any) => state).pipe(Effect.flip),
          "aggregate.key",
        )
        const deleted: any = yield* aggregate.delete({}).pipe(Effect.flip)
        expect(deleted._tag).toBe("AggregateAssemblyError")
        expect(String(deleted.reason ?? deleted.message)).toContain("EDD-9123")
        expect(yield* table.rows()).toHaveLength(0)
      }),
    )
  }),
  ...bothSettings("a null composite has no value either", (h, on) => {
    const Nullable = Schema.Struct({
      id: Schema.String,
      region: Schema.NullOr(Schema.String),
    })
    const none = { timestamps: undefined }
    const w = aggregateWorld(on, (make) => ({
      NullList: make("NullList", Nullable, {
        ...none,
        list: listIndex("nulllist", [], ["region"]),
      }),
      NullCollected: make("NullCollected", Nullable, {
        ...none,
        collection: {
          index: "lsi1",
          name: "nullcollected",
          sk: { field: "lsi1sk", composite: ["region"] },
        },
      }),
    }))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.aggregates.NullList.create({ id: "a", region: null })
        const row = onlyRow(yield* table.rows(), "NullList")
        expect(row.gsi1pk).toBeUndefined()
        expect(row.gsi1sk).toBeUndefined()
        expect((yield* db.aggregates.NullList.get({ id: "a" })).region).toBeNull()
        expect((yield* db.aggregates.NullList.list({})).data).toHaveLength(0)
        expectEdd9123(
          yield* db.aggregates.NullCollected.create({ id: "a", region: null }).pipe(Effect.flip),
          "aggregate.create",
        )
        expect(rowsOfType(yield* table.rows(), "NullCollected")).toHaveLength(0)
      }),
    )
  }),
  ...bothSettings("a stored row without an optional date: a no-op update leaves it", (h, on) => {
    const w = aggregateWorld(on, (make) => ({
      Older: make(
        "Older",
        Schema.Struct({
          id: Schema.String,
          title: Schema.optional(Schema.String),
          createdAt: Schema.optional(Schema.DateTimeUtc),
          updatedAt: Schema.optional(Schema.DateTimeUtc),
        }),
      ),
    }))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.aggregates.Older.create({ id: "a" })
        const row = onlyRow(yield* table.rows(), "Older")
        yield* table.seed(withoutKeys(row, "createdAt", "updatedAt"))
        table.clear()
        const returned = yield* db.aggregates.Older.update({ id: "a" }, ({ state }: any) => state)
        expect(commands(table)).not.toContain("transactWriteItems")
        expect(returned.createdAt).toBeUndefined()
        expect(returned.updatedAt).toBeUndefined()
        expect(onlyRow(yield* table.rows(), "Older").createdAt).toBeUndefined()
        // Any other change writes the row, and stamps it.
        yield* db.aggregates.Older.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          title: "t",
        }))
        expect(onlyRow(yield* table.rows(), "Older").createdAt).toBeDefined()
      }),
    )
  }),
  ...bothSettings("a no-op update returns what's stored, with no write", (h, on) => {
    const w = aggregateWorld(on, (make) => ({
      Same: make(
        "Same",
        Schema.Struct({
          id: Schema.String,
          createdAt: Schema.DateTimeUtc,
          updatedAt: Schema.DateTimeUtc,
        }),
      ),
    }))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.aggregates.Same.create({ id: "a" })
        const row = onlyRow(yield* table.rows(), "Same")
        yield* tick
        table.clear()
        const returned = yield* db.aggregates.Same.update({ id: "a" }, ({ state }: any) => state)
        expect(commands(table)).not.toContain("transactWriteItems")
        expect(onlyRow(yield* table.rows(), "Same")).toEqual(row)
        expectReturnedAsStored(returned, row)
      }),
    )
  }),
  ...bothSettings("no die on any of it: nothing here is a defect", (h, on) => {
    const w = aggregateWorld(on, (make) => ({
      ListSk: make("ListSk", Listed, {
        timestamps: undefined,
        list: listIndex("listsk", [], ["region"]),
      }),
    }))
    return h.on(w, () =>
      Effect.gen(function* () {
        const db = yield* w.client
        const exit = yield* Effect.exit(db.aggregates.ListSk.create({ id: "a" }))
        expect(Exit.isSuccess(exit) ? "ok" : Cause.pretty(exit.cause)).toBe("ok")
      }),
    )
  }),
]

// ---------------------------------------------------------------------------
// An upsert leaving out a composite: it leaves the value, and the key holding it, as stored
// ---------------------------------------------------------------------------

const Noted = Schema.Struct({
  id: Schema.String,
  owner: Schema.optional(Schema.String),
  a: Schema.optional(Schema.String),
  b: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
})

const notedWorld = (on: boolean, indexes: Record<string, unknown>, extra = {}) =>
  looseWorld(on, { N: { model: Noted, indexes, ...extra } })

/** What the row says, with the keys' text cut to what they hold. */
const keysOf = (row: StoredRow) => ({
  pk: row.gsi1pk?.S?.split("#n#")[1] ?? row.gsi1pk?.S?.split("$stamped#v1#n#")[1],
  sk: row.gsi1sk?.S?.split("$stamped#v1#n#")[1],
})

const requestOf = (table: RepairTable, at = 0) => updatesOf(table)[at]!.input

export const upsertOmittedScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings("a changed half is written, the half it can't compose is left", (h, on) => {
    const w = notedWorld(on, byOwnerOver(["note"]))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", owner: "o1", note: "n1" }).asEffect()
        table.clear()
        yield* db.entities.N.upsert({ id: "a", owner: "o2" }).asEffect()
        // One write, no read, no condition: nothing it names is in the half it leaves.
        expect(commands(table)).toEqual(["updateItem"])
        expect(requestOf(table).ConditionExpression).toBeUndefined()
        const row = typeOf(yield* table.rows(), "N")
        expect(row.owner.S).toBe("o2")
        expect(row.note.S).toBe("n1")
        expect(keysOf(row)).toEqual({ pk: "owner_o2", sk: "note_n1" })
        expectKeysOfValues(w, row, w.entities.N, "N")
        expect(yield* db.entities.N.byOwner({ owner: "o2" }).collect()).toHaveLength(1)
        expect(yield* db.entities.N.byOwner({ owner: "o1" }).collect()).toHaveLength(0)
      }),
    )
  }),
  ...bothSettings("the other half, the other way round", (h, on) => {
    const w = notedWorld(on, byOwnerOver(["note"]))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", owner: "o1", note: "n1" }).asEffect()
        table.clear()
        yield* db.entities.N.upsert({ id: "a", note: "n2" }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        const row = typeOf(yield* table.rows(), "N")
        expect(keysOf(row)).toEqual({ pk: "owner_o1", sk: "note_n2" })
      }),
    )
  }),
  ...bothSettings("a row without the other half isn't in the index until it has both", (h, on) => {
    const w = notedWorld(on, byOwnerOver(["note"]))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", owner: "o1" }).asEffect()
        let row = typeOf(yield* table.rows(), "N")
        expect(keysOf(row)).toEqual({ pk: "owner_o1", sk: undefined })
        expect(yield* db.entities.N.byOwner({ owner: "o1" }).collect()).toHaveLength(0)
        yield* db.entities.N.upsert({ id: "a", owner: "o2" }).asEffect()
        row = typeOf(yield* table.rows(), "N")
        expect(keysOf(row)).toEqual({ pk: "owner_o2", sk: undefined })
        yield* db.entities.N.upsert({ id: "a", note: "n1" }).asEffect()
        row = typeOf(yield* table.rows(), "N")
        expect(keysOf(row)).toEqual({ pk: "owner_o2", sk: "note_n1" })
        expect(yield* db.entities.N.byOwner({ owner: "o2" }).collect()).toHaveLength(1)
      }),
    )
  }),
  ...bothSettings("rekey finds nothing to do on a row holding one half", (h, on) => {
    const w = notedWorld(on, byOwnerOver(["note"]))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", owner: "o1" }).asEffect()
        const before = yield* table.rows()
        const report = yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
        expect(report.moved.item).toBe(0)
        expect(report.indexKeysRewritten).toBe(0)
        expect(yield* table.rows()).toEqual(before)
      }),
    )
  }),
  ...bothSettings("a half that can't change isn't written on its own", (h, on) => {
    const w = looseWorld(on, {
      OverKey: {
        model: Noted,
        indexes: { byId: { name: "gsi1", pk: half(1, ["id"]), sk: sortHalf(1, ["note"]) } },
      },
      Empty: {
        model: Noted,
        indexes: { byNote: { name: "gsi1", pk: half(1, []), sk: sortHalf(1, ["note"]) } },
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        for (const name of ["OverKey", "Empty"]) {
          table.clear()
          yield* db.entities[name].upsert({ id: "a", owner: "o" }).asEffect()
          const row = typeOf(yield* table.rows(), name)
          expect(row.gsi1pk, name).toBeUndefined()
          expect(row.gsi1sk, name).toBeUndefined()
          expect(requestOf(table).ConditionExpression, name).toBeUndefined()
          // Given the value, both halves are written, as ever.
          yield* db.entities[name].upsert({ id: "a", note: "n" }).asEffect()
          expectKeysOfValues(w, typeOf(yield* table.rows(), name), w.entities[name], name)
        }
      }),
    )
  }),
  ...bothSettings(
    "a half it names part of stays, in one write, while what it names doesn't change",
    (h, on) => {
      const w = notedWorld(on, byOwnerOver(["a", "b"]))
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.N.upsert({ id: "a", owner: "o", a: "1", b: "2" }).asEffect()
          table.clear()
          yield* db.entities.N.upsert({ id: "a", a: "1", note: "x" }).asEffect()
          expect(commands(table)).toEqual(["updateItem"])
          expect(requestOf(table).ConditionExpression).toContain("attribute_not_exists(#kpk)")
          expect(keysOf(typeOf(yield* table.rows(), "N"))).toEqual({ pk: "owner_o", sk: "a_1#b_2" })
        }),
      )
    },
  ),
  ...bothSettings("a change to it composes from what the row returned, with no read", (h, on) => {
    const w = notedWorld(on, byOwnerOver(["a", "b"]))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", owner: "o", a: "1", b: "2" }).asEffect()
        table.clear()
        yield* db.entities.N.upsert({ id: "a", a: "9" }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        const row = typeOf(yield* table.rows(), "N")
        expect(row.a.S).toBe("9")
        expect(keysOf(row)).toEqual({ pk: "owner_o", sk: "a_9#b_2" })
        expectKeysOfValues(w, row, w.entities.N, "N")
      }),
    )
  }),
  ...bothSettings("a new row takes what it can, in one write", (h, on) => {
    const w = notedWorld(on, byOwnerOver(["a", "b"]))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        table.clear()
        yield* db.entities.N.upsert({ id: "a", owner: "o", a: "1" }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        const row = typeOf(yield* table.rows(), "N")
        expect(row.a.S).toBe("1")
        expect(keysOf(row)).toEqual({ pk: "owner_o", sk: undefined })
        // It holds no `b`, so a second one is held to `a` alone.
        table.clear()
        yield* db.entities.N.upsert({ id: "a", a: "1", b: "2" }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        expect(keysOf(typeOf(yield* table.rows(), "N"))).toEqual({ pk: "owner_o", sk: "a_1#b_2" })
      }),
    )
  }),
  ...["sparse", "preserve"].flatMap((policy) =>
    bothSettings(`what the row can't supply goes by its policy: ${policy}`, (h, on) => {
      const w = notedWorld(on, {
        byOwner: {
          name: "gsi1",
          pk: half(1, ["owner"]),
          sk: sortHalf(1, ["a", "b"]),
          indexPolicy: { pk: policy, sk: policy },
        },
      })
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.N.upsert({ id: "a", owner: "o", a: "1", b: "2" }).asEffect()
          const { a: _a, ...withoutA } = typeOf(yield* table.rows(), "N")
          yield* table.seed(withoutA)
          table.clear()
          // A hole: `b` is new and the row has no `a` to compose it under.
          yield* db.entities.N.upsert({ id: "a", b: "9" }).asEffect()
          expect(commands(table)).toEqual(["updateItem", "updateItem"])
          const row = typeOf(yield* table.rows(), "N")
          expect(row.b.S).toBe("9")
          expect(keysOf(row).sk).toBe(policy === "sparse" ? undefined : "a_1#b_2")
        }),
      )
    }),
  ),
  ...bothSettings("a row with no trailing value takes the key an update gives it", (h, on) => {
    const w = notedWorld(on, byOwnerOver(["a", "b"]))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const seeded = (id: string) =>
          Effect.gen(function* () {
            yield* db.entities.N.upsert({ id, owner: "o", a: "1", b: "2" }).asEffect()
            const { b: _b, ...withoutB } = typeOf(yield* table.rows(), "N", id)
            yield* table.seed(withoutB)
          })
        yield* seeded("a")
        yield* seeded("b")
        yield* db.entities.N.upsert({ id: "a", a: "9" }).asEffect()
        yield* db.entities.N.update({ id: "b" }).set({ a: "9" }).asEffect()
        const rows = yield* table.rows()
        expect(keysOf(typeOf(rows, "N", "a")).sk).toBe("a_9")
        expect(keysOf(typeOf(rows, "N", "a"))).toEqual(keysOf(typeOf(rows, "N", "b")))
      }),
    )
  }),
  ...bothSettings("a sharded partition half needs what it hashes", (h, on) => {
    const w = notedWorld(on, {
      byOwner: {
        name: "gsi1",
        pk: half(1, ["owner"]),
        sk: sortHalf(1, ["a"]),
        shards: { count: 8, by: ["a"] },
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", owner: "o1", a: "x" }).asEffect()
        const first = typeOf(yield* table.rows(), "N")
        expectKeysOfValues(w, first, w.entities.N, "N")
        // Nothing to hash: the partition half can't compose, and stays while `owner` does.
        table.clear()
        yield* db.entities.N.upsert({ id: "a", owner: "o1", note: "x" }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        expect(typeOf(yield* table.rows(), "N").gsi1pk).toEqual(first.gsi1pk)
        // `owner` changing moves it, composed from the row's `a`.
        table.clear()
        yield* db.entities.N.upsert({ id: "a", owner: "o2" }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        let row = typeOf(yield* table.rows(), "N")
        expect(row.gsi1pk.S).toContain("owner_o2")
        expectKeysOfValues(w, row, w.entities.N, "N")
        // `a` changing moves it too, the shard being its hash.
        table.clear()
        yield* db.entities.N.upsert({ id: "a", a: "y" }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        row = typeOf(yield* table.rows(), "N")
        expect(row.a.S).toBe("y")
        expectKeysOfValues(w, row, w.entities.N, "N")
      }),
    )
  }),
  ...bothSettings("a Z-order half is all or nothing", (h, on) => {
    const Facets = Schema.Struct({
      id: Schema.String,
      owner: Schema.optional(Schema.String),
      price: Schema.optional(Schema.Number),
      beds: Schema.optional(Schema.Number),
    })
    const w = looseWorld(on, {
      N: {
        model: Facets,
        indexes: {
          byOwner: {
            name: "gsi1",
            pk: half(1, ["owner"]),
            sk: {
              field: "gsi1sk",
              zorder: [
                { field: "price", min: 0, max: 255 },
                { field: "beds", min: 0, max: 15 },
              ],
            },
          },
        },
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", owner: "o1", price: 10 }).asEffect()
        expect(typeOf(yield* table.rows(), "N").gsi1sk).toBeUndefined()
        yield* db.entities.N.upsert({ id: "a", price: 10, beds: 2 }).asEffect()
        const whole = typeOf(yield* table.rows(), "N")
        expectKeysOfValues(w, whole, w.entities.N, "N")
        table.clear()
        yield* db.entities.N.upsert({ id: "a", price: 10 }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        expect(typeOf(yield* table.rows(), "N").gsi1sk).toEqual(whole.gsi1sk)
        table.clear()
        yield* db.entities.N.upsert({ id: "a", price: 200 }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        const moved = typeOf(yield* table.rows(), "N")
        expect(moved.gsi1sk).not.toEqual(whole.gsi1sk)
        expectKeysOfValues(w, moved, w.entities.N, "N")
      }),
    )
  }),
  ...bothSettings("the caller's condition still decides", (h, on) => {
    const w = notedWorld(on, byOwnerOver(["a", "b"]))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", owner: "o", a: "1", b: "2" }).asEffect()
        const before = yield* table.rows()
        const refused = yield* Effect.flip(
          db.entities.N.upsert({ id: "a", a: "9" }).condition({ owner: "other" }).asEffect(),
        )
        expect((refused as { readonly _tag: string })._tag).toBe("ConditionalCheckFailed")
        expect(yield* table.rows()).toEqual(before)
        yield* db.entities.N.upsert({ id: "a", a: "9" }).condition({ owner: "o" }).asEffect()
        expect(keysOf(typeOf(yield* table.rows(), "N"))).toEqual({ pk: "owner_o", sk: "a_9#b_2" })
      }),
    )
  }),
  ...bothSettings("a renamed field is held to its stored name", (h, on) => {
    const Renamed = DynamoModel.configure(Noted, { a: { field: "storedA" } })
    const w = looseWorld(on, { N: { model: Renamed, indexes: byOwnerOver(["a", "b"]) } })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", owner: "o", a: "1", b: "2" }).asEffect()
        table.clear()
        yield* db.entities.N.upsert({ id: "a", a: "1" }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        const names = Object.values(requestOf(table).ExpressionAttributeNames as object)
        expect(names).toContain("storedA")
        table.clear()
        yield* db.entities.N.upsert({ id: "a", a: "9" }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        const row = typeOf(yield* table.rows(), "N")
        expect(row.storedA.S).toBe("9")
        expect(keysOf(row).sk).toBe("a_9#b_2")
      }),
    )
  }),
  ...bothSettings("a kept value beside a changing one, its partner left out", (h, on) => {
    const Fixed = DynamoModel.configure(Noted, { a: { immutable: true } })
    const w = looseWorld(on, {
      N: {
        model: Fixed,
        indexes: { byOwner: { name: "gsi1", pk: half(1, ["a", "owner"]), sk: sortHalf(1, ["b"]) } },
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", a: "1", owner: "o1", b: "2" }).asEffect()
        table.clear()
        yield* db.entities.N.upsert({ id: "a", a: "1", owner: "o2" }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        expect(keysOf(typeOf(yield* table.rows(), "N"))).toEqual({
          pk: "a_1#owner_o2",
          sk: "b_2",
        })
        // Another `a` contradicts the row, which keeps its own: composed from that.
        table.clear()
        yield* db.entities.N.upsert({ id: "a", a: "9", owner: "o3" }).asEffect()
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        expect(keysOf(typeOf(yield* table.rows(), "N"))).toEqual({
          pk: "a_1#owner_o3",
          sk: "b_2",
        })
      }),
    )
  }),
  ...bothSettings("a kept value alone in a half isn't written on its own", (h, on) => {
    const Fixed = DynamoModel.configure(Noted, { a: { immutable: true } })
    const w = looseWorld(on, {
      N: {
        model: Fixed,
        indexes: { byA: { name: "gsi1", pk: half(1, ["a"]), sk: sortHalf(1, ["note"]) } },
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", a: "1" }).asEffect()
        expect(typeOf(yield* table.rows(), "N").gsi1pk).toBeUndefined()
        table.clear()
        yield* db.entities.N.upsert({ id: "a", a: "1", owner: "x" }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
      }),
    )
  }),
  ...bothSettings("a half over nothing but updatedAt moves, the other half left out", (h, on) => {
    const Stamped = Schema.Struct({
      id: Schema.String,
      owner: Schema.optional(Schema.String),
      updatedAt: Schema.optional(Schema.DateTimeUtc),
    })
    const w = looseWorld(on, {
      N: { model: Stamped, timestamps: true, indexes: byOwnerOver(["updatedAt"]) },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", owner: "o1" }).asEffect()
        const first = typeOf(yield* table.rows(), "N")
        yield* tick
        table.clear()
        yield* db.entities.N.upsert({ id: "a" }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        const row = typeOf(yield* table.rows(), "N")
        expect(row.gsi1sk).not.toEqual(first.gsi1sk)
        expect(row.gsi1pk).toEqual(first.gsi1pk)
        expectKeysOfValues(w, row, w.entities.N, "N")
      }),
    )
  }),
  ...bothSettings("an updatedAt the input supplies moves the half, from the row", (h, on) => {
    const Stamped = Schema.Struct({
      id: Schema.String,
      owner: Schema.optional(Schema.String),
      note: Schema.optional(Schema.String),
      updatedAt: Schema.optional(Schema.DateTimeUtc),
    })
    const w = looseWorld(on, {
      N: { model: Stamped, timestamps: true, indexes: byOwnerOver(["note", "updatedAt"]) },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", owner: "o1", note: "n" }).asEffect()
        table.clear()
        yield* db.entities.N.upsert({ id: "a", owner: "o1", updatedAt: SUPPLIED }).asEffect()
        // The first is rejected on the value it names, and its row says what the key needs.
        expect(commands(table)).toEqual(["updateItem", "updateItem"])
        const row = typeOf(yield* table.rows(), "N")
        expect(row.updatedAt.S).toBe(SUPPLIED)
        expect(keysOf(row).sk).toBe(`note_n#updatedat_${SUPPLIED.toLowerCase()}`)
      }),
    )
  }),
  ...bothSettings("an updatedAt in the half it can't compose lags, as on an update", (h, on) => {
    const Stamped = Schema.Struct({
      id: Schema.String,
      owner: Schema.optional(Schema.String),
      note: Schema.optional(Schema.String),
      updatedAt: Schema.optional(Schema.DateTimeUtc),
    })
    const w = looseWorld(on, {
      N: { model: Stamped, timestamps: true, indexes: byOwnerOver(["updatedAt", "note"]) },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", owner: "o1", note: "n" }).asEffect()
        const first = typeOf(yield* table.rows(), "N")
        yield* tick
        table.clear()
        yield* db.entities.N.upsert({ id: "a", owner: "o2" }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        expect(requestOf(table).ConditionExpression).toBeUndefined()
        const row = typeOf(yield* table.rows(), "N")
        expect(row.gsi1sk).toEqual(first.gsi1sk)
        expect(keysOf(row).pk).toBe("owner_o2")
      }),
    )
  }),
  ...bothSettings("a time-series append leaving one out is per half already", (h, on) => {
    const Meter = Schema.Struct({
      id: Schema.String,
      at: Schema.Number,
      owner: Schema.optional(Schema.String),
      note: Schema.optional(Schema.String),
    })
    const w = looseWorld(on, {
      N: {
        model: Meter,
        indexes: byOwnerOver(["note"]),
        timeSeries: { orderBy: "at", appendInput: Meter },
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.append({ id: "a", at: 1, owner: "o1", note: "n1" }).asEffect()
        yield* db.entities.N.append({ id: "a", at: 2, owner: "o2" }).asEffect()
        const row = (yield* table.rows()).find(
          (candidate) => candidate.owner?.S === "o2" && !candidate.sk.S.includes("#e#"),
        )!
        expect(keysOf(row)).toEqual({ pk: "owner_o2", sk: "note_n1" })
      }),
    )
  }),
]

// ---------------------------------------------------------------------------
// A many edge with a custom decompose: its rows hold what its elements do
// ---------------------------------------------------------------------------

const Line = Schema.Struct({
  sku: Schema.String,
  qty: Schema.Number,
  at: Schema.optional(Schema.DateTimeUtc),
  ...Dates,
})
type LineValue = { readonly sku: string }
const byValues = {
  decompose: (value: unknown) => Object.values(value as Record<string, LineValue>),
  assemble: (items: ReadonlyArray<unknown>) =>
    Object.fromEntries((items as ReadonlyArray<LineValue>).map((item) => [item.sku, item])),
}
const LineEntity = () =>
  Entity.make({
    model: Line,
    entityType: "LineEntity",
    primaryKey: { pk: { field: "pk", composite: ["sku"] }, sk: { field: "sk", composite: [] } },
  })

const decomposeWorld = (on: boolean, model: unknown, edge: Record<string, unknown>) =>
  aggregateWorld(on, (make) => ({
    Orders: make("Order", model, {
      edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["sku"] }, ...edge }) },
    }),
  }))

const OrderOfRecord = Schema.Struct({
  id: Schema.String,
  lines: Schema.Record(Schema.String, Line),
})

export const decomposeScenarios: ReadonlyArray<RepairScenario> = [
  ...[
    ["no entity", {}],
    ["an entity", { entity: LineEntity() }],
  ].flatMap(([label, edge]) =>
    bothSettings(`a record's values, with ${label as string}, stamped and read back`, (h, on) => {
      const w = decomposeWorld(on, OrderOfRecord, { ...byValues, ...(edge as object) })
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          const created = yield* db.aggregates.Orders.create({
            id: "o",
            lines: { a: { sku: "a", qty: 1 } },
          })
          const stamped = created.lines.a.updatedAt
          expect(DateTime.isDateTime(stamped)).toBe(true)
          const line = (yield* table.rows()).find((row) => row.sku?.S === "a")!
          expect(line.updatedAt.S).toBe(DateTime.formatIso(stamped))
          expect(line.createdAt.S).toBe(DateTime.formatIso(created.lines.a.createdAt))
          const read = yield* db.aggregates.Orders.get({ id: "o" })
          expect(read.lines.a.qty).toBe(1)
          expect(DateTime.formatIso(read.lines.a.updatedAt)).toBe(DateTime.formatIso(stamped))
          yield* tick
          const updated = yield* db.aggregates.Orders.update({ id: "o" }, ({ state }: any) => ({
            ...state,
            lines: {
              ...state.lines,
              a: { ...state.lines.a, qty: 2 },
              b: { sku: "b", qty: 3 },
            },
          }))
          expect(updated.lines.a.qty).toBe(2)
          expect(DateTime.isDateTime(updated.lines.b.updatedAt)).toBe(true)
          const rows = yield* table.rows()
          expect(rows.find((row) => row.sku?.S === "b")!.updatedAt.S).toBe(
            DateTime.formatIso(updated.lines.b.updatedAt),
          )
        }),
      )
    }),
  ),
  ...bothSettings(
    "create stamps over a supplied date, and a date field is stored as its own form",
    (h, on) => {
      const w = decomposeWorld(on, OrderOfRecord, byValues)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          const created = yield* db.aggregates.Orders.create({
            id: "o",
            lines: { a: { sku: "a", qty: 1, at: SUPPLIED, updatedAt: SUPPLIED } },
          })
          expect(DateTime.formatIso(created.lines.a.updatedAt)).not.toBe(SUPPLIED)
          const line = (yield* table.rows()).find((row) => row.sku?.S === "a")!
          expect(line.at.S).toBe(SUPPLIED)
          expect(line.updatedAt.S).toBe(DateTime.formatIso(created.lines.a.updatedAt))
          const read = yield* db.aggregates.Orders.get({ id: "o" })
          expect(DateTime.formatIso(read.lines.a.at)).toBe(SUPPLIED)
        }),
      )
    },
  ),
  ...bothSettings("an array with its own decompose and assemble", (h, on) => {
    const Order = Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) })
    const assembled: Array<number> = []
    const w = decomposeWorld(on, Order, {
      decompose: (value: unknown) => [...(value as ReadonlyArray<unknown>)],
      assemble: (items: ReadonlyArray<unknown>) => {
        assembled.push(items.length)
        return [...items]
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const created = yield* db.aggregates.Orders.create({
          id: "o",
          lines: [{ sku: "a", qty: 1 }],
        })
        expect(assembled[0]).toBe(1)
        expect(DateTime.isDateTime(created.lines[0].updatedAt)).toBe(true)
        expect((yield* table.rows()).find((row) => row.sku?.S === "a")!.updatedAt.S).toBe(
          DateTime.formatIso(created.lines[0].updatedAt),
        )
      }),
    )
  }),
  ...bothSettings("a value its decompose can't take apart is left for the schema", (h, on) => {
    const w = decomposeWorld(on, OrderOfRecord, {
      ...byValues,
      decompose: (value: unknown) => {
        if (typeof value !== "object" || value === null || "bad" in value) {
          throw new Error("not a record")
        }
        return Object.values(value)
      },
    })
    return h.on(w, () =>
      Effect.gen(function* () {
        const db = yield* w.client
        const error: any = yield* Effect.flip(
          db.aggregates.Orders.create({ id: "o", lines: { bad: { sku: "a", qty: 1 } } }),
        )
        expect(error._tag).toBe("ValidationError")
        expect(String(error.cause?.message ?? error.cause)).toContain("Missing key")
      }),
    )
  }),
  ...bothSettings("an assemble that can't take the input yet is left for the schema", (h, on) => {
    const w = decomposeWorld(on, OrderOfRecord, {
      ...byValues,
      assemble: (items: ReadonlyArray<any>) =>
        Object.fromEntries(items.map((item) => [item.updatedAt.toISOString(), item])),
    })
    return h.on(w, () =>
      Effect.gen(function* () {
        const db = yield* w.client
        const error: any = yield* Effect.flip(
          db.aggregates.Orders.create({ id: "o", lines: { a: { sku: "a", qty: 1 } } }),
        )
        expect(error._tag).toBe("ValidationError")
        expect(String(error.cause?.message ?? error.cause)).toContain("Missing key")
      }),
    )
  }),
  ...[
    ["no assemble", { decompose: (value: unknown) => [...(value as ReadonlyArray<unknown>)] }],
    ["no decompose", { assemble: (items: ReadonlyArray<unknown>) => [...items] }],
  ].flatMap(([label, edge]) =>
    bothSettings(`an array with ${label as string} is still filled`, (h, on) => {
      const Order = Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) })
      const w = decomposeWorld(on, Order, edge as Record<string, unknown>)
      return h.on(w, () =>
        Effect.gen(function* () {
          const db = yield* w.client
          const created = yield* db.aggregates.Orders.create({
            id: "o",
            lines: [{ sku: "a", qty: 1 }],
          })
          expect(DateTime.isDateTime(created.lines[0].updatedAt)).toBe(true)
        }),
      )
    }),
  ),
  ...bothSettings("rows with nothing to add aren't taken apart and put back", (h, on) => {
    const Plain = Schema.Struct({ sku: Schema.String, qty: Schema.Number })
    const Order = Schema.Struct({ id: Schema.String, lines: Schema.Record(Schema.String, Plain) })
    const assembled: Array<number> = []
    const w = decomposeWorld(on, Order, {
      decompose: byValues.decompose,
      assemble: (items: ReadonlyArray<unknown>) => {
        assembled.push(items.length)
        return byValues.assemble(items)
      },
    })
    return h.on(w, () =>
      Effect.gen(function* () {
        const db = yield* w.client
        // The key isn't the one `assemble` gives, so a round trip would change the value.
        const created = yield* db.aggregates.Orders.create({
          id: "o",
          lines: { x: { sku: "a", qty: 1 } },
        })
        expect(assembled).toEqual([])
        expect(Object.keys(created.lines)).toEqual(["x"])
      }),
    )
  }),
  ...bothSettings("an edge left out isn't taken apart", (h, on) => {
    const Order = Schema.Struct({
      id: Schema.String,
      lines: Schema.optional(Schema.Record(Schema.String, Line)),
    })
    const given: Array<unknown> = []
    const w = decomposeWorld(on, Order, {
      ...byValues,
      decompose: (value: unknown) => {
        given.push(value)
        return value === undefined ? [] : byValues.decompose(value)
      },
    })
    return h.on(w, () =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.aggregates.Orders.create({ id: "o" })
        expect(given).not.toContain(undefined)
      }),
    )
  }),
  ...bothSettings("with no assemble, a record's rows can't be put back", (h, on) => {
    const w = decomposeWorld(on, OrderOfRecord, { decompose: byValues.decompose })
    return h.on(w, () =>
      Effect.gen(function* () {
        const db = yield* w.client
        const error: any = yield* Effect.flip(
          db.aggregates.Orders.create({ id: "o", lines: { a: { sku: "a", qty: 1 } } }),
        )
        expect(error._tag).toBe("ValidationError")
      }),
    )
  }),
  ...bothSettings("an optional record left out", (h, on) => {
    const Order = Schema.Struct({
      id: Schema.String,
      lines: Schema.optional(Schema.Record(Schema.String, Line)),
    })
    const w = decomposeWorld(on, Order, byValues)
    return h.on(w, () =>
      Effect.gen(function* () {
        const db = yield* w.client
        const created = yield* db.aggregates.Orders.create({ id: "o" })
        expect(created.lines).toBeUndefined()
        yield* db.aggregates.Orders.create({ id: "p", lines: { a: { sku: "a", qty: 1 } } })
        const read = yield* db.aggregates.Orders.get({ id: "p" })
        expect(DateTime.isDateTime(read.lines.a.updatedAt)).toBe(true)
      }),
    )
  }),
  ...bothSettings(
    "an opaque value: its rows' dates are the library's, not the element's",
    (h, on) => {
      // Nothing says what the rows hold: `Schema.Unknown` has no element to read. They're stamped and
      // the stamps are stripped on the read, so they don't reach the value.
      const Order = Schema.Struct({ id: Schema.String, lines: Schema.Unknown })
      const w = decomposeWorld(on, Order, byValues)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.aggregates.Orders.create({ id: "o", lines: { a: { sku: "a", qty: 1 } } })
          expect((yield* table.rows()).find((row) => row.sku?.S === "a")!.updatedAt).toBeDefined()
          const read = yield* db.aggregates.Orders.get({ id: "o" })
          expect(read.lines).toEqual({ a: { sku: "a", qty: 1 } })
        }),
      )
    },
  ),
  ...bothSettings("a one edge with no entity takes the value, its dates stamped", (h, on) => {
    const Match = Schema.Struct({
      id: Schema.String,
      venue: Schema.Struct({ name: Schema.String, ...Dates }),
    })
    const w = aggregateWorld(on, (make) => ({
      Matches: make("Match", Match, { edges: { venue: Aggregate.one({ entityType: "Venue" }) } }),
    }))
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const created = yield* db.aggregates.Matches.create({ id: "m", venue: { name: "v" } })
        expect(created.venue.name).toBe("v")
        expect(DateTime.isDateTime(created.venue.updatedAt)).toBe(true)
        expect((yield* table.rows()).find((row) => row.name?.S === "v")!.updatedAt.S).toBe(
          DateTime.formatIso(created.venue.updatedAt),
        )
      }),
    )
  }),
]

// ---------------------------------------------------------------------------
// Clearing a field, against what the library stamps: one form, and a stamp is never touched by it
// ---------------------------------------------------------------------------

const Clearing = Schema.Struct({
  id: Schema.String,
  owner: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
})

const POLICIES = ["sparse", "preserve"] as const
const CLEARS = [
  ["`.set({ status: undefined })`", (u: any) => u.set({ status: undefined })],
  ['`.remove(["status"])`', (u: any) => u.remove(["status"])],
] as const
const UNRELATED = [
  ["`.set({ note: undefined })`", (u: any) => u.set({ note: undefined })],
  ['`.remove(["note"])`', (u: any) => u.remove(["note"])],
] as const

const clearingWorld = (
  on: boolean,
  composite: ReadonlyArray<string>,
  policy: string,
  extra: Record<string, unknown> = {},
) =>
  looseWorld(on, {
    N: {
      model: Clearing,
      timestamps: true,
      indexes: {
        byOwner: {
          name: "gsi1",
          pk: half(1, ["owner"]),
          sk: sortHalf(1, composite),
          indexPolicy: { pk: policy, sk: policy },
        },
      },
      ...extra,
    },
  })

const seeded = { id: "a", owner: "o", status: "s", note: "n" }

/** The clear's outcome, for each form and policy: the sort key's text as `expected` says of the row. */
const clearScenario = (
  name: string,
  composite: ReadonlyArray<string>,
  forms: typeof CLEARS | typeof UNRELATED,
  expected: (before: StoredRow, after: StoredRow) => void,
  extra: Record<string, unknown> = {},
): ReadonlyArray<RepairScenario> =>
  POLICIES.flatMap((policy) =>
    forms.flatMap(([form, clear]) =>
      bothSettings(`${name}: ${form}, ${policy}`, (h, on) => {
        const w = clearingWorld(on, composite, policy, extra)
        return h.on(w, (table) =>
          Effect.gen(function* () {
            const db = yield* w.client
            yield* db.entities.N.put(seeded).asEffect()
            const before = typeOf(yield* table.rows(), "N")
            yield* tick
            yield* clear(db.entities.N.update({ id: "a" })).asEffect()
            const after = typeOf(yield* table.rows(), "N")
            expect(after.updatedAt.S).not.toBe(before.updatedAt.S)
            expect(after.createdAt.S).toBe(before.createdAt.S)
            expected(before, after)
          }),
        )
      }),
    ),
  )

const REFUSED_NAMES = [
  ['`.remove(["createdAt"])`', (u: any) => u.remove(["createdAt"])],
  ["`.set({ createdAt: undefined })`", (u: any) => u.set({ createdAt: undefined })],
  ['`.remove(["updatedAt"])`', (u: any) => u.remove(["updatedAt"])],
  ['`.pathRemove(["createdAt"])`', (u: any) => u.pathRemove(["createdAt"])],
  ['`.pathRemove(["updatedAt"])`', (u: any) => u.pathRemove(["updatedAt"])],
] as const

const DATES = [
  ["a required date", Schema.DateTimeUtc],
  ["a `Schema.optional` date", Schema.optional(Schema.DateTimeUtc)],
  ["a `Schema.optionalKey` date", Schema.optionalKey(Schema.DateTimeUtc)],
] as const

const datedWorld = (on: boolean, field: Schema.Top) =>
  looseWorld(on, {
    N: {
      model: Schema.Struct({
        id: Schema.String,
        note: Schema.optional(Schema.String),
        createdAt: field,
        updatedAt: field,
      } as never),
      timestamps: true,
    },
  })

export const clearScenarios: ReadonlyArray<RepairScenario> = [
  ...clearScenario(
    "a half over `updatedAt` loses its key with its value",
    ["status", "updatedAt"],
    CLEARS,
    (_, after) => {
      expect(after.status).toBeUndefined()
      expect(after.gsi1sk).toBeUndefined()
      expect(after.gsi1pk.S).toContain("owner_o")
    },
  ),
  ...clearScenario(
    "the same, read first",
    ["status", "updatedAt"],
    CLEARS,
    (_, after) => {
      expect(after.status).toBeUndefined()
      expect(after.gsi1sk).toBeUndefined()
    },
    { versioned: { retain: true } },
  ),
  ...clearScenario(
    "a half over `createdAt` loses its key with its value",
    ["status", "createdAt"],
    CLEARS,
    (_, after) => {
      expect(after.status).toBeUndefined()
      expect(after.gsi1sk).toBeUndefined()
    },
  ),
  ...clearScenario(
    "the parent the library stamps is enough to truncate to",
    ["updatedAt", "status"],
    CLEARS,
    (_, after) => {
      expect(after.status).toBeUndefined()
      expect(after.gsi1sk.S).toContain(`updatedat_${after.updatedAt.S.toLowerCase()}`)
      expect(after.gsi1sk.S).not.toContain("status_")
    },
  ),
  ...clearScenario(
    "clearing what isn't in the half doesn't touch it, stamp or no stamp",
    ["status", "updatedAt"],
    UNRELATED,
    (before, after) => {
      expect(after.note).toBeUndefined()
      expect(after.gsi1sk.S).toBe(before.gsi1sk.S)
      expect(after.gsi1pk.S).toBe(before.gsi1pk.S)
    },
  ),
  ...clearScenario(
    "...read first it composes whole, so the stamp moves it",
    ["status", "updatedAt"],
    UNRELATED,
    (before, after) => {
      expect(after.note).toBeUndefined()
      expect(after.gsi1sk.S).not.toBe(before.gsi1sk.S)
      expect(after.gsi1sk.S).toContain(`updatedat_${after.updatedAt.S.toLowerCase()}`)
    },
    { versioned: { retain: true } },
  ),
  ...clearScenario(
    "a half of nothing but the stamp moves on any clear",
    ["updatedAt"],
    UNRELATED,
    (before, after) => {
      expect(after.note).toBeUndefined()
      expect(after.gsi1sk.S).not.toBe(before.gsi1sk.S)
    },
  ),
  ...DATES.flatMap(([name, field]) =>
    REFUSED_NAMES.flatMap(([form, clear]) =>
      bothSettings(`${name} the library stamps can't be cleared: ${form}`, (h, on) => {
        const w = datedWorld(on, field)
        return h.on(w, (table) =>
          Effect.gen(function* () {
            const db = yield* w.client
            yield* db.entities.N.put({ id: "a" }).asEffect()
            const before = yield* table.rows()
            table.clear()
            const error: any = yield* Effect.flip(
              clear(db.entities.N.update({ id: "a" })).asEffect() as Effect.Effect<unknown, any>,
            )
            expect(error._tag).toBe("ValidationError")
            expect(String(error.cause)).toContain("managed by the library")
            expect(commands(table)).toEqual([])
            expect(yield* table.rows()).toEqual(before)
          }),
        )
      }),
    ),
  ),
  ...DATES.flatMap(([name, field]) =>
    bothSettings(`${name}: \`.set({ updatedAt: undefined })\` means stamp it`, (h, on) => {
      const w = datedWorld(on, field)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.N.put({ id: "a" }).asEffect()
          const before = typeOf(yield* table.rows(), "N")
          yield* tick
          yield* db.entities.N.update({ id: "a" }).set({ updatedAt: undefined }).asEffect()
          const after = typeOf(yield* table.rows(), "N")
          expect(after.updatedAt.S).not.toBe(before.updatedAt.S)
          expect(after.createdAt.S).toBe(before.createdAt.S)
        }),
      )
    }),
  ),
  ...[
    ['`.remove(["createdAt"])`', (u: any) => u.remove(["createdAt"])],
    ["`.set({ createdAt: undefined })`", (u: any) => u.set({ createdAt: undefined })],
    ['`.remove(["updatedAt"])`', (u: any) => u.remove(["updatedAt"])],
    ["`.set({ updatedAt: undefined })`", (u: any) => u.set({ updatedAt: undefined })],
  ].flatMap(([form, clear]: any) =>
    bothSettings(`a field of that name of another type is the caller's: ${form}`, (h, on) => {
      const w = datedWorld(on, Schema.optional(Schema.String))
      const name = form.includes("createdAt") ? "createdAt" : "updatedAt"
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.N.put({ id: "a", createdAt: "c", updatedAt: "u" }).asEffect()
          yield* clear(db.entities.N.update({ id: "a" })).asEffect()
          const row = typeOf(yield* table.rows(), "N")
          expect(row[name]).toBeUndefined()
          expect(yield* db.entities.N.get({ id: "a" })).not.toHaveProperty(name)
        }),
      )
    }),
  ),
  ...bothSettings("a required field of that name of another type can't be cleared", (h, on) => {
    const w = datedWorld(on, Schema.String)
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.put({ id: "a", createdAt: "c", updatedAt: "u" }).asEffect()
        const before = yield* table.rows()
        const error: any = yield* Effect.flip(
          db.entities.N.update({ id: "a" }).remove(["createdAt"]).asEffect() as Effect.Effect<
            unknown,
            any
          >,
        )
        expect(String(error.cause)).toContain("the model requires")
        expect(yield* table.rows()).toEqual(before)
      }),
    )
  }),
  ...bothSettings("an append's `.remove` of a stamped date is refused", (h, on) => {
    const Series = Schema.Struct({
      id: Schema.String,
      at: Schema.Number,
      note: Schema.optional(Schema.String),
      createdAt: Schema.optional(Schema.DateTimeUtc),
    })
    const w = looseWorld(on, {
      N: {
        model: Series,
        timestamps: true,
        timeSeries: {
          orderBy: "at",
          appendInput: Schema.Struct({ id: Schema.String, at: Schema.Number }),
        },
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.append({ id: "a", at: 1 }).asEffect()
        const before = yield* table.rows()
        const error: any = yield* Effect.flip(
          db.entities.N.append({ id: "a", at: 2 })
            .remove(["createdAt"])
            .asEffect() as Effect.Effect<unknown, any>,
        )
        expect(error._tag).toBe("ValidationError")
        expect(String(error.cause)).toContain("managed by the library")
        expect(yield* table.rows()).toEqual(before)
      }),
    )
  }),
  ...[
    ["a required date", Schema.DateTimeUtc],
    ["a `Schema.optional` date", Schema.optional(Schema.DateTimeUtc)],
  ].flatMap(([name, field]: any) =>
    [
      [
        "leaving `createdAt` out",
        ({ state }: any) => {
          const { createdAt: _, ...rest } = state
          return { ...rest, note: "m1" }
        },
      ],
      [
        "setting `createdAt` to undefined",
        ({ state }: any) => ({ ...state, createdAt: undefined, note: "m2" }),
      ],
      [
        "leaving `updatedAt` out",
        ({ state }: any) => {
          const { updatedAt: _, ...rest } = state
          return { ...rest, note: "m3" }
        },
      ],
      [
        "setting `updatedAt` to undefined",
        ({ state }: any) => ({ ...state, updatedAt: undefined, note: "m4" }),
      ],
    ].flatMap(([label, mutate]: any) =>
      bothSettings(`an aggregate root with ${name}: ${label} clears nothing`, (h, on) => {
        const w = aggregateWorld(on, (make) => ({
          Dated: make(
            "Dated",
            Schema.Struct({
              id: Schema.String,
              note: Schema.optional(Schema.String),
              createdAt: field,
              updatedAt: field,
            } as never),
          ),
        }))
        return h.on(w, (table) =>
          Effect.gen(function* () {
            const db = yield* w.client
            yield* db.aggregates.Dated.create({ id: "a" })
            const before = (yield* table.rows()).find((row) => row.id?.S === "a")!
            yield* tick
            yield* db.aggregates.Dated.update({ id: "a" }, mutate)
            const after = (yield* table.rows()).find((row) => row.id?.S === "a")!
            expect(after.createdAt.S).toBe(before.createdAt.S)
            expect(after.updatedAt.S).not.toBe(before.updatedAt.S)
            expect(after.note).toBeDefined()
          }),
        )
      }),
    ),
  ),
]

// ---------------------------------------------------------------------------
// An upsert holding a value with no stored form: an absent attribute, and a key can't outlive it
// ---------------------------------------------------------------------------

const AbsentReads = Schema.Struct({
  id: Schema.String,
  owner: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  und: Schema.UndefinedOr(Schema.String),
  tags: Schema.ReadonlySet(Schema.String),
  optTags: Schema.optional(Schema.ReadonlySet(Schema.String)),
  plain: Schema.optional(Schema.Number),
  score: Schema.optional(Schema.Number),
})

const absentWorld = (on: boolean, composite: ReadonlyArray<string>, extra = {}) =>
  looseWorld(on, {
    N: { model: AbsentReads, indexes: byOwnerOver(composite), ...extra },
  })

const whole = { owner: "o1", note: "n1", und: "u1", tags: new Set(["t"]) }

export const upsertNoStoredFormScenarios: ReadonlyArray<RepairScenario> = [
  ...bothSettings("clearing a composite takes its half with it, as an update does", (h, on) => {
    const w = absentWorld(on, ["und"])
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", ...whole }).asEffect()
        table.clear()
        yield* db.entities.N.upsert({ id: "a", ...whole, und: undefined }).asEffect()
        // What's left of a half is the update's to say, and that takes the stored row.
        expect(commands(table)).toEqual(["getItem", "updateItem"])
        const row = typeOf(yield* table.rows(), "N")
        expect(row.und).toBeUndefined()
        expect(keysOf(row)).toEqual({ pk: "owner_o1", sk: undefined })
        expect(yield* db.entities.N.byOwner({ owner: "o1" }).collect()).toHaveLength(0)
        expect((yield* db.entities.N.get({ id: "a" })).und).toBeUndefined()
      }),
    )
  }),
  ...bothSettings("the other half still moves", (h, on) => {
    const w = absentWorld(on, ["und"])
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", ...whole }).asEffect()
        yield* db.entities.N.upsert({ id: "a", ...whole, owner: "o2", und: undefined }).asEffect()
        expect(keysOf(typeOf(yield* table.rows(), "N"))).toEqual({ pk: "owner_o2", sk: undefined })
      }),
    )
  }),
  ...bothSettings(
    "a hierarchical half truncates, as `.set(parents).remove(leaf)` does",
    (h, on) => {
      const w = absentWorld(on, ["note", "und"])
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.N.upsert({ id: "a", ...whole }).asEffect()
          yield* db.entities.N.upsert({ id: "a", ...whole, und: undefined }).asEffect()
          const upserted = keysOf(typeOf(yield* table.rows(), "N"))
          expect(upserted).toEqual({ pk: "owner_o1", sk: "note_n1" })
          yield* db.entities.N.upsert({ id: "b", ...whole }).asEffect()
          yield* db.entities.N.update({ id: "b" })
            .set({ owner: "o1", note: "n1" })
            .remove(["und"])
            .asEffect()
          expect(keysOf(typeOf(yield* table.rows(), "N", "b"))).toEqual(upserted)
        }),
      )
    },
  ),
  ...bothSettings("a new row cleared from the start has neither", (h, on) => {
    const w = absentWorld(on, ["und"])
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", ...whole, und: undefined }).asEffect()
        const row = typeOf(yield* table.rows(), "N")
        expect(row.und).toBeUndefined()
        expect(row.gsi1sk).toBeUndefined()
        expect((yield* db.entities.N.get({ id: "a" })).und).toBeUndefined()
      }),
    )
  }),
  ...bothSettings(
    "a composite left `undefined` on an optional field stays, with its key",
    (h, on) => {
      const w = absentWorld(on, ["note"])
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          yield* db.entities.N.upsert({ id: "a", ...whole }).asEffect()
          table.clear()
          yield* db.entities.N.upsert({ id: "a", ...whole, note: undefined }).asEffect()
          expect(commands(table)).toEqual(["updateItem"])
          const row = typeOf(yield* table.rows(), "N")
          expect(row.note.S).toBe("n1")
          expect(keysOf(row)).toEqual({ pk: "owner_o1", sk: "note_n1" })
        }),
      )
    },
  ),
  ...bothSettings("an immutable composite left `undefined` stays, with its key", (h, on) => {
    const w = looseWorld(on, {
      N: {
        model: DynamoModel.configure(AbsentReads, { und: { immutable: true } }),
        indexes: byOwnerOver(["und"]),
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", ...whole }).asEffect()
        table.clear()
        yield* db.entities.N.upsert({ id: "a", ...whole, und: undefined }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        const row = typeOf(yield* table.rows(), "N")
        expect(row.und.S).toBe("u1")
        expect(keysOf(row)).toEqual({ pk: "owner_o1", sk: "und_u1" })
      }),
    )
  }),
  ...bothSettings("clearing what no key holds is one write, no read", (h, on) => {
    const w = absentWorld(on, ["note"])
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", ...whole, optTags: new Set(["t"]) }).asEffect()
        table.clear()
        yield* db.entities.N.upsert({
          id: "a",
          ...whole,
          und: undefined,
          tags: new Set(),
          optTags: new Set(),
        }).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        const row = typeOf(yield* table.rows(), "N")
        expect(row.und).toBeUndefined()
        expect(row.tags).toBeUndefined()
        expect(row.optTags).toBeUndefined()
        expect(keysOf(row)).toEqual({ pk: "owner_o1", sk: "note_n1" })
        const read = yield* db.entities.N.get({ id: "a" })
        expect(read.tags).toEqual(new Set())
        expect(read.und).toBeUndefined()
      }),
    )
  }),
  ...bothSettings("a stamped date left `undefined` is stamped, not cleared: one write", (h, on) => {
    const Maybe = Schema.UndefinedOr(Schema.DateTimeUtc)
    const w = looseWorld(on, {
      N: {
        model: DynamoModel.configure(
          Schema.Struct({
            id: Schema.String,
            owner: Schema.optional(Schema.String),
            createdAt: Maybe,
            updatedAt: Maybe,
          }),
          {
            createdAt: { storedAs: DynamoModel.DateEpochMs },
            updatedAt: { storedAs: DynamoModel.DateEpochMs },
          },
        ),
        timestamps: true,
        indexes: {
          ...byOwnerOver(["updatedAt"]),
          byBirth: {
            name: "gsi2",
            pk: half(2, ["owner"]),
            sk: sortHalf(2, ["createdAt"]),
          },
        },
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        const input = { id: "a", owner: "o1", createdAt: undefined, updatedAt: undefined }
        yield* db.entities.N.upsert(input).asEffect()
        const before = typeOf(yield* table.rows(), "N")
        table.clear()
        yield* tick
        yield* db.entities.N.upsert(input).asEffect()
        expect(commands(table)).toEqual(["updateItem"])
        const after = typeOf(yield* table.rows(), "N")
        expect(after.createdAt.N).toBe(before.createdAt.N)
        expect(after.updatedAt.N).not.toBe(before.updatedAt.N)
        expect(after.gsi2sk.S).toBe(before.gsi2sk.S)
        expect(after.gsi1sk.S).toContain(after.updatedAt.N)
      }),
    )
  }),
  ...bothSettings("an `UndefinedOr` date is the caller's: not stamped, and it clears", (h, on) => {
    const Maybe = Schema.UndefinedOr(Schema.DateTimeUtc)
    const w = looseWorld(on, {
      N: {
        model: Schema.Struct({
          id: Schema.String,
          owner: Schema.optional(Schema.String),
          createdAt: Maybe,
          updatedAt: Maybe,
        }),
        timestamps: true,
        indexes: byOwnerOver(["updatedAt"]),
      },
    })
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.put({
          id: "a",
          owner: "o1",
          createdAt: undefined,
          updatedAt: undefined,
        }).asEffect()
        const row = typeOf(yield* table.rows(), "N")
        expect(row.createdAt).toBeUndefined()
        expect(row.updatedAt).toBeUndefined()
        expect(row.gsi1sk).toBeUndefined()
        const when = DateTime.makeUnsafe("2026-01-02T03:04:05.000Z")
        yield* db.entities.N.update({ id: "a" }).set({ updatedAt: when }).asEffect()
        expect(typeOf(yield* table.rows(), "N").gsi1sk.S).toContain("2026-01-02")
        yield* db.entities.N.update({ id: "a" }).remove(["updatedAt"]).asEffect()
        const cleared = typeOf(yield* table.rows(), "N")
        expect(cleared.updatedAt).toBeUndefined()
        expect(cleared.gsi1sk).toBeUndefined()
      }),
    )
  }),
  ...bothSettings(
    "a primary composite left `undefined` names no row, and sends nothing",
    (h, on) => {
      const w = looseWorld(on, {
        N: {
          model: Schema.Struct({ id: Schema.UndefinedOr(Schema.String), owner: Schema.String }),
          indexes: {
            byOwner: { name: "gsi1", pk: half(1, ["owner"]), sk: sortHalf(1, ["id"]) },
          },
        },
      })
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* w.client
          table.clear()
          const exit = yield* Effect.exit(
            db.entities.N.upsert({ id: undefined, owner: "o1" }).asEffect() as Effect.Effect<
              unknown,
              any
            >,
          )
          expect(commands(table)).toEqual([])
          expect(String(exit)).toContain("Failure")
        }),
      )
    },
  ),
  ...bothSettings("a value DynamoDB can't store sends nothing, and says which", (h, on) => {
    const w = absentWorld(on, ["note"])
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        yield* db.entities.N.upsert({ id: "a", ...whole }).asEffect()
        const before = yield* table.rows()
        table.clear()
        const error: any = yield* Effect.flip(
          db.entities.N.upsert({
            id: "a",
            ...whole,
            plain: Number.NaN,
          }).asEffect() as Effect.Effect<unknown, any>,
        )
        expect(error._tag).toBe("ValidationError")
        expect(String(error.cause)).toMatch(/"plain":.*\[EDD-9124\]/)
        expect(commands(table)).toEqual([])
        expect(yield* table.rows()).toEqual(before)
      }),
    )
  }),
  ...bothSettings("a `NaN` feeding a half it writes is a key's refusal, `EDD-9096`", (h, on) => {
    const w = absentWorld(on, ["score"])
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* w.client
        table.clear()
        const error: any = yield* Effect.flip(
          db.entities.N.upsert({
            id: "a",
            ...whole,
            score: Number.NaN,
          }).asEffect() as Effect.Effect<unknown, any>,
        )
        expect(error._tag).toBe("ValidationError")
        expect(error.cause.message).toContain("[EDD-9096]")
        expect(commands(table)).toEqual([])
      }),
    )
  }),
]

// ---------------------------------------------------------------------------
// rekey reading rows through what an absent attribute means
// ---------------------------------------------------------------------------

const absentRepairWorld = (on: boolean, policy: string) =>
  looseWorld(on, {
    N: {
      model: Schema.Struct({
        id: Schema.String,
        und: Schema.UndefinedOr(Schema.String),
        tags: Schema.ReadonlySet(Schema.String),
      }),
      indexes: {
        bySort: {
          name: "gsi1",
          pk: half(1, []),
          sk: sortHalf(1, ["und"]),
          indexPolicy: { pk: policy, sk: policy },
        },
        byPartition: {
          name: "gsi2",
          pk: half(2, ["und"]),
          sk: sortHalf(2, ["id"]),
          indexPolicy: { pk: policy, sk: policy },
        },
      },
    },
  })

/** Rows a current write leaves, and one an earlier release left: no attribute, the key saying the value. */
const seedAbsentRows = (w: any, table: RepairTable) =>
  Effect.gen(function* () {
    const db = yield* w.client
    yield* db.entities.N.put({ id: "has", und: "u1", tags: new Set(["t"]) }).asEffect()
    yield* db.entities.N.put({ id: "none", und: undefined, tags: new Set() }).asEffect()
    yield* db.entities.N.put({ id: "stale", und: "u1", tags: new Set(["t"]) }).asEffect()
    yield* table.seed(withoutKeys(typeOf(yield* table.rows(), "N", "stale"), "und"))
    return db
  })

export const repairNoStoredFormScenarios: ReadonlyArray<RepairScenario> = [
  ...POLICIES.flatMap((policy) =>
    bothSettings(`every row reads, and a current write's are fine: ${policy}`, (h, on) => {
      const w = absentRepairWorld(on, policy)
      return h.on(w, (table) =>
        Effect.gen(function* () {
          const db = yield* seedAbsentRows(w, table)
          const report = yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
          expect(report.indexKeys.missing).toBe(0)
          expect(report.indexKeys.truncated).toBe(0)
          expect(report.skipped.unrecognizedKey ?? 0).toBe(0)
          const rows = yield* table.rows()
          expect(typeOf(rows, "N", "has").gsi1sk.S).toContain("und_u1")
          expect(typeOf(rows, "N", "none").gsi1sk).toBeUndefined()
          expect(typeOf(rows, "N", "none").gsi2pk).toBeUndefined()
          expect(typeOf(rows, "N", "none").und).toBeUndefined()
          expect(typeOf(rows, "N", "none").tags).toBeUndefined()
          const none = yield* db.entities.N.get({ id: "none" })
          expect(none.und).toBeUndefined()
          expect(none.tags).toEqual(new Set())
          expect((yield* db.entities.N.get({ id: "stale" })).und).toBeUndefined()
        }),
      )
    }),
  ),
  ...bothSettings("under `sparse`, a key its value left is repaired away, once", (h, on) => {
    const w = absentRepairWorld(on, "sparse")
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* seedAbsentRows(w, table)
        const dry = yield* db.tables.MainTable.rekey({ repairIndexKeys: true, dryRun: true })
        expect(dry.indexKeys.lagging).toBe(2)
        expect(typeOf(yield* table.rows(), "N", "stale").gsi1sk.S).toContain("und_u1")
        const report = yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
        expect(report.indexKeys.repaired).toBe(2)
        const stale = typeOf(yield* table.rows(), "N", "stale")
        expect(stale.gsi1sk).toBeUndefined()
        expect(stale.gsi2pk).toBeUndefined()
        expect(stale.gsi2sk.S).toContain("id_stale")
        expect(stale.tags.SS).toEqual(["t"])
        const again = yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
        expect(again.indexKeys.lagging).toBe(0)
        expect(again.indexKeys.repaired).toBe(0)
      }),
    )
  }),
  ...bothSettings("under `preserve`, it's what the policy keeps: an update clears it", (h, on) => {
    const w = absentRepairWorld(on, "preserve")
    return h.on(w, (table) =>
      Effect.gen(function* () {
        const db = yield* seedAbsentRows(w, table)
        const before = yield* table.rows()
        const report = yield* db.tables.MainTable.rekey({ repairIndexKeys: true })
        expect(report.indexKeys.lagging).toBe(0)
        expect(report.indexKeys.repaired).toBe(0)
        expect(yield* table.rows()).toEqual(before)
        yield* db.entities.N.update({ id: "stale" }).remove(["und"]).asEffect()
        const stale = typeOf(yield* table.rows(), "N", "stale")
        expect(stale.gsi1sk).toBeUndefined()
        expect(stale.gsi2pk).toBeUndefined()
      }),
    )
  }),
]

export const ALL_SCENARIOS: ReadonlyArray<readonly [string, ReadonlyArray<RepairScenario>]> = [
  ["shapes 16 to 18", writeScenarios],
  ["an append", appendScenarios],
  ["`retain`", retainScenarios],
  ["adjacent positions", adjacentScenarios],
  ["an upsert over a value it keeps", upsertScenarios],
  ["an append's requests", appendRequestScenarios],
  ["aggregates", aggregateScenarios],
  ["an upsert leaving out a composite", upsertOmittedScenarios],
  ["a custom decompose, and a one edge with no entity", decomposeScenarios],
  ["clearing a field, against what the library stamps", clearScenarios],
  ["an upsert holding a value with no stored form", upsertNoStoredFormScenarios],
  ["rekey and what an absent attribute means", repairNoStoredFormScenarios],
]
