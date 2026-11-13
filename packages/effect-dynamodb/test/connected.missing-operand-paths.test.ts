/**
 * A record operation on an attribute, or a sparse map's entry, the row lacks (`.subtract()`,
 * `.append()`), or on one the row holds as `NULL` (those and `.add()`, `.deleteFromSet()`): what
 * each write path does, against DynamoDB Local, as on 1.40.0 (#236 names the difference, it
 * doesn't change it). Sent as an expression (`#f - :v`, `list_append(#f, :v)`, `ADD`, `DELETE`),
 * DynamoDB refuses the update and nothing is written. An update that reads the row first and
 * applies the operation to the row it read (a retained entity's; one setting a unique field; one
 * computing an index composite) starts the attribute from nothing and stores `-v`, `v` or the
 * operand alone (a `DELETE` leaves the `NULL`). Callers may rely on either outcome, so both are
 * pinned here, alone and in a transaction.
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
    nul: Schema.optional(Schema.NullOr(Schema.Number)),
    nlist: Schema.optional(Schema.NullOr(Schema.Array(Schema.Number))),
    nset: Schema.optional(Schema.NullOr(Schema.ReadonlySet(Schema.String))),
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

/** A write path: the entity's configuration, the update besides the operation, and its way. */
const paths: ReadonlyArray<{
  readonly name: string
  readonly entity: Record<string, unknown>
  readonly prefix: (update: any) => any
  /** Whether the update applies the operation to the row it read (else DynamoDB refuses it). */
  readonly applied: boolean
}> = [
  { name: "plain", entity: {}, prefix: (u) => u, applied: false },
  {
    name: "retained",
    entity: { versioned: { retain: true } },
    prefix: (u) => u,
    applied: true,
  },
  {
    name: "unique, setting the unique field",
    entity: { unique: { email: ["email"] } },
    prefix: (u) => u.set({ email: "b" }),
    applied: true,
  },
  {
    name: "unique, not setting the unique field",
    entity: { unique: { email: ["email"] } },
    prefix: (u) => u,
    applied: false,
  },
  {
    name: "an index composite computed",
    entity: { indexes: byRank },
    prefix: (u) => u.add({ rank: 1 }),
    applied: true,
  },
  {
    name: "an index composite not computed",
    entity: { indexes: byRank },
    prefix: (u) => u,
    applied: false,
  },
]

/** An operation on what the row lacks, its attribute, and what it stores where it's applied. */
const operations: ReadonlyArray<{
  readonly name: string
  readonly apply: (update: any) => any
  readonly attribute: string
  /** What the row holds there before: nothing, or `NULL`. */
  readonly held?: AttributeValue
  readonly stored: AttributeValue
}> = [
  {
    name: ".subtract() from an attribute",
    apply: (u) => u.subtract({ n: 2 }),
    attribute: "n",
    stored: { N: "-2" },
  },
  {
    name: ".append() to an attribute",
    apply: (u) => u.append({ tags: [2] }),
    attribute: "tags",
    stored: { L: [{ N: "2" }] },
  },
  {
    name: ".subtract() from a sparse map's entry",
    apply: (u) => u.subtract({ "data#x": 2 }),
    attribute: "data#x",
    stored: { N: "-2" },
  },
  {
    name: ".append() to a sparse map's entry",
    apply: (u) => u.append({ "lists#x": [2] }),
    attribute: "lists#x",
    stored: { L: [{ N: "2" }] },
  },
  {
    name: ".subtract() from NULL",
    apply: (u) => u.subtract({ nul: 2 }),
    attribute: "nul",
    held: { NULL: true },
    stored: { N: "-2" },
  },
  {
    name: ".add() of a number to NULL",
    apply: (u) => u.add({ nul: 2 }),
    attribute: "nul",
    held: { NULL: true },
    stored: { N: "2" },
  },
  {
    name: ".append() to NULL",
    apply: (u) => u.append({ nlist: [2] }),
    attribute: "nlist",
    held: { NULL: true },
    stored: { L: [{ N: "2" }] },
  },
  {
    name: ".add() of a set to NULL",
    apply: (u) => u.add({ nset: new Set(["x"]) }),
    attribute: "nset",
    held: { NULL: true },
    stored: { SS: ["x"] },
  },
  {
    name: ".deleteFromSet() from NULL",
    apply: (u) => u.deleteFromSet({ nset: new Set(["x"]) }),
    attribute: "nset",
    held: { NULL: true },
    stored: { NULL: true },
  },
]

let tables = 0
/** How the update of `a` ended, whether the table changed, and `attribute` of `a` afterwards. */
const outcome = (
  path: (typeof paths)[number],
  transaction: boolean,
  apply: (update: any) => any,
  attribute: string,
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
  const items = Effect.promise(() =>
    raw.send(new ScanCommand({ TableName: tableName, ConsistentRead: true })),
  ).pipe(Effect.map((out) => out.Items ?? []))
  const scan = items.pipe(
    Effect.map((rows) =>
      rows.map((item) => JSON.stringify(item)).sort((a, b) => a.localeCompare(b)),
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
          nul: null,
          nlist: null,
          nset: null,
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
        const a = (yield* items).find((item) => item.pk?.S?.endsWith("#id_a"))
        return {
          error: failure?._tag as string | undefined,
          changed,
          reads: Exit.isSuccess(read),
          stored: a?.[attribute],
        }
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
      error: string | undefined
      changed: boolean
      reads: boolean
      stored: AttributeValue | undefined
    },
    unknown
  >
}

describeConnected(
  "an operation on what the row lacks or holds as NULL: each path as on 1.40.0 (#236)",
  () => {
    for (const path of paths) {
      for (const operation of operations) {
        for (const transaction of [false, true]) {
          const ends = path.applied
            ? `stores ${JSON.stringify(operation.stored)}`
            : "DynamoValidationError, nothing written"
          it.effect(
            `${path.name} | ${operation.name} | ${transaction ? "in a transaction" : "alone"} | ${ends}`,
            () =>
              Effect.gen(function* () {
                expect(
                  yield* outcome(path, transaction, operation.apply, operation.attribute),
                ).toEqual(
                  path.applied
                    ? { error: undefined, changed: true, reads: true, stored: operation.stored }
                    : {
                        error: "DynamoValidationError",
                        changed: false,
                        reads: true,
                        stored: operation.held,
                      },
                )
              }),
          )
        }
      }
    }
  },
)
