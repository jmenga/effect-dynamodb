/**
 * A transformation between lists, or onto a list, against DynamoDB Local. What's stored is measured on
 * the published 1.39.0: a list whose elements are substituted is walked from its type side and the step
 * never runs, so rows already written hold what those elements store. A list with nothing to substitute
 * takes either side of it on an aggregate.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import {
  type AttributeValue,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  Config,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  SchemaGetter,
  SchemaTransformation,
} from "effect"
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

const Keys = {
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" as const },
    { AttributeName: "sk", KeyType: "RANGE" as const },
  ],
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" as const },
    { AttributeName: "sk", AttributeType: "S" as const },
  ],
}

type Row = Record<string, AttributeValue>

let tables = 0
const onTable = <A, E>(Base: any, body: (tableName: string) => Effect.Effect<A, E, any>) => {
  const tableName = `list-steps-${Date.now()}-${tables++}`
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", ...Keys })
    }),
    () => body(tableName),
    () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Base.layer({ name: tableName }) as Layer.Layer<never>)),
  ) as Effect.Effect<A, unknown>
}

const rowsOf = (tableName: string) =>
  Effect.promise(async () => {
    const { Items = [] } = await raw.send(
      new ScanCommand({ TableName: tableName, ConsistentRead: true }),
    )
    return Items as ReadonlyArray<Row>
  })

const load = (tableName: string, Item: Row) =>
  Effect.promise(() => raw.send(new PutItemCommand({ TableName: tableName, Item })))

const ISO = "1970-01-01T00:00:00.000Z"
const when = new Date(0)
const R = Schema.Redacted(Schema.String)
const secret = Redacted.make("s")
const D = Schema.Date
const List = Schema.Array

const overItself = <S extends Schema.Top>(from: S) =>
  from.pipe(Schema.decodeTo(from as never, SchemaTransformation.passthrough() as never))
const mapped = (
  from: Schema.Top,
  to: Schema.Top,
  decode: (value: any) => unknown,
  encode: (value: any) => unknown,
) =>
  (from as Schema.Codec<any>).pipe(
    Schema.decodeTo(to as Schema.Codec<any>, {
      decode: SchemaGetter.transform((list: ReadonlyArray<unknown>) => list.map(decode)),
      encode: SchemaGetter.transform((list: ReadonlyArray<unknown>) => list.map(encode)),
    }),
  ) as Schema.Top

/** Redacted values don't compare, and a read one doesn't print. */
const plain = (value: unknown): unknown =>
  Redacted.isRedacted(value)
    ? `redacted ${Redacted.value(value as Redacted.Redacted<unknown>)}`
    : value instanceof Date
      ? value.toISOString()
      : Array.isArray(value)
        ? value.map(plain)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, plain(v)]))
          : value

type Shape = {
  readonly name: string
  readonly field: Schema.Top
  readonly value: unknown
  /** What the published 1.39.0 stored for `value`, on an aggregate and, unless `aggregateOnly`, an entity. */
  readonly stored: AttributeValue
  /** What an entity stores for it, if that's something else. On 1.39.0 it wrote this, and failed. */
  readonly entityStored?: AttributeValue
  /** On 1.39.0 and now, an entity's `put` refuses it, writing nothing. */
  readonly aggregateOnly?: boolean
}

const WALKED: ReadonlyArray<Shape> = [
  {
    name: "a list of dates over itself",
    field: overItself(List(D)),
    value: [when],
    stored: { L: [{ S: ISO }] },
  },
  {
    name: "a list of redacted values over itself",
    field: overItself(List(R)),
    value: [secret],
    stored: { L: [{ S: "s" }] },
  },
  {
    name: "a list of lists of dates over itself",
    field: overItself(List(List(D))),
    value: [[when]],
    stored: { L: [{ L: [{ S: ISO }] }] },
  },
  {
    name: "a struct holding a list of dates over itself",
    field: Schema.Struct({ l: overItself(List(D)) as never }),
    value: { l: [when] },
    stored: { M: { l: { L: [{ S: ISO }] } } },
  },
  {
    name: "a list of dates or null, over itself in a union",
    field: Schema.NullOr(overItself(List(D)) as never),
    value: [when],
    stored: { L: [{ S: ISO }] },
  },
  {
    name: "a list of dates mapped to itself, where the step never runs",
    field: mapped(
      List(D),
      List(D),
      (d: Date) => new Date(d.getTime() + 1),
      (d: Date) => new Date(d.getTime() - 1),
    ),
    value: [when],
    stored: { L: [{ S: ISO }] },
  },
  {
    name: "a list of numbers decoded to a list of dates",
    field: mapped(
      List(Schema.Number),
      List(D),
      (n: number) => new Date(n),
      (d: Date) => d.getTime(),
    ),
    value: [when],
    stored: { L: [{ S: ISO }] },
  },
  {
    name: "a list of strings decoded to a list of redacted values",
    field: mapped(
      List(Schema.String),
      List(R),
      (s: string) => Redacted.make(s),
      (r: Redacted.Redacted<string>) => Redacted.value(r),
    ),
    value: [secret],
    stored: { L: [{ S: "s" }] },
  },
  {
    name: "a list of Schema.BigIntFromString over itself",
    field: overItself(List(Schema.BigIntFromString)),
    value: [5n],
    stored: { L: [{ S: "5" }] },
    aggregateOnly: true,
  },
  {
    name: "a list of Schema.BigIntFromString decoded to a list of bigints",
    field: mapped(
      List(Schema.BigIntFromString),
      List(Schema.BigInt),
      (b: bigint) => b,
      (b: bigint) => b,
    ),
    value: [5n],
    stored: { L: [{ N: "5" }] },
    entityStored: { L: [{ S: "5" }] },
  },
  {
    name: "a list of strings decoded to a list of bigints",
    field: mapped(
      List(Schema.String),
      List(Schema.BigInt),
      (s: string) => BigInt(s),
      (b: bigint) => String(b),
    ),
    value: [5n],
    stored: { L: [{ N: "5" }] },
    entityStored: { L: [{ S: "5" }] },
  },
  {
    name: "a list of Schema.BigIntFromString held as JSON",
    field: Schema.fromJsonString(List(Schema.BigIntFromString)),
    value: [1n],
    stored: { L: [{ S: "1" }] },
    entityStored: { S: '["1"]' },
  },
]

/** Nothing in the list is substituted, so an aggregate takes what the step makes and what it stores. */
const EITHER_SIDE: ReadonlyArray<{
  readonly name: string
  readonly field: Schema.Top
  readonly domain: unknown
  readonly wire: unknown
  readonly stored: AttributeValue
}> = [
  {
    name: "a list of strings decoded to a list of numbers",
    field: mapped(
      List(Schema.String),
      List(Schema.Number),
      (s: string) => Number(s),
      (n: number) => String(n),
    ),
    domain: [5],
    wire: ["5"],
    stored: { L: [{ S: "5" }] },
  },
  {
    name: "a list of bigints decoded to a list of strings",
    field: mapped(
      List(Schema.BigInt),
      List(Schema.String),
      (b: bigint) => String(b),
      (s: string) => BigInt(s),
    ),
    domain: ["5"],
    wire: [5n],
    stored: { L: [{ N: "5" }] },
  },
  {
    name: "a list of numbers held as JSON",
    field: Schema.fromJsonString(List(Schema.Number)),
    domain: [1],
    wire: "[1]",
    stored: { S: "[1]" },
  },
  {
    name: "a one-element tuple of numbers decoded to one of dates",
    field: Schema.Tuple([Schema.Number]).pipe(
      Schema.decodeTo(Schema.Tuple([D]), {
        decode: SchemaGetter.transform(([n]: readonly [number]) => [new Date(n)] as const),
        encode: SchemaGetter.transform(([d]: readonly [Date]) => [d.getTime()] as const),
      }),
    ),
    domain: [when],
    wire: [0],
    stored: { L: [{ N: "0" }] },
  },
]

const schema = DynamoSchema.make({ name: "steps", version: 1 })

const aggregateOver = (field: Schema.Top) => {
  const Model = Schema.Struct({
    id: Schema.String,
    f: field as Schema.Codec<any>,
    note: Schema.optional(Schema.String),
  })
  const Base = Table.make({ schema, entities: {} })
  const A = Aggregate.make(
    Model as never,
    {
      table: Base,
      schema: Base.schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "agg" },
      root: { entityType: "Root" },
      edges: {},
    } as never,
  ) as any
  const Tb = { ...Base, aggregates: { A } } as any
  const client = DynamoClient.make({ entities: {}, aggregates: { A }, tables: { Tb } } as never)
  return { Base, client: client as Effect.Effect<any, never, any> }
}

const entityOver = (field: Schema.Top) => {
  const Model = Schema.Struct({
    id: Schema.String,
    f: field as Schema.Codec<any>,
    note: Schema.optional(Schema.String),
  })
  const E = Entity.make({
    model: Model as never,
    entityType: "E",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  } as never) as any
  const Base = Table.make({ schema, entities: { E } })
  const client = DynamoClient.make({ entities: { E }, tables: { Base } } as never)
  return { Base, client: client as Effect.Effect<any, never, any> }
}

describeConnected("a transformation between lists", () => {
  it.effect("an entity reads a row holding a list of Schema.BigIntFromString over itself", () => {
    const { Base, client } = entityOver(overItself(List(Schema.BigIntFromString)))
    return onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const db = yield* client
        yield* load(tableName, {
          pk: { S: "$steps#v1#e#id_a" },
          sk: { S: "$steps#v1#e" },
          __edd_e__: { S: "E" },
          id: { S: "a" },
          f: { L: [{ S: "5" }] },
        })
        const read = yield* db.entities.E.get({ id: "a" })
        expect(read.f).toEqual([5n])
      }),
    ) as Effect.Effect<void>
  })

  for (const [name, element] of [
    ["bigints", Schema.BigInt],
    ["Schema.BigIntFromString", Schema.BigIntFromString],
  ] as const) {
    it.effect(`an aggregate given nothing for a step to a list of lists of ${name}`, () => {
      const inner = List(element)
      const step = Schema.optionalKey(inner).pipe(
        Schema.decodeTo(
          List(Schema.toType(inner)) as never,
          {
            decode: SchemaGetter.transformOptional((value: Option.Option<unknown>) =>
              Option.some(Option.match(value, { onNone: () => [], onSome: (one) => [one] })),
            ),
            encode: SchemaGetter.transformOptional((value: Option.Option<any>) =>
              Option.flatMap(value, (list) =>
                list.length > 0 ? Option.some(list[0]) : Option.none(),
              ),
            ),
          } as never,
        ),
      ) as unknown as Schema.Top
      const { Base, client } = aggregateOver(step)
      return onTable(Base, (tableName) =>
        Effect.gen(function* () {
          const db = yield* client
          const created = yield* db.aggregates.A.create({ id: "a" })
          expect(created.f).toEqual([])
          const [row] = yield* rowsOf(tableName)
          expect(row!.f).toBeUndefined()
          const read = yield* db.aggregates.A.get({ id: "a" })
          expect(read.f).toEqual([])
        }),
      ) as Effect.Effect<void>
    })
  }

  it.effect("an entity reads back a list of bigints decoded to a list of strings", () => {
    const { Base, client } = entityOver(
      mapped(
        List(Schema.BigInt),
        List(Schema.String),
        (b: bigint) => String(b),
        (s: string) => BigInt(s),
      ),
    )
    return onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.E.put({ id: "a", f: ["5"] }).asEffect()
        const [row] = yield* rowsOf(tableName)
        expect(row!.f).toEqual({ L: [{ N: "5" }] })
        const read = yield* db.entities.E.get({ id: "a" })
        expect(read.f).toEqual(["5"])
      }),
    ) as Effect.Effect<void>
  })

  for (const shape of WALKED) {
    it.effect(`an aggregate stores and reads ${shape.name} as 1.39.0 did`, () => {
      const { Base, client } = aggregateOver(shape.field)
      return onTable(Base, (tableName) =>
        Effect.gen(function* () {
          const db = yield* client
          const created = yield* db.aggregates.A.create({ id: "a", f: shape.value })
          expect(plain(created.f)).toEqual(plain(shape.value))
          const [row] = yield* rowsOf(tableName)
          expect(row!.f).toEqual(shape.stored)

          const read = yield* db.aggregates.A.get({ id: "a" })
          expect(plain(read.f)).toEqual(plain(shape.value))

          const updated = yield* db.aggregates.A.update({ id: "a" }, ({ state }: any) => ({
            ...state,
            note: "n",
          }))
          expect(plain(updated.f)).toEqual(plain(shape.value))
          const [after] = yield* rowsOf(tableName)
          expect(after!.f).toEqual(shape.stored)
          expect(after!.note).toEqual({ S: "n" })
        }),
      ) as Effect.Effect<void>
    })

    it.effect(`an aggregate reads a row 1.39.0 wrote for ${shape.name}`, () => {
      const { Base, client } = aggregateOver(shape.field)
      return onTable(Base, (tableName) =>
        Effect.gen(function* () {
          const db = yield* client
          yield* db.aggregates.A.create({ id: "a", f: shape.value })
          const [row] = yield* rowsOf(tableName)
          yield* load(tableName, { ...row!, f: shape.stored })
          const read = yield* db.aggregates.A.get({ id: "a" })
          expect(plain(read.f)).toEqual(plain(shape.value))
        }),
      ) as Effect.Effect<void>
    })

    if (shape.aggregateOnly === true) continue

    it.effect(`an entity stores and reads ${shape.name} as 1.39.0 did`, () => {
      const { Base, client } = entityOver(shape.field)
      return onTable(Base, (tableName) =>
        Effect.gen(function* () {
          const db = yield* client
          const put = yield* db.entities.E.put({ id: "a", f: shape.value }).asEffect()
          expect(plain(put.f)).toEqual(plain(shape.value))
          const [row] = yield* rowsOf(tableName)
          expect(row!.f).toEqual(shape.entityStored ?? shape.stored)
          const read = yield* db.entities.E.get({ id: "a" })
          expect(plain(read.f)).toEqual(plain(shape.value))
          const updated = yield* db.entities.E.update({ id: "a" }).set({ note: "n" }).asEffect()
          expect(plain(updated.f)).toEqual(plain(shape.value))
          const [after] = yield* rowsOf(tableName)
          expect(after!.f).toEqual(shape.entityStored ?? shape.stored)
        }),
      ) as Effect.Effect<void>
    })
  }

  for (const shape of EITHER_SIDE) {
    for (const [side, value] of [
      ["what the step makes", shape.domain],
      ["what it stores", shape.wire],
    ] as const) {
      it.effect(`an aggregate takes ${shape.name}, given ${side}`, () => {
        const { Base, client } = aggregateOver(shape.field)
        return onTable(Base, (tableName) =>
          Effect.gen(function* () {
            const db = yield* client
            const created = yield* db.aggregates.A.create({ id: "a", f: value })
            expect(plain(created.f)).toEqual(plain(shape.domain))
            const [row] = yield* rowsOf(tableName)
            expect(row!.f).toEqual(shape.stored)
            const read = yield* db.aggregates.A.get({ id: "a" })
            expect(plain(read.f)).toEqual(plain(shape.domain))
            yield* db.aggregates.A.update({ id: "a" }, ({ state }: any) => ({
              ...state,
              note: "n",
            }))
            const [after] = yield* rowsOf(tableName)
            expect(after!.f).toEqual(shape.stored)
          }),
        ) as Effect.Effect<void>
      })
    }
  }
})
