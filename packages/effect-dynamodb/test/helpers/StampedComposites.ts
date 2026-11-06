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
import { DateTime, Effect, Schema } from "effect"
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
const composedFrom = (w: any, row: StoredRow): Record<string, unknown> =>
  KeyComposer.composeAllKeys(
    w.schema,
    "Ticket",
    1,
    w.Tickets.indexes,
    w.Tickets._keyForm(fromAttributeMap(row)),
  )

const keyBytes = (attribute: any): unknown =>
  attribute === undefined ? undefined : (attribute.S ?? [...attribute.B])

/** Every index key on `row` is what a `put` of its values composes, and every composable one is there. */
const expectKeysOfValues = (w: any, row: StoredRow): void => {
  const composed = composedFrom(w, row)
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
          // A single UpdateItem can't say what's stored: it reads first.
          expect(table.requests().map((request) => request.command)).toContain("getItem")
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
  ...bothSettings(
    "an append over `createdAt` reads the row, and the key holds what it holds",
    (h, on) => {
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
    },
  ),
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
  return { schema, MainTable, client } as any
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
        // A root declaring the field has to name it, and the stamp wins: the key follows the stamp.
        yield* db.aggregates.Created.create({ id: "a", createdAt: supplied })
        yield* db.aggregates.Updated.create({ id: "a", updatedAt: supplied })
        const created = typeOf(yield* table.rows(), "Created")
        const updated = typeOf(yield* table.rows(), "Updated")
        expect(created.createdAt.S).not.toBe(SUPPLIED)
        expect(created.gsi1sk.S).toContain(stamp(created, "createdAt"))
        expect(updated.gsi1sk.S).toContain(stamp(updated, "updatedAt"))
        expect((yield* db.aggregates.Created.list({})).data).toHaveLength(1)
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

export const ALL_SCENARIOS: ReadonlyArray<readonly [string, ReadonlyArray<RepairScenario>]> = [
  ["shapes 16 to 18", writeScenarios],
  ["an append", appendScenarios],
  ["`retain`", retainScenarios],
  ["adjacent positions", adjacentScenarios],
]
