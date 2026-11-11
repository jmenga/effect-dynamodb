/**
 * `.subtract()` and `.append()` on an attribute, or a sparse map's entry, the row lacks: one
 * answer on every write path, against DynamoDB Local (#236). DynamoDB refuses `#f - :v` and
 * `list_append(#f, :v)` on a missing attribute and writes nothing. An update that reads the row
 * first applies the operation to the row it read (a retained entity's; one setting a unique field;
 * one computing an index composite): through 1.40.0 it stored `-v` or the operand alone there,
 * where the same update without that configuration, or without setting that field, was refused.
 * Each row names the path, the operation and the mode, and what 1.40.0 did there, measured on
 * DynamoDB Local; every row now fails with `DynamoValidationError` and leaves the table as it was.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { type AttributeValue, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb"
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

const model = Lib.DynamoModel.configure(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.optional(Schema.String),
    rank: Schema.optional(Schema.Number),
    n: Schema.optional(Schema.Number),
    tags: Schema.optional(Schema.Array(Schema.Number)),
    data: Schema.Record(Schema.String, Schema.Number),
    lists: Schema.Record(Schema.String, Schema.Array(Schema.Number)),
  }),
  {
    data: { storedAs: Lib.DynamoModel.SparseMap() },
    lists: { storedAs: Lib.DynamoModel.SparseMap() },
  },
)

const byRank = {
  byRank: {
    name: "gsi1",
    pk: { field: "gsi1pk", composite: ["name"] },
    sk: { field: "gsi1sk", composite: ["rank"] },
  },
}

/** A write path: the entity's configuration, the update besides the operation, 1.40.0's way. */
const paths: ReadonlyArray<{
  readonly name: string
  readonly entity: Record<string, unknown>
  readonly prefix: (update: any) => any
  /** Whether 1.40.0 applied the operation to the row it read (else DynamoDB refused it). */
  readonly appliedOn140: boolean
}> = [
  { name: "plain", entity: {}, prefix: (u) => u, appliedOn140: false },
  {
    name: "retained",
    entity: { versioned: { retain: true } },
    prefix: (u) => u,
    appliedOn140: true,
  },
  {
    name: "unique, setting the unique field",
    entity: { unique: { email: ["email"] } },
    prefix: (u) => u.set({ email: "b" }),
    appliedOn140: true,
  },
  {
    name: "unique, not setting the unique field",
    entity: { unique: { email: ["email"] } },
    prefix: (u) => u,
    appliedOn140: false,
  },
  {
    name: "an index composite computed",
    entity: { indexes: byRank },
    prefix: (u) => u.add({ rank: 1 }),
    appliedOn140: true,
  },
  {
    name: "an index composite not computed",
    entity: { indexes: byRank },
    prefix: (u) => u,
    appliedOn140: false,
  },
]

/** An operation on what the row lacks, and what 1.40.0 stored where it applied it. */
const operations: ReadonlyArray<{
  readonly name: string
  readonly apply: (update: any) => any
  readonly storedOn140: AttributeValue
}> = [
  {
    name: ".subtract() from an attribute",
    apply: (u) => u.subtract({ n: 2 }),
    storedOn140: { N: "-2" },
  },
  {
    name: ".append() to an attribute",
    apply: (u) => u.append({ tags: [2] }),
    storedOn140: { L: [{ N: "2" }] },
  },
  {
    name: ".subtract() from a sparse map's entry",
    apply: (u) => u.subtract({ "data#x": 2 }),
    storedOn140: { N: "-2" },
  },
  {
    name: ".append() to a sparse map's entry",
    apply: (u) => u.append({ "lists#x": [2] }),
    storedOn140: { L: [{ N: "2" }] },
  },
]

let tables = 0
/** How the update of `a` ended, and whether the table changed. */
const outcome = (
  path: (typeof paths)[number],
  transaction: boolean,
  apply: (update: any) => any,
) => {
  const E = Lib.Entity.make({
    model,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...path.entity,
  } as never) as any
  const Main = Lib.Table.make({
    schema: Lib.DynamoSchema.make({ name: "missing", version: 1 }),
    entities: { E },
  } as never) as any
  const tableName = `missing-operand-${Date.now()}-${tables++}`
  const scan = Effect.promise(() =>
    raw.send(new ScanCommand({ TableName: tableName, ConsistentRead: true })),
  ).pipe(
    Effect.map((out) =>
      (out.Items ?? []).map((item) => JSON.stringify(item)).sort((a, b) => a.localeCompare(b)),
    ),
  )
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
          data: { y: 1 },
          lists: {},
        }).asEffect()
        yield* db.entities.E.put({ id: "b", name: "x", data: {}, lists: {} }).asEffect()
        const before = yield* scan
        const op = apply(path.prefix(db.entities.E.update({ id: "a" })))
        const exit = yield* Effect.exit(
          transaction
            ? Lib.Transaction.transactWrite([db.entities.E.update({ id: "b" }).set({ n: 1 }), op])
            : op.asEffect(),
        )
        const changed = JSON.stringify(yield* scan) !== JSON.stringify(before)
        const read = yield* Effect.exit(db.entities.E.get({ id: "a" }))
        const failure = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as any) : undefined
        return { error: failure?._tag as string | undefined, changed, reads: Exit.isSuccess(read) }
      }),
    () =>
      Effect.gen(function* () {
        const client = yield* Lib.DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Main.layer({ name: tableName }) as Layer.Layer<never>)),
  ) as Effect.Effect<{ error: string | undefined; changed: boolean; reads: boolean }, unknown>
}

describeConnected("an operation on what the row lacks: one answer on every path (#236)", () => {
  for (const path of paths) {
    for (const operation of operations) {
      for (const transaction of [false, true]) {
        const on140 = path.appliedOn140
          ? `stored ${JSON.stringify(operation.storedOn140)}`
          : "DynamoValidationError, nothing written"
        it.effect(
          `${path.name} | ${operation.name} | ${transaction ? "in a transaction" : "alone"} | 1.40.0: ${on140}`,
          () =>
            Effect.gen(function* () {
              expect(yield* outcome(path, transaction, operation.apply)).toEqual({
                error: "DynamoValidationError",
                changed: false,
                reads: true,
              })
            }),
        )
      }
    }
  }
})
