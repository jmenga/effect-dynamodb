/**
 * The `key` on a write's error, against DynamoDB Local: the primary key
 * composites, with a redacted field nowhere on the error.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)
const tableName = `error-key-conn-${Date.now()}`
const SECRET = "hunter2"

class Credential extends Schema.Class<Credential>("Credential")({
  id: Schema.String,
  scope: Schema.String,
  email: Schema.String,
  secret: Schema.RedactedFromValue(Schema.String),
  note: Schema.String,
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: ["scope"] },
} as const

const Plain = Entity.make({ model: Credential, entityType: "Plain", primaryKey })
const Guarded = Entity.make({
  model: Credential,
  entityType: "Guarded",
  primaryKey,
  versioned: true,
  unique: { email: ["email"] },
})
const entities = { Plain, Guarded }
const MainTable = Table.make({
  schema: DynamoSchema.make({ name: "errkey-conn", version: 1 }),
  entities,
})
const TestLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: tableName }),
)
const database = DynamoClient.make({ entities, tables: { MainTable } })

const inputFor = (id: string) => ({
  id,
  scope: "admin",
  email: `${id}@example.com`,
  secret: Redacted.make(SECRET),
  note: "n",
})

const expectOnlyKey = (error: unknown, id: string, tag: string) => {
  const failure = error as { readonly _tag: string; readonly key: unknown }
  expect(failure._tag).toBe(tag)
  expect(failure.key).toEqual({ id, scope: "admin" })
  expect(JSON.stringify(error)).not.toContain(SECRET)
  expect(String(error)).not.toContain(SECRET)
}

describe("error key (connected)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
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
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  it.effect("create of a plain entity", () =>
    Effect.gen(function* () {
      const db = yield* database
      const input = inputFor("plain")
      yield* db.entities.Plain.create(input).asEffect()
      const error = yield* db.entities.Plain.create(input).asEffect().pipe(Effect.flip)
      expectOnlyKey(error, "plain", "ConditionalCheckFailed")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("create of a versioned, unique entity", () =>
    Effect.gen(function* () {
      const db = yield* database
      const input = inputFor("guarded")
      yield* db.entities.Guarded.create(input).asEffect()
      const error = yield* db.entities.Guarded.create(input).asEffect().pipe(Effect.flip)
      expectOnlyKey(error, "guarded", "ConditionalCheckFailed")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("upsert with a condition", () =>
    Effect.gen(function* () {
      const db = yield* database
      const input = inputFor("upserted")
      yield* db.entities.Plain.put(input).asEffect()
      const error = yield* db.entities.Plain.upsert(input)
        .condition({ note: "other" })
        .asEffect()
        .pipe(Effect.flip)
      expectOnlyKey(error, "upserted", "ConditionalCheckFailed")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("insert of an existing item", () =>
    Effect.gen(function* () {
      const db = yield* database
      const input = inputFor("inserted")
      yield* db.entities.Plain.insert(input).asEffect()
      const error = yield* db.entities.Plain.insert(input).asEffect().pipe(Effect.flip)
      expectOnlyKey(error, "inserted", "ItemAlreadyExists")
    }).pipe(Effect.provide(TestLayer)),
  )

  // AWS returns the stored row on the exception that becomes this error's cause.
  it.effect("a transaction's cancellation carries the row's values nowhere serializable", () =>
    Effect.gen(function* () {
      const db = yield* database
      const input = inputFor("transacted")
      yield* db.entities.Guarded.create(input).asEffect()
      const error = yield* Transaction.transactWrite([db.entities.Guarded.create(input)]).pipe(
        Effect.flip,
      )
      expect(error._tag).toBe("TransactionCancelled")
      expect(JSON.stringify(error)).not.toContain(SECRET)
      expect(String(error)).not.toContain(SECRET)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the verdicts still read the returned row: a guarded put keeps its version", () =>
    Effect.gen(function* () {
      const db = yield* database
      const input = inputFor("versioned")
      yield* db.entities.Guarded.create(input).asEffect()
      const second = yield* db.entities.Guarded.put({ ...input, note: "second" }).asEffect()
      expect(second.note).toBe("second")
      const stored = yield* Entity.asRecord(Guarded.get({ id: "versioned", scope: "admin" }))
      expect(stored.version).toBe(2)
    }).pipe(Effect.provide(TestLayer)),
  )
})
