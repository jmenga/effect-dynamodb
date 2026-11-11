/**
 * A retained entity's record operations against DynamoDB Local, beside the same update of an
 * entity that isn't retained (#236). The retained update applies `.subtract()`, `.append()`,
 * `.add()` and `.deleteFromSet()` to the row it read; the other sends them as an expression. Both
 * now end the same way: where DynamoDB refuses the expression, both fail with its
 * `DynamoValidationError` and its words, and neither row changes; where it applies it, both rows
 * read back the same.
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

type Row = Record<string, AttributeValue>

let tables = 0
/** Runs `body` with a client bound to `E` on a table of its own, and a scan of that table. */
const onTable = <A>(
  E: any,
  body: (db: any, scan: Effect.Effect<ReadonlyArray<Row>>) => Effect.Effect<A, unknown, any>,
): Effect.Effect<A, unknown> => {
  const Main = Lib.Table.make({
    schema: Lib.DynamoSchema.make({ name: "records", version: 1 }),
    entities: { E },
  } as never) as any
  const tableName = `retained-record-ops-${Date.now()}-${tables++}`
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
        const scan = Effect.promise(() =>
          raw.send(new ScanCommand({ TableName: tableName, ConsistentRead: true })),
        ).pipe(
          Effect.map((out) =>
            [...((out.Items ?? []) as ReadonlyArray<Row>)].sort((a, b) =>
              JSON.stringify(a).localeCompare(JSON.stringify(b)),
            ),
          ),
        )
        return yield* body(db, scan)
      }),
    () =>
      Effect.gen(function* () {
        const client = yield* Lib.DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Main.layer({ name: tableName }) as Layer.Layer<never>)),
  ) as Effect.Effect<A, unknown>
}

const entity = (retained: boolean) =>
  Lib.Entity.make({
    model: Lib.DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        n: Schema.optional(Schema.Number),
        m: Schema.optional(Schema.Number),
        tags: Schema.optional(Schema.Array(Schema.String)),
        notes: Schema.optional(Schema.Array(Schema.String)),
        labels: Schema.optional(Schema.ReadonlySet(Schema.String)),
        data: Schema.Record(Schema.String, Schema.Number),
      }),
      { data: { storedAs: Lib.DynamoModel.SparseMap() } },
    ),
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...(retained ? { versioned: { retain: true } } : {}),
  } as never) as any

const cases: ReadonlyArray<readonly [name: string, apply: (u: any) => any]> = [
  ["append to a string", (u) => u.append({ name: ["x"] })],
  ["subtract from a string", (u) => u.subtract({ name: 2 })],
  ["add a number to a string", (u) => u.add({ name: 2 })],
  ["add a set to a string", (u) => u.add({ name: new Set(["x"]) })],
  ["add a number to a set", (u) => u.add({ labels: 2 })],
  ["add a set of numbers to a set of strings", (u) => u.add({ labels: new Set([2]) })],
  ["delete from a string", (u) => u.deleteFromSet({ name: new Set(["x"]) })],
  [
    "operations on values the row holds",
    (u) =>
      u
        .subtract({ n: 2, "data#y": 1 })
        .append({ tags: ["u"] })
        .add({ labels: new Set(["m"]), "data#z": 3, m: 4 }),
  ],
  ["delete from a set the row holds", (u) => u.deleteFromSet({ labels: new Set(["l"]) })],
  ["delete from a set the row lacks", (u) => u.deleteFromSet({ notes: new Set(["x"]) })],
]

/** How an update of `a` ended, whether the table changed, and `a` as it reads afterwards. */
const outcome = (retained: boolean, transaction: boolean, apply: (u: any) => any) =>
  onTable(entity(retained), (db, scan) =>
    Effect.gen(function* () {
      yield* db.entities.E.put({
        id: "a",
        name: "abc",
        n: 5,
        tags: ["t"],
        labels: new Set(["l"]),
        data: { y: 1 },
      }).asEffect()
      yield* db.entities.E.put({ id: "b", name: "b", data: {} }).asEffect()
      const before = yield* scan
      const op = apply(db.entities.E.update({ id: "a" }))
      const exit = yield* Effect.exit(
        transaction
          ? Lib.Transaction.transactWrite([
              db.entities.E.update({ id: "b" }).set({ name: "c" }),
              op,
            ])
          : op.asEffect(),
      )
      const changed = JSON.stringify(yield* scan) !== JSON.stringify(before)
      // The retained row's version is its own.
      const { version: _, ...read } = (yield* db.entities.E.get({ id: "a" })) as Record<
        string,
        unknown
      >
      const failure = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as any) : undefined
      return {
        ok: Exit.isSuccess(exit),
        error: failure?._tag,
        says: failure?.cause?.message,
        changed,
        read: {
          ...read,
          labels: read.labels === undefined ? undefined : [...(read.labels as Set<string>)],
        },
      }
    }),
  )

describeConnected(
  "a retained entity's record operations end as an expression's, on DynamoDB Local",
  () => {
    for (const transaction of [false, true]) {
      for (const [name, apply] of cases) {
        it.effect(`${name}, ${transaction ? "in a transaction" : "alone"}`, () =>
          Effect.gen(function* () {
            const plain = yield* outcome(false, transaction, apply)
            const retained = yield* outcome(true, transaction, apply)
            expect(retained).toEqual(plain)
            if (!plain.ok) {
              expect(plain.error).toBe("DynamoValidationError")
              expect(plain.changed).toBe(false)
            }
          }),
        )
      }
    }
  },
)
