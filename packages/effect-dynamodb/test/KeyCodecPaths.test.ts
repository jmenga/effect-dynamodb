/**
 * The key a multi-item op composes from a caller's key is the key `Entity.put` wrote, and the key
 * the entity's own `get` and `delete` compose (`TransactableOps.composePrimaryKeyOrFail`, through
 * `Entity._domainKeyForm`).
 *
 * A codec whose `encode` takes its own output (prepending `x:`) is keyed by its stored text, once:
 * `"MiX"`, stored `"x:MiX"`, is at `docid_x:mix`. Up to 1.39.0 `put`, `get` and `delete` encoded that
 * text once more (`x:x:mix`), and `Batch.get`, `Batch.write` deletes, `transactGet`, and
 * `transactWrite` deletes and condition checks keyed the caller's value encoded once, so they
 * found, deleted and checked nothing. A codec inside a wrapper (`Schema.optional`, a union) is keyed
 * by `put` as its stored text, which the key form takes as it comes (`itemid_5`); those paths keyed
 * the caller's domain value (`itemid_0000000000000005`). For every other key, the key is what 1.39.0
 * composed, byte for byte.
 *
 * The rows 1.39.0 wrote for such codecs are found by key once `rekey` has moved them: the last
 * section seeds them (`helpers/KeyCodecShapes.ts`) under `escapeKeys` off and on, and runs it.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import {
  makeCompositeKeyForm,
  toCompositeKeyRecord,
} from "@effect-dynamodb/schema/internal/CompositeCodec.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { DateTime, Effect, Exit, Layer, Schema, SchemaGetter } from "effect"
import { describe, expect } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import { composePrimaryKey } from "../src/internal/TransactableOps.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import * as VectorSearchEmulation from "../src/VectorSearchEmulation.js"
import * as Shapes from "./helpers/KeyCodecShapes.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

/** A codec whose `encode` takes its own output: `"MiX"` is stored `"x:MiX"`. */
const Prefixed = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((s: string) => s.slice(2)),
    encode: SchemaGetter.transform((s: string) => `x:${s}`),
  }),
)

const schema = DynamoSchema.make({ name: "codec", version: 1 })

class Doc extends Schema.Class<Doc>("Doc")({ docId: Prefixed, n: Schema.Number }) {}
const Docs = Entity.make({
  model: Doc,
  entityType: "Doc",
  primaryKey: {
    pk: { field: "pk", composite: ["docId"] },
    sk: { field: "sk", composite: [] },
  },
})
const Base = Table.make({ schema, entities: { Docs } })

const STORED_KEY = { pk: { S: "$codec#v1#doc#docid_x:mix" }, sk: { S: "$codec#v1#doc" } }

const withTable = <A, E>(
  body: (db: any, table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, E, any>,
) => {
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({ entities: { Docs }, tables: { Base } })
    yield* db.entities.Docs.put({ docId: "MiX", n: 1 }).asEffect()
    table.take()
    return yield* body(db, table)
  }).pipe(Effect.provide(Base.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    E,
    never
  >
}

/** The `Key`s a recorded request named, whatever the command. */
const keysSent = (requests: ReadonlyArray<{ readonly command: string; readonly input: any }>) =>
  requests.flatMap((request) => {
    const input = request.input
    if (input.Key) return [input.Key]
    if (input.RequestItems)
      return Object.values(input.RequestItems as Record<string, any>).flatMap((entry) =>
        Array.isArray(entry)
          ? entry.map((write: any) => write.DeleteRequest?.Key ?? write.PutRequest?.Item)
          : entry.Keys,
      )
    if (input.TransactItems)
      return input.TransactItems.map(
        (item: any) =>
          (item.Get ?? item.Delete ?? item.ConditionCheck ?? item.Update ?? item.Put).Key ??
          item.Put?.Item,
      )
    return []
  })

describe("a multi-item op composes the key Entity.put wrote", () => {
  it.effect("put keys a codec-keyed item by its stored text, once", () =>
    withTable((_db, table) =>
      Effect.sync(() => {
        expect([...table.items.values()].map((row: any) => ({ pk: row.pk, sk: row.sk }))).toEqual([
          STORED_KEY,
        ])
      }),
    ),
  )

  it.effect("the entity's own get finds it", () =>
    withTable((db, table) =>
      Effect.gen(function* () {
        const found = yield* db.entities.Docs.get({ docId: "MiX" })
        expect(found).toMatchObject({ docId: "MiX", n: 1 })
        expect(keysSent(table.take())).toEqual([STORED_KEY])
      }),
    ),
  )

  it.effect("Batch.get finds it", () =>
    withTable((db, table) =>
      Effect.gen(function* () {
        const [found] = yield* Batch.get([db.entities.Docs.get({ docId: "MiX" })])
        expect(found).toMatchObject({ docId: "MiX", n: 1 })
        expect(keysSent(table.take())).toEqual([STORED_KEY])
      }),
    ),
  )

  it.effect("transactGet finds it", () =>
    withTable((db, table) =>
      Effect.gen(function* () {
        const [found] = yield* Transaction.transactGet([db.entities.Docs.get({ docId: "MiX" })])
        expect(found).toMatchObject({ docId: "MiX", n: 1 })
        expect(keysSent(table.take())).toEqual([STORED_KEY])
      }),
    ),
  )

  it.effect("a transactWrite condition check tests it", () =>
    withTable((db, table) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(
          Transaction.transactWrite([
            Transaction.check(
              db.entities.Docs.get({ docId: "MiX" }),
              Expression.condition({ attributeExists: "n" }),
            ),
          ]),
        )
        expect(Exit.isSuccess(result)).toBe(true)
        expect(keysSent(table.take())).toEqual([STORED_KEY])
      }),
    ),
  )

  it.effect("Batch.write deletes it", () =>
    withTable((db, table) =>
      Effect.gen(function* () {
        yield* Batch.write([db.entities.Docs.delete({ docId: "MiX" })])
        expect(keysSent(table.take())).toEqual([STORED_KEY])
        expect(table.items.size).toBe(0)
      }),
    ),
  )

  it.effect("a transactWrite delete deletes it", () =>
    withTable((db, table) =>
      Effect.gen(function* () {
        yield* Transaction.transactWrite([db.entities.Docs.delete({ docId: "MiX" })])
        expect(keysSent(table.take())).toEqual([STORED_KEY])
        expect(table.items.size).toBe(0)
      }),
    ),
  )
})

describe("a key whose encode doesn't take its own output composes as on 1.39.0", () => {
  const cases: ReadonlyArray<readonly [string, Schema.Top, ReadonlyArray<unknown>]> = [
    ["a string", Schema.String, ["MiX", "a#b"]],
    ["a branded string", Schema.String.pipe(Schema.brand("DocId")), ["MiX"]],
    ["a literal", Schema.Literals(["a", "b"]), ["a"]],
    ["a number", Schema.Number, [5, -1.5]],
    ["a bigint", Schema.BigInt, [5n]],
    ["a NumberFromString", Schema.NumberFromString, [5, "5"]],
    ["a Date", Schema.Date, [new Date("2024-01-02T03:04:05.000Z"), "2024-01-02T03:04:05.000Z"]],
    [
      "a DateTimeUtc",
      Schema.DateTimeUtc,
      [DateTime.makeUnsafe("2024-01-02T03:04:05.000Z"), "2024-01-02T03:04:05.000Z"],
    ],
    [
      "a DateTimeUtcFromString",
      Schema.DateTimeUtcFromString,
      [DateTime.makeUnsafe("2024-01-02T03:04:05.000Z"), "2024-01-02T03:04:05.000Z"],
    ],
    ["an optional string", Schema.optional(Schema.String), ["MiX"]],
    ["an optional literal", Schema.optional(Schema.Literals(["a", "b"])), ["a"]],
    ["an optional number", Schema.optional(Schema.Number), [5, -1.5]],
    ["an optional bigint", Schema.optional(Schema.BigInt), [5n]],
    [
      "an optional Date",
      Schema.optional(Schema.Date),
      [new Date("2024-01-02T03:04:05.000Z"), "2024-01-02T03:04:05.000Z"],
    ],
    [
      "an optional DateTimeUtc",
      Schema.optional(Schema.DateTimeUtc),
      [DateTime.makeUnsafe("2024-01-02T03:04:05.000Z"), "2024-01-02T03:04:05.000Z"],
    ],
  ]
  for (const [what, keySchema, values] of cases)
    it(`${what}: the caller's key composes the key 1.39.0 composed`, () => {
      class Item extends Schema.Class<Item>("Item")({ itemId: keySchema as never }) {}
      const Items = Entity.make({
        model: Item,
        entityType: "Item",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      } as never) as unknown as Entity.Entity
      Table.make({ schema, entities: { Items } } as never)
      // 1.39.0 composed the key form of the caller's key, whose codec it encoded first.
      const form139 = makeCompositeKeyForm(
        Items.schemas.inputSchema as unknown as Schema.Top,
        (attr) => {
          throw new Error(attr)
        },
        { text139: true },
      )
      const primary = Items.indexes.primary!
      for (const value of values) {
        const record = toCompositeKeyRecord(form139, { itemId: value })
        expect(composePrimaryKey(Items, { itemId: value })).toEqual({
          pk: KeyComposer.composePk(schema, "Item", primary, record),
          sk: KeyComposer.composeSk(schema, "Item", 1, primary, record),
        })
      }
    })
})

describe("a codec inside a wrapper composes the key Entity.put wrote", () => {
  // `put` encodes the input, then keys the stored text as it comes: `id_5`, `id_x:mix`. Up to
  // 1.39.0 a multi-item op keyed the caller's domain value instead: `5` composed the padded
  // `itemid_0000000000000005` and `"MiX"` composed `itemid_mix`, keys no `put` writes, so it found,
  // checked and deleted nothing. The stored text given (`"5"`) composed the key `put` wrote, and still
  // does.
  const cases: ReadonlyArray<
    readonly [string, Schema.Top, unknown, string, ReadonlyArray<unknown>]
  > = [
    ["an optional NumberFromString", Schema.optional(Schema.NumberFromString), 5, "5", [5, "5"]],
    ["an optional BigIntFromString", Schema.optional(Schema.BigIntFromString), 5n, "5", [5n, "5"]],
    [
      "a NumberFromString or a literal",
      Schema.Union([Schema.NumberFromString, Schema.Literal("none")]),
      5,
      "5",
      [5, "5"],
    ],
    ["an optional string codec", Schema.optional(Prefixed), "MiX", "x:mix", ["MiX"]],
  ]
  for (const [what, keySchema, value, keyText, given] of cases) {
    class Item extends Schema.Class<Item>("Item")({
      itemId: keySchema as never,
      n: Schema.Number,
    }) {}
    const Items = Entity.make({
      model: Item,
      entityType: "Item",
      primaryKey: {
        pk: { field: "pk", composite: ["itemId"] },
        sk: { field: "sk", composite: [] },
      },
    } as never) as any
    const Wrapped = Table.make({ schema, entities: { Items } } as never) as any
    const key = { pk: { S: `$codec#v1#item#itemid_${keyText}` }, sk: { S: "$codec#v1#item" } }
    const withItem = (
      body: (
        db: any,
        table: ReturnType<typeof makeRecordingTable>,
      ) => Effect.Effect<void, unknown, any>,
    ) => {
      const table = makeRecordingTable()
      return Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: { Items },
          tables: { Wrapped },
        } as never) as Effect.Effect<any>
        yield* db.entities.Items.put({ itemId: value, n: 1 }).asEffect()
        expect([...table.items.values()].map((row: any) => ({ pk: row.pk, sk: row.sk }))).toEqual([
          key,
        ])
        table.take()
        yield* body(db, table)
      }).pipe(
        Effect.provide(Wrapped.layer({ name: "t" })),
        Effect.provide(table.layer),
      ) as Effect.Effect<void>
    }
    for (const id of given) {
      const as =
        typeof id === "string" && typeof value !== "string" ? "its stored text" : "its value"
      it.effect(`${what}, given ${as}: Batch.get and transactGet find it`, () =>
        withItem((db, table) =>
          Effect.gen(function* () {
            const [batch] = yield* Batch.get([db.entities.Items.get({ itemId: id })])
            const [transact] = yield* Transaction.transactGet([
              db.entities.Items.get({ itemId: id }),
            ])
            expect(batch).toMatchObject({ itemId: value, n: 1 })
            expect(transact).toMatchObject({ itemId: value, n: 1 })
            expect(keysSent(table.take())).toEqual([key, key])
          }),
        ),
      )
    }
    it.effect(`${what}: a check tests it, and Batch.write and transactWrite delete it`, () =>
      withItem((db, table) =>
        Effect.gen(function* () {
          yield* Transaction.transactWrite([
            Transaction.check(
              db.entities.Items.get({ itemId: value }),
              Expression.condition({ attributeExists: "n" }),
            ),
          ])
          yield* Batch.write([db.entities.Items.delete({ itemId: value })])
          expect(table.items.size).toBe(0)
          expect(keysSent(table.take())).toEqual([key, key])
          yield* db.entities.Items.put({ itemId: value, n: 1 }).asEffect()
          table.take()
          yield* Transaction.transactWrite([db.entities.Items.delete({ itemId: value })])
          expect(table.items.size).toBe(0)
          expect(keysSent(table.take())).toEqual([key])
        }),
      ),
    )
  }
})

/**
 * With `escapeKeys: true` a time series' event key holds its `orderBy` value's key form: for a codec
 * `encode` takes on its own output, its stored text (`#e#x:t1`), the bound `history().where()`
 * composes. 1.39.0's `append` keyed it encoded once more (`#e#x:x:t1`), and its bound found
 * nothing: `eq("t1")` and `lt("t2")` returned no events.
 */
describe("history().where() on a codec orderBy, escapeKeys on", () => {
  class Reading extends Schema.Class<Reading>("Reading")({
    sensorId: Schema.String,
    at: Prefixed,
    n: Schema.Number,
  }) {}
  const Readings = Entity.make({
    model: Reading,
    entityType: "Reading",
    primaryKey: {
      pk: { field: "pk", composite: ["sensorId"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({ sensorId: Schema.String, at: Prefixed, n: Schema.Number }),
    },
  })
  const OnTable = Table.make({
    schema: DynamoSchema.make({ name: "on", version: 1, escapeKeys: true }),
    entities: { Readings },
  })

  it.effect("finds the events append wrote", () => {
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({ entities: { Readings }, tables: { OnTable } })
      for (const at of ["t1", "t2"]) {
        yield* db.entities.Readings.append({ sensorId: "s", at, n: 1 }).asEffect()
      }
      expect([...table.items.values()].map((row) => row.sk!.S).sort()).toEqual([
        "$on#v1#reading",
        "$on#v1#reading#e#x:t1",
        "$on#v1#reading#e#x:t2",
      ])
      const where = (f: (t: any, ops: any) => unknown) =>
        db.entities.Readings.history({ sensorId: "s" }).where(f).collect() as Effect.Effect<
          ReadonlyArray<Reading>
        >
      const ats = (events: ReadonlyArray<Reading>) => events.map((event) => event.at)
      expect(ats(yield* where((t, { eq }) => eq(t.at, "t1")))).toEqual(["t1"])
      expect(ats(yield* where((t, { lt }) => lt(t.at, "t2")))).toEqual(["t1"])
      expect(ats(yield* where((t, { gte }) => gte(t.at, "t2")))).toEqual(["t2"])
    }).pipe(
      Effect.provide(OnTable.layer({ name: "t" })),
      Effect.provide(table.layer),
    ) as Effect.Effect<void, unknown>
  })
})

/**
 * The rows published 1.39.0 wrote (`fixtures/key-codec-1.39.0.json`, `helpers/KeyCodecShapes.ts`),
 * seeded on a recording table, under `escapeKeys` off and on, and the rows of the first moved to
 * `escapeKeys: true`: one `rekey` pass moves every row kind to the key a write now gives it, which
 * a fresh write of the same values matches byte for byte, and every read finds them after it.
 */
describe.each([
  ["escapeKeys off", "off", "off"],
  ["escapeKeys on", "on", "on"],
  ["escapeKeys off, then on, in one pass", "off", "on"],
] as const)("rows 1.39.0 wrote for codec-keyed entities, %s", (_label, written, now) => {
  const w = Shapes.world(now)
  const rowsOf = (rows: ReadonlyArray<Shapes.Row>) => {
    const table = makeRecordingTable({ indexes: Shapes.indexes })
    for (const row of rows) table.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
    return table
  }
  const seeded = () => rowsOf(Shapes.fixture[written].rows)
  const layerOf = (table: ReturnType<typeof makeRecordingTable>) =>
    Layer.mergeAll(
      VectorSearchEmulation.layer(table.layer, { tables: { Base: w.Base } }),
      w.Base.layer({ name: "kc" }),
      Embedder.layerTest({ dimensions: 8 }),
    )
  const withDb = <A>(
    table: ReturnType<typeof makeRecordingTable>,
    body: (db: any) => Effect.Effect<A, unknown, any>,
  ) =>
    Effect.flatMap(DynamoClient.make({ entities: w.entities, tables: { Base: w.Base } }), (db) =>
      body(db),
    ).pipe(Effect.provide(layerOf(table))) as Effect.Effect<A, unknown, never>
  const rekey = (table: ReturnType<typeof makeRecordingTable>) =>
    withDb(table, (db) => db.tables.Base.rekey() as Effect.Effect<Table.RekeyReport>)
  const ZERO = { item: 0, snapshot: 0, tombstone: 0, outbox: 0, event: 0, aggregate: 0, stream: 0 }

  if (written === now)
    it("1.39.0 found none of them by a caller's values, but its own get and a row check", () => {
      expect(Shapes.fixture.writtenBy["effect-dynamodb"]).toBe("1.39.0")
      for (const read of Shapes.reads.filter((read) => read.label in Shapes.fixture[written].reads))
        expect(Shapes.fixture[written].reads[read.label], read.label).toEqual({
          ok: read.on139 ?? (typeof read.expected === "number" ? 0 : { Docs: 0, Notes: 0 }),
        })
    })

  it.effect("before rekey, an item's own get finds it no more", () =>
    Effect.gen(function* () {
      const got = yield* withDb(seeded(), (db) =>
        Effect.exit(db.entities.Docs.get({ docId: "Mi X", part: "P 1" })),
      )
      expect(Exit.isFailure(got) && JSON.stringify(got.cause)).toContain("ItemNotFound")
    }),
  )

  it.effect(
    "rekey moves every row kind to the key a write gives it now; a rerun moves nothing",
    () =>
      Effect.gen(function* () {
        const table = seeded()
        const report = yield* rekey(table)
        expect(report.moved).toEqual(Shapes.MOVED)
        expect(report.indexKeysRewritten).toBe(Shapes.REWRITTEN)
        // The sentinel holds the stored text, which 1.39.0 keyed once: it moves only to escape it.
        expect(report.sentinelsMoved).toBe(written === now ? 0 : 1)
        expect(report.conflicts).toEqual([])
        expect(report.skipped).toEqual({
          notLibrary: 0,
          unregistered: 0,
          unrecognizedKey: 0,
          rootNotSeen: 0,
        })

        const fresh = makeRecordingTable({ indexes: Shapes.indexes })
        yield* withDb(fresh, Shapes.writeAll)
        expect(Shapes.comparable(table.items.values())).toEqual(
          Shapes.comparable(fresh.items.values()),
        )

        const again = yield* rekey(table)
        expect(again.moved).toEqual(ZERO)
        expect(again.indexKeysRewritten).toBe(0)
        expect(again.sentinelsMoved).toBe(0)
        // Every row but the member's uniqueness sentinel, which is no item.
        expect(again.unchanged).toBe(again.scanned - 1)
        expect(again.conflicts).toEqual([])
      }),
  )

  for (const read of Shapes.reads)
    it.effect(`after rekey, ${read.label} finds them`, () =>
      Effect.gen(function* () {
        const table = seeded()
        yield* rekey(table)
        expect(yield* withDb(table, (db) => read.run(db, w))).toEqual(read.expected)
      }),
    )

  if (written === now)
    it.effect("a product 1.39.0's reembed moved holds the partition a write gives it now", () =>
      Effect.gen(function* () {
        const product = (rows: Iterable<Shapes.Row>) =>
          [...rows].find((row) => row.__edd_e__?.S === "Product")!.__edd_vp_vec1__?.S
        const fresh = makeRecordingTable({ indexes: Shapes.indexes })
        yield* withDb(fresh, Shapes.writeAll)
        const written = product(fresh.items.values())
        expect(product(Shapes.fixture[now].rows)).not.toBe(written)
        expect(product(Shapes.fixture[now].rowsAfterReembed)).toBe(written)

        const table = rowsOf(Shapes.fixture[now].rowsAfterReembed)
        const report = yield* rekey(table)
        expect(report.indexKeysRewritten).toBe(Shapes.REWRITTEN - 1)
        expect(product(table.items.values())).toBe(written)
        expect(yield* withDb(table, (db) => db.entities.Products.reembed())).toBe(1)
        expect(product(table.items.values())).toBe(written)
      }),
    )
})

/**
 * An item, its version snapshot and a time series' event 1.39.0 wrote under `escapeKeys` off, keyed
 * by the codec's doubled text, and the same three a write gave the stored text's key since (the
 * second row a put writes beside one not yet moved): turning `escapeKeys` on, one pass moves both
 * to one key. The write's row, the newer, is the one there after it, whichever the scan meets
 * first; 1.39.0's is left and reported `bothKeys`, the same in either order, and again by a rerun.
 */
describe("1.39.0's rows and a write's since, moved by one pass to escapeKeys on", () => {
  const off = Shapes.world("off")
  const on = Shapes.world("on")
  const withDb = <A>(
    world: ReturnType<typeof Shapes.world>,
    table: ReturnType<typeof makeRecordingTable>,
    body: (db: any) => Effect.Effect<A, unknown, any>,
    first?: (row: Shapes.Row) => boolean,
  ) =>
    Effect.flatMap(
      DynamoClient.make({ entities: world.entities, tables: { Base: world.Base } }),
      (db) => body(db),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          VectorSearchEmulation.layer(
            first === undefined ? table.layer : Shapes.scanningFirst(table.layer, first),
            { tables: { Base: world.Base } },
          ),
          world.Base.layer({ name: "kc" }),
          Embedder.layerTest({ dimensions: 8 }),
        ),
      ),
    ) as Effect.Effect<A, unknown, never>
  const seeded = Effect.gen(function* () {
    const table = makeRecordingTable({ indexes: Shapes.indexes })
    for (const row of Shapes.fixture.off.rows) table.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
    yield* withDb(off, table, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Docs.put({ docId: "Mi X", part: "P 1", code: "C 1", n: 9 }).asEffect()
        yield* db.entities.Revs.put({ cardId: "Mi X", part: "P 1", n: 9 }).asEffect()
        yield* db.entities.Readings.append({ sensorId: "Mi X", at: "T 2", n: 9 }).asEffect()
      }),
    )
    return table
  })
  const doubled = (row: Shapes.Row) => row.pk?.S?.includes("x:x:") === true
  const orders = [
    ["1.39.0's rows first", doubled],
    ["the write's rows first", (row: Shapes.Row) => !doubled(row)],
  ] as const
  /** `rekey`, one row at a time, `first`'s rows first; the report, its conflicts in key order. */
  const rekeyInOrder = (
    table: ReturnType<typeof makeRecordingTable>,
    first: (row: Shapes.Row) => boolean,
  ) =>
    withDb(
      on,
      table,
      (db) =>
        Effect.map(
          db.tables.Base.rekey({ concurrency: 1 }) as Effect.Effect<Table.RekeyReport>,
          (report) => ({
            ...report,
            capacity: undefined,
            conflicts: [...report.conflicts].sort((a, b) =>
              JSON.stringify(a.key) < JSON.stringify(b.key) ? -1 : 1,
            ),
          }),
        ),
      first,
    )
  const read = (table: ReturnType<typeof makeRecordingTable>) =>
    withDb(on, table, (db) =>
      Effect.all({
        doc: db.entities.Docs.get({ docId: "Mi X", part: "P 1" }),
        rev: db.entities.Revs.get({ cardId: "Mi X", part: "P 1" }),
        v1: db.entities.Revs.getVersion({ cardId: "Mi X", part: "P 1" }, 1),
        reading: db.entities.Readings.get({ sensorId: "Mi X" }),
        events: db.entities.Readings.history({ sensorId: "Mi X" }).collect(),
      }),
    ) as Effect.Effect<any>

  for (const [order, first] of orders)
    it.effect(`the write's rows are at their keys after it, ${order}, and a rerun agrees`, () =>
      Effect.gen(function* () {
        const table = yield* seeded
        const report = yield* rekeyInOrder(table, first)
        expect(report.conflicts.map((c) => [c.member, c.kind, c.reason])).toEqual([
          ["Doc", "item", "bothKeys"],
          ["Reading", "item", "bothKeys"],
          ["Reading", "event", "bothKeys"],
          ["Rev", "item", "bothKeys"],
          ["Rev", "snapshot", "bothKeys"],
        ])
        expect(report.conflicts.every((c) => JSON.stringify(c.key).includes("x:x:"))).toBe(true)
        const got = yield* read(table)
        expect(got.doc.n).toBe(9)
        expect(got.rev.n).toBe(9)
        expect(got.v1.n).toBe(9)
        expect(got.reading.n).toBe(9)
        expect(got.events.find((e: { at: string }) => e.at === "T 2")?.n).toBe(9)

        const again = yield* rekeyInOrder(table, first)
        expect(again.conflicts).toEqual(report.conflicts)
        expect(Object.values(again.moved).every((n) => n === 0)).toBe(true)
      }),
    )

  it.effect("rekey reports and leaves the same in either order", () =>
    Effect.gen(function* () {
      const a = yield* seeded
      const b = yield* seeded
      const reports = [yield* rekeyInOrder(a, orders[0][1]), yield* rekeyInOrder(b, orders[1][1])]
      expect(reports[0]).toEqual(reports[1])
      expect(Shapes.comparable(a.items.values())).toEqual(Shapes.comparable(b.items.values()))
    }),
  )
})

/**
 * A geo index's partition key holds a codec `pkFilter` composite (`depot`): 1.39.0 keyed it encoded
 * once more (`fixtures/key-codec-geo-1.39.0.json`, in the geo package, whose `GeoSearch.test.ts`
 * searches it). `rekey` rewrites it in place to what a write gives it now.
 */
describe.each([
  ["escapeKeys off", "off", "off"],
  ["escapeKeys on", "on", "on"],
  ["escapeKeys off, then on, in one pass", "off", "on"],
] as const)("a geo index's partition 1.39.0 wrote, %s", (_label, written, now) => {
  const geo = JSON.parse(
    readFileSync(
      new URL("../../effect-dynamodb-geo/test/fixtures/key-codec-geo-1.39.0.json", import.meta.url),
      "utf8",
    ),
  )
  const Fleet = Entity.make({
    model: Schema.Struct({
      vehicleId: Schema.String,
      depot: Prefixed,
      latitude: Schema.Number,
      longitude: Schema.Number,
      timestamp: Schema.Number,
      cell: Schema.optional(Schema.String),
      parentCell: Schema.optional(Schema.String),
      timePartition: Schema.optional(Schema.String),
    }),
    entityType: "FleetVehicle",
    primaryKey: {
      pk: { field: "pk", composite: ["vehicleId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byCell: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["depot", "parentCell", "timePartition"] },
        sk: { field: "gsi1sk", composite: ["cell"] },
      },
    },
  })
  const FleetTable = Table.make({
    schema: DynamoSchema.make({ name: "kc", version: 1, escapeKeys: now === "on" }),
    entities: { Fleet },
  })
  const withDb = <A>(
    table: ReturnType<typeof makeRecordingTable>,
    body: (db: any) => Effect.Effect<A, unknown, any>,
  ) =>
    Effect.flatMap(DynamoClient.make({ entities: { Fleet }, tables: { FleetTable } }), (db) =>
      body(db),
    ).pipe(
      Effect.provide(Layer.merge(table.layer, FleetTable.layer({ name: "geo" }))),
    ) as Effect.Effect<A, unknown, never>

  it.effect("rekey rewrites it to the key a put of its values writes now", () =>
    Effect.gen(function* () {
      expect(geo[written].reads["nearby({ pkFilter: { depot } })"]).toEqual({ ok: 0 })
      const [row] = geo[written].rows as ReadonlyArray<Shapes.Row>
      const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
      table.items.set(`${row!.pk!.S}|${row!.sk!.S}`, row!)
      const report = yield* withDb(
        table,
        (db) => db.tables.FleetTable.rekey() as Effect.Effect<Table.RekeyReport>,
      )
      expect(report.indexKeysRewritten).toBe(1)

      const fresh = makeRecordingTable()
      yield* withDb(fresh, (db) =>
        db.entities.Fleet.put({
          vehicleId: "v1",
          depot: "D 1",
          latitude: Number(row!.latitude!.N),
          longitude: Number(row!.longitude!.N),
          timestamp: Number(row!.timestamp!.N),
          cell: row!.cell!.S,
          parentCell: row!.parentCell!.S,
          timePartition: row!.timePartition!.S,
        }).asEffect(),
      )
      expect(Shapes.comparable(table.items.values())).toEqual(
        Shapes.comparable(fresh.items.values()),
      )
      expect([...table.items.values()][0]!.gsi1pk!.S).toContain(
        now === "on" ? "depot_x:d%201#" : "depot_x:d 1#",
      )
    }),
  )
})
