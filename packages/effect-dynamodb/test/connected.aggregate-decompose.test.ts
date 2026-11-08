/**
 * A `many` edge's custom `decompose` is handed a write's value as 1.39.0 handed it, against
 * DynamoDB Local, so its rows store, key and read exactly as 1.39.0's did.
 *
 * The sort-key composite here is a transformation with one type on both sides (it multiplies by 10
 * on decode). 1.39.0 read a write's value stored form first, so `create(50)` handed `decompose` 500.
 * `lines`' `decompose` returns the stored form (`f / 10`), so 1.39.0 stored 5 under the key text 50
 * and read 50, and an update left the row where it was. `kept`'s hands the value back unchanged, so
 * 1.39.0 stored 50 under 500 and read 500, and every update did it again.
 *
 * `fixtures/aggregate-decompose-1.39.0.json` holds the rows published 1.39.0 wrote through `create`,
 * and through `create` and one update, with what its `get` returned. It's generated once from the
 * published package: don't regenerate or "fix" it.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import { type AttributeValue, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Schema, SchemaGetter } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
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

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const raw = new DynamoDBClient({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

type Row = Record<string, AttributeValue>

// The fixture's model: it must stay what the generator declared.
const X10 = Schema.Number.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((value) => value * 10),
    encode: SchemaGetter.transform((value) => value / 10),
  }),
)
const schema = DynamoSchema.make({ name: "dc", version: 1 })
const Anchors = Entity.make({
  model: Schema.Struct({ anchorId: Schema.String }),
  entityType: "DcAnchor",
  primaryKey: {
    pk: { field: "pk", composite: ["anchorId"] },
    sk: { field: "sk", composite: [] },
  },
})
const Line = Schema.Struct({
  lineId: Schema.String,
  f: X10,
  note: Schema.optional(Schema.String),
})
type Line = typeof Line.Type
const Order = Schema.Struct({
  id: Schema.String,
  lines: Schema.Array(Line),
  kept: Schema.Array(Line),
})
const Main = Table.make({ schema, entities: { Anchors } })
const handed: Array<number> = []
const Orders = Aggregate.make(Order, {
  table: Main,
  schema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "dcorder" },
  root: { entityType: "DcOrder" },
  edges: {
    lines: Aggregate.many({
      entityType: "DcLine",
      sk: { composite: ["f"] },
      decompose: (lines) =>
        (lines as ReadonlyArray<Line>).map((line) => {
          handed.push(line.f)
          return { ...line, f: line.f / 10 }
        }),
    }),
    kept: Aggregate.many({
      entityType: "DcKept",
      sk: { composite: ["f"] },
      decompose: (lines) => (lines as ReadonlyArray<Line>).map((line) => ({ ...line })),
    }),
  },
})

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/aggregate-decompose-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly read: Record<string, Record<string, unknown>>
  readonly rows: ReadonlyArray<Row>
}

let tables = 0
const onTable = <A, E>(body: (tableName: string) => Effect.Effect<A, E, any>) => {
  const tableName = `decompose-${Date.now()}-${tables++}`
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
    () => body(tableName),
    () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Main.layer({ name: tableName }))),
  ) as Effect.Effect<A, unknown>
}

const bind = DynamoClient.make({ entities: { Anchors }, aggregates: { Orders }, tables: { Main } })

/** Every row of one aggregate, in key order. */
const rowsOf = (tableName: string, id: string) =>
  Effect.promise(async () => {
    const scan = await raw.send(new ScanCommand({ TableName: tableName, ConsistentRead: true }))
    return ((scan.Items ?? []) as ReadonlyArray<Row>)
      .filter((row) => (row.pk as { S: string }).S === `$dc#v1#dcorder#${id}`)
      .sort((a, b) => (a.sk as { S: string }).S.localeCompare((b.sk as { S: string }).S))
  })

/** The fixture's rows of one aggregate, in key order. */
const fixtureRows = (id: string) =>
  fixture.rows
    .filter((row) => (row.pk as { S: string }).S === `$dc#v1#dcorder#${id}`)
    .sort((a, b) => (a.sk as { S: string }).S.localeCompare((b.sk as { S: string }).S))

/** A row as another aggregate's: the partition key and `id` renamed. */
const renamed = (rows: ReadonlyArray<Row>, from: string, to: string) =>
  rows.map((row) => ({
    ...row,
    pk: { S: (row.pk as { S: string }).S.replace(`#${from}`, `#${to}`) },
    ...(row.id !== undefined && { id: { S: to } }),
  }))

const input = (id: string) => ({
  id,
  lines: [{ lineId: "l1", f: 50 }],
  kept: [{ lineId: "k1", f: 50 }],
})

const noteAll =
  (note: string) =>
  ({ state }: { readonly state: typeof Order.Type }) => ({
    ...state,
    lines: state.lines.map((line) => ({ ...line, note })),
    kept: state.kept.map((line) => ({ ...line, note })),
  })

describeConnected("a custom decompose is handed a write's value as 1.39.0 handed it", () => {
  it.effect("create stores and keys the rows 1.39.0 stored, and returns what was given", () =>
    onTable((tableName) =>
      Effect.gen(function* () {
        const db = yield* bind
        handed.length = 0
        const created = yield* db.aggregates.Orders.create(input("created"))
        expect(handed).toEqual([500])
        expect(created).toEqual(input("created"))
        expect(yield* rowsOf(tableName, "created")).toEqual(fixtureRows("created"))
        expect(yield* db.aggregates.Orders.get({ id: "created" })).toEqual(fixture.read.created)
      }),
    ),
  )

  it.effect("an update stores and keys the rows 1.39.0 stored", () =>
    onTable((tableName) =>
      Effect.gen(function* () {
        const db = yield* bind
        yield* db.aggregates.Orders.create(input("updated-once"))
        yield* db.aggregates.Orders.update({ id: "updated-once" }, noteAll("n0"))
        expect(yield* rowsOf(tableName, "updated-once")).toEqual(fixtureRows("updated-once"))
        expect(yield* db.aggregates.Orders.get({ id: "updated-once" })).toEqual(
          fixture.read["updated-once"],
        )
      }),
    ),
  )

  it.effect("an update of a row 1.39.0 wrote changes it in place, however many times", () =>
    onTable((tableName) =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        for (const row of fixture.rows) yield* client.putItem({ TableName: tableName, Item: row })
        const db = yield* bind
        expect(yield* db.aggregates.Orders.get({ id: "created" })).toEqual(fixture.read.created)
        const line = (rows: ReadonlyArray<Row>) =>
          rows.filter((row) => (row.__edd_e__ as { S: string }).S === "DcLine")
        const before = line(fixtureRows("created"))
        for (const note of ["one", "two", "three"]) {
          yield* db.aggregates.Orders.update({ id: "created" }, noteAll(note))
          const after = line(yield* rowsOf(tableName, "created"))
          expect(after).toEqual(before.map((row) => ({ ...row, note: { S: note } })))
          expect(yield* db.aggregates.Orders.get({ id: "created" })).toMatchObject({
            lines: [{ lineId: "l1", f: 50, note }],
          })
        }
      }),
    ),
  )

  it.effect("a value handed back unchanged moves as on 1.39.0", () =>
    onTable((tableName) =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        for (const row of fixture.rows) yield* client.putItem({ TableName: tableName, Item: row })
        const db = yield* bind
        yield* db.aggregates.Orders.update({ id: "created" }, noteAll("n0"))
        const kept = (rows: ReadonlyArray<Row>) =>
          rows.filter((row) => (row.__edd_e__ as { S: string }).S === "DcKept")
        expect(kept(yield* rowsOf(tableName, "created"))).toEqual(
          kept(renamed(fixtureRows("updated-once"), "updated-once", "created")),
        )
      }),
    ),
  )

  it.effect("an update deletes a removed element's row, and a changed key's old row", () =>
    onTable((tableName) =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        for (const row of fixture.rows) yield* client.putItem({ TableName: tableName, Item: row })
        const db = yield* bind
        const lines = (rows: ReadonlyArray<Row>) =>
          rows
            .filter((row) => (row.__edd_e__ as { S: string }).S === "DcLine")
            .map((row) => [(row.sk as { S: string }).S, row.f])
        // 1.39.0 sent a Delete for the key decomposing 50 again gives (5), and left this row.
        yield* db.aggregates.Orders.update({ id: "created" }, ({ state }) => ({
          ...state,
          lines: state.lines.map((line) => ({ ...line, f: 60 })),
        }))
        expect(lines(yield* rowsOf(tableName, "created"))).toEqual([
          ["$dc#v1#dcline#0000000000000060", { N: "6" }],
        ])
        yield* db.aggregates.Orders.update({ id: "created" }, ({ state }) => ({
          ...state,
          lines: [],
        }))
        expect(lines(yield* rowsOf(tableName, "created"))).toEqual([])
        expect((yield* db.aggregates.Orders.get({ id: "created" })).lines).toEqual([])
      }),
    ),
  )

  it.effect("rekey moves the edge's rows with the root, under escaped keys", () =>
    onTable((tableName) =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        // The fixture's rows as those of an aggregate whose id holds a space.
        const seeded = renamed(fixtureRows("created"), "created", "a b")
        for (const row of seeded) yield* client.putItem({ TableName: tableName, Item: row })
        const escaped = DynamoSchema.make({ name: "dc", version: 1, escapeKeys: true })
        const Escaped = Table.make({ schema: escaped, entities: { Anchors } })
        const Moved = Aggregate.make(Order, {
          table: Escaped,
          schema: escaped,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "dcorder" },
          root: { entityType: "DcOrder" },
          edges: {
            lines: Aggregate.many({
              entityType: "DcLine",
              sk: { composite: ["f"] },
              decompose: (lines) =>
                (lines as ReadonlyArray<Line>).map((line) => ({ ...line, f: line.f / 10 })),
            }),
            kept: Aggregate.many({
              entityType: "DcKept",
              sk: { composite: ["f"] },
              decompose: (lines) => (lines as ReadonlyArray<Line>).map((line) => ({ ...line })),
            }),
          },
        })
        const report = yield* Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { Anchors },
            aggregates: { Moved },
            tables: { Escaped },
          })
          return yield* db.tables.Escaped.rekey()
        }).pipe(Effect.provide(Escaped.layer({ name: tableName })))
        expect(report.conflicts).toEqual([])
        expect(report.moved.aggregate).toBe(3)
        expect(yield* rowsOf(tableName, "a b")).toEqual([])
        expect(yield* rowsOf(tableName, "a%20b")).toEqual(
          renamed(seeded, "a b", "a%20b").map((row) => ({
            ...row,
            ...(row.id !== undefined && { id: { S: "a b" } }),
          })),
        )
        const got = yield* Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { Anchors },
            aggregates: { Moved },
            tables: { Escaped },
          })
          return yield* db.aggregates.Moved.get({ id: "a b" })
        }).pipe(Effect.provide(Escaped.layer({ name: tableName })))
        expect(got).toEqual({ ...fixture.read.created, id: "a b" })
      }),
    ),
  )
})
