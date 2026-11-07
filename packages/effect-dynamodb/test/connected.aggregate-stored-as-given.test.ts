/**
 * An aggregate write's value no encoder of its field takes (`EDD-9127`), against DynamoDB Local. A
 * transformation over itself can encode no value, and stored as given, a bigint reads back as a
 * number and a class as a map, so no read could get the row back: `create` and `update` refuse it
 * and write nothing, at every position. A one-way transformation's value reads back as given, and is
 * still stored.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { type AttributeValue, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Config, Effect, Layer, Schema, SchemaGetter, SchemaTransformation } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
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

const overItself = <S extends Schema.Top>(schema: S) =>
  schema.pipe(Schema.decodeTo(schema, SchemaTransformation.passthrough()))
class Klass extends Schema.Class<Klass>("Klass")({ b: Schema.BigIntFromString }) {}
const OverStruct = overItself(Schema.Struct({ b: Schema.BigIntFromString }))
const OverClass = overItself(Klass)
const OneWay = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.forbidden(() => "one way"),
  }),
)

class Line extends Schema.Class<Line>("Line")({
  lineId: Schema.String,
  f: Schema.optional(OverStruct),
}) {}
class Coach extends Schema.Class<Coach>("Coach")({
  name: Schema.String,
  f: Schema.optional(OverStruct),
}) {}
class Captain extends Schema.Class<Captain>("Captain")({
  name: Schema.String,
  f: Schema.optional(OverStruct),
}) {}
class Squad extends Schema.Class<Squad>("Squad")({
  label: Schema.String,
  f: Schema.optional(OverStruct),
  captain: Schema.optional(Captain),
}) {}
class Team extends Schema.Class<Team>("Team")({
  id: Schema.String,
  note: Schema.optional(Schema.String),
  f: Schema.optional(OverStruct),
  k: Schema.optional(OverClass),
  w: Schema.optional(OneWay),
  coach: Schema.optional(Coach),
  lines: Schema.Array(Line),
  squad: Schema.optional(Squad),
}) {}

const schema = DynamoSchema.make({ name: "asgiven", version: 1 })
const Main = Table.make({ schema, entities: {} })
// A child edge makes it a sub-aggregate: its own transaction group and its own root row.
const SquadAggregate = Aggregate.make(Squad, {
  root: { entityType: "TeamSquad" },
  edges: { captain: Aggregate.one({ entityType: "SquadCaptain" }) },
})
const Teams = Aggregate.make(Team, {
  table: Main,
  schema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "team" },
  root: { entityType: "Team" },
  edges: {
    coach: Aggregate.one({ entityType: "TeamCoach" }),
    lines: Aggregate.many({ entityType: "TeamLine", sk: { composite: ["lineId"] } }),
    squad: SquadAggregate.with({ discriminator: { n: 1 } }),
  },
})

let tables = 0
const onTable = <A, E>(body: (tableName: string) => Effect.Effect<A, E, any>) => {
  const tableName = `stored-as-given-${Date.now()}-${tables++}`
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

const rowsOf = (tableName: string) =>
  Effect.promise(async () => {
    const scan = await raw.send(new ScanCommand({ TableName: tableName, ConsistentRead: true }))
    return (scan.Items ?? []) as ReadonlyArray<Record<string, AttributeValue>>
  })

const bind = DynamoClient.make({ entities: {}, aggregates: { Teams }, tables: { Main } })

const team = { id: "a", lines: [{ lineId: "l1" }] }

const POSITIONS: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
  ["the root", { f: { b: 5n } }, '"f" of "Team"'],
  ["the root, a class", { k: new Klass({ b: 5n }) }, '"k" of "Team"'],
  ["a one edge", { coach: { name: "c", f: { b: 5n } } }, '"f" of "coach"'],
  ["a many edge's element", { lines: [{ lineId: "l1", f: { b: 5n } }] }, '"f" of "lines"'],
  ["a sub-aggregate", { squad: { label: "s", f: { b: 5n } } }, '"f" of "squad"'],
  [
    "a sub-aggregate's edge",
    { squad: { label: "s", captain: { name: "c", f: { b: 5n } } } },
    '"f" of "captain"',
  ],
]

describeConnected("[EDD-9127] a value stored as given that wouldn't read back is refused", () => {
  for (const [position, given, named] of POSITIONS) {
    it.effect(`create, at ${position}: nothing is written`, () =>
      onTable((tableName) =>
        Effect.gen(function* () {
          const db = yield* bind
          const error = yield* db.aggregates.Teams.create({ ...team, ...given } as never).pipe(
            Effect.flip,
          )
          expect(error).toBeInstanceOf(ValidationError)
          expect(String((error as ValidationError).cause)).toContain(
            `Field ${named} can't be put in the stored form`,
          )
          expect(String((error as ValidationError).cause)).toContain("EDD-9127")
          expect(yield* rowsOf(tableName)).toEqual([])
          expect(yield* db.aggregates.Teams.get({ id: "a" }).pipe(Effect.flip)).toMatchObject({
            _tag: "AggregateAssemblyError",
          })
        }),
      ),
    )

    it.effect(`update, at ${position}: the rows stay as they were, and read`, () =>
      onTable((tableName) =>
        Effect.gen(function* () {
          const db = yield* bind
          yield* db.aggregates.Teams.create(team as never)
          const before = yield* rowsOf(tableName)
          const error = yield* db.aggregates.Teams.update({ id: "a" }, ({ state }) => ({
            ...state,
            ...given,
          })).pipe(Effect.flip)
          expect(error).toBeInstanceOf(ValidationError)
          expect(String((error as ValidationError).cause)).toContain(
            `Field ${named} can't be put in the stored form`,
          )
          expect(yield* rowsOf(tableName)).toEqual(before)
          expect(yield* db.aggregates.Teams.get({ id: "a" })).toMatchObject({
            id: "a",
            lines: [{ lineId: "l1" }],
          })
        }),
      ),
    )
  }

  it.effect("a one-way transformation's value is stored as given, and reads back", () =>
    onTable((tableName) =>
      Effect.gen(function* () {
        const db = yield* bind
        yield* db.aggregates.Teams.create({ ...team, w: "x" } as never)
        const root = (yield* rowsOf(tableName)).find((row) => row.w !== undefined)
        expect(root?.w).toEqual({ S: "x" })
        expect((yield* db.aggregates.Teams.get({ id: "a" })).w).toBe("x")
        const updated = yield* db.aggregates.Teams.update({ id: "a" }, ({ state }) => ({
          ...state,
          note: "n",
        }))
        expect(updated).toMatchObject({ w: "x", note: "n" })
        expect((yield* db.aggregates.Teams.get({ id: "a" })).w).toBe("x")
      }),
    ),
  )
})
