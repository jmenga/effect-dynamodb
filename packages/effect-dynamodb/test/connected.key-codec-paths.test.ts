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

import { type AttributeValue, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Exit, Layer, Schema, SchemaGetter } from "effect"
import { describe, expect } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

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
