/**
 * An operand at a position the read schema resolves exactly (#236), against DynamoDB Local. The
 * shapes #236 reproduced, each alone, in a transaction and on a retained entity: an operand no
 * reader at its position reads is refused and the stored row is the row that was there, where
 * 1.39.0 and 1.40.0 wrote a row that no longer read; an operand only its encoded form is valid for
 * is stored in that form, and the row reads back. A `Schema.UndefinedOr` field is read as a
 * `Schema.optional` one is: where 1.40.0 sent elements neither of its lists reads, they're refused.
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

type Row = Record<string, AttributeValue>
type Sending = "alone" | "in a transaction" | "retained"

class Entry extends Schema.Class<Entry>("ConnectedOperandReadersEntry")({
  n: Schema.NumberFromString,
}) {}
const Suspended: Schema.Top = Schema.suspend(() => Schema.Struct({ n: Schema.NumberFromString }))

const definitions = (retained: boolean) => {
  const schema = Lib.DynamoSchema.make({ name: "readers", version: 1 })
  const model = Lib.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      sparse: Schema.Record(Schema.String, Entry),
      lists: Schema.Union([Schema.Array(Schema.Number), Schema.Array(Schema.String)]),
      suspended: Suspended,
      undefOr: Schema.UndefinedOr(
        Schema.Union([Schema.Array(Schema.Number), Schema.Array(Schema.String)]),
      ),
      inner: Schema.Struct({
        u: Schema.UndefinedOr(
          Schema.Union([Schema.Array(Schema.Number), Schema.Array(Schema.String)]),
        ),
      }),
    }),
    { sparse: { storedAs: Lib.DynamoModel.SparseMap() } },
  )
  const E = Lib.Entity.make({
    model,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...(retained ? { versioned: { retain: true } } : {}),
  } as never) as any
  const Main = Lib.Table.make({ schema, entities: { E } } as never) as any
  return { E, Main }
}

let tables = 0
/** Seeds `a` and `b` on a table of their own, then sends `apply`'s update of `a`. */
const run = (sending: Sending, apply: (update: any) => any) => {
  const { E, Main } = definitions(sending === "retained")
  const tableName = `operand-readers-${Date.now()}-${tables++}`
  const row = Effect.promise(() =>
    raw.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: "$readers#v1#e#id_a" }, sk: { S: "$readers#v1#e" } },
        ConsistentRead: true,
      }),
    ),
  ).pipe(Effect.map((out) => out.Item as Row | undefined))
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
        const seed = (id: string) => ({
          id,
          sparse: { a: new Entry({ n: 1 }) },
          lists: [1],
          suspended: { n: 1 },
          undefOr: [1],
          inner: { u: [1] },
        })
        yield* db.entities.E.put(seed("a")).asEffect()
        yield* db.entities.E.put(seed("b")).asEffect()
        const before = yield* row
        const op = apply(db.entities.E.update({ id: "a" }))
        const exit = yield* Effect.exit(
          sending === "in a transaction"
            ? Lib.Transaction.transactWrite([
                db.entities.E.update({ id: "b" }).set({ lists: [2] }),
                op,
              ])
            : op.asEffect(),
        )
        const read = yield* Effect.exit(db.entities.E.get({ id: "a" }))
        return { exit, read, before, after: yield* row }
      }),
    () =>
      Effect.gen(function* () {
        const client = yield* Lib.DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Main.layer({ name: tableName }) as Layer.Layer<never>)),
  ) as Effect.Effect<
    {
      readonly exit: Exit.Exit<unknown, unknown>
      readonly read: Exit.Exit<unknown, unknown>
      readonly before: Row | undefined
      readonly after: Row | undefined
    },
    unknown
  >
}

const refused: ReadonlyArray<readonly [what: string, operation: string, apply: (u: any) => any]> = [
  [
    "a value a sparse map's entry refuses, named by its stored name",
    "update.pathSet",
    (update) => update.pathSet({ segments: ["sparse#a", "n"], value: false, isPath: false }),
  ],
  [
    "elements neither list of a union reads (append)",
    "update.append",
    (update) => update.append({ lists: [true] }),
  ],
  [
    "elements neither list of a union reads (pathAppend)",
    "update.pathAppend",
    (update) => update.pathAppend({ segments: ["lists"], value: [true] }),
  ],
  [
    "elements neither list of a union reads (pathPrepend)",
    "update.pathPrepend",
    (update) => update.pathPrepend({ segments: ["lists"], value: [true] }),
  ],
  [
    "a value a suspended schema refuses",
    "update.pathSet",
    (update) => update.pathSet({ segments: ["suspended", "n"], value: true, isPath: false }),
  ],
  [
    "elements neither list of a Schema.UndefinedOr union reads (append; 1.40.0 sent them)",
    "update.append",
    (update) => update.append({ undefOr: [true] }),
  ],
  [
    "elements neither list of a nested Schema.UndefinedOr union reads (pathAppend; 1.40.0 sent them)",
    "update.pathAppend",
    (update) => update.pathAppend({ segments: ["inner", "u"], value: [true] }),
  ],
]

describeConnected(
  "an operand at a position the read schema resolves exactly, on DynamoDB Local",
  () => {
    for (const sending of ["alone", "in a transaction", "retained"] as const) {
      for (const [what, operation, apply] of refused) {
        it.effect(`${sending}: refuses ${what}, and the row is as it was`, () =>
          Effect.gen(function* () {
            const { exit, read, before, after } = yield* run(sending, apply)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              const error = Cause.squash(exit.cause) as any
              expect(error._tag).toBe("ValidationError")
              expect(error.operation).toBe(operation)
            }
            expect(after).toEqual(before)
            expect(Exit.isSuccess(read)).toBe(true)
          }),
        )
      }

      it.effect(`${sending}: stores a number a suspended schema reads as text, and it reads`, () =>
        Effect.gen(function* () {
          const { exit, read, after } = yield* run(sending, (update) =>
            update.pathSet({ segments: ["suspended", "n"], value: 7, isPath: false }),
          )
          expect(Exit.isSuccess(exit)).toBe(true)
          expect(after?.suspended).toEqual({ M: { n: { S: "7" } } })
          expect(Exit.isSuccess(read)).toBe(true)
          if (Exit.isSuccess(read)) expect((read.value as any).suspended).toEqual({ n: 7 })
        }),
      )
    }
  },
)
