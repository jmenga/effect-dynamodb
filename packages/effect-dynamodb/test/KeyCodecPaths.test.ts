/**
 * The key a multi-item op composes from a caller's key is the key `Entity.put` wrote, and the key
 * the entity's own `get` and `delete` compose (`TransactableOps.composePrimaryKeyOrFail`, through
 * `Entity._domainKeyForm`).
 *
 * `put` encodes its input (`inputSchema`), then applies the composite key form, which encodes a
 * transformed composite again when its `encode` takes its own output: a codec prepending `x:` stores
 * `"MiX"` under the key text `x:x:mix`. The standalone `get` and `delete` do the same (`encodeKey`,
 * then the key form). Up to 1.39.0 `Batch.get`, `Batch.write` deletes, `transactGet`, and
 * `transactWrite` deletes and condition checks applied the key form alone, so they composed
 * `x:mix` and found, deleted and checked nothing. A codec inside a wrapper (`Schema.optional`, a
 * union) is keyed by `put` as its stored text, which the key form takes as it comes (`itemid_5`);
 * those paths keyed the caller's domain value (`itemid_0000000000000005`). For every other key, the
 * key is what 1.39.0 composed, byte for byte.
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
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

const STORED_KEY = { pk: { S: "$codec#v1#doc#docid_x:x:mix" }, sk: { S: "$codec#v1#doc" } }

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
  it.effect("put stores a codec-keyed item under the key its encode gives twice", () =>
    withTable((_db, table) =>
      Effect.sync(() => {
        expect([...table.items.values()].map((row: any) => ({ pk: row.pk, sk: row.sk }))).toEqual([
          STORED_KEY,
        ])
      }),
    ),
  )

  it.effect("the entity's own get finds it (as on 1.39.0)", () =>
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
      // 1.39.0 composed `composePrimaryKey` of the caller's key; the domain key form adds a step.
      for (const value of values)
        expect(composePrimaryKey(Items, Items._domainKeyForm({ itemId: value }))).toEqual(
          composePrimaryKey(Items, { itemId: value }),
        )
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
 * The rows published 1.39.0 wrote (`fixtures/key-codec-1.39.0.json`, `helpers/KeyCodecShapes.ts`),
 * seeded on a recording table: every read that composes a key from a caller's values finds them,
 * and `put` and the other writes store them byte for byte as 1.39.0 did.
 */
describe("rows 1.39.0 wrote for codec-keyed entities", () => {
  const seeded = () => {
    const table = makeRecordingTable({
      indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" }, gsi2: { pk: "gsi2pk", sk: "gsi2sk" } },
    })
    for (const row of Shapes.fixture.rows) table.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
    return table
  }
  const layerOf = (table: ReturnType<typeof makeRecordingTable>) =>
    Layer.mergeAll(
      VectorSearchEmulation.layer(table.layer, { tables: { Base: Shapes.Base } }),
      Shapes.Base.layer({ name: "kc" }),
      Embedder.layerTest({ dimensions: 8 }),
    )
  const withDb = <A>(
    table: ReturnType<typeof makeRecordingTable>,
    body: (db: any) => Effect.Effect<A, unknown, any>,
  ) =>
    Effect.flatMap(
      DynamoClient.make({ entities: Shapes.entities, tables: { Base: Shapes.Base } }),
      (db) => body(db),
    ).pipe(Effect.provide(layerOf(table))) as Effect.Effect<A, unknown, never>

  it("1.39.0 found none of them, but where a row check took a range's rows", () => {
    for (const read of Shapes.reads.filter((read) => read.label in Shapes.fixture.reads))
      expect(Shapes.fixture.reads[read.label], read.label).toEqual({
        ok: read.on139 ?? (typeof read.expected === "number" ? 0 : { Docs: 0, Notes: 0 }),
      })
  })

  for (const read of Shapes.reads)
    it.effect(`${read.label} finds them`, () =>
      Effect.gen(function* () {
        const table = seeded()
        expect(yield* withDb(table, read.run)).toEqual(read.expected)
      }),
    )

  it.effect("the writes store the keys 1.39.0 stored", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable({
        indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" }, gsi2: { pk: "gsi2pk", sk: "gsi2sk" } },
      })
      yield* withDb(table, (db) =>
        Effect.gen(function* () {
          const e = db.entities
          yield* e.Docs.put({ docId: "MiX", part: "P1", code: "C1", n: 1 }).asEffect()
          yield* e.Docs.put({ docId: "MiX", part: "P2", code: "C1", n: 2 }).asEffect()
          yield* e.Notes.put({ noteId: "n1", code: "C1", part: "P9" }).asEffect()
          yield* e.Cards.put({ cardId: "MiX", part: "P1", n: 1 }).asEffect()
          yield* e.Cards.put({ cardId: "MiX", part: "P2", n: 2 }).asEffect()
          yield* e.Cards.delete({ cardId: "MiX", part: "P2" }).asEffect()
          yield* e.Revs.put({ cardId: "MiX", part: "P1", n: 1 }).asEffect()
          yield* e.Revs.update({ cardId: "MiX", part: "P1" }).set({ n: 2 }).asEffect()
          yield* e.Readings.append({ sensorId: "MiX", at: "T1", n: 1 }).asEffect()
          yield* e.Readings.append({ sensorId: "MiX", at: "T2", n: 2 }).asEffect()
          yield* e.Zones.put({
            zoneId: "z1",
            region: "North",
            agency: "AgA",
            price: 500,
          }).asEffect()
          yield* e.Tags.put({ tagId: "t1", owner: "o1", kind: "K1", part: "P1" }).asEffect()
          yield* e.Tags.put({ tagId: "t2", owner: "o1", kind: "K2", part: "P2" }).asEffect()
          yield* e.Products.put({ productId: "p1", tenantId: "Acme", name: "lamp" }).asEffect()
        }),
      )
      expect(Shapes.keysOf([...table.items.values()])).toEqual(Shapes.keysOf(Shapes.fixture.rows))
    }),
  )

  it.effect(
    "reembed keeps the partition put wrote, and moves back one 1.39.0's reembed moved",
    () =>
      Effect.gen(function* () {
        const product = (rows: ReadonlyArray<Shapes.Row>) =>
          rows.find((row) => row.__edd_e__?.S === "Product")!.__edd_vp_vec1__?.S
        const written = product(Shapes.fixture.rows)
        expect(written).toBe("$kc#v1#product#tenantid_x:x:acme")
        // 1.39.0's reembed rewrote it once encoded, where no query of the partition finds it.
        expect(product(Shapes.fixture.rowsAfterReembed)).toBe("$kc#v1#product#tenantid_x:acme")

        const table = seeded()
        expect(yield* withDb(table, (db) => db.entities.Products.reembed())).toBe(1)
        expect(product([...table.items.values()])).toBe(written)

        const moved = seeded()
        for (const row of Shapes.fixture.rowsAfterReembed)
          moved.items.set(`${row.pk!.S}|${row.sk!.S}`, row)
        expect(yield* withDb(moved, (db) => db.entities.Products.reembed())).toBe(1)
        expect(product([...moved.items.values()])).toBe(written)
      }),
  )
})
