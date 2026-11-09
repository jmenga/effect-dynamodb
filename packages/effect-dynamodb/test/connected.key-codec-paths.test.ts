/**
 * Against DynamoDB Local: a multi-item op finds, checks and deletes a codec-keyed item by the key
 * `Entity.put` wrote (`KeyCodecPaths.test.ts` has the requests). Up to 1.39.0 `Batch.get` and
 * `transactGet` returned nothing for it, a condition check on it was cancelled, and `Batch.write`
 * and `transactWrite` deletes left it in place.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import {
  type AttributeValue,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import { Config, Effect, Exit, Layer, Schema, SchemaGetter } from "effect"
import { describe, expect } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import * as VectorSearchEmulation from "../src/VectorSearchEmulation.js"
import * as P from "./helpers/KeyCodecProjection.js"
import * as Shapes from "./helpers/KeyCodecShapes.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}
const describeConnected = dynamoAvailable ? describe : describe.skip

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const raw = new DynamoDBClient({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

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

type Row = Record<string, AttributeValue>

/** The entity a test puts its item with, on a table holding it. */
type Setup = {
  readonly member: string
  readonly entities: Record<string, unknown>
  readonly base: any
  readonly item: Record<string, unknown>
}
const docs: Setup = { member: "Docs", entities: { Docs }, base: Base, item: { docId: "MiX", n: 1 } }

let tables = 0
/** Puts the item on a fresh table, runs `body`, and returns its result and the rows left. */
const run = <A>(body: (db: any) => Effect.Effect<A, unknown, any>, setup: Setup = docs) => {
  const tableName = `key-codec-${Date.now()}-${tables++}`
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
      })
    }),
    () =>
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: setup.entities,
          tables: { Base: setup.base },
        } as never) as Effect.Effect<any>
        yield* db.entities[setup.member].put(setup.item).asEffect()
        const result = yield* Effect.exit(body(db))
        const rows = yield* Effect.promise(async () => {
          const scan = await raw.send(
            new ScanCommand({ TableName: tableName, ConsistentRead: true }),
          )
          return (scan.Items ?? []) as ReadonlyArray<Row>
        })
        return { result, rows }
      }),
    () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, setup.base.layer({ name: tableName }))),
  ) as unknown as Effect.Effect<{ result: Exit.Exit<A, unknown>; rows: ReadonlyArray<Row> }>
}

describeConnected("a multi-item op composes the key Entity.put wrote (connected)", () => {
  it.effect("put stores the item under the key its encode gives twice", () =>
    Effect.gen(function* () {
      const { rows } = yield* run(() => Effect.void)
      expect(rows.map((row) => row.pk?.S)).toEqual(["$codec#v1#doc#docid_x:x:mix"])
    }),
  )

  it.effect("Batch.get finds it", () =>
    Effect.gen(function* () {
      const { result } = yield* run((db) => Batch.get([db.entities.Docs.get({ docId: "MiX" })]))
      expect(Exit.isSuccess(result) && result.value[0]).toMatchObject({ docId: "MiX", n: 1 })
    }),
  )

  it.effect("transactGet finds it", () =>
    Effect.gen(function* () {
      const { result } = yield* run((db) =>
        Transaction.transactGet([db.entities.Docs.get({ docId: "MiX" })]),
      )
      expect(Exit.isSuccess(result) && result.value[0]).toMatchObject({ docId: "MiX", n: 1 })
    }),
  )

  it.effect("a transactWrite condition check tests it", () =>
    Effect.gen(function* () {
      const { result } = yield* run((db) =>
        Transaction.transactWrite([
          Transaction.check(
            db.entities.Docs.get({ docId: "MiX" }),
            Expression.condition({ attributeExists: "n" }),
          ),
        ]),
      )
      expect(Exit.isSuccess(result)).toBe(true)
    }),
  )

  it.effect("Batch.write deletes it", () =>
    Effect.gen(function* () {
      const { result, rows } = yield* run((db) =>
        Batch.write([db.entities.Docs.delete({ docId: "MiX" })]),
      )
      expect(Exit.isSuccess(result)).toBe(true)
      expect(rows).toEqual([])
    }),
  )

  it.effect("a transactWrite delete deletes it", () =>
    Effect.gen(function* () {
      const { result, rows } = yield* run((db) =>
        Transaction.transactWrite([db.entities.Docs.delete({ docId: "MiX" })]),
      )
      expect(Exit.isSuccess(result)).toBe(true)
      expect(rows).toEqual([])
    }),
  )
})

describeConnected("a codec inside a wrapper composes the key Entity.put wrote (connected)", () => {
  // Up to 1.39.0 a multi-item op keyed a domain `5` as the padded `itemid_0000000000000005` and a
  // domain `"MiX"` as `itemid_mix`, keys no `put` writes.
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
    const setup: Setup = {
      member: "Items",
      entities: { Items },
      base: Table.make({ schema, entities: { Items } } as never),
      item: { itemId: value, n: 1 },
    }
    it.effect(`${what}: put keys its stored text, and Batch.get and transactGet find it`, () =>
      Effect.gen(function* () {
        const { result, rows } = yield* run(
          (db) =>
            Effect.all(
              given.flatMap((id) => [
                Batch.get([db.entities.Items.get({ itemId: id })]),
                Transaction.transactGet([db.entities.Items.get({ itemId: id })]),
              ]),
            ),
          setup,
        )
        expect(rows.map((row) => row.pk?.S)).toEqual([`$codec#v1#item#itemid_${keyText}`])
        expect(Exit.isSuccess(result) && result.value.map(([found]) => found)).toEqual(
          given.flatMap(() => [
            expect.objectContaining({ itemId: value, n: 1 }),
            expect.objectContaining({ itemId: value, n: 1 }),
          ]),
        )
      }),
    )
    it.effect(`${what}: a check tests it, and a Batch.write delete deletes it`, () =>
      Effect.gen(function* () {
        const { result, rows } = yield* run(
          (db) =>
            Effect.gen(function* () {
              yield* Transaction.transactWrite([
                Transaction.check(
                  db.entities.Items.get({ itemId: value }),
                  Expression.condition({ attributeExists: "n" }),
                ),
              ])
              yield* Batch.write([db.entities.Items.delete({ itemId: value })])
            }),
          setup,
        )
        expect(Exit.isSuccess(result)).toBe(true)
        expect(rows).toEqual([])
      }),
    )
    it.effect(`${what}: a transactWrite delete deletes it`, () =>
      Effect.gen(function* () {
        const { result, rows } = yield* run(
          (db) => Transaction.transactWrite([db.entities.Items.delete({ itemId: value })]),
          setup,
        )
        expect(Exit.isSuccess(result)).toBe(true)
        expect(rows).toEqual([])
      }),
    )
  }
})

/**
 * The rows published 1.39.0 wrote (`fixtures/key-codec-1.39.0.json`, `helpers/KeyCodecShapes.ts`),
 * seeded on DynamoDB Local: every read that composes a key from a caller's values finds them, the
 * writes store them byte for byte as 1.39.0 did, and `reembed` keeps the vector partition `put` wrote.
 */
describeConnected("rows 1.39.0 wrote for codec-keyed entities (connected)", () => {
  const seed = (tableName: string, rows: ReadonlyArray<Row>) =>
    Effect.promise(async () => {
      for (const Item of rows) await raw.send(new PutItemCommand({ TableName: tableName, Item }))
    })
  const scanAll = (tableName: string) =>
    Effect.promise(
      async () =>
        ((await raw.send(new ScanCommand({ TableName: tableName, ConsistentRead: true }))).Items ??
          []) as ReadonlyArray<Row>,
    )
  /** A fresh table holding `rows`; `body` runs with the typed client, then the rows left. */
  const withSeeded = <A>(
    rows: ReadonlyArray<Row>,
    body: (db: any) => Effect.Effect<A, unknown, any>,
  ) => {
    const tableName = `key-codec-139-${Date.now()}-${tables++}`
    const key = (hash: string, range: string) => [
      { AttributeName: hash, KeyType: "HASH" as const },
      { AttributeName: range, KeyType: "RANGE" as const },
    ]
    return Effect.acquireUseRelease(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: key("pk", "sk"),
          AttributeDefinitions: [
            ...["pk", "sk", "gsi1pk", "gsi1sk", "gsi2pk"].map((AttributeName) => ({
              AttributeName,
              AttributeType: "S" as const,
            })),
            { AttributeName: "gsi2sk", AttributeType: "B" as const },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: "gsi1",
              KeySchema: key("gsi1pk", "gsi1sk"),
              Projection: { ProjectionType: "ALL" },
            },
            {
              IndexName: "gsi2",
              KeySchema: key("gsi2pk", "gsi2sk"),
              Projection: { ProjectionType: "ALL" },
            },
          ],
        })
        yield* seed(tableName, rows)
      }),
      () =>
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: Shapes.entities,
            tables: { Base: Shapes.Base },
          })
          const result = yield* body(db)
          return { result, rows: yield* scanAll(tableName) }
        }),
      () =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          yield* client.deleteTable({ TableName: tableName })
        }).pipe(Effect.ignore),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          VectorSearchEmulation.layer(ClientLayer, { tables: { Base: Shapes.Base } }),
          Shapes.Base.layer({ name: tableName }),
          Embedder.layerTest({ dimensions: 8 }),
        ),
      ),
    ) as unknown as Effect.Effect<{ result: A; rows: ReadonlyArray<Row> }>
  }

  for (const read of Shapes.reads)
    it.effect(`${read.label} finds them`, () =>
      Effect.gen(function* () {
        const { result } = yield* withSeeded(Shapes.fixture.rows, read.run)
        expect(result).toEqual(read.expected)
      }),
    )

  it.effect("the writes store the keys 1.39.0 stored", () =>
    Effect.gen(function* () {
      const { rows } = yield* withSeeded([], (db) =>
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
      expect(Shapes.keysOf(rows)).toEqual(Shapes.keysOf(Shapes.fixture.rows))
    }),
  )

  it.effect(
    "reembed keeps the partition put wrote, and moves back one 1.39.0's reembed moved",
    () =>
      Effect.gen(function* () {
        const partition = (rows: ReadonlyArray<Row>) =>
          rows.find((row) => row.__edd_e__?.S === "Product")!.__edd_vp_vec1__?.S
        const written = partition(Shapes.fixture.rows)
        const kept = yield* withSeeded(Shapes.fixture.rows, (db) => db.entities.Products.reembed())
        expect(kept.result).toBe(1)
        expect(partition(kept.rows)).toBe(written)
        const moved = yield* withSeeded(Shapes.fixture.rowsAfterReembed, (db) =>
          db.entities.Products.reembed(),
        )
        expect(moved.result).toBe(1)
        expect(partition(moved.rows)).toBe(written)
      }),
  )
})

/**
 * A projection whose read model's key composite is a codec `encode` takes on its own output, over
 * the rows 1.39.0 wrote (`helpers/KeyCodecProjection.ts`): the next event updates the row `put`
 * wrote, a removal tombstones it, and outbox items keep the key text 1.39.0 gave them. On 1.39.0
 * every event after the first failed, and the tombstone went to a key the row was not at.
 */
describeConnected("a projection keyed by a codec over 1.39.0's rows (connected)", () => {
  const scanRead = (TableName: string) =>
    Effect.promise(
      async () =>
        ((await raw.send(new ScanCommand({ TableName, ConsistentRead: true }))).Items ??
          []) as ReadonlyArray<Row>,
    )
  /** Fresh event and read-model tables holding 1.39.0's rows; `body`, then the read model's rows. */
  const withTables = <A>(body: (readTable: string) => Effect.Effect<A, unknown, any>) => {
    const suffix = `${Date.now()}-${tables++}`
    const names = { events: `key-codec-ev-${suffix}`, read: `key-codec-rm-${suffix}` }
    return Effect.acquireUseRelease(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        for (const TableName of [names.events, names.read]) {
          yield* client.createTable({
            TableName,
            BillingMode: "PAY_PER_REQUEST",
            KeySchema: [
              { AttributeName: "pk", KeyType: "HASH" },
              { AttributeName: "sk", KeyType: "RANGE" },
            ],
            AttributeDefinitions: [
              { AttributeName: "pk", AttributeType: "S" },
              { AttributeName: "sk", AttributeType: "S" },
            ],
          })
        }
        yield* Effect.promise(async () => {
          for (const Item of P.fixture.seed.events)
            await raw.send(new PutItemCommand({ TableName: names.events, Item }))
          for (const Item of P.fixture.seed.read)
            await raw.send(new PutItemCommand({ TableName: names.read, Item }))
        })
      }),
      () =>
        Effect.gen(function* () {
          const result = yield* body(names.read)
          return { result, rows: yield* scanRead(names.read) }
        }),
      () =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          yield* client.deleteTable({ TableName: names.events })
          yield* client.deleteTable({ TableName: names.read })
        }).pipe(Effect.ignore),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          ClientLayer,
          P.EventsTable.layer({ name: names.events }),
          P.ReadTable.layer({ name: names.read }),
        ),
      ),
    ) as unknown as Effect.Effect<{ result: A; rows: ReadonlyArray<Row> }>
  }
  const at = (rows: ReadonlyArray<Row>, key: { readonly pk: string; readonly sk: string }) =>
    rows.find((row) => row.pk?.S === key.pk && row.sk?.S === key.sk)

  it.effect("the next event updates the row 1.39.0 wrote", () =>
    Effect.gen(function* () {
      const { result, rows } = yield* withTables(() =>
        Effect.gen(function* () {
          yield* P.Orders.append({ orderId: "o1" }, [new P.Added({ amount: 3 })], 1)
          const a = yield* P.A.catchUp({ orderId: "o1" })
          const b = yield* P.B.catchUp({ orderId: "o1" })
          return [a.applied.map((e) => e.version), b.applied.map((e) => e.version)]
        }),
      )
      expect(result).toEqual([[2], [2]])
      expect(at(rows, P.rowKey.Removable)?.total).toEqual({ N: "8" })
      expect(at(rows, P.rowKey.Effected)?.rev).toEqual({ N: "2" })
      expect(at(rows, P.singleKey)).toBeUndefined()
    }),
  )

  it.effect("a removal tombstones the row put wrote, and the entity reads no row", () =>
    Effect.gen(function* () {
      const { result, rows } = yield* withTables(() =>
        Effect.gen(function* () {
          yield* P.Orders.append(
            { orderId: "o1" },
            [new P.Added({ amount: 3 }), new P.Cancelled()],
            1,
          )
          const a = yield* P.A.catchUp({ orderId: "o1" })
          const got = yield* Effect.exit(P.Removable.get({ orderId: "o1" }).asEffect())
          return { removed: a.removed, got: Exit.isFailure(got) && JSON.stringify(got.cause) }
        }),
      )
      expect(result.removed).toBe(true)
      expect(result.got).toContain("ItemNotFound")
      expect(at(rows, P.rowKey.Removable)?.__edd_e__).toEqual({ S: "Removable#tombstone" })
      expect(at(rows, P.singleKey)).toBeUndefined()
    }),
  )

  it.effect("outbox items keep the key text 1.39.0 gave them, and drain delivers them", () =>
    Effect.gen(function* () {
      const notes: Array<string> = []
      const { result, rows } = yield* withTables((readTable) =>
        Effect.gen(function* () {
          yield* P.Orders.append({ orderId: "o1" }, [new P.Added({ amount: 3 })], 1)
          yield* P.B.catchUp({ orderId: "o1" })
          const pending = (yield* scanRead(readTable))
            .filter((row) => row.__edd_e__?.S === "Effected#outbox")
            .map((row) => [row.pk?.S, row.sk?.S, row.__edd_row_pk__?.S, row.__edd_row_sk__?.S])
          const drained = yield* P.B.drain({ orderId: "o1" }, (effect) =>
            Effect.sync(() => {
              notes.push(effect.note)
            }),
          )
          return { pending, delivered: drained.delivered }
        }),
      )
      expect(result.pending).toEqual([
        [P.outboxPk, "$kp#v1#effected#outbox#000000000002#0000", P.outboxPk, P.rowKey.Effected.sk],
      ])
      expect(result.delivered).toBe(1)
      expect(notes).toEqual(["Added v2"])
      expect(rows.filter((row) => row.__edd_e__?.S === "Effected#outbox")).toEqual([])
    }),
  )
})
