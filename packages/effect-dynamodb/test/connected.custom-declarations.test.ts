/**
 * The write check for a custom declaration against DynamoDB Local. A `Schema.instanceOf` over a class
 * of your own is refused on every path with nothing written; a duck-typed `Schema.declare` that takes
 * what's stored, and a struct decoded to the class, write and read back on every one of them; and a
 * row stored before the check stays as it is and still fails on read.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { DynamoDBClient, PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Config, Effect, Exit, Layer, Schema, SchemaGetter } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import { clientOf, type Members, membersOf, PATHS } from "./helpers/CustomDeclarationPaths.js"

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

const Keys = {
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" as const },
    { AttributeName: "sk", KeyType: "RANGE" as const },
  ],
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" as const },
    { AttributeName: "sk", AttributeType: "S" as const },
    { AttributeName: "gsi1pk", AttributeType: "S" as const },
    { AttributeName: "gsi1sk", AttributeType: "S" as const },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: "gsi1",
      KeySchema: [
        { AttributeName: "gsi1pk", KeyType: "HASH" as const },
        { AttributeName: "gsi1sk", KeyType: "RANGE" as const },
      ],
      Projection: { ProjectionType: "ALL" as const },
    },
  ],
}

let tables = 0
const onTable = <A, E>(
  members: Members,
  body: (db: any, tableName: string) => Effect.Effect<A, E, any>,
) => {
  const tableName = `custom-${Date.now()}-${tables++}`
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", ...Keys })
    }),
    () =>
      Effect.gen(function* () {
        const db = yield* clientOf(members)
        return yield* body(db, tableName)
      }),
    () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(
      Layer.merge(ClientLayer, members.Base.layer({ name: tableName }) as Layer.Layer<never>),
    ),
  ) as Effect.Effect<A, unknown>
}

const rowsOf = (tableName: string) =>
  Effect.promise(async () => {
    const { Items = [] } = await raw.send(
      new ScanCommand({ TableName: tableName, ConsistentRead: true }),
    )
    return Items
  })

/** The rows a path that changes a row needs to find, with the list and the map a path op reaches into. */
const seed = (db: any, held?: unknown) =>
  Effect.gen(function* () {
    yield* db.entities.Rows.put({
      id: "a",
      ...(held === undefined ? {} : { list: [held], nested: { p: held } }),
    }).asEffect()
    yield* db.entities.Retained.put({ id: "a" }).asEffect()
    yield* db.aggregates.Order.create({ id: "a", lines: [] })
  })

class Point {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}
}
const Custom = Schema.instanceOf(Point)
const Duck = Schema.declare(
  (input: unknown): input is Point => typeof input === "object" && input !== null && "x" in input,
)
const FromStruct = Schema.Struct({ x: Schema.Number, y: Schema.Number }).pipe(
  Schema.decodeTo(Custom, {
    decode: SchemaGetter.transform(({ x, y }: { x: number; y: number }) => new Point(x, y)),
    encode: SchemaGetter.transform((point: Point) => ({ x: point.x, y: point.y })),
  }),
)

const value = new Point(1, 2)

describeConnected("a custom declaration on every write path", () => {
  for (const path of PATHS) {
    const named = `${path.operation}: ${path.name}`

    it.effect(`refused, nothing written: ${named}`, () => {
      const members = membersOf(Custom)
      return onTable(members, (db, tableName) =>
        Effect.gen(function* () {
          if (path.seeded) yield* seed(db)
          const before = yield* rowsOf(tableName)
          const exit = yield* Effect.exit(path.run(db, members, value))
          expect(Exit.isFailure(exit)).toBe(true)
          const error = Cause.squash(
            (exit as Exit.Failure<unknown, unknown>).cause,
          ) as ValidationError
          expect(error).toBeInstanceOf(ValidationError)
          expect(String(error.cause)).toContain("EDD-9126")
          expect(yield* rowsOf(tableName)).toEqual(before)
        }),
      )
    })

    for (const [what, F] of [
      ["a duck-typed declare", Duck],
      ["a struct decoded to the class", FromStruct],
    ] as const) {
      it.effect(`${what} writes: ${named}`, () => {
        const members = membersOf(F)
        return onTable(members, (db, tableName) =>
          Effect.gen(function* () {
            if (path.seeded) yield* seed(db, new Point(9, 9))
            const before = yield* rowsOf(tableName)
            yield* path.run(db, members, value)
            expect(yield* rowsOf(tableName)).not.toEqual(before)
          }),
        )
      })
    }
  }
})

describeConnected("a custom declaration's values", () => {
  it.effect("a duck-typed declare reads back what it wrote", () => {
    const members = membersOf(Duck)
    return onTable(members, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put({
          id: "a",
          f: value,
          list: [value],
          nested: { p: value },
        }).asEffect()
        const read = yield* db.entities.Rows.get({ id: "a" })
        expect(read).toEqual({
          id: "a",
          f: { x: 1, y: 2 },
          list: [{ x: 1, y: 2 }],
          nested: { p: { x: 1, y: 2 } },
        })
      }),
    )
  })

  it.effect("a struct decoded to the class reads back the class", () => {
    const members = membersOf(FromStruct)
    return onTable(members, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put({ id: "a", f: value }).asEffect()
        const read = yield* db.entities.Rows.get({ id: "a" })
        expect(read.f).toBeInstanceOf(Point)
        expect(read.f).toEqual(value)
      }),
    )
  })

  it.effect(
    "the guide's shape: refused with the row never written, and the struct form round-trips",
    () => {
      const refused = membersOf(Custom)
      const round = membersOf(FromStruct)
      return Effect.all([
        onTable(refused, (db, tableName) =>
          Effect.gen(function* () {
            const failure = yield* Effect.flip(
              db.entities.Rows.put({ id: "a", f: value }).asEffect(),
            )
            expect((failure as ValidationError)._tag).toBe("ValidationError")
            expect(String((failure as ValidationError).cause)).toContain("wouldn't read back")
            expect(yield* rowsOf(tableName)).toEqual([])
            expect(yield* db.entities.Rows.scan().collect()).toEqual([])
          }),
        ),
        onTable(round, (db, tableName) =>
          Effect.gen(function* () {
            const put = yield* db.entities.Rows.put({ id: "a", f: value }).asEffect()
            expect(put.f).toBeInstanceOf(Point)
            const [row] = yield* rowsOf(tableName)
            expect(row?.f).toEqual({ M: { x: { N: "1" }, y: { N: "2" } } })
            expect((yield* db.entities.Rows.get({ id: "a" })).f).toBeInstanceOf(Point)
          }),
        ),
      ])
    },
  )

  it.effect("a plain object given for the class still fails as it always has", () => {
    const members = membersOf(Custom)
    return onTable(members, (db, tableName) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          db.entities.Rows.put({ id: "a", f: { x: 1, y: 2 } }).asEffect(),
        )
        expect(error).toBeInstanceOf(ValidationError)
        expect(String((error as ValidationError).cause)).not.toContain("EDD-9126")
        expect(yield* rowsOf(tableName)).toEqual([])
      }),
    )
  })

  it.effect("a field left out of the payload isn't judged", () => {
    const members = membersOf(Custom)
    return onTable(members, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put({ id: "a", n: 1 }).asEffect()
        const updated = yield* db.entities.Rows.update({ id: "a" }).set({ n: 2 }).asEffect()
        expect(updated.n).toBe(2)
      }),
    )
  })

  it.effect("a row already stored stays as it is, and still fails on read", () => {
    const members = membersOf(Custom)
    return onTable(members, (db, tableName) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put({ id: "a" }).asEffect()
        const [seeded] = yield* rowsOf(tableName)
        // As 1.39.0 stored one: the instance's own properties, as a map.
        const Item = { ...seeded, f: { M: { x: { N: "1" }, y: { N: "2" } } } }
        yield* Effect.promise(() => raw.send(new PutItemCommand({ TableName: tableName, Item })))
        const failure = yield* Effect.flip(db.entities.Rows.get({ id: "a" }))
        expect(failure).toBeInstanceOf(ValidationError)
        expect(String((failure as ValidationError).cause)).not.toContain("EDD-9126")
        const [row] = yield* rowsOf(tableName)
        expect(row?.f).toEqual(Item.f)
        // A write that doesn't touch it leaves it, and can't be judged by a value it doesn't hold.
        yield* db.entities.Rows.update({ id: "a" }).set({ n: 1 }).asEffect().pipe(Effect.exit)
        const [after] = yield* rowsOf(tableName)
        expect(after?.f).toEqual(Item.f)
      }),
    )
  })
})
