/**
 * An aggregate takes what a caller holds as a domain value, as an entity does, against DynamoDB Local.
 * Where a transformation has one type on both sides, 1.39.0 read a caller's value as its stored form:
 * `create(50)` on a field multiplying by 10 returned 500 and stored 50, and every `update`, whatever it
 * changed, multiplied it again.
 *
 * `fixtures/aggregate-same-type-1.39.0.json` holds rows published 1.39.0 wrote through `create`, and
 * through one and two updates, with what its `get` returned. It's generated once from the published
 * package: don't regenerate or "fix" it.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import { type AttributeValue, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  Config,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
  SchemaGetter,
  SchemaTransformation,
} from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
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

const X10 = Schema.Number.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((value) => value * 10),
    encode: SchemaGetter.transform((value) => value / 10),
  }),
)
const Bang = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value) => `${value}!`),
    encode: SchemaGetter.transform((value) => value.replace(/!$/, "")),
  }),
)
const B10 = Schema.BigInt.pipe(
  Schema.decodeTo(Schema.BigInt, {
    decode: SchemaGetter.transform((value) => value * 10n),
    encode: SchemaGetter.transform((value) => value / 10n),
  }),
)

// The fixture's model: it must stay what the generator declared.
const schema = DynamoSchema.make({ name: "dv", version: 1 })
const primary = <const F extends string>(field: F) =>
  ({
    pk: { field: "pk", composite: [field] },
    sk: { field: "sk", composite: [] },
  }) as const
class Maker extends Schema.Class<Maker>("Maker")({
  makerId: Schema.String,
  rate: X10,
  label: Bang,
}) {}
const Makers = Entity.make({
  model: DynamoModel.configure(Maker, { makerId: { identifier: true } }),
  entityType: "DvMaker",
  primaryKey: primary("makerId"),
})
class Line extends Schema.Class<Line>("Line")({ id: Schema.String, f: X10 }) {}
const Lines = Entity.make({
  model: DynamoModel.configure(Line, { id: { identifier: true } }),
  entityType: "DvLineEntity",
  primaryKey: primary("id"),
})
class Boss extends Schema.Class<Boss>("Boss")({ f: X10 }) {}
class Squad extends Schema.Class<Squad>("Squad")({ f: X10, boss: Boss }) {}
const SquadAggregate = Aggregate.make(Squad, {
  root: { entityType: "DvSquad" },
  edges: { boss: Aggregate.one({ entityType: "DvBoss" }) },
})
class Root extends Schema.Class<Root>("Root")({
  id: Schema.String,
  customer: Schema.String,
  region: Bang,
  f: X10,
  label: Bang,
  note: Schema.optional(Schema.String),
  nested: Schema.Struct({ x: X10 }),
  list: Schema.Array(X10),
  rec: Schema.Record(Schema.String, X10),
  opt: Schema.optional(X10),
  maybe: Schema.NullOr(X10),
  maker: Maker.pipe(DynamoModel.ref),
  boss: Boss,
  lines: Schema.Array(Line),
  squad: Squad,
}) {}
class Anchor extends Schema.Class<Anchor>("Anchor")({ anchorId: Schema.String }) {}
const Anchors = Entity.make({
  model: Anchor,
  entityType: "DvAnchor",
  primaryKey: primary("anchorId"),
})
const Main = Table.make({ schema, entities: { Anchors, Makers, Lines } })
const Roots = Aggregate.make(Root, {
  table: Main,
  schema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "dvroot" },
  list: {
    index: "gsi1",
    name: "dvlist",
    pk: { field: "gsi1pk", composite: ["customer"] },
    sk: { field: "gsi1sk", composite: ["id"] },
  },
  context: ["region"],
  root: { entityType: "DvRoot" },
  edges: {
    maker: Aggregate.one({ entityType: "DvMakerRow", entity: Makers }),
    boss: Aggregate.one({ entityType: "DvBossRow" }),
    lines: Aggregate.many({ entityType: "DvLine", entity: Lines }),
    squad: SquadAggregate.with({ discriminator: { part: 1 } }),
  },
})

let tables = 0
const definition = {
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

/** Runs `body` on a fresh table, counting the transactions it sends. */
const onTable = <A, E>(
  Base: { readonly layer: (config: { readonly name: string }) => unknown },
  body: (tableName: string, writes: { count: number }) => Effect.Effect<A, E, any>,
) => {
  const tableName = `domain-values-${Date.now()}-${tables++}`
  const writes = { count: 0 }
  const Counting = Layer.effect(
    DynamoClient,
    Effect.gen(function* () {
      const client = yield* DynamoClient
      return {
        ...client,
        transactWriteItems: (input) => {
          writes.count++
          return client.transactWriteItems(input)
        },
      } satisfies DynamoClientService
    }),
  ).pipe(Layer.provide(ClientLayer))
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        ...definition,
      })
    }),
    () => body(tableName, writes),
    () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(Counting, Base.layer({ name: tableName }) as Layer.Layer<never>)),
  ) as Effect.Effect<A, unknown>
}

const rowsOf = (tableName: string, id: string) =>
  Effect.promise(async () => {
    const scan = await raw.send(new ScanCommand({ TableName: tableName, ConsistentRead: true }))
    return ((scan.Items ?? []) as ReadonlyArray<Row>).filter((row) =>
      (row.pk as { S: string }).S.includes(id),
    )
  })

/** The row whose sort key names this entity type. */
const rowOf = (rows: ReadonlyArray<Row>, entityType: string) =>
  rows.find((row) => (row.sk as { S: string }).S.includes(entityType)) as Row

const input = (id: string) => ({
  id,
  customer: "c",
  region: "r!",
  f: 50,
  label: "a!",
  nested: { x: 50 },
  list: [50],
  rec: { k: 50 },
  opt: 50,
  maybe: 50,
  makerId: "m1",
  boss: { f: 50 },
  lines: [{ id: "l1", f: 50 }],
  squad: { f: 50, boss: { f: 50 } },
})

const asDomain = {
  region: "r!",
  f: 50,
  label: "a!",
  nested: { x: 50 },
  list: [50],
  rec: { k: 50 },
  opt: 50,
  maybe: 50,
  maker: { makerId: "m1", rate: 50, label: "a!" },
  boss: { f: 50 },
  lines: [{ id: "l1", f: 50 }],
  squad: { f: 50, boss: { f: 50 } },
}

/** What every row of one `input` stores: the encoded form, at every position. */
const expectStored = (rows: ReadonlyArray<Row>) => {
  const root = rowOf(rows, "dvroot")
  expect(root.f).toEqual({ N: "5" })
  expect(root.label).toEqual({ S: "a" })
  expect(root.region).toEqual({ S: "r" })
  expect(root.nested).toEqual({ M: { x: { N: "5" } } })
  expect(root.list).toEqual({ L: [{ N: "5" }] })
  expect(root.rec).toEqual({ M: { k: { N: "5" } } })
  expect(root.opt).toEqual({ N: "5" })
  expect(root.maybe).toEqual({ N: "5" })
  const maker = rowOf(rows, "dvmakerrow")
  expect(maker.rate).toEqual({ N: "5" })
  expect(maker.label).toEqual({ S: "a" })
  for (const entityType of ["dvbossrow", "dvline", "dvsquad", "dvboss#"]) {
    const row = rowOf(rows, entityType)
    expect(row.f).toEqual({ N: "5" })
    expect(row.region).toEqual({ S: "r" })
  }
}

const bind = Effect.gen(function* () {
  return yield* DynamoClient.make({
    entities: { Makers },
    aggregates: { Roots },
    tables: { Main },
  })
})

const withMaker = Effect.gen(function* () {
  const db = yield* bind
  yield* db.entities.Makers.put({ makerId: "m1", rate: 50, label: "a!" }).asEffect()
  return db
})

describeConnected("an aggregate takes a caller's value as a domain value", () => {
  it.effect("create stores the encoded form at every position and returns what was given", () =>
    onTable(Main, (tableName) =>
      Effect.gen(function* () {
        const db = yield* withMaker
        const created = yield* db.aggregates.Roots.create(input("a"))
        expect(created).toMatchObject(asDomain)
        expectStored(yield* rowsOf(tableName, "dvroot#a"))
        expect(yield* db.aggregates.Roots.get({ id: "a" })).toMatchObject(asDomain)
      }),
    ),
  )

  it.effect("list reads what get reads", () =>
    onTable(Main, () =>
      Effect.gen(function* () {
        const db = yield* withMaker
        yield* db.aggregates.Roots.create(input("a"))
        const listed = yield* db.aggregates.Roots.list({ customer: "c" })
        expect(listed.data).toHaveLength(1)
        expect(listed.data[0]).toMatchObject(asDomain)
      }),
    ),
  )

  it.effect("an update changing something else leaves every other stored value alone", () =>
    onTable(Main, (tableName) =>
      Effect.gen(function* () {
        const db = yield* withMaker
        yield* db.aggregates.Roots.create(input("a"))
        for (const note of ["one", "two", "three"]) {
          const updated = yield* db.aggregates.Roots.update({ id: "a" }, ({ state }) => ({
            ...state,
            note,
          }))
          expect(updated).toMatchObject({ ...asDomain, note })
          expectStored(yield* rowsOf(tableName, "dvroot#a"))
          expect(yield* db.aggregates.Roots.get({ id: "a" })).toMatchObject({ ...asDomain, note })
        }
      }),
    ),
  )

  it.effect("a no-op update writes nothing", () =>
    onTable(Main, (_tableName, writes) =>
      Effect.gen(function* () {
        const db = yield* withMaker
        yield* db.aggregates.Roots.create(input("a"))
        writes.count = 0
        yield* db.aggregates.Roots.update({ id: "a" }, ({ state }) => state)
        expect(writes.count).toBe(0)
      }),
    ),
  )

  it.effect(
    "state, cursor and current hold domain values, and what's set stores its encoded form",
    () =>
      onTable(Main, (tableName) =>
        Effect.gen(function* () {
          const db = yield* withMaker
          yield* db.aggregates.Roots.create(input("a"))
          const updated = yield* db.aggregates.Roots.update({ id: "a" }, (context) => {
            const state = context.state as unknown as typeof asDomain
            expect(state).toMatchObject(asDomain)
            expect(context.current).toMatchObject(asDomain)
            return {
              ...state,
              f: state.f + 20,
              label: "b!",
              region: "s!",
              boss: { f: 70 },
            } as never
          })
          expect(updated).toMatchObject({ f: 70, label: "b!", region: "s!", boss: { f: 70 } })
          const rows = yield* rowsOf(tableName, "dvroot#a")
          expect(rowOf(rows, "dvroot").f).toEqual({ N: "7" })
          expect(rowOf(rows, "dvroot").label).toEqual({ S: "b" })
          expect(rowOf(rows, "dvbossrow").f).toEqual({ N: "7" })
          for (const entityType of ["dvroot", "dvline", "dvsquad", "dvbossrow"]) {
            expect(rowOf(rows, entityType).region).toEqual({ S: "s" })
          }
          expect(rowOf(rows, "dvline").f).toEqual({ N: "5" })
          expect(yield* db.aggregates.Roots.get({ id: "a" })).toMatchObject({ f: 70, region: "s!" })
        }),
      ),
  )

  it.effect("a mutation through the cursor stores the encoded form", () =>
    onTable(Main, (tableName) =>
      Effect.gen(function* () {
        const db = yield* withMaker
        yield* db.aggregates.Roots.create(input("a"))
        yield* db.aggregates.Roots.update({ id: "a" }, ({ cursor }) =>
          (cursor as any).key("nested").key("x").replace(90),
        )
        const rows = yield* rowsOf(tableName, "dvroot#a")
        expect(rowOf(rows, "dvroot").nested).toEqual({ M: { x: { N: "9" } } })
        expect(rowOf(rows, "dvroot").f).toEqual({ N: "5" })
      }),
    ),
  )

  it.effect("nonsense is refused, on create and on update, and nothing is written", () =>
    onTable(Main, (tableName) =>
      Effect.gen(function* () {
        const db = yield* withMaker
        const refused = yield* db.aggregates.Roots.create({ ...input("b"), f: "nonsense" }).pipe(
          Effect.flip,
        )
        expect(refused._tag).toBe("ValidationError")
        expect(yield* rowsOf(tableName, "dvroot#b")).toEqual([])
        yield* db.aggregates.Roots.create(input("a"))
        const before = yield* rowsOf(tableName, "dvroot#a")
        for (const [field, value] of [
          ["f", "nonsense"],
          ["nested", { x: "nonsense" }],
          ["list", ["nonsense"]],
          ["boss", { f: "nonsense" }],
        ] as const) {
          const error = yield* db.aggregates.Roots.update(
            { id: "a" },
            ({ state }) => ({ ...state, [field]: value }) as never,
          ).pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
        }
        expect(yield* rowsOf(tableName, "dvroot#a")).toEqual(before)
      }),
    ),
  )
})

const S = Schema.String
const over = (transformation: SchemaTransformation.Transformation<string, string>) =>
  S.pipe(Schema.decodeTo(S, transformation))
class Held extends Schema.Class<Held>("Held")({ x: X10 }) {}
type Tree = { readonly x: number; readonly next?: Tree }
const Tree: Schema.Codec<Tree, { readonly x: number; readonly next?: unknown }> = Schema.Struct({
  x: X10,
  next: Schema.optionalKey(Schema.suspend((): Schema.Codec<Tree, any> => Tree)),
})

const SetS = Schema.ReadonlySet(S)
const SetB = Schema.ReadonlySet(Schema.BigInt)
/** A list decoded to a list of something else, one to one. */
const listTo = (
  element: Schema.Top,
  to: Schema.Top,
  decode: (x: any) => unknown,
  encode: (x: any) => unknown,
) =>
  Schema.Array(element as Schema.Codec<any>).pipe(
    Schema.decodeTo(Schema.Array(to as Schema.Codec<any>), {
      decode: SchemaGetter.transform((list: ReadonlyArray<unknown>) => list.map(decode)),
      encode: SchemaGetter.transform((list: ReadonlyArray<unknown>) => list.map(encode)),
    }),
  ) as Schema.Top
/** One value stored, read as a struct holding it. */
const toStruct = (held: Schema.Top) =>
  (held as Schema.Codec<any>).pipe(
    Schema.decodeTo(Schema.Struct({ y: Schema.toType(held as Schema.Codec<any>) }), {
      decode: SchemaGetter.transform((y: unknown) => ({ y })),
      encode: SchemaGetter.transform((value: { readonly y: unknown }) => value.y),
    }),
  ) as Schema.Top
/** A list stored, read as a set of ten times each number, so its plain state is a list that means something else. */
const SetFromListX10 = Schema.Array(Schema.Number).pipe(
  Schema.decodeTo(Schema.ReadonlySet(Schema.Number), {
    decode: SchemaGetter.transform(
      (list: ReadonlyArray<number>) => new Set(list.map((x) => x * 10)),
    ),
    encode: SchemaGetter.transform((set: ReadonlySet<number>) => [...set].map((x) => x / 10)),
  }),
)

/** Field, what a caller gives, and how it should read when both owners take it. */
const SAME: ReadonlyArray<readonly [string, Schema.Top, unknown]> = [
  ["a number", X10, 50],
  ["a string", Bang, "a!"],
  ["a bigint", B10, 50n],
  ["a key optional", Schema.optionalKey(X10), 50],
  ["an optional", Schema.optional(X10), 50],
  ["a nullable", Schema.NullOr(X10), 50],
  ["a list", Schema.Array(X10), [50, 60]],
  ["a record", Schema.Record(S, X10), { k: 50 }],
  ["a tuple", Schema.Tuple([X10, S]), [50, "s"]],
  ["a struct", Schema.Struct({ x: X10 }), { x: 50 }],
  ["a class", Held, new Held({ x: 50 })],
  ["an Option", Schema.Option(X10), Option.some(50)],
  ["an Option of a struct", Schema.Option(Schema.Struct({ x: X10 })), Option.some({ x: 50 })],
  ["a Result", Schema.Result(X10, S), Result.succeed(50)],
  ["a set", Schema.ReadonlySet(X10), new Set([50])],
  ["a suspend", Schema.suspend(() => X10), 50],
  ["a suspended struct", Schema.suspend(() => Schema.Struct({ x: X10 })), { x: 50 }],
  ["a recursive struct", Tree, { x: 50, next: { x: 60 } }],
  ["a union", Schema.Union([X10, S]), 50],
  ["a union's other member", Schema.Union([X10, S]), "s"],
  ["a union of strings", Schema.Union([Bang, Schema.Number]), "a!"],
  ["a check", Bang.check(Schema.isMinLength(1)), "a!"],
  ["a default", X10.pipe(Schema.withDecodingDefaultKey(Effect.succeed(7))), 50],
  [
    "a default on a struct",
    Schema.Struct({ x: X10 }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ x: 7 }))),
    { x: 50 },
  ],
  ["encodeKeys", Schema.Struct({ a: S }).pipe(Schema.encodeKeys({ a: "b" })), { a: "x" }],
  [
    "encodeKeys, optional",
    Schema.Struct({ a: Schema.optionalKey(S) }).pipe(Schema.encodeKeys({ a: "b" })),
    { a: "x" },
  ],
  ["OptionFromOptional", Schema.OptionFromOptional(S), Option.some("x")],
  ["OptionFromOptional, none", Schema.OptionFromOptional(S), Option.none()],
  ["OptionFromOptional over a transformation", Schema.OptionFromOptional(X10), Option.some(50)],
  ["OptionFromNullOr over a transformation", Schema.OptionFromNullOr(X10), Option.some(50)],
  ["StringFromBase64, given base64", Schema.StringFromBase64, "aGVsbG8="],
  ["StringFromBase64", Schema.StringFromBase64, "hello"],
  ["StringFromBase64Url, given base64", Schema.StringFromBase64Url, "aGVsbG8"],
  ["StringFromHex, given hex", Schema.StringFromHex, "6869"],
  ["StringFromHex", Schema.StringFromHex, "hi"],
  ["StringFromUriComponent, given an escape", Schema.StringFromUriComponent, "a%20b"],
  ["fromJsonString over unknown, given json", Schema.fromJsonString(Schema.Unknown), '{"a":1}'],
  ["fromJsonString over unknown, given a struct", Schema.fromJsonString(Schema.Unknown), { a: 1 }],
  ["fromJsonString, given a quoted string", Schema.fromJsonString(S), '"x"'],
  ["Trim", Schema.Trim, "a"],
  ["Trim, given spaces", Schema.Trim, "  a "],
  ["snakeToCamel, given snake", over(SchemaTransformation.snakeToCamel()), "a_b"],
  ["NumberFromString, given the number", Schema.NumberFromString, 5],
  ["NumberFromString, given the text", Schema.NumberFromString, "5"],
  ["BigIntFromString, given the bigint", Schema.BigIntFromString, 5n],
  // What a mutation's plain state holds as something else, inside what a transformation decodes to.
  [
    "a list decoded to sets",
    listTo(
      S,
      SetS,
      (x) => new Set([x]),
      (x) => [...x][0],
    ),
    [new Set(["a"])],
  ],
  ["a struct holding a set", toStruct(SetS), { y: new Set(["a"]) }],
  ["a struct holding a set of bigints", toStruct(SetB), { y: new Set([5n]) }],
  ["a struct holding a class", toStruct(Held), { y: new Held({ x: 50 }) }],
  ["a set decoded from a list, ten times each number", SetFromListX10, new Set([50])],
]

/** The same field on an entity and an aggregate. */
const bothOwners = (field: Schema.Top) => {
  const Model = Schema.Struct({ id: S, f: field, note: Schema.optional(S) })
  const One = Entity.make({
    model: Model,
    entityType: "One",
    primaryKey: primary("id"),
  } as never) as any
  const Base = Table.make({
    schema: DynamoSchema.make({ name: "same", version: 1 }),
    entities: { One },
  })
  const Group = Aggregate.make(Model, {
    table: Base,
    schema: Base.schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "group" },
    root: { entityType: "Group" },
    edges: {},
  } as never) as any
  return { One, Base, Group }
}

const fieldOf = (rows: ReadonlyArray<Row>) => rows[0]?.f

describeConnected("an aggregate stores and reads what an entity does, on one field", () => {
  for (const [name, field, given] of SAME) {
    it.effect(name, () => {
      const { One, Base, Group } = bothOwners(field)
      return onTable(Base, (tableName, writes) =>
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { One },
            aggregates: { Group },
            tables: { Base },
          }) as any
          const put = yield* db.entities.One.put({ id: "e", f: given }).asEffect()
          const stored = fieldOf(yield* rowsOf(tableName, "#one#id_e"))
          const got = yield* db.entities.One.get({ id: "e" })

          const created = yield* db.aggregates.Group.create({ id: "g", f: given })
          expect(created.f).toEqual(put.f)
          expect(fieldOf(yield* rowsOf(tableName, "group#g"))).toEqual(stored)
          expect((yield* db.aggregates.Group.get({ id: "g" })).f).toEqual(got.f)

          // An update of something else leaves it, however many times.
          for (const note of ["one", "two"]) {
            yield* db.aggregates.Group.update({ id: "g" }, ({ state }: any) => ({ ...state, note }))
            expect(fieldOf(yield* rowsOf(tableName, "group#g"))).toEqual(stored)
            expect((yield* db.aggregates.Group.get({ id: "g" })).f).toEqual(got.f)
          }
          writes.count = 0
          yield* db.aggregates.Group.update({ id: "g" }, ({ state }: any) => state)
          expect(writes.count).toBe(0)
        }),
      )
    })
  }

  // A transformation that changes text on decode reads the same on both owners. An aggregate stores
  // what it reads, as it always has, where an entity stores what it was given.
  it.effect("a transformation changing text on decode reads the same, stored as it was", () => {
    const { One, Base, Group } = bothOwners(over(SchemaTransformation.toLowerCase()))
    return onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { One },
          aggregates: { Group },
          tables: { Base },
        }) as any
        const put = yield* db.entities.One.put({ id: "e", f: "A" }).asEffect()
        expect(put.f).toBe("a")
        expect(fieldOf(yield* rowsOf(tableName, "#one#id_e"))).toEqual({ S: "A" })
        const created = yield* db.aggregates.Group.create({ id: "g", f: "A" })
        expect(created.f).toBe("a")
        expect(fieldOf(yield* rowsOf(tableName, "group#g"))).toEqual({ S: "a" })
        expect((yield* db.aggregates.Group.get({ id: "g" })).f).toBe("a")
      }),
    )
  })

  for (const [name, field, stored, read] of [
    ["a number", X10.pipe(Schema.withDecodingDefaultKey(Effect.succeed(7))), { N: "7" }, 70],
    [
      "a number, or undefined",
      X10.pipe(Schema.withDecodingDefault(Effect.succeed(7))),
      { N: "7" },
      70,
    ],
    ["a bigint", B10.pipe(Schema.withDecodingDefaultKey(Effect.succeed(7n))), { N: "7" }, 70n],
    [
      "a struct",
      Schema.Struct({ x: X10 }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ x: 7 }))),
      { M: { x: { N: "7" } } },
      { x: 70 },
    ],
    [
      "a class",
      Held.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ x: 7 }))),
      { M: { x: { N: "7" } } },
      { x: 70 },
    ],
  ] as const) {
    // A default is in the stored form, so it isn't a domain value.
    it.effect(`a default stands for what its stored form reads as: ${name}`, () => {
      const { Base, Group } = bothOwners(field)
      return onTable(Base, (tableName) =>
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: {},
            aggregates: { Group },
            tables: { Base },
          }) as any
          expect((yield* db.aggregates.Group.create({ id: "g" })).f).toEqual(read)
          expect(fieldOf(yield* rowsOf(tableName, "group#g"))).toEqual(stored)
          yield* db.aggregates.Group.update({ id: "g" }, ({ state }: any) => ({
            ...state,
            note: "n",
          }))
          expect(fieldOf(yield* rowsOf(tableName, "group#g"))).toEqual(stored)
          expect((yield* db.aggregates.Group.get({ id: "g" })).f).toEqual(read)
        }),
      )
    })
  }

  // The stored form was the only input that read back as meant on 1.39.0. It's a domain value too,
  // so it's taken as one, with no error. The guide and the changeset say what such a caller changes.
  for (const [name, field, storedForm, meant, storedFormNow, stored] of [
    ["a number", X10, 5, 50, { N: "0.5" }, { N: "5" }],
    [
      "base64",
      Schema.StringFromBase64,
      "aGVsbG8=",
      "hello",
      { S: "YUdWc2JHOD0=" },
      { S: "aGVsbG8=" },
    ],
  ] as const) {
    it.effect(
      `what 1.39.0 took as stored is a domain value, and the meant value is what it stored: ${name}`,
      () => {
        const { Base, Group } = bothOwners(field)
        return onTable(Base, (tableName) =>
          Effect.gen(function* () {
            const db = yield* DynamoClient.make({
              entities: {},
              aggregates: { Group },
              tables: { Base },
            }) as any
            expect((yield* db.aggregates.Group.create({ id: "a", f: storedForm })).f).toBe(
              storedForm,
            )
            expect(fieldOf(yield* rowsOf(tableName, "group#a"))).toEqual(storedFormNow)
            expect((yield* db.aggregates.Group.get({ id: "a" })).f).toBe(storedForm)
            yield* db.aggregates.Group.update({ id: "a" }, ({ state }: any) => ({
              ...state,
              note: "n",
            }))
            expect(fieldOf(yield* rowsOf(tableName, "group#a"))).toEqual(storedFormNow)
            expect((yield* db.aggregates.Group.get({ id: "a" })).f).toBe(storedForm)

            expect((yield* db.aggregates.Group.create({ id: "b", f: meant })).f).toBe(meant)
            expect(fieldOf(yield* rowsOf(tableName, "group#b"))).toEqual(stored)
            expect((yield* db.aggregates.Group.get({ id: "b" })).f).toBe(meant)
          }),
        )
      },
    )
  }

  it.effect("a plain word that's valid base64 stays the word", () => {
    const { Base, Group } = bothOwners(Schema.StringFromBase64)
    return onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: {},
          aggregates: { Group },
          tables: { Base },
        }) as any
        expect((yield* db.aggregates.Group.create({ id: "a", f: "test" })).f).toBe("test")
        expect(fieldOf(yield* rowsOf(tableName, "group#a"))).toEqual({ S: "dGVzdA==" })
        expect((yield* db.aggregates.Group.get({ id: "a" })).f).toBe("test")
      }),
    )
  })

  it.effect("a ref on an entity stores what the same ref on an aggregate stores", () => {
    class Holder extends Schema.Class<Holder>("Holder")({
      holderId: S,
      maker: Maker.pipe(DynamoModel.ref),
    }) {}
    const Holders = Entity.make({
      model: Holder,
      entityType: "Holder",
      primaryKey: primary("holderId"),
      refs: { maker: { entity: Makers } },
    })
    const Base = Table.make({ schema, entities: { Makers, Holders } })
    return onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Makers, Holders },
          tables: { Base },
        })
        yield* db.entities.Makers.put({ makerId: "m1", rate: 50, label: "a!" }).asEffect()
        yield* db.entities.Holders.put({ holderId: "h", makerId: "m1" } as never).asEffect()
        const [row] = yield* rowsOf(tableName, "#holder#")
        expect(row?.maker).toMatchObject({ M: { rate: { N: "5" }, label: { S: "a" } } })
        expect(yield* db.entities.Holders.get({ holderId: "h" })).toMatchObject({
          maker: { rate: 50, label: "a!" },
        })
      }),
    )
  })

  it.effect("a same-type composite keys on its encoded form, and get finds it", () => {
    const Model = Schema.Struct({ n: X10, note: Schema.optional(S) })
    const Base = Table.make({
      schema: DynamoSchema.make({ name: "same", version: 1 }),
      entities: {},
    })
    const Keyed = Aggregate.make(Model, {
      table: Base,
      schema: Base.schema,
      pk: { field: "pk", composite: ["n"] },
      collection: { name: "keyed" },
      root: { entityType: "Keyed" },
      edges: {},
    } as never) as any
    return onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: {},
          aggregates: { Keyed },
          tables: { Base },
        }) as any
        expect((yield* db.aggregates.Keyed.create({ n: 50 })).n).toBe(50)
        const rows = yield* rowsOf(tableName, "keyed#")
        expect(rows).toHaveLength(1)
        expect(rows[0]?.n).toEqual({ N: "5" })
        expect((yield* db.aggregates.Keyed.get({ n: 50 })).n).toBe(50)
        yield* db.aggregates.Keyed.update({ n: 50 }, ({ state }: any) => ({ ...state, note: "n" }))
        expect(yield* rowsOf(tableName, "keyed#")).toHaveLength(1)
        expect((yield* db.aggregates.Keyed.get({ n: 50 })).note).toBe("n")
      }),
    )
  })
})

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/aggregate-same-type-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly read: Record<string, Record<string, unknown>>
  readonly rows: ReadonlyArray<Row>
}

const loadFixture = (tableName: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    for (const row of fixture.rows) yield* client.putItem({ TableName: tableName, Item: row })
  })

const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

const withoutNote = (rows: ReadonlyArray<Row>) =>
  rows
    .map(({ note: _note, ...row }) => row)
    .sort((a, b) => (a.sk?.S ?? "").localeCompare(b.sk?.S ?? ""))

describeConnected("rows 1.39.0 wrote through an aggregate", () => {
  for (const id of ["created", "updated-once", "updated-twice"] as const) {
    it.effect(`${id}: reads as 1.39.0 read it`, () =>
      onTable(Main, (tableName) =>
        Effect.gen(function* () {
          const db = yield* bind
          yield* loadFixture(tableName)
          expect(plain(yield* db.aggregates.Roots.get({ id }))).toEqual(fixture.read[id])
        }),
      ),
    )

    it.effect(`${id}: an update leaves what's stored, however many times`, () =>
      onTable(Main, (tableName, writes) =>
        Effect.gen(function* () {
          const db = yield* bind
          yield* loadFixture(tableName)
          const before = yield* rowsOf(tableName, `dvroot#${id}`)
          expect(before).not.toEqual([])

          yield* db.aggregates.Roots.update({ id }, ({ state }) => state)
          expect(writes.count).toBe(0)

          for (const note of ["later", "later still"]) {
            yield* db.aggregates.Roots.update({ id }, ({ state }) => ({ ...state, note }))
            expect(withoutNote(yield* rowsOf(tableName, `dvroot#${id}`))).toEqual(
              withoutNote(before),
            )
            expect(plain(yield* db.aggregates.Roots.get({ id }))).toEqual({
              ...fixture.read[id],
              note,
            })
          }
        }),
      ),
    )

    it.effect(`${id}: a value set now stores its encoded form, beside what's there`, () =>
      onTable(Main, (tableName) =>
        Effect.gen(function* () {
          const db = yield* bind
          yield* loadFixture(tableName)
          const before = rowOf(yield* rowsOf(tableName, `dvroot#${id}`), "dvroot")
          yield* db.aggregates.Roots.update({ id }, ({ state }) => ({ ...state, f: 70 }))
          const after = rowOf(yield* rowsOf(tableName, `dvroot#${id}`), "dvroot")
          expect(after.f).toEqual({ N: "7" })
          expect(after.nested).toEqual(before.nested)
          expect(after.label).toEqual(before.label)
          expect(plain(yield* db.aggregates.Roots.get({ id }))).toEqual({
            ...fixture.read[id],
            f: 70,
          })
        }),
      ),
    )
  }
})
