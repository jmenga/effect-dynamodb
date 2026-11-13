/**
 * An update that sets an attribute and also changes it by `.subtract()`, `.add()` or `.append()`
 * (`.set({ m: 9 }).subtract({ m: 1 })`), against DynamoDB Local (#236). Pinned as it is, no
 * change: DynamoDB refuses an update expression whose two paths overlap (`DynamoValidationError`,
 * "Two document paths overlap", DynamoDB Local's wording), and that's what an update that sends
 * its operations as an expression gets (a plain entity's, a unique one's). An update that applies
 * its record operations to the row it read (a retained entity's, one computing an index
 * composite) applies them in order: the set, then the change (`9 - 1`, stored `8`). Each row
 * names the path, the operations and the mode, and what 1.40.0 did there, measured on DynamoDB
 * Local: the same.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { type AttributeValue, DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Cause, Config, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"

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
const ClientLayer = Lib.DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

const model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.optional(Schema.String),
  rank: Schema.optional(Schema.Number),
  m: Schema.optional(Schema.Number),
  tags: Schema.optional(Schema.Array(Schema.Number)),
})

const byRank = {
  byRank: {
    name: "gsi1",
    pk: { field: "gsi1pk", composite: ["name"] },
    sk: { field: "gsi1sk", composite: ["rank"] },
  },
}

/** A write path: the entity's configuration, and the update besides the operations. */
const paths: ReadonlyArray<{
  readonly name: string
  readonly entity: Record<string, unknown>
  readonly prefix: (update: any) => any
  /** Whether the update applies its record operations to the row it read. */
  readonly inMemory: boolean
}> = [
  { name: "plain", entity: {}, prefix: (u) => u, inMemory: false },
  { name: "retained", entity: { versioned: { retain: true } }, prefix: (u) => u, inMemory: true },
  {
    name: "unique, setting the unique field",
    entity: { unique: { email: ["email"] } },
    prefix: (u) => u.set({ email: "b" }),
    inMemory: false,
  },
  {
    name: "unique, not setting the unique field",
    entity: { unique: { email: ["email"] } },
    prefix: (u) => u,
    inMemory: false,
  },
  {
    name: "an index composite computed",
    entity: { indexes: byRank },
    prefix: (u) => u.add({ rank: 1 }),
    inMemory: true,
  },
]

/** The operations, and what an update applying them in order stores (the row holds 5 and [5]). */
const operations: ReadonlyArray<{
  readonly name: string
  readonly apply: (update: any) => any
  readonly attribute: string
  readonly inOrder: AttributeValue
}> = [
  {
    name: ".set({ m: 9 }).subtract({ m: 1 })",
    apply: (u) => u.set({ m: 9 }).subtract({ m: 1 }),
    attribute: "m",
    inOrder: { N: "8" },
  },
  {
    name: ".set({ m: 9 }).add({ m: 1 })",
    apply: (u) => u.set({ m: 9 }).add({ m: 1 }),
    attribute: "m",
    inOrder: { N: "10" },
  },
  {
    name: ".set({ tags: [9] }).append({ tags: [1] })",
    apply: (u) => u.set({ tags: [9] }).append({ tags: [1] }),
    attribute: "tags",
    inOrder: { L: [{ N: "9" }, { N: "1" }] },
  },
]

let tables = 0
/** How the update of `a` ended, and what `a` stores of the attribute afterwards. */
const outcome = (
  path: (typeof paths)[number],
  transaction: boolean,
  operation: (typeof operations)[number],
) => {
  const E = Lib.Entity.make({
    model,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...path.entity,
  } as never) as any
  const Main = Lib.Table.make({
    schema: Lib.DynamoSchema.make({ name: "overlap", version: 1 }),
    entities: { E },
  } as never) as any
  const tableName = `overlapping-ops-${Date.now()}-${tables++}`
  const stored = Effect.promise(() =>
    raw.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: "$overlap#v1#e#id_a" }, sk: { S: "$overlap#v1#e" } },
        ConsistentRead: true,
      }),
    ),
  ).pipe(Effect.map((out) => out.Item?.[operation.attribute]))
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* Lib.DynamoClient
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
        const db: any = yield* Lib.DynamoClient.make({ entities: { E }, tables: { Main } } as never)
        yield* db.entities.E.put({
          id: "a",
          name: "x",
          email: "a",
          rank: 1,
          m: 5,
          tags: [5],
        }).asEffect()
        yield* db.entities.E.put({ id: "b", name: "x" }).asEffect()
        const op = operation.apply(path.prefix(db.entities.E.update({ id: "a" })))
        const exit = yield* Effect.exit(
          transaction
            ? Lib.Transaction.transactWrite([db.entities.E.update({ id: "b" }).set({ m: 1 }), op])
            : op.asEffect(),
        )
        const failure = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as any) : undefined
        return { error: failure?._tag as string | undefined, stored: yield* stored }
      }),
    () =>
      Effect.gen(function* () {
        const client = yield* Lib.DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Main.layer({ name: tableName }) as Layer.Layer<never>)),
  ) as Effect.Effect<{ error: string | undefined; stored: AttributeValue | undefined }, unknown>
}

describeConnected("an attribute set and changed in one update: pinned on every path (#236)", () => {
  for (const path of paths) {
    for (const operation of operations) {
      for (const transaction of [false, true]) {
        const answer = path.inMemory
          ? `applied in order, stored ${JSON.stringify(operation.inOrder)}`
          : "DynamoValidationError, nothing written"
        it.effect(
          `${path.name} | ${operation.name} | ${transaction ? "in a transaction" : "alone"} | ${answer} | 1.40.0: the same`,
          () =>
            Effect.gen(function* () {
              const got = yield* outcome(path, transaction, operation)
              if (path.inMemory) {
                expect(got).toEqual({ error: undefined, stored: operation.inOrder })
              } else {
                expect(got.error).toBe("DynamoValidationError")
                // The row as it was.
                expect(got.stored).toEqual(
                  operation.attribute === "m" ? { N: "5" } : { L: [{ N: "5" }] },
                )
              }
            }),
        )
      }
    }
  }
})
