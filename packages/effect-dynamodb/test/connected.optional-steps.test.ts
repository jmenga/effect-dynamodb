/**
 * A step encoded as optional that isn't a default, such as `Schema.OptionFromOptional`, against DynamoDB
 * Local: what's beneath it isn't what's stored, so a read leaves it as declared, and a caller, who holds
 * what the step makes, goes round it. Rows from the published 1.39.0 read as they did.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import {
  type AttributeValue,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Exit, Layer, Option, Schema, SchemaGetter } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

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
  const tableName = `optional-steps-${Date.now()}-${tables++}`
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

const load = (tableName: string, rows: ReadonlyArray<Row>) =>
  Effect.promise(async () => {
    for (const Item of rows) await raw.send(new PutItemCommand({ TableName: tableName, Item }))
  })

const B = Schema.BigIntFromString
const toList = Schema.optionalKey(B).pipe(
  Schema.decodeTo(Schema.Array(Schema.BigInt), {
    decode: SchemaGetter.transformOptional((value) =>
      Option.some(Option.match(value, { onNone: () => [], onSome: (one: bigint) => [one] })),
    ),
    encode: SchemaGetter.transformOptional((value) =>
      Option.flatMap(value, (list: ReadonlyArray<bigint>) =>
        list.length > 0 ? Option.some(list[0]!) : Option.none(),
      ),
    ),
  }),
)
const Keyed = Schema.Struct({ c: Schema.String, b: Schema.optionalKey(Schema.BigInt) })

type Shape = {
  readonly name: string
  readonly field: Schema.Top
  /** What the step makes. */
  readonly value: unknown
  /** What's stored for it, as a caller could also give it to an aggregate. */
  readonly wire: unknown
  readonly stored: AttributeValue
  /** What the step makes of nothing stored; undefined if the field isn't optional. */
  readonly none?: unknown
}

const SHAPES: ReadonlyArray<Shape> = [
  {
    name: "OptionFromOptional(BigIntFromString)",
    field: Schema.OptionFromOptional(B),
    value: Option.some(5n),
    wire: "5",
    stored: { S: "5" },
    none: Option.none(),
  },
  {
    name: "OptionFromOptionalKey(BigIntFromString)",
    field: Schema.OptionFromOptionalKey(B),
    value: Option.some(5n),
    wire: "5",
    stored: { S: "5" },
    none: Option.none(),
  },
  {
    name: "OptionFromOptional(Struct{BigIntFromString})",
    field: Schema.OptionFromOptional(Schema.Struct({ b: B })),
    value: Option.some({ b: 5n }),
    wire: { b: "5" },
    stored: { M: { b: { S: "5" } } },
    none: Option.none(),
  },
  {
    name: "OptionFromOptional(Array(BigIntFromString))",
    field: Schema.OptionFromOptional(Schema.Array(B)),
    value: Option.some([5n]),
    wire: ["5"],
    stored: { L: [{ S: "5" }] },
    none: Option.none(),
  },
  {
    name: "OptionFromOptionalKey(BigInt)",
    field: Schema.OptionFromOptionalKey(Schema.BigInt),
    value: Option.some(5n),
    wire: 5n,
    stored: { N: "5" },
    none: Option.none(),
  },
  {
    name: "OptionFromOptional(ReadonlySet)",
    field: Schema.OptionFromOptional(Schema.ReadonlySet(Schema.String)),
    value: Option.some(new Set(["a"])),
    wire: new Set(["a"]),
    stored: { SS: ["a"] },
    none: Option.none(),
  },
  {
    name: "a step to a list of bigints",
    field: toList,
    value: [5n],
    wire: "5",
    stored: { S: "5" },
    none: [],
  },
  {
    name: "OptionFromUndefinedOr(Struct{optionalKey BigInt})",
    field: Schema.OptionFromUndefinedOr(Keyed),
    value: Option.some({ c: "x" }),
    wire: { c: "x" },
    stored: { M: { c: { S: "x" } } },
  },
  {
    name: "OptionFromNullishOr(Struct{optionalKey BigInt})",
    field: Schema.OptionFromNullishOr(Keyed, { onNoneEncoding: null }),
    value: Option.some({ c: "x" }),
    wire: { c: "x" },
    stored: { M: { c: { S: "x" } } },
  },
]

const schema = DynamoSchema.make({ name: "s", version: 1 })
const primary = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }
const seed = (id: string): Row => ({
  pk: { S: `$s#v1#e#id_${id}` },
  sk: { S: "$s#v1#e" },
  __edd_e__: { S: "E" },
  id: { S: id },
  note: { S: "x" },
})

const entityOf = (field: Schema.Top) => {
  const Model = Schema.Struct({ id: Schema.String, f: field, note: Schema.optional(Schema.String) })
  const E = Entity.make({ model: Model, entityType: "E", primaryKey: primary } as any) as any
  const Main = Table.make({ schema, entities: { E } })
  const client = DynamoClient.make({
    entities: { E },
    tables: { Main },
  } as any) as Effect.Effect<any>
  return { Main, client }
}

const aggregateOf = (field: Schema.Top) => {
  const Model = Schema.Struct({ id: Schema.String, f: field, note: Schema.optional(Schema.String) })
  const Base = Table.make({ schema, entities: {} })
  const A = Aggregate.make(Model, {
    table: Base,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "agg" },
    root: { entityType: "Root" },
    edges: {},
  } as any) as any
  const Tb = { ...Base, aggregates: { A } }
  const client = DynamoClient.make({
    entities: {},
    aggregates: { A },
    tables: { Tb },
  } as any) as Effect.Effect<any>
  return { Base, client }
}

const edgesOf = (field: Schema.Top) => {
  const Model = Schema.Struct({
    id: Schema.String,
    note: Schema.optional(Schema.String),
    one: Schema.Struct({ f: field }),
    many: Schema.Array(Schema.Struct({ lineId: Schema.String, f: field })),
  })
  const Base = Table.make({ schema, entities: {} })
  const A = Aggregate.make(Model, {
    table: Base,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "agg" },
    root: { entityType: "Root" },
    edges: {
      one: Aggregate.one({ entityType: "One" }),
      many: Aggregate.many({ entityType: "Many", sk: { composite: ["lineId"] } }),
    },
  } as any) as any
  const Tb = { ...Base, aggregates: { A } }
  const client = DynamoClient.make({
    entities: {},
    aggregates: { A },
    tables: { Tb },
  } as any) as Effect.Effect<any>
  return { Base, client }
}

const streamsOf = (field: Schema.Top) => {
  const Base = Table.make({ schema, entities: {} })
  const Noted = Schema.Struct({ _tag: Schema.tag("Noted"), f: field })
  const State = Schema.Struct({ f: field })
  const make = (extra: object) =>
    EventStore.makeStream({
      table: Base,
      streamName: "T",
      events: [Noted],
      streamId: { composite: ["id"] },
      ...extra,
    } as any) as any
  return {
    Base,
    Plain: make({ metadata: State }),
    Snapped: make({ snapshot: { schema: State } }),
    Inline: make({ snapshot: { schema: State, mode: "inline" } }),
  }
}

/** The rows the published 1.39.0 wrote, by shape, then by the owner that wrote them. */
const published = (
  JSON.parse(
    readFileSync(new URL("./fixtures/optional-steps-1.39.0.json", import.meta.url), "utf8"),
  ) as { readonly shapes: Record<string, Record<string, ReadonlyArray<Row>>> }
).shapes

describeConnected("a step encoded as optional that isn't a default", () => {
  it.effect("an aggregate's read doesn't take what the step makes for what's stored", () => {
    const { Base, client } = aggregateOf(Schema.OptionFromOptional(Schema.String))
    return onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const db = yield* client
        const A = db.aggregates.A
        yield* A.create({ id: "a", f: Option.some("x") })
        const [row] = yield* rowsOf(tableName)
        expect(row!.f).toEqual({ S: "x" })
        yield* load(tableName, [
          {
            ...row!,
            f: {
              M: {
                _op: { S: "Some" },
                _tag: { S: "Some" },
                value: { S: "x" },
                "~effect/Option": { M: {} },
              },
            },
          },
        ])
        const read = yield* Effect.exit(A.get({ id: "a" }) as Effect.Effect<any, any>)
        expect(Exit.isFailure(read)).toBe(true)
      }),
    ) as Effect.Effect<void>
  })

  for (const shape of SHAPES) {
    const { name, field, value, wire, stored, none } = shape

    describe(name, () => {
      it.effect("an entity's every write returns what it wrote, and reads it back", () => {
        const { Main, client } = entityOf(field)
        return onTable(Main, (tableName) =>
          Effect.gen(function* () {
            const db = yield* client
            const E = db.entities.E
            yield* load(tableName, [seed("us"), seed("tu")])
            const rowOf = (id: string) =>
              Effect.map(rowsOf(tableName), (rows) => rows.find((row) => row.id?.S === id))

            for (const [id, write] of [
              ["p", () => E.put({ id: "p", f: value }).asEffect()],
              ["c", () => E.create({ id: "c", f: value }).asEffect()],
              ["up", () => E.upsert({ id: "up", f: value }).asEffect()],
              ["us", () => E.update({ id: "us" }).set({ f: value }).asEffect()],
            ] as const) {
              // A write that lands doesn't report a failure.
              const written = yield* write() as Effect.Effect<any>
              expect(written.f).toEqual(value)
              expect((yield* rowOf(id))?.f).toEqual(stored)
              expect((yield* E.get({ id }) as Effect.Effect<any>).f).toEqual(value)
            }

            yield* Batch.write([E.put({ id: "bw", f: value })] as any) as Effect.Effect<any>
            expect((yield* rowOf("bw"))?.f).toEqual(stored)
            yield* Transaction.transactWrite([
              E.put({ id: "tp", f: value }),
              E.update({ id: "tu" }).set({ f: value }),
            ] as any) as Effect.Effect<any>
            expect((yield* rowOf("tp"))?.f).toEqual(stored)
            expect((yield* rowOf("tu"))?.f).toEqual(stored)

            const updated = (yield* E.update({ id: "p" }).set({ note: "n" }).asEffect()) as any
            expect(updated.f).toEqual(value)
            expect((yield* rowOf("p"))?.f).toEqual(stored)
          }),
        )
      })

      if (none !== undefined) {
        it.effect("an entity stores nothing for what stands for absent", () => {
          const { Main, client } = entityOf(field)
          return onTable(Main, (tableName) =>
            Effect.gen(function* () {
              const db = yield* client
              const E = db.entities.E
              const rowOf = (id: string) =>
                Effect.map(rowsOf(tableName), (rows) => rows.find((row) => row.id?.S === id))

              expect((yield* E.put({ id: "pa" }).asEffect() as Effect.Effect<any>).f).toEqual(none)
              expect((yield* rowOf("pa"))?.f).toBeUndefined()
              expect((yield* E.upsert({ id: "ua" }).asEffect() as Effect.Effect<any>).f).toEqual(
                none,
              )
              expect((yield* rowOf("ua"))?.f).toBeUndefined()
              expect((yield* E.get({ id: "pa" }) as Effect.Effect<any>).f).toEqual(none)
              const updated = yield* E.update({ id: "pa" })
                .set({ note: "n" })
                .asEffect() as Effect.Effect<any>
              expect(updated.f).toEqual(none)
              expect((yield* rowOf("pa"))?.f).toBeUndefined()
            }),
          )
        })
      }

      it.effect("an aggregate takes what the step makes and what's stored", () => {
        const { Base, client } = aggregateOf(field)
        return onTable(Base, (tableName) =>
          Effect.gen(function* () {
            const db = yield* client
            const A = db.aggregates.A
            const rowOf = (id: string) =>
              Effect.map(rowsOf(tableName), (rows) => rows.find((row) => row.id?.S === id))

            for (const [id, given] of [
              ["d", value],
              ["w", wire],
            ] as const) {
              expect((yield* A.create({ id, f: given }) as Effect.Effect<any>).f).toEqual(value)
              expect((yield* rowOf(id))?.f).toEqual(stored)
              expect((yield* A.get({ id }) as Effect.Effect<any>).f).toEqual(value)
            }
          }),
        )
      })

      it.effect("an aggregate's update leaves what it didn't change", () => {
        const { Base, client } = aggregateOf(field)
        return onTable(Base, (tableName) =>
          Effect.gen(function* () {
            const db = yield* client
            const A = db.aggregates.A
            const rowOf = (id: string) =>
              Effect.map(rowsOf(tableName), (rows) => rows.find((row) => row.id?.S === id))

            yield* A.create({ id: "a", f: value }) as Effect.Effect<any>
            const updated = yield* A.update({ id: "a" }, ({ state }: any) => ({
              ...state,
              note: "n",
            })) as Effect.Effect<any>
            expect(updated.f).toEqual(value)
            const row = yield* rowOf("a")
            expect(row?.note).toEqual({ S: "n" })
            expect(row?.f).toEqual(stored)
            expect((yield* A.get({ id: "a" }) as Effect.Effect<any>).f).toEqual(value)
          }),
        )
      })

      it.effect("an aggregate's update stores a value it's given", () => {
        const { Base, client } = aggregateOf(field)
        return onTable(Base, (tableName) =>
          Effect.gen(function* () {
            const db = yield* client
            const A = db.aggregates.A
            const rowOf = (id: string) =>
              Effect.map(rowsOf(tableName), (rows) => rows.find((row) => row.id?.S === id))

            yield* A.create({ id: "a", f: value, note: "x" }) as Effect.Effect<any>
            const updated = yield* A.update({ id: "a" }, ({ state }: any) => ({
              ...state,
              f: value,
              note: "n",
            })) as Effect.Effect<any>
            expect(updated.f).toEqual(value)
            expect((yield* rowOf("a"))?.f).toEqual(stored)
          }),
        )
      })

      it.effect("an aggregate's update refuses nonsense and writes nothing", () => {
        const { Base, client } = aggregateOf(field)
        return onTable(Base, (tableName) =>
          Effect.gen(function* () {
            const db = yield* client
            const A = db.aggregates.A
            yield* A.create({ id: "a", f: value }) as Effect.Effect<any>
            const before = yield* rowsOf(tableName)
            const exit = yield* Effect.exit(
              A.update({ id: "a" }, ({ state }: any) => ({
                ...state,
                f: Option.some({ nonsense: true }),
              })) as Effect.Effect<any>,
            )
            expect(Exit.isFailure(exit)).toBe(true)
            expect(yield* rowsOf(tableName)).toEqual(before)
          }),
        )
      })

      if (none !== undefined) {
        it.effect("an aggregate stores nothing for what stands for absent", () => {
          const { Base, client } = aggregateOf(field)
          return onTable(Base, (tableName) =>
            Effect.gen(function* () {
              const db = yield* client
              const A = db.aggregates.A
              const rowOf = (id: string) =>
                Effect.map(rowsOf(tableName), (rows) => rows.find((row) => row.id?.S === id))

              for (const [id, input] of [
                ["abs", { id: "abs" }],
                ["non", { id: "non", f: none }],
              ] as const) {
                expect((yield* A.create(input) as Effect.Effect<any>).f).toEqual(none)
                expect((yield* rowOf(id))?.f).toBeUndefined()
                expect((yield* A.get({ id }) as Effect.Effect<any>).f).toEqual(none)
                const updated = yield* A.update({ id }, ({ state }: any) => ({
                  ...state,
                  note: "n",
                })) as Effect.Effect<any>
                expect(updated.f).toEqual(none)
                expect((yield* rowOf(id))?.f).toBeUndefined()
              }
            }),
          )
        })
      }

      it.effect("an aggregate's edges take it too", () => {
        const { Base, client } = edgesOf(field)
        return onTable(Base, (tableName) =>
          Effect.gen(function* () {
            const db = yield* client
            const A = db.aggregates.A
            const fields = Effect.map(rowsOf(tableName), (rows) =>
              rows.filter((row) => row.f !== undefined).map((row) => row.f),
            )
            yield* A.create({
              id: "a",
              one: { f: value },
              many: [{ lineId: "l", f: value }],
            }) as Effect.Effect<any>
            expect(yield* fields).toEqual([stored, stored])
            const updated = yield* A.update({ id: "a" }, ({ state }: any) => ({
              ...state,
              note: "n",
            })) as Effect.Effect<any>
            expect(updated.one.f).toEqual(value)
            expect(updated.many[0].f).toEqual(value)
            expect(yield* fields).toEqual([stored, stored])
            const read = (yield* A.get({ id: "a" })) as any
            expect(read.one.f).toEqual(value)
            expect(read.many[0].f).toEqual(value)
          }),
        )
      })

      it.effect("a stream appends, reads and snapshots it", () => {
        const { Base, Plain, Snapped, Inline } = streamsOf(field)
        return onTable(Base, (tableName) =>
          Effect.gen(function* () {
            yield* Plain.append({ id: "a" }, [{ _tag: "Noted", f: value }], 0, {
              metadata: { f: value },
            }) as Effect.Effect<any>
            const event = (yield* rowsOf(tableName)).find((row) => row.data !== undefined)
            expect((event?.data as { M: Row }).M.f).toEqual(stored)
            expect((event?.metadata as { M: Row }).M.f).toEqual(stored)
            const [read] = (yield* Plain.read({ id: "a" })) as any[]
            expect(read.data.f).toEqual(value)
            expect(read.metadata.f).toEqual(value)

            yield* Snapped.append(
              { id: "s" },
              [{ _tag: "Noted", f: value }],
              0,
            ) as Effect.Effect<any>
            yield* Snapped.writeSnapshot({ id: "s" }, { f: value }, 1) as Effect.Effect<any>
            const snapshot = (yield* Snapped.readSnapshot({ id: "s" })) as any
            expect(Option.getOrThrow(snapshot as Option.Option<any>).state.f).toEqual(value)

            yield* Inline.append({ id: "i" }, [{ _tag: "Noted", f: value }], 0, {
              snapshot: { f: value },
            }) as Effect.Effect<any>
            const latest = (yield* Inline.readLatest({ id: "i" })) as any
            expect(Option.getOrThrow(latest.snapshot as Option.Option<any>).state.f).toEqual(value)
          }),
        )
      })
    })
  }

  // `create` with the step's own value failed on 1.39.0, so it wrote only what it was given as stored.
  describe("rows from the published 1.39.0", () => {
    for (const { name, field, value, stored, none } of SHAPES) {
      const rows = published[name]
      if (rows === undefined) continue

      describe(name, () => {
        it.effect("an entity reads them, and an update leaves them", () => {
          const { Main, client } = entityOf(field)
          return onTable(Main, (tableName) =>
            Effect.gen(function* () {
              yield* load(tableName, rows.entity!)
              const db = yield* client
              const E = db.entities.E
              for (const row of rows.entity!) {
                const id = row.id!.S!
                const expected = row.f === undefined ? none : value
                if (row.f !== undefined) expect(row.f).toEqual(stored)
                expect((yield* E.get({ id }) as Effect.Effect<any>).f).toEqual(expected)
                const updated = yield* E.update({ id })
                  .set({ note: "again" })
                  .asEffect() as Effect.Effect<any>
                expect(updated.f).toEqual(expected)
                const after = (yield* rowsOf(tableName)).find((each) => each.id?.S === id)
                expect(after?.f).toEqual(row.f)
              }
            }),
          )
        })

        it.effect("an aggregate reads them, and an update leaves them", () => {
          const { Base, client } = aggregateOf(field)
          return onTable(Base, (tableName) =>
            Effect.gen(function* () {
              yield* load(tableName, rows.agg!)
              const db = yield* client
              const A = db.aggregates.A
              for (const row of rows.agg!) {
                const id = row.id!.S!
                const expected = row.f === undefined ? none : value
                expect((yield* A.get({ id }) as Effect.Effect<any>).f).toEqual(expected)
                const updated = yield* A.update({ id }, ({ state }: any) => ({
                  ...state,
                  note: "again",
                })) as Effect.Effect<any>
                expect(updated.f).toEqual(expected)
                const after = (yield* rowsOf(tableName)).find((each) => each.id?.S === id)
                expect(after?.f).toEqual(row.f)
              }
            }),
          )
        })

        it.effect("a stream reads them", () => {
          const { Base, Plain, Snapped, Inline } = streamsOf(field)
          return onTable(Base, (tableName) =>
            Effect.gen(function* () {
              yield* load(tableName, rows.stream!)
              const [read] = (yield* Plain.read({ id: "a" })) as any[]
              expect(read.data.f).toEqual(value)
              expect(read.metadata.f).toEqual(value)
              const snapshot = (yield* Snapped.readSnapshot({ id: "s" })) as any
              expect(Option.getOrThrow(snapshot as Option.Option<any>).state.f).toEqual(value)
              const latest = (yield* Inline.readLatest({ id: "i" })) as any
              expect(Option.getOrThrow(latest.snapshot as Option.Option<any>).state.f).toEqual(
                value,
              )
            }),
          )
        })
      })
    }
  })
})
