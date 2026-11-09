/**
 * An aggregate whose rows together pass 4 MB moves on DynamoDB (connected): `rekey` packs a wave's
 * moves into transactions of at most 100 actions and 4 MB, so DynamoDB accepts each one, where a
 * single transaction of all the lines' moves would be rejected for size.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import { TRANSACT_WRITE_MAX_BYTES, transactionBytes } from "../src/internal/ItemSize.js"
import * as Table from "../src/Table.js"

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

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

class Line extends Schema.Class<Line>("Line")({
  lid: Schema.String,
  note: Schema.String,
}) {}

class Order extends Schema.Class<Order>("Order")({
  id: Schema.String,
  note: Schema.String,
  lines: Schema.Array(Line),
}) {}

const world = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "sized", version: 1, escapeKeys })
  const MainTable = Table.make({ schema, entities: {} })
  const Orders = Aggregate.make(Order, {
    table: MainTable,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "orders" },
    root: { entityType: "OrderItem" },
    edges: {
      lines: Aggregate.many({ entityType: "OrderLine", sk: { composite: ["lid"] } }),
    },
  })
  const client = DynamoClient.make({ entities: {}, aggregates: { Orders }, tables: { MainTable } })
  return { MainTable, Orders, client }
}

const LINES = 12
const NOTE = 360_000

let tables = 0

const SETTINGS = [
  ["to on", true],
  ["to off", false],
] as const

describeConnected("an aggregate's rekey over 4 MB, on DynamoDB", () => {
  it.each(SETTINGS)("%s, its rows move in transactions DynamoDB accepts", (_d, escapeKeys) => {
    const tableName = `rekey-size-${Date.now()}-${tables++}`
    const before = world(!escapeKeys)
    const after = world(escapeKeys)
    const scan = Effect.gen(function* () {
      const client = yield* DynamoClient
      const rows: Array<Record<string, any>> = []
      let start: Record<string, any> | undefined
      do {
        const page = yield* client.scan({
          TableName: tableName,
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        })
        rows.push(...(page.Items ?? []))
        start = page.LastEvaluatedKey
      } while (start !== undefined)
      return rows
    })
    const body = Effect.gen(function* () {
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
      const lines = Array.from(
        { length: LINES },
        (_, i) => new Line({ lid: `line${i}`, note: "x" }),
      )
      yield* Effect.gen(function* () {
        const db = yield* before.client
        yield* db.aggregates.Orders.create({ id: "p q", note: "root", lines })
      }).pipe(Effect.provide(before.MainTable.layer({ name: tableName })))
      // Each line made large in place: a create of all of them would pass 4 MB itself.
      for (const row of yield* scan) {
        if (row.__edd_e__?.S !== "OrderLine") continue
        yield* client.updateItem({
          TableName: tableName,
          Key: { pk: row.pk, sk: row.sk },
          UpdateExpression: "SET #n = :n",
          ExpressionAttributeNames: { "#n": "note" },
          ExpressionAttributeValues: { ":n": { S: "x".repeat(NOTE) } },
        })
      }
      // The lines' moves would pass 4 MB as one transaction.
      const stored = yield* scan
      const lineRows = stored.filter((row) => row.__edd_e__?.S === "OrderLine")
      expect(
        transactionBytes(lineRows.flatMap((row) => [{ Put: { TableName: tableName, Item: row } }])),
      ).toBeGreaterThan(TRANSACT_WRITE_MAX_BYTES)

      const report = yield* Effect.gen(function* () {
        const db = yield* after.client
        const dry: Table.RekeyReport = yield* db.tables.MainTable.rekey({ dryRun: true })
        const real: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        const found = yield* db.aggregates.Orders.get({ id: "p q" })
        const again: Table.RekeyReport = yield* db.tables.MainTable.rekey()
        return { dry, real, found, again }
      }).pipe(Effect.provide(after.MainTable.layer({ name: tableName })))
      expect(report.dry.moved.aggregate).toBe(LINES + 1)
      expect(report.real.conflicts).toEqual([])
      expect(report.real.moved.aggregate).toBe(LINES + 1)
      expect(report.again.moved.aggregate).toBe(0)
      expect(report.found.lines.map((line) => [line.lid, line.note.length]).sort()).toEqual(
        Array.from({ length: LINES }, (_, i) => [`line${i}`, NOTE]).sort(),
      )
      const pk = `$sized#v1#orders#${escapeKeys ? "p%20q" : "p q"}`
      const rows = yield* scan
      expect(rows.length).toBe(LINES + 1)
      expect(new Set(rows.map((row) => row.pk?.S))).toEqual(new Set([pk]))
    })
    const drop = Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.deleteTable({ TableName: tableName })
    }).pipe(Effect.ignore)
    return Effect.runPromise(
      Effect.ensuring(body, drop).pipe(Effect.provide(ClientLayer)) as Effect.Effect<void>,
    )
  })
})
