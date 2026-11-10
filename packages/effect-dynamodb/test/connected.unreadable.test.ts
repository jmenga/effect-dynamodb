/**
 * What `[EDD-9125]` points to and what it leaves standing, against DynamoDB Local: every replacement
 * a refusal names, on every owner; what reads back changed, as the modeling guide says; what can't be
 * judged at load; and an aggregate's `update`, which hands back the state's plain form.
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
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  BigDecimal,
  Cause,
  Chunk,
  Config,
  DateTime,
  Duration,
  Effect,
  Equal,
  Exit,
  HashMap,
  HashSet,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
  SchemaGetter,
  SemVer,
} from "effect"
import * as Cookies from "effect/http/Cookies"
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

const AppSchema = DynamoSchema.make({ name: "unreadable", version: 1 })

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

let tables = 0
const onTable = <A, E>(Base: any, body: (tableName: string) => Effect.Effect<A, E, any>) => {
  const tableName = `unreadable-${Date.now()}-${tables++}`
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
    return Items
  })

const keyed = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }

const entityOver = (field: Schema.Top) =>
  Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      f: field as never,
      n: Schema.optional(Schema.Number),
    }),
    entityType: "Row",
    primaryKey: keyed,
  } as never) as any

/** `body` with a client of one entity over this field, on a fresh table. */
const onEntity = <A, E>(
  field: Schema.Top,
  body: (rows: any, tableName: string) => Effect.Effect<A, E, any>,
) => {
  const Rows = entityOver(field)
  const MainTable = Table.make({ schema: AppSchema, entities: { Rows } })
  return onTable(MainTable, (tableName) =>
    Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({ entities: { Rows }, tables: { MainTable } })
      return yield* body(db.entities.Rows, tableName)
    }),
  )
}

/** `body` with a bound aggregate of this model and these edges, on a fresh table. */
const onAggregate = <A, E>(
  model: Schema.Top,
  edges: Record<string, unknown>,
  body: (agg: any, tableName: string) => Effect.Effect<A, E, any>,
) => {
  const Base = Table.make({ schema: AppSchema, entities: {} })
  const Root = (Aggregate.make as any)(model, {
    table: Base,
    schema: Base.schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "root" },
    root: { entityType: "Root" },
    edges,
  })
  const MainTable = { ...Base, aggregates: { Root } }
  return onTable(Base, (tableName) =>
    Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: {},
        aggregates: { Root },
        tables: { MainTable },
      } as never)
      return yield* body(db.aggregates.Root, tableName)
    }),
  )
}

const rootOver = (field: Schema.Top) =>
  Schema.Struct({ id: Schema.String, f: field as never, note: Schema.optional(Schema.String) })

const at = new Date("2025-01-01T00:00:00.000Z")
const instant = DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")
const kib = Schema.decodeUnknownSync(Schema.ByteSizeFromString)("1KiB")
const url = new URL("https://example.com/a?b=1")
const same = (a: unknown, b: unknown) => expect(a).toEqual(b)

/** Every replacement a refusal names, with a value, and how to tell it came back. */
const REPLACEMENTS: ReadonlyArray<
  readonly [name: string, field: Schema.Top, value: unknown, check: (read: unknown) => void]
> = [
  ["Schema.URLFromString", Schema.URLFromString, url, (r) => same(String(r), url.href)],
  ["Schema.ByteSizeFromString", Schema.ByteSizeFromString, kib, (r) => same(r, kib)],
  ["Schema.ByteSizeFromNumber", Schema.ByteSizeFromNumber, kib, (r) => same(r, kib)],
  ["Schema.String", Schema.String, "a+", (r) => same(r, "a+")],
  [
    "Schema.Record",
    Schema.Record(Schema.String, Schema.Number),
    { a: 1 },
    (r) => same(r, { a: 1 }),
  ],
  [
    "Schema.Uint8Array",
    Schema.Uint8Array,
    new Uint8Array([1, 2]),
    (r) => same(r, new Uint8Array([1, 2])),
  ],
  [
    "Schema.Defect()",
    Schema.Defect(),
    new Error("a"),
    (r) => same((r as { readonly message: string }).message, "a"),
  ],
  ["Schema.Array", Schema.Array(Schema.String), ["a"], (r) => same(r, ["a"])],
  [
    "Schema.ReadonlySet",
    Schema.ReadonlySet(Schema.String),
    new Set(["a"]),
    (r) => same(r, new Set(["a"])),
  ],
  ["Schema.DateFromString", Schema.DateFromString, at, (r) => same(r, at)],
  ["Schema.DateFromMillis", Schema.DateFromMillis, at, (r) => same(r, at)],
  [
    "Schema.DateTimeUtcFromString",
    Schema.DateTimeUtcFromString,
    instant,
    (r) => expect(Equal.equals(r, instant)).toBe(true),
  ],
  [
    "Schema.DateTimeUtcFromMillis",
    Schema.DateTimeUtcFromMillis,
    instant,
    (r) => expect(Equal.equals(r, instant)).toBe(true),
  ],
  [
    "Schema.RedactedFromValue",
    Schema.RedactedFromValue(Schema.String, { label: "a" }),
    Redacted.make("a", { label: "a" }),
    (r) => same(Redacted.value(r as Redacted.Redacted<string>), "a"),
  ],
  ["Schema.BigIntFromString", Schema.BigIntFromString, 5n, (r) => same(r, 5n)],
  [
    "Schema.DurationFromMillis",
    Schema.DurationFromMillis,
    Duration.seconds(1),
    (r) => expect(Equal.equals(r, Duration.seconds(1))).toBe(true),
  ],
  [
    "Schema.BigDecimalFromString",
    Schema.BigDecimalFromString,
    BigDecimal.fromNumberUnsafe(1.5),
    (r) => {
      const read = r as BigDecimal.BigDecimal
      expect(BigDecimal.format(BigDecimal.sum(read, read))).toBe("3")
    },
  ],
  [
    "Schema.Option(Schema.DateFromString)",
    Schema.Option(Schema.DateFromString),
    Option.some(at),
    (r) => same(r, Option.some(at)),
  ],
  [
    "Schema.Option(Schema.RedactedFromValue)",
    Schema.Option(Schema.RedactedFromValue(Schema.String, { label: "a" })),
    Option.some(Redacted.make("a", { label: "a" })),
    (r) => same(Redacted.value(Option.getOrThrow(r as Option.Option<any>)), "a"),
  ],
  [
    "Schema.Option(Schema.BigIntFromString)",
    Schema.Option(Schema.BigIntFromString),
    Option.some(5n),
    (r) => same(r, Option.some(5n)),
  ],
  [
    "Schema.ReadonlySet(Schema.BigIntFromString)",
    Schema.ReadonlySet(Schema.BigIntFromString),
    new Set([5n]),
    (r) => same(r, new Set([5n])),
  ],
  [
    "Schema.Result(Schema.DateFromString, Schema.String)",
    Schema.Result(Schema.DateFromString, Schema.String),
    Result.succeed(at),
    (r) => same(r, Result.succeed(at)),
  ],
  [
    "a suspended Schema.DateFromString",
    Schema.suspend(() => Schema.DateFromString),
    at,
    (r) => same(r, at),
  ],
  [
    "a suspended Schema.BigIntFromString",
    Schema.suspend(() => Schema.BigIntFromString),
    5n,
    (r) => same(r, 5n),
  ],
  [
    "a suspended Schema.RedactedFromValue",
    Schema.suspend(() => Schema.RedactedFromValue(Schema.String, { label: "a" })),
    Redacted.make("a", { label: "a" }),
    (r) => same(Redacted.value(r as Redacted.Redacted<string>), "a"),
  ],
  [
    "Schema.DateFromString in a struct with a decoding default",
    Schema.Struct({ d: Schema.DateFromString }).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({ d: at.toISOString() })),
    ),
    { d: at },
    (r) => same(r, { d: at }),
  ],
  [
    "Schema.DateFromString or null with a decoding default",
    Schema.NullOr(Schema.DateFromString).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
    at,
    (r) => same(r, at),
  ],
  [
    "Schema.RedactedFromValue in a struct with a decoding default",
    Schema.Struct({ r: Schema.RedactedFromValue(Schema.String, { label: "a" }) }).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({ r: "a" })),
    ),
    { r: Redacted.make("a", { label: "a" }) },
    (r) => same(Redacted.value((r as { readonly r: Redacted.Redacted<string> }).r), "a"),
  ],
]

describeConnected("what a [EDD-9125] refusal points to", () => {
  for (const [name, field, value, check] of REPLACEMENTS) {
    it.effect(`${name}, on an entity: put, get, update`, () =>
      onEntity(field, (rows) =>
        Effect.gen(function* () {
          yield* rows.put({ id: "a", f: value }).asEffect()
          check((yield* rows.get({ id: "a" })).f)
          check((yield* rows.update({ id: "a" }).set({ n: 1 }).asEffect()).f)
          check((yield* rows.get({ id: "a" })).f)
        }),
      ),
    )

    it.effect(`${name}, on an aggregate: create, get, update`, () =>
      onAggregate(rootOver(field), {}, (agg) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", f: value })
          check((yield* agg.get({ id: "a" })).f)
          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
          const read = yield* agg.get({ id: "a" })
          check(read.f)
          expect(read.note).toBe("n")
        }),
      ),
    )

    it.effect(`${name}, in an event, metadata and a snapshot`, () => {
      const Base = Table.make({ schema: AppSchema, entities: {} })
      const Noted = Schema.Struct({ _tag: Schema.tag("Noted"), m: field as never })
      const Events = EventStore.makeStream({
        table: Base,
        streamName: "Tally",
        events: [Noted],
        streamId: { composite: ["id"] },
        metadata: Schema.Struct({ m: field as never }),
        snapshot: { schema: Schema.Struct({ m: field as never }) },
      } as never) as any
      return onTable(Base, () =>
        Effect.gen(function* () {
          const id = { id: "a" }
          yield* Events.append(id, [{ _tag: "Noted", m: value }], 0, { metadata: { m: value } })
          const [event] = yield* Events.read(id)
          check(event.data.m)
          check(event.metadata.m)
          yield* Events.writeSnapshot(id, { m: value }, 1)
          const latest = yield* Events.readLatest(id)
          check(latest.snapshot.value.state.m)
        }),
      )
    })

    it.effect(`${name}, in an outbox effect`, () => {
      const Summaries = Entity.make({
        model: Schema.Struct({ id: Schema.String, version: Schema.Number, rev: Schema.Number }),
        entityType: "Summary",
        primaryKey: keyed,
      } as never) as any
      const Base = Table.make({ schema: AppSchema, entities: { Summaries } })
      const Events = EventStore.makeStream({
        table: Base,
        streamName: "Tally",
        events: [Schema.Struct({ _tag: Schema.tag("Plain") })],
        streamId: { composite: ["id"] },
      } as never) as any
      const Projected = EventStore.projection({
        stream: Events,
        readModel: Summaries,
        key: (id: { readonly id: string }) => ({ id: id.id }),
        initial: (id: { readonly id: string }) => ({ id: id.id, version: 0, rev: 0 }),
        evolve: (state: unknown) => Effect.succeed(state),
        checkpoint: "version",
        revision: "rev",
        outbox: { schema: Schema.Struct({ m: field as never }), effects: () => [{ m: value }] },
      } as never) as any
      return onTable(Base, () =>
        Effect.gen(function* () {
          const id = { id: "a" }
          yield* Events.append(id, [{ _tag: "Plain" }], 0)
          const [event] = yield* Events.read(id)
          yield* Projected.apply(event)
          const delivered: Array<any> = []
          yield* Projected.drain(id, (effect: unknown) =>
            Effect.sync(() => {
              delivered.push(effect)
            }),
          )
          expect(delivered).toHaveLength(1)
          check(delivered[0].m)
        }),
      )
    })
  }
})

describeConnected("what [EDD-9125] leaves standing, as the modeling guide says", () => {
  it.effect("a Schema.Duration reads back as the Duration written", () =>
    onEntity(Schema.Duration, (rows) =>
      Effect.gen(function* () {
        const second = Duration.seconds(1)
        yield* rows.put({ id: "a", f: second }).asEffect()
        const read = (yield* rows.get({ id: "a" })).f
        expect(Equal.equals(read, second)).toBe(true)
        expect(Duration.toMillis(Duration.sum(read, second))).toBe(2000)
        expect(typeof read.pipe).toBe("function")
      }),
    ),
  )

  it.effect("a Schema.DurationFromMillis comes back as a Duration, and is stored as a number", () =>
    onEntity(Schema.DurationFromMillis, (rows, tableName) =>
      Effect.gen(function* () {
        const second = Duration.seconds(1)
        yield* rows.put({ id: "a", f: second }).asEffect()
        const read = (yield* rows.get({ id: "a" })).f
        expect(Equal.equals(read, second)).toBe(true)
        expect(typeof read.pipe).toBe("function")
        const [row] = yield* rowsOf(tableName)
        expect(row?.f).toEqual({ N: "1000" })
      }),
    ),
  )

  it.effect("a Schema.Option comes back as an Option, stored as Effect's internal form", () =>
    onEntity(Schema.Option(Schema.String), (rows, tableName) =>
      Effect.gen(function* () {
        yield* rows.put({ id: "a", f: Option.some("x") }).asEffect()
        const read = (yield* rows.get({ id: "a" })).f
        expect(Equal.equals(read, Option.some("x"))).toBe(true)
        const [row] = yield* rowsOf(tableName)
        expect(Object.keys(row?.f?.M ?? {}).sort()).toEqual(
          ["_op", "_tag", "value", "~effect/Option"].sort(),
        )
      }),
    ),
  )

  it.effect(
    "a declaration over bigint reads a value past 2^53, and a smaller one is refused at write",
    () => {
      const Base = Table.make({ schema: AppSchema, entities: {} })
      const over = (field: Schema.Top) =>
        EventStore.makeStream({
          table: Base,
          streamName: "Tally",
          events: [Schema.Struct({ _tag: Schema.tag("Noted"), big: field as never })],
          streamId: { composite: ["id"] },
        } as never) as any
      const big = 2n ** 60n
      const overBigint = over(
        Schema.declare((input: unknown): input is bigint => typeof input === "bigint"),
      )
      return onTable(Base, () =>
        Effect.gen(function* () {
          const id = { id: "a" }
          yield* overBigint.append(id, [{ _tag: "Noted", big }], 0)
          const [event] = yield* overBigint.read(id)
          expect(event.data.big).toBe(big)

          const replaced = yield* Effect.flip(over(Schema.BigIntFromString).read(id))
          expect((replaced as { readonly _tag: string })._tag).toBe("ValidationError")

          const [lifted] = yield* over(Schema.BigInt).read(id)
          expect(lifted.data.big).toBe(big)

          const small = yield* Effect.flip(
            overBigint.append({ id: "b" }, [{ _tag: "Noted", big: 5n }], 0),
          )
          expect((small as { readonly _tag: string })._tag).toBe("ValidationError")
          expect(String((small as { readonly cause: unknown }).cause)).toContain("EDD-9126")
          expect(yield* overBigint.read({ id: "b" })).toEqual([])
        }),
      )
    },
  )

  it.effect("a Schema.OptionFromNullOr comes back as an Option, stored as the value or null", () =>
    onEntity(Schema.OptionFromNullOr(Schema.String), (rows, tableName) =>
      Effect.gen(function* () {
        yield* rows.put({ id: "a", f: Option.some("x") }).asEffect()
        const some = (yield* rows.get({ id: "a" })).f
        expect(Equal.equals(some, Option.some("x"))).toBe(true)
        expect((yield* rowsOf(tableName))[0]?.f).toEqual({ S: "x" })
        yield* rows.put({ id: "a", f: Option.none() }).asEffect()
        const none = (yield* rows.get({ id: "a" })).f
        expect(Equal.equals(none, Option.none())).toBe(true)
        expect((yield* rowsOf(tableName))[0]?.f).toEqual({ NULL: true })
      }),
    ),
  )

  it.effect(
    "a Schema.BigDecimal reads back as the BigDecimal written, below 2^53 and past it",
    () =>
      onEntity(Schema.BigDecimal, (rows) =>
        Effect.gen(function* () {
          for (const text of ["1.5", "123456789012345678.9"]) {
            const value = BigDecimal.fromStringUnsafe(text)
            yield* rows.put({ id: "a", f: value }).asEffect()
            const read = (yield* rows.get({ id: "a" })).f
            expect(BigDecimal.equals(read, value)).toBe(true)
            expect(BigDecimal.sum(read, value)).toEqual(BigDecimal.sum(value, value))
          }
        }),
      ),
  )

  it.effect("a Schema.BigDecimal once normalised is stored as a fresh one of its value is", () =>
    onEntity(Schema.BigDecimal, (rows, tableName) =>
      Effect.gen(function* () {
        yield* rows.put({ id: "a", f: BigDecimal.fromStringUnsafe("1.5") }).asEffect()
        const fresh = (yield* rowsOf(tableName))[0]?.f
        const value = BigDecimal.normalize(BigDecimal.fromStringUnsafe("1.5"))
        yield* rows.put({ id: "a", f: value }).asEffect()
        expect((yield* rowsOf(tableName))[0]?.f).toEqual(fresh)
        expect(BigDecimal.equals((yield* rows.get({ id: "a" })).f, value)).toBe(true)
      }),
    ),
  )

  it.effect("a Schema.BigDecimalFromString has neither problem, normalised or not", () =>
    onEntity(Schema.BigDecimalFromString, (rows) =>
      Effect.gen(function* () {
        const value = BigDecimal.normalize(BigDecimal.fromStringUnsafe("1.5"))
        yield* rows.put({ id: "a", f: value }).asEffect()
        const read = (yield* rows.get({ id: "a" })).f
        expect(BigDecimal.equals(read, value)).toBe(true)
        expect(BigDecimal.format(BigDecimal.sum(read, value))).toBe("3")
      }),
    ),
  )

  it.effect("a Schema.SemVer reads back as the SemVer written", () =>
    onEntity(Schema.SemVer, (rows) =>
      Effect.gen(function* () {
        const value = Schema.decodeUnknownSync(Schema.SemVerFromString)("1.2.3")
        yield* rows.put({ id: "a", f: value }).asEffect()
        const read = (yield* rows.get({ id: "a" })).f
        expect(SemVer.format(read)).toBe("1.2.3")
        expect(Object.getPrototypeOf(read)).toBe(Object.getPrototypeOf(value))
        expect(Equal.equals(read, value)).toBe(true)
      }),
    ),
  )

  it.effect(
    "a Schema.Cookie keeps its expiry, and a condition on it doesn't match a row that lost its own",
    () =>
      onEntity(Schema.Cookie, (rows, tableName) =>
        Effect.gen(function* () {
          const expires = new Date("2030-01-02T03:04:05.678Z")
          const cookie = () => Cookies.makeCookieUnsafe("a", "b", { path: "/", expires })
          yield* rows.put({ id: "a", f: cookie() }).asEffect()
          const [row] = yield* rowsOf(tableName)
          expect(row?.f?.M?.options?.M?.expires).toEqual({ S: expires.toISOString() })
          const read = (yield* rows.get({ id: "a" })).f
          expect(Cookies.isCookie(read)).toBe(true)
          expect(read.options.expires).toEqual(expires)

          // A condition on the cookie matches the row holding it.
          yield* rows
            .update({ id: "a" })
            .set({ n: 1 })
            .condition((t: any, { eq }: any) => eq(t.f, cookie()))
            .asEffect()
          // As 1.39.0 stored one, its expiry an empty map: a condition on a cookie with an expiry
          // doesn't match it, where 1.39.0's matched it whatever its date had been.
          yield* Effect.promise(() =>
            raw.send(
              new UpdateItemCommand({
                TableName: tableName,
                Key: { pk: row!.pk!, sk: row!.sk! },
                UpdateExpression: "SET #f.#o.#e = :lost",
                ExpressionAttributeNames: { "#f": "f", "#o": "options", "#e": "expires" },
                ExpressionAttributeValues: { ":lost": { M: {} } },
              }),
            ),
          )
          const refused = yield* rows
            .update({ id: "a" })
            .set({ n: 2 })
            .condition((t: any, { eq }: any) => eq(t.f, cookie()))
            .asEffect()
            .pipe(Effect.flip)
          expect(refused._tag).toBe("ConditionalCheckFailed")
          // It reads back as the map 1.39.0 read, and a condition on that matches it.
          const lost = (yield* rows.get({ id: "a" })).f
          expect(Object.getPrototypeOf(lost)).toBe(Object.prototype)
          expect(lost.options.expires).toEqual({})
          yield* rows.update({ id: "a" }).set({ n: 3 }).condition({ f: lost }).asEffect()
        }),
      ),
  )

  it.effect("a Schema.HashSet: an empty one reads back, a non-empty one is refused at write", () =>
    onEntity(Schema.HashSet(Schema.String), (rows, tableName) =>
      Effect.gen(function* () {
        const refused = yield* Effect.flip(rows.put({ id: "a", f: HashSet.make("x") }).asEffect())
        expect(String((refused as { readonly cause: unknown }).cause)).toContain("EDD-9124")
        expect(yield* rowsOf(tableName)).toEqual([])
        yield* rows.put({ id: "a", f: HashSet.empty<string>() }).asEffect()
        expect(HashSet.size((yield* rows.get({ id: "a" })).f)).toBe(0)
      }),
    ),
  )
})

describeConnected("a Schema.BigInt under a union, on real rows", () => {
  const big = 2n ** 60n
  const bigN = { N: String(big) }
  const small = { N: "5" }
  const nullable = Schema.NullOr(Schema.BigInt)
  const WithB = Schema.Struct({ b: Schema.BigInt })

  /** Each value: what it's written as, what's stored, and what it reads back as. */
  type Reading = readonly [written: unknown, stored: unknown, read: unknown]
  const smallBigNull: ReadonlyArray<Reading> = [
    [5n, small, 5n],
    [big, bigN, big],
    [null, { NULL: true }, null],
  ]

  const CASES: ReadonlyArray<readonly [string, Schema.Top, ReadonlyArray<Reading>]> = [
    ["Schema.NullOr(Schema.BigInt)", nullable, smallBigNull],
    ["Schema.NullishOr(Schema.BigInt)", Schema.NullishOr(Schema.BigInt), smallBigNull],
    ["Schema.optional(Schema.NullOr(Schema.BigInt))", Schema.optional(nullable), smallBigNull],
    [
      "Schema.optionalKey(Schema.NullOr(Schema.BigInt))",
      Schema.optionalKey(nullable),
      smallBigNull,
    ],
    [
      "Schema.NullOr(Schema.BigInt) with a decoding default",
      nullable.pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
      smallBigNull,
    ],
    [
      "Schema.Union([Schema.String, Schema.BigInt])",
      Schema.Union([Schema.String, Schema.BigInt]),
      [
        [5n, small, 5n],
        [big, bigN, big],
        ["5", { S: "5" }, "5"],
      ],
    ],
    [
      "Schema.Union([Schema.BigInt, Schema.String])",
      Schema.Union([Schema.BigInt, Schema.String]),
      [
        [5n, small, 5n],
        [big, bigN, big],
        ["5", { S: "5" }, "5"],
      ],
    ],
    [
      "a oneOf Schema.Union([Schema.BigInt, Schema.String])",
      Schema.Union([Schema.BigInt, Schema.String], { mode: "oneOf" }),
      [
        [5n, small, 5n],
        [big, bigN, big],
        ["a", { S: "a" }, "a"],
      ],
    ],
    [
      "Schema.NullOr(Schema.Struct({ b: Schema.BigInt }))",
      Schema.NullOr(WithB),
      [
        [{ b: 5n }, { M: { b: small } }, { b: 5n }],
        [{ b: big }, { M: { b: bigN } }, { b: big }],
        [null, { NULL: true }, null],
      ],
    ],
    [
      "Schema.Struct({ b: Schema.NullOr(Schema.BigInt) })",
      Schema.Struct({ b: nullable }),
      [
        [{ b: 5n }, { M: { b: small } }, { b: 5n }],
        [{ b: big }, { M: { b: bigN } }, { b: big }],
        [{ b: null }, { M: { b: { NULL: true } } }, { b: null }],
      ],
    ],
    [
      "Schema.Array(Schema.NullOr(Schema.BigInt))",
      Schema.Array(nullable),
      [[[5n, big, null], { L: [small, bigN, { NULL: true }] }, [5n, big, null]]],
    ],
    [
      "Schema.Record(Schema.String, Schema.NullOr(Schema.BigInt))",
      Schema.Record(Schema.String, nullable),
      [
        [
          { s: 5n, b: big, n: null },
          { M: { s: small, b: bigN, n: { NULL: true } } },
          { s: 5n, b: big, n: null },
        ],
      ],
    ],
    [
      "Schema.Union([Schema.Number, Schema.Struct({ b: Schema.BigInt })])",
      Schema.Union([Schema.Number, WithB]),
      [
        [{ b: 5n }, { M: { b: small } }, { b: 5n }],
        [{ b: big }, { M: { b: bigN } }, { b: big }],
        [7, { N: "7" }, 7],
      ],
    ],
    [
      "Schema.Union([Schema.Struct({ b: Schema.BigInt }), Schema.Number])",
      Schema.Union([WithB, Schema.Number]),
      [
        [{ b: 5n }, { M: { b: small } }, { b: 5n }],
        [7, { N: "7" }, 7],
      ],
    ],
    [
      "Schema.Struct({ b: Schema.BigInt }) with a decoding default",
      WithB.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ b: 0n }))),
      [
        [{ b: 5n }, { M: { b: small } }, { b: 5n }],
        [{ b: big }, { M: { b: bigN } }, { b: big }],
      ],
    ],

    // The guide's "read back changed": a number member takes what a number can hold.
    [
      "Schema.Union([Schema.Number, Schema.BigInt])",
      Schema.Union([Schema.Number, Schema.BigInt]),
      [
        [5n, small, 5],
        [big, bigN, big],
        [5, small, 5],
      ],
    ],
    [
      "Schema.Union([Schema.BigInt, Schema.Number])",
      Schema.Union([Schema.BigInt, Schema.Number]),
      [
        [5n, small, 5],
        [big, bigN, big],
        [5, small, 5],
      ],
    ],
    [
      "Schema.Union([Schema.Literal(5), Schema.BigInt])",
      Schema.Union([Schema.Literal(5), Schema.BigInt]),
      [
        [5n, small, 5],
        [6n, { N: "6" }, 6n],
        [big, bigN, big],
      ],
    ],
  ]

  const stored = (tableName: string) =>
    Effect.map(rowsOf(tableName), (rows) => rows.find((row) => row.f !== undefined)?.f)

  for (const [name, field, readings] of CASES) {
    it.effect(`${name}, on an entity: put, get, query, update`, () =>
      onEntity(field, (rows, tableName) =>
        Effect.gen(function* () {
          for (const [written, kept, read] of readings) {
            yield* rows.put({ id: "a", f: written }).asEffect()
            expect(yield* stored(tableName)).toEqual(kept)
            expect((yield* rows.get({ id: "a" })).f).toEqual(read)
            expect((yield* rows.scan().collect())[0].f).toEqual(read)
            expect((yield* rows.update({ id: "a" }).set({ n: 1 }).asEffect()).f).toEqual(read)
            expect(yield* stored(tableName)).toEqual(kept)
            if (written !== null) {
              expect((yield* rows.update({ id: "a" }).set({ f: written }).asEffect()).f).toEqual(
                read,
              )
              expect(yield* stored(tableName)).toEqual(kept)
            }
          }
        }),
      ),
    )

    it.effect(`${name}, on an aggregate: create, get, update`, () =>
      onAggregate(rootOver(field), {}, (agg, tableName) =>
        Effect.gen(function* () {
          for (const [written, kept, read] of readings) {
            yield* Effect.ignore(agg.delete({ id: "a" }))
            yield* agg.create({ id: "a", f: written })
            expect(yield* stored(tableName)).toEqual(kept)
            expect((yield* agg.get({ id: "a" })).f).toEqual(read)

            yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
            expect((yield* agg.get({ id: "a" })).f).toEqual(read)
            expect(yield* stored(tableName)).toEqual(kept)

            yield* agg.update({ id: "a" }, ({ state }: any) => ({
              ...state,
              f: written,
              note: "m",
            }))
            expect((yield* agg.get({ id: "a" })).f).toEqual(read)
          }
        }),
      ),
    )
  }

  it.effect("in a one edge and in a many edge's rows, past 2^53 and below it, and null", () => {
    const Row = Schema.Struct({ sku: Schema.String, qty: nullable })
    const model = Schema.Struct({
      id: Schema.String,
      note: Schema.optional(Schema.String),
      head: Row,
      lines: Schema.Array(Row),
    })
    const value = {
      id: "a",
      head: { sku: "h", qty: 5n },
      lines: [
        { sku: "s", qty: 5n },
        { sku: "n", qty: null },
        { sku: "b", qty: big },
      ],
    }
    const sorted = (read: any) => ({
      ...read,
      lines: [...read.lines].sort((a: any, b: any) => (a.sku < b.sku ? 1 : -1)),
    })
    return onAggregate(
      model,
      {
        head: Aggregate.one({ entityType: "Head" }),
        lines: Aggregate.many({ entityType: "Line", sk: { composite: ["sku"] } } as never),
      },
      (agg, tableName) =>
        Effect.gen(function* () {
          yield* agg.create(value)
          const rows = yield* rowsOf(tableName)
          expect(rows.find((row) => row.__edd_e__?.S === "Head")?.qty).toEqual(small)
          expect(rows.find((row) => row.sku?.S === "b")?.qty).toEqual(bigN)
          expect(rows.find((row) => row.sku?.S === "n")?.qty).toEqual({ NULL: true })
          expect(sorted(yield* agg.get({ id: "a" }))).toMatchObject(value)

          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
          const handedBack = sorted(yield* agg.get({ id: "a" }))
          expect(handedBack).toMatchObject(value)
          expect(handedBack.note).toBe("n")
        }),
    )
  })

  it.effect("a null set by an update: stored on a required one, a removal on an optional one", () =>
    Effect.gen(function* () {
      yield* onEntity(nullable, (rows, tableName) =>
        Effect.gen(function* () {
          yield* rows.put({ id: "a", f: 5n }).asEffect()
          expect((yield* rows.update({ id: "a" }).set({ f: null }).asEffect()).f).toBeNull()
          expect((yield* rowsOf(tableName))[0]?.f).toEqual({ NULL: true })
        }),
      )
      yield* onEntity(Schema.optionalKey(nullable), (rows, tableName) =>
        Effect.gen(function* () {
          yield* rows.put({ id: "a", f: 5n }).asEffect()
          expect((yield* rows.update({ id: "a" }).set({ f: null }).asEffect()).f).toBeUndefined()
          expect((yield* rowsOf(tableName))[0]?.f).toBeUndefined()
        }),
      )
    }),
  )

  it.effect("through Batch.get and Transaction.transactGet", () =>
    onEntity(nullable, (rows) =>
      Effect.gen(function* () {
        yield* rows.put({ id: "s", f: 5n }).asEffect()
        yield* rows.put({ id: "b", f: big }).asEffect()
        yield* rows.put({ id: "n", f: null }).asEffect()
        const batch: any = yield* Batch.get([
          rows.get({ id: "s" }),
          rows.get({ id: "b" }),
          rows.get({ id: "n" }),
        ] as never)
        expect(batch.map((row: any) => row.f)).toEqual([5n, big, null])
        const transact: any = yield* Transaction.transactGet([
          rows.get({ id: "s" }),
          rows.get({ id: "b" }),
          rows.get({ id: "n" }),
        ] as never)
        expect(transact.map((row: any) => row.f)).toEqual([5n, big, null])
      }),
    ),
  )

  it.effect("an optional one left out stays out, on both owners", () =>
    Effect.gen(function* () {
      yield* onEntity(Schema.optionalKey(nullable), (rows, tableName) =>
        Effect.gen(function* () {
          yield* rows.put({ id: "a" }).asEffect()
          expect((yield* rows.get({ id: "a" })).f).toBeUndefined()
          expect((yield* rowsOf(tableName))[0]?.f).toBeUndefined()
        }),
      )
      yield* onAggregate(rootOver(Schema.optionalKey(nullable)), {}, (agg, tableName) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a" })
          expect((yield* agg.get({ id: "a" })).f).toBeUndefined()
          expect((yield* rowsOf(tableName))[0]?.f).toBeUndefined()
        }),
      )
    }),
  )

  it.effect("a row without the attribute takes the decoding default, on both owners", () => {
    const defaulted = nullable.pipe(Schema.withDecodingDefaultKey(Effect.succeed(3n)))
    const removed = (tableName: string) =>
      Effect.promise(async () => {
        const { Items = [] } = await raw.send(new ScanCommand({ TableName: tableName }))
        const row = Items[0]!
        await raw.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: { pk: row.pk!, sk: row.sk! },
            UpdateExpression: "REMOVE f",
          }),
        )
      })
    return Effect.gen(function* () {
      yield* onEntity(defaulted, (rows, tableName) =>
        Effect.gen(function* () {
          yield* rows.put({ id: "a", f: 5n }).asEffect()
          yield* removed(tableName)
          expect((yield* rows.get({ id: "a" })).f).toBe(3n)
        }),
      )
      yield* onAggregate(rootOver(defaulted), {}, (agg, tableName) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", f: 5n })
          yield* removed(tableName)
          expect((yield* agg.get({ id: "a" })).f).toBe(3n)
        }),
      )
    })
  })

  it.effect("a value no member takes is still refused at the read", () =>
    Effect.gen(function* () {
      const overString = entityOver(Schema.String)
      const Base = Table.make({ schema: AppSchema, entities: { Rows: overString } })
      yield* onTable(Base, (tableName) =>
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: { Rows: overString },
            tables: { MainTable: Base },
          })
          yield* db.entities.Rows.put({ id: "a", f: "text" }).asEffect()
          const Nullable = entityOver(nullable)
          const Read = Table.make({ schema: AppSchema, entities: { Rows: Nullable } })
          const failure = yield* Effect.gen(function* () {
            const again: any = yield* DynamoClient.make({
              entities: { Rows: Nullable },
              tables: { MainTable: Read },
            })
            return yield* Effect.flip(again.entities.Rows.get({ id: "a" }))
          }).pipe(Effect.provide(Read.layer({ name: tableName }) as Layer.Layer<never>))
          expect((failure as { readonly _tag: string })._tag).toBe("ValidationError")
        }),
      )
    }),
  )
})

describeConnected("a labelled redacted value, on real rows", () => {
  const labelled = Schema.RedactedFromValue(Schema.String, { label: "a" })
  const secret = Redacted.make("s", { label: "a" })
  const kept = (read: unknown) => {
    const value = read as Redacted.Redacted<string>
    expect(Redacted.value(value)).toBe("s")
    expect(value.label).toBe("a")
  }

  const CASES: ReadonlyArray<
    readonly [string, Schema.Top, unknown, unknown, (read: any) => unknown]
  > = [
    ["on its own", labelled, secret, { S: "s" }, (read) => read],
    [
      "in a struct",
      Schema.Struct({ r: labelled }),
      { r: secret },
      { M: { r: { S: "s" } } },
      (read) => read.r,
    ],
    [
      "in a struct with a decoding default",
      Schema.Struct({ r: labelled }).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed({ r: "s" })),
      ),
      { r: secret },
      { M: { r: { S: "s" } } },
      (read) => read.r,
    ],
    [
      "or null with a decoding default",
      Schema.NullOr(labelled).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
      secret,
      { S: "s" },
      (read) => read,
    ],
    [
      "in a record with a decoding default",
      Schema.Record(Schema.String, labelled).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed({})),
      ),
      { x: secret },
      { M: { x: { S: "s" } } },
      (read) => read.x,
    ],
  ]

  for (const [name, field, value, kept_, inside] of CASES) {
    it.effect(`${name}: keeps its value and its label, on both owners`, () =>
      Effect.gen(function* () {
        yield* onEntity(field, (rows, tableName) =>
          Effect.gen(function* () {
            yield* rows.put({ id: "a", f: value }).asEffect()
            expect((yield* rowsOf(tableName))[0]?.f).toEqual(kept_)
            kept(inside((yield* rows.get({ id: "a" })).f))
          }),
        )
        yield* onAggregate(rootOver(field), {}, (agg, tableName) =>
          Effect.gen(function* () {
            yield* agg.create({ id: "a", f: value })
            expect((yield* rowsOf(tableName))[0]?.f).toEqual(kept_)
            kept(inside((yield* agg.get({ id: "a" })).f))
            yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
            expect((yield* rowsOf(tableName))[0]?.f).toEqual(kept_)
            kept(inside((yield* agg.get({ id: "a" })).f))
          }),
        )
      }),
    )
  }

  it.effect(
    "another label set on an aggregate's update stores the value, not its internals",
    () => {
      const field = Schema.Struct({ r: labelled }).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed({ r: "s" })),
      )
      return onAggregate(rootOver(field), {}, (agg, tableName) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", f: { r: secret } })
          yield* agg.update({ id: "a" }, ({ state }: any) => ({
            ...state,
            f: { r: Redacted.make("t") },
          }))
          expect((yield* rowsOf(tableName))[0]?.f).toEqual({ M: { r: { S: "t" } } })
          const read = (yield* agg.get({ id: "a" })).f.r
          expect(Redacted.value(read)).toBe("t")
        }),
      )
    },
  )
})

describeConnected("a date beneath a decoding default, on real rows", () => {
  const stamped = (read: unknown) => {
    expect(DateTime.isDateTime(read)).toBe(true)
    expect(Equal.equals(read, instant)).toBe(true)
  }

  it.effect("Schema.NullOr(Schema.DateTimeUtc): a DateTime and null, on both owners", () => {
    const field = Schema.NullOr(Schema.DateTimeUtc).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(null)),
    )
    return Effect.gen(function* () {
      yield* onEntity(field, (rows) =>
        Effect.gen(function* () {
          yield* rows.put({ id: "a", f: instant }).asEffect()
          stamped((yield* rows.get({ id: "a" })).f)
          stamped((yield* rows.update({ id: "a" }).set({ n: 1 }).asEffect()).f)
          yield* rows.put({ id: "a", f: null }).asEffect()
          expect((yield* rows.get({ id: "a" })).f).toBeNull()
        }),
      )
      yield* onAggregate(rootOver(field), {}, (agg, tableName) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", f: instant })
          expect((yield* rowsOf(tableName))[0]?.f).toEqual({ S: "2025-01-01T00:00:00.000Z" })
          stamped((yield* agg.get({ id: "a" })).f)
          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
          stamped((yield* agg.get({ id: "a" })).f)
        }),
      )
    })
  })

  it.effect("Schema.Struct({ d: Schema.DateTimeUtc }): a DateTime, on both owners", () => {
    const field = Schema.Struct({ d: Schema.DateTimeUtc }).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({ d: instant })),
    )
    return Effect.gen(function* () {
      const storedAsItIs = (tableName: string) =>
        Effect.map(rowsOf(tableName), ([row]) =>
          expect(Object.keys(row?.f?.M?.d?.M ?? {})).toContain("epochMilliseconds"),
        )
      yield* onEntity(field, (rows, tableName) =>
        Effect.gen(function* () {
          yield* rows.put({ id: "a", f: { d: instant } }).asEffect()
          yield* storedAsItIs(tableName)
          stamped((yield* rows.get({ id: "a" })).f.d)
        }),
      )
      yield* onAggregate(rootOver(field), {}, (agg, tableName) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", f: { d: instant } })
          yield* storedAsItIs(tableName)
          stamped((yield* agg.get({ id: "a" })).f.d)
          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
          stamped((yield* agg.get({ id: "a" })).f.d)
        }),
      )
    })
  })

  it.effect("a recursive model over Schema.DateFromString, on both owners", () => {
    interface Node {
      readonly at: Date
      readonly next: Node | null
    }
    interface NodeEncoded {
      readonly at: string
      readonly next: NodeEncoded | null
    }
    const Node: Schema.Codec<Node, NodeEncoded> = Schema.Struct({
      at: Schema.DateFromString,
      next: Schema.NullOr(Schema.suspend((): Schema.Codec<Node, NodeEncoded> => Node)),
    })
    const value = { at, next: { at, next: null } }
    return Effect.gen(function* () {
      yield* onEntity(Node, (rows) =>
        Effect.gen(function* () {
          yield* rows.put({ id: "a", f: value }).asEffect()
          expect((yield* rows.get({ id: "a" })).f).toEqual(value)
        }),
      )
      yield* onAggregate(rootOver(Node), {}, (agg) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", f: value })
          expect((yield* agg.get({ id: "a" })).f).toEqual(value)
          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
          expect((yield* agg.get({ id: "a" })).f).toEqual(value)
        }),
      )
    })
  })
})

describeConnected(
  "Schema.optionalKey over a union: its first member's stored form, the rest as declared",
  () => {
    const INTERNAL = {
      M: {
        epochMilliseconds: { N: String(at.getTime()) },
        "~effect/DateTime": { S: "~effect/DateTime" },
        _tag: { S: "Utc" },
      },
    }
    const K = (...members: ReadonlyArray<Schema.Top>) =>
      Schema.optionalKey(Schema.Union(members as never) as never) as unknown as Schema.Top
    const expectValue = (read: unknown, value: unknown) => {
      if (DateTime.isDateTime(value)) expect(Equal.equals(read, value)).toBe(true)
      else expect(read).toEqual(value)
    }
    const ISO = "2025-01-01T00:00:00.000Z"

    const STORED: ReadonlyArray<
      readonly [name: string, field: Schema.Top, value: unknown, stored: unknown]
    > = [
      ["a date after a string", K(Schema.String, Schema.DateTimeUtc), instant, INTERNAL],
      ["a date before a string", K(Schema.DateTimeUtc, Schema.String), instant, { S: ISO }],
      ["a string before a date", K(Schema.String, Schema.DateTimeUtc), "x", { S: "x" }],
      ["a string after a date", K(Schema.DateTimeUtc, Schema.String), "x", { S: "x" }],
      ["a date before null", K(Schema.DateTimeUtc, Schema.Null), instant, { S: ISO }],
      ["null after a date", K(Schema.DateTimeUtc, Schema.Null), null, { NULL: true }],
      [
        "null after a date from a string",
        K(Schema.DateFromString, Schema.Null),
        null,
        { NULL: true },
      ],
      ["a date from a string before null", K(Schema.DateFromString, Schema.Null), at, { S: ISO }],
      ["a number after a date", K(Schema.DateTimeUtc, Schema.Number), 5, { N: "5" }],
      ["a Date before a string", K(Schema.Date, Schema.String), at, { S: ISO }],
      [
        "a nested union, the date later",
        Schema.Struct({ a: K(Schema.String, Schema.DateTimeUtc) }),
        { a: instant },
        { M: { a: INTERNAL } },
      ],
      [
        "a nested union, the date first",
        Schema.Struct({ a: K(Schema.DateTimeUtc, Schema.String) }),
        { a: instant },
        { M: { a: { S: ISO } } },
      ],
      [
        "a list of dates, later",
        K(Schema.String, Schema.Array(Schema.DateTimeUtc)),
        [instant],
        { L: [INTERNAL] },
      ],
      [
        "a list of dates, first",
        K(Schema.Array(Schema.DateTimeUtc), Schema.String),
        [instant],
        { L: [{ S: ISO }] },
      ],
    ]

    for (const [name, field, value, stored] of STORED) {
      it.effect(`${name}: stored, read back and updated on an entity`, () =>
        onEntity(field, (rows, tableName) =>
          Effect.gen(function* () {
            yield* rows.put({ id: "a", f: value }).asEffect()
            expect((yield* rowsOf(tableName))[0]?.f).toEqual(stored)
            expectValue((yield* rows.get({ id: "a" })).f, value)
            yield* rows.update({ id: "a" }).set({ n: 1 }).asEffect()
            expect((yield* rowsOf(tableName))[0]?.f).toEqual(stored)
            expectValue((yield* rows.get({ id: "a" })).f, value)
            if (value !== null) {
              yield* rows.put({ id: "b", f: value }).asEffect()
              yield* rows.update({ id: "b" }).set({ f: value }).asEffect()
              const row = (yield* rowsOf(tableName)).find((r) => r.pk?.S?.includes("b"))
              expect(row?.f).toEqual(stored)
              expectValue((yield* rows.get({ id: "b" })).f, value)
            }
          }),
        ),
      )

      it.effect(`${name}: stored, read back and updated on an aggregate`, () =>
        onAggregate(rootOver(field), {}, (agg, tableName) =>
          Effect.gen(function* () {
            yield* agg.create({ id: "a", f: value })
            expect((yield* rowsOf(tableName))[0]?.f).toEqual(stored)
            expectValue((yield* agg.get({ id: "a" })).f, value)
            yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
            const [row] = yield* rowsOf(tableName)
            expect(row?.f).toEqual(stored)
            expect(row?.note).toEqual({ S: "n" })
            expectValue((yield* agg.get({ id: "a" })).f, value)
          }),
        ),
      )
    }

    const EPOCH = Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs))
    for (const [name, field, value] of [
      ["optionalKey(Null, DateTimeUtc storedAs)", K(Schema.Null, EPOCH), instant],
      ["NullOr(DateTimeUtc storedAs)", Schema.NullOr(EPOCH), instant],
      ["optionalKey(Null, DateEpochMs)", K(Schema.Null, DynamoModel.DateEpochMs), instant],
      ["NullOr(DateFromMillis)", Schema.NullOr(Schema.DateFromMillis), at],
    ] as const) {
      it.effect(`an aggregate reads what its date encoder stores under ${name}`, () =>
        onAggregate(rootOver(field), {}, (agg, tableName) =>
          Effect.gen(function* () {
            yield* agg.create({ id: "a", f: value })
            expect((yield* rowsOf(tableName))[0]?.f).toEqual({ S: ISO })
            expectValue((yield* agg.get({ id: "a" })).f, value)
            yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
            expect((yield* rowsOf(tableName))[0]?.f).toEqual({ S: ISO })
            expectValue((yield* agg.get({ id: "a" })).f, value)
          }),
        ),
      )
    }

    for (const [name, field, value, read] of [
      ["a Date under a first DateTime", K(Schema.DateTimeUtc, Schema.DateFromString), at, instant],
      [
        "a Date under a first epoch",
        K(DynamoModel.DateEpochMs, Schema.DateFromMillis),
        at,
        instant,
      ],
      [
        "a DateTime under a first Date, a plain union",
        Schema.Union([Schema.DateFromMillis, DynamoModel.DateEpochMs]),
        instant,
        at,
      ],
    ] as const) {
      it.effect(`two kinds of date on an aggregate: ${name}`, () =>
        onAggregate(rootOver(field), {}, (agg, tableName) =>
          Effect.gen(function* () {
            yield* agg.create({ id: "a", f: value })
            expect((yield* rowsOf(tableName))[0]?.f).toEqual({ S: ISO })
            expectValue((yield* agg.get({ id: "a" })).f, read)
            yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
            expect((yield* rowsOf(tableName))[0]?.f).toEqual({ S: ISO })
          }),
        ),
      )
    }

    it.effect(
      "the text of a date is that text under a first string, and a date under a first date",
      () =>
        Effect.gen(function* () {
          yield* onEntity(K(Schema.String, Schema.DateTimeUtc), (rows) =>
            Effect.gen(function* () {
              yield* rows.put({ id: "a", f: ISO }).asEffect()
              expect((yield* rows.get({ id: "a" })).f).toBe(ISO)
            }),
          )
          yield* onEntity(K(Schema.DateTimeUtc, Schema.String), (rows) =>
            Effect.gen(function* () {
              yield* rows.put({ id: "a", f: ISO }).asEffect()
              expectValue((yield* rows.get({ id: "a" })).f, instant)
            }),
          )
        }),
    )

    it.effect("a value of a later member is stored and comes back as it is, not as a date", () =>
      Effect.gen(function* () {
        for (const [field, value, stored] of [
          [K(Schema.DateTimeUtc, Schema.Number), 5, { N: "5" }],
          [K(Schema.DateTimeUtc, Schema.String), "5", { S: "5" }],
          [K(Schema.DateTimeUtc, Schema.String), "2025-01-01", { S: "2025-01-01" }],
        ] as const) {
          yield* onEntity(field, (rows, tableName) =>
            Effect.gen(function* () {
              yield* rows.put({ id: "a", f: value }).asEffect()
              expect((yield* rowsOf(tableName))[0]?.f).toEqual(stored)
              expect((yield* rows.get({ id: "a" })).f).toBe(value)
            }),
          )
          yield* onAggregate(rootOver(field), {}, (agg, tableName) =>
            Effect.gen(function* () {
              yield* agg.create({ id: "a", f: value })
              expect((yield* rowsOf(tableName))[0]?.f).toEqual(stored)
              expect((yield* agg.get({ id: "a" })).f).toBe(value)
            }),
          )
        }
      }),
    )

    it.effect("a row a date was converted into still reads as that date", () =>
      onEntity(K(Schema.DateTimeUtc, Schema.Number), (rows, tableName) =>
        Effect.gen(function* () {
          yield* rows.put({ id: "a" }).asEffect()
          const [row] = yield* rowsOf(tableName)
          yield* Effect.promise(() =>
            raw.send(
              new PutItemCommand({
                TableName: tableName,
                Item: { ...row!, f: { S: "1970-01-01T00:00:00.005Z" } },
              }),
            ),
          )
          expectValue((yield* rows.get({ id: "a" })).f, DateTime.makeUnsafe(5))
        }),
      ),
    )

    it.effect("an aggregate reads what it stores for a first date transform", () =>
      Effect.gen(function* () {
        for (const field of [
          K(Schema.DateFromMillis, Schema.Null),
          K(Schema.DateFromMillis, Schema.String),
        ]) {
          yield* onAggregate(rootOver(field), {}, (agg, tableName) =>
            Effect.gen(function* () {
              yield* agg.create({ id: "a", f: at })
              expect((yield* rowsOf(tableName))[0]?.f).toEqual({ S: ISO })
              expect((yield* agg.get({ id: "a" })).f).toEqual(at)
              yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
              expect((yield* rowsOf(tableName))[0]?.f).toEqual({ S: ISO })
              expect((yield* agg.get({ id: "a" })).f).toEqual(at)
            }),
          )
        }
      }),
    )

    it.effect("a path write follows the member it goes through", () =>
      Effect.gen(function* () {
        const next = DateTime.makeUnsafe("2026-02-02T00:00:00.000Z")
        yield* onEntity(
          K(Schema.String, Schema.Struct({ d: Schema.DateTimeUtc })),
          (rows, tableName) =>
            Effect.gen(function* () {
              yield* rows.put({ id: "a", f: { d: instant } }).asEffect()
              yield* rows
                .update({ id: "a" })
                .pathSet({ segments: ["f", "d"], value: next, isPath: false })
                .asEffect()
              const stored = (yield* rowsOf(tableName))[0]?.f?.M?.d
              expect(stored?.M?.epochMilliseconds).toEqual({
                N: String(DateTime.toEpochMillis(next)),
              })
              expectValue(((yield* rows.get({ id: "a" })).f as { d: unknown }).d, next)
            }),
        )
        yield* onEntity(
          K(Schema.Struct({ d: Schema.DateTimeUtc }), Schema.String),
          (rows, tableName) =>
            Effect.gen(function* () {
              yield* rows.put({ id: "a", f: { d: instant } }).asEffect()
              yield* rows
                .update({ id: "a" })
                .pathSet({ segments: ["f", "d"], value: next, isPath: false })
                .asEffect()
              expect((yield* rowsOf(tableName))[0]?.f?.M?.d).toEqual({
                S: "2026-02-02T00:00:00.000Z",
              })
              expectValue(((yield* rows.get({ id: "a" })).f as { d: unknown }).d, next)
            }),
        )
        yield* onEntity(K(Schema.Array(Schema.DateTimeUtc), Schema.String), (rows, tableName) =>
          Effect.gen(function* () {
            yield* rows.put({ id: "a", f: [instant] }).asEffect()
            yield* rows
              .update({ id: "a" })
              .append({ f: [next] })
              .asEffect()
            expect((yield* rowsOf(tableName))[0]?.f).toEqual({
              L: [{ S: ISO }, { S: "2026-02-02T00:00:00.000Z" }],
            })
          }),
        )
      }),
    )

    it.effect("an aggregate's update keeps a list where a later member is one", () =>
      onAggregate(
        rootOver(K(Schema.ReadonlySet(Schema.String), Schema.Array(Schema.String))),
        {},
        (agg, tableName) =>
          Effect.gen(function* () {
            yield* agg.create({ id: "a", f: ["a"] })
            yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
            expect((yield* rowsOf(tableName))[0]?.f).toEqual({ L: [{ S: "a" }] })
          }),
      ),
    )

    it.effect("a number under a first bigint reads as that bigint, as it always has", () =>
      onEntity(K(Schema.BigInt, Schema.Number), (rows) =>
        Effect.gen(function* () {
          yield* rows.put({ id: "a", f: 5n }).asEffect()
          expect((yield* rows.get({ id: "a" })).f).toBe(5n)
        }),
      ),
    )
  },
)

describeConnected("what can't be judged at load", () => {
  class Point {
    constructor(
      readonly x: number,
      readonly y: number,
    ) {}
  }

  it.effect("a Schema.instanceOf loads, and its write is refused", () =>
    onEntity(Schema.instanceOf(Point), (rows) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(rows.put({ id: "a", f: new Point(1, 2) }).asEffect())
        expect((failure as { readonly _tag: string })._tag).toBe("ValidationError")
        expect(String((failure as { readonly cause: unknown }).cause)).toContain("EDD-9126")
        expect(yield* Effect.flip(rows.get({ id: "a" }))).toMatchObject({ _tag: "ItemNotFound" })
      }),
    ),
  )

  it.effect("a duck-typed Schema.declare with the same AST reads back", () =>
    onEntity(
      Schema.declare(
        (input: unknown): input is Point =>
          typeof input === "object" && input !== null && "x" in input,
      ),
      (rows) =>
        Effect.gen(function* () {
          yield* rows.put({ id: "a", f: new Point(1, 2) }).asEffect()
          expect((yield* rows.get({ id: "a" })).f).toEqual({ x: 1, y: 2 })
        }),
    ),
  )
})

describeConnected("an aggregate's update hands back the state's plain form", () => {
  const CASES: ReadonlyArray<
    readonly [name: string, field: Schema.Top, value: unknown, next: unknown]
  > = [
    ["Schema.Option, some", Schema.Option(Schema.String), Option.some("a"), Option.some("b")],
    ["Schema.Option, none", Schema.Option(Schema.String), Option.none(), Option.some("b")],
    [
      "Schema.Option of a struct",
      Schema.Option(Schema.Struct({ x: Schema.Number })),
      Option.some({ x: 1 }),
      Option.some({ x: 2 }),
    ],
    [
      "Schema.Option of a set",
      Schema.Option(Schema.ReadonlySet(Schema.String)),
      Option.some(new Set(["a"])),
      Option.some(new Set(["b"])),
    ],
    [
      "Schema.Result",
      Schema.Result(Schema.String, Schema.Number),
      Result.succeed("a"),
      Result.fail(1),
    ],
    [
      "Schema.Exit",
      Schema.Exit(Schema.String, Schema.String, Schema.Defect()),
      Exit.succeed("a"),
      Exit.fail("e"),
    ],
    [
      "Schema.Cause",
      Schema.Cause(Schema.String, Schema.Defect()),
      Cause.fail("a"),
      Cause.fail("b"),
    ],
    ["Schema.ReadonlySet", Schema.ReadonlySet(Schema.String), new Set(["a"]), new Set(["b"])],
    ["Schema.HashSet, empty", Schema.HashSet(Schema.String), HashSet.empty(), HashSet.empty()],
    [
      "an Option in a struct",
      Schema.Struct({ o: Schema.Option(Schema.String) }),
      { o: Option.some("a") },
      { o: Option.none() },
    ],
    [
      "an Option in an array",
      Schema.Array(Schema.Option(Schema.String)),
      [Option.some("a")],
      [Option.none()],
    ],
  ]

  const equal = (field: Schema.Top) => {
    const equivalent = Schema.toEquivalence(field as never) as (a: unknown, b: unknown) => boolean
    return (a: unknown, b: unknown) => expect(equivalent(a, b)).toBe(true)
  }

  for (const [name, field, value, next] of CASES) {
    it.effect(`${name}: the state handed back, a domain value set, the current value kept`, () =>
      onAggregate(rootOver(field), {}, (agg) =>
        Effect.gen(function* () {
          const check = equal(field)
          yield* agg.create({ id: "a", f: value })

          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
          const handedBack = yield* agg.get({ id: "a" })
          check(handedBack.f, value)
          expect(handedBack.note).toBe("n")

          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, f: next }))
          check((yield* agg.get({ id: "a" })).f, next)

          yield* agg.update({ id: "a" }, ({ current }: any) => ({ ...current, note: "m" }))
          const kept = yield* agg.get({ id: "a" })
          check(kept.f, next)
          expect(kept.note).toBe("m")
        }),
      ),
    )
  }

  for (const [name, field, value, next] of [
    [
      "Schema.Option(Schema.DateFromString)",
      Schema.Option(Schema.DateFromString),
      Option.some(at),
      Option.some(new Date("2026-02-02T00:00:00.000Z")),
    ],
    [
      "Schema.Option(Schema.URLFromString)",
      Schema.Option(Schema.URLFromString),
      Option.some(url),
      Option.some(new URL("https://example.com/next")),
    ],
    [
      "Schema.ReadonlySet(Schema.DateFromString)",
      Schema.ReadonlySet(Schema.DateFromString),
      new Set([at]),
      new Set([new Date("2026-02-02T00:00:00.000Z")]),
    ],
  ] as const) {
    it.effect(`${name}: a domain value at create and at update, the state handed back`, () =>
      onAggregate(rootOver(field), {}, (agg) =>
        Effect.gen(function* () {
          const check = equal(field)
          yield* agg.create({ id: "a", f: value })
          check((yield* agg.get({ id: "a" })).f, value)

          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
          const handedBack = yield* agg.get({ id: "a" })
          check(handedBack.f, value)
          expect(handedBack.note).toBe("n")

          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, f: next }))
          check((yield* agg.get({ id: "a" })).f, next)
        }),
      ),
    )
  }

  it.effect(
    "a transformation over a date to an instant, on an aggregate: stored as its domain",
    () => {
      const toInstant = Schema.Date.pipe(
        Schema.decodeTo(Schema.DateTimeUtc, {
          decode: SchemaGetter.transform((d: Date) => DateTime.fromDateUnsafe(d)),
          encode: SchemaGetter.transform((u: DateTime.Utc) => DateTime.toDateUtc(u)),
        }),
      )
      return onAggregate(rootOver(toInstant), {}, (agg) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", f: instant })
          expect(Equal.equals((yield* agg.get({ id: "a" })).f, instant)).toBe(true)
          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
          const read = yield* agg.get({ id: "a" })
          expect(Equal.equals(read.f, instant)).toBe(true)
          expect(read.note).toBe("n")
        }),
      )
    },
  )

  const mapFromRecord = Schema.Record(Schema.String, Schema.Number).pipe(
    Schema.decodeTo(Schema.ReadonlyMap(Schema.String, Schema.Number), {
      decode: SchemaGetter.transform(
        (record: Readonly<Record<string, number>>) => new Map(Object.entries(record)),
      ),
      encode: SchemaGetter.transform((map: ReadonlyMap<string, number>) => Object.fromEntries(map)),
    }),
  )

  it.effect("a map decoded from a record keeps its entries, and is stored as the record", () =>
    onAggregate(rootOver(mapFromRecord), {}, (agg, tableName) =>
      Effect.gen(function* () {
        yield* agg.create({ id: "a", f: new Map([["x", 1]]) })
        expect((yield* rowsOf(tableName))[0]?.f).toEqual({ M: { x: { N: "1" } } })
        expect([...(yield* agg.get({ id: "a" })).f]).toEqual([["x", 1]])

        yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
        const handedBack = yield* agg.get({ id: "a" })
        expect([...handedBack.f]).toEqual([["x", 1]])
        expect(handedBack.note).toBe("n")

        yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, f: new Map([["y", 2]]) }))
        expect((yield* rowsOf(tableName))[0]?.f).toEqual({ M: { y: { N: "2" } } })
      }),
    ),
  )

  for (const [name, field, value, next, stored] of [
    [
      "Schema.OptionFromNullOr",
      Schema.OptionFromNullOr(Schema.String),
      Option.some("a"),
      Option.none(),
      { S: "a" },
    ],
    [
      "Schema.OptionFromUndefinedOr",
      Schema.OptionFromUndefinedOr(Schema.String),
      Option.some("a"),
      Option.some("b"),
      { S: "a" },
    ],
    [
      "Schema.OptionFromNullishOr",
      Schema.OptionFromNullishOr(Schema.String),
      Option.some("a"),
      Option.some("b"),
      { S: "a" },
    ],
    [
      "Schema.toCodecJson over a map",
      Schema.toCodecJson(Schema.ReadonlyMap(Schema.String, Schema.Number)),
      new Map([["a", 1]]),
      new Map([["b", 2]]),
      { L: [{ L: [{ S: "a" }, { N: "1" }] }] },
    ],
    [
      "Schema.fromJsonString over a list",
      Schema.fromJsonString(Schema.Array(Schema.String)),
      ["a"],
      ["b"],
      { S: '["a"]' },
    ],
    [
      "Schema.toCodecJson over a set",
      Schema.toCodecJson(Schema.ReadonlySet(Schema.String)),
      new Set(["a"]),
      new Set(["b"]),
      { L: [{ S: "a" }] },
    ],
  ] as const) {
    it.effect(`${name}: the domain value at create and update, and the state handed back`, () =>
      onAggregate(rootOver(field), {}, (agg, tableName) =>
        Effect.gen(function* () {
          const check = equal(field)
          yield* agg.create({ id: "a", f: value })
          expect((yield* rowsOf(tableName))[0]?.f).toEqual(stored)
          check((yield* agg.get({ id: "a" })).f, value)

          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
          const handedBack = yield* agg.get({ id: "a" })
          check(handedBack.f, value)
          expect(handedBack.note).toBe("n")

          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, f: next }))
          check((yield* agg.get({ id: "a" })).f, next)
        }),
      ),
    )
  }

  it.effect("a value that's none of its forms is still refused, and nothing is written", () =>
    onAggregate(rootOver(Schema.Option(Schema.String)), {}, (agg) =>
      Effect.gen(function* () {
        yield* agg.create({ id: "a", f: Option.some("a") })
        const failure = yield* Effect.flip(
          agg.update({ id: "a" }, ({ state }: any) => ({ ...state, f: { nonsense: true } })),
        )
        expect((failure as { readonly _tag: string })._tag).toBe("ValidationError")
        expect((yield* agg.get({ id: "a" })).f).toEqual(Option.some("a"))
      }),
    ),
  )

  for (const [name, field, value] of [
    ["Schema.Defect()", Schema.Defect(), new Error("a")],
    ["Schema.RecordFromCookies", Schema.RecordFromCookies, {}],
    ["Schema.RecordFromUrlParams", Schema.RecordFromUrlParams, { a: "b" }],
  ] as const) {
    it.effect(`${name}, encoded as a declaration: create, get, update`, () =>
      onAggregate(rootOver(field), {}, (agg) =>
        Effect.gen(function* () {
          yield* agg.create({ id: "a", f: value })
          yield* agg.get({ id: "a" })
          yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
          expect((yield* agg.get({ id: "a" })).note).toBe("n")
        }),
      ),
    )
  }
})

describeConnected("a many edge's collection is rows, not a stored value", () => {
  const Line = Schema.Struct({ sku: Schema.String, qty: Schema.Number })
  const row = { sku: "s", qty: 1 }

  const CASES: ReadonlyArray<
    readonly [
      name: string,
      field: Schema.Top,
      decompose: (value: any) => ReadonlyArray<unknown>,
      assemble: (rows: ReadonlyArray<any>) => unknown,
      value: () => unknown,
      list: (read: any) => ReadonlyArray<unknown>,
    ]
  > = [
    [
      "Schema.Chunk",
      Schema.Chunk(Line),
      (lines) => Chunk.toReadonlyArray(lines),
      (rows) => Chunk.fromIterable(rows),
      () => Chunk.make(row),
      (read) => Chunk.toReadonlyArray(read),
    ],
    [
      "Schema.HashMap",
      Schema.HashMap(Schema.String, Line),
      (lines) => [...HashMap.values(lines)],
      (rows) => HashMap.fromIterable(rows.map((r) => [r.sku, r] as const)),
      () => HashMap.make(["s", row]),
      (read) => [...HashMap.values(read)],
    ],
    [
      "Schema.HashSet",
      Schema.HashSet(Line),
      (lines) => [...lines],
      (rows) => HashSet.fromIterable(rows),
      () => HashSet.make(row),
      (read) => [...read],
    ],
    [
      "Schema.ReadonlyMap",
      Schema.ReadonlyMap(Schema.String, Line),
      (lines) => [...lines.values()],
      (rows) => new Map(rows.map((r) => [r.sku, r] as const)),
      () => new Map([["s", row]]),
      (read) => [...read.values()],
    ],
  ]

  for (const [name, field, decompose, assemble, value, list] of CASES) {
    it.effect(`${name}: created, read, updated and read again, one row per line`, () =>
      onAggregate(
        Schema.Struct({
          id: Schema.String,
          note: Schema.optional(Schema.String),
          lines: field as never,
        }),
        {
          lines: Aggregate.many({
            entityType: "Line",
            sk: { composite: ["sku"] },
            decompose,
            assemble,
          } as never),
        },
        (agg, tableName) =>
          Effect.gen(function* () {
            yield* agg.create({ id: "a", lines: value() })
            expect(list((yield* agg.get({ id: "a" })).lines)).toEqual([row])
            const rows = yield* rowsOf(tableName)
            expect(rows.filter((item) => item.__edd_e__?.S === "Line")).toHaveLength(1)

            yield* agg.update({ id: "a" }, ({ state }: any) => ({ ...state, note: "n" }))
            const read = yield* agg.get({ id: "a" })
            expect(read.note).toBe("n")
            expect(list(read.lines)).toEqual([row])
          }),
      ),
    )
  }
})

describeConnected("a cookie 1.39.0 stored, read and written back", () => {
  // Rows as published 1.39.0 stored them, and what it did writing back what it read
  // (`fixtures/cookie-writeback-1.39.0.json`, never regenerated). `CookieWriteBack.test.ts` holds
  // the same cases on a recording table, which compares maps by their text.
  type Item = Record<string, AttributeValue>
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/cookie-writeback-1.39.0.json", import.meta.url), "utf8"),
  ) as {
    readonly entity: Record<
      string,
      { readonly row: Item; readonly ops: Record<string, { readonly outcome: string }> }
    >
    readonly aggregate: {
      readonly rows: ReadonlyArray<Item>
      readonly ops: Record<string, { readonly outcome: string; readonly f: unknown }>
    }
  }
  const look = DynamoSchema.make({ name: "look", version: 1 })
  const FIELDS = { cookie: Schema.Cookie, jar: Schema.Cookies, list: Schema.Array(Schema.Cookie) }
  const seed = (tableName: string, rows: ReadonlyArray<Item>) =>
    Effect.promise(() =>
      Promise.all(rows.map((Item) => raw.send(new PutItemCommand({ TableName: tableName, Item })))),
    )
  const outcomeOf = (exit: Exit.Exit<unknown, unknown>) => {
    if (Exit.isSuccess(exit)) return "ok"
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail") as
      | { readonly error: { readonly _tag: string; readonly message?: string } }
      | undefined
    return failure === undefined
      ? "defect"
      : `${failure.error._tag}: ${String(failure.error.message ?? "").slice(0, 160)}`
  }
  const OPS: Record<
    string,
    { readonly immutable: boolean; readonly run: (rows: any, got: any) => any }
  > = {
    putBack: { immutable: false, run: (rows, got) => rows.put(got).asEffect() },
    setBack: {
      immutable: false,
      run: (rows, got) => rows.update({ id: got.id }).set({ f: got.f, n: 2 }).asEffect(),
    },
    conditionBack: {
      immutable: false,
      run: (rows, got) =>
        rows.update({ id: got.id }).set({ n: 1 }).condition({ f: got.f }).asEffect(),
    },
    unrelated: {
      immutable: false,
      run: (rows, got) => rows.update({ id: got.id }).set({ n: 1 }).asEffect(),
    },
    immutableSetBack: {
      immutable: true,
      run: (rows, got) => rows.update({ id: got.id }).set({ f: got.f, n: 2 }).asEffect(),
    },
  }

  for (const [name, pinned] of Object.entries(fixture.entity)) {
    for (const immutable of [false, true]) {
      const ops = Object.entries(OPS).filter(([, op]) => op.immutable === immutable)
      it.effect(`${name}: ${ops.map(([op]) => op).join(", ")}`, () => {
        const base = Schema.Struct({
          id: Schema.String,
          f: FIELDS[name.split(".")[0] as keyof typeof FIELDS] as Schema.Top,
          n: Schema.optional(Schema.Number),
        })
        const Rows = Entity.make({
          model: immutable
            ? DynamoModel.configure(base, { f: { immutable: true } } as never)
            : base,
          entityType: "Row",
          primaryKey: keyed,
        } as never) as any
        const MainTable = Table.make({ schema: look, entities: { Rows } } as never) as any
        return onTable(MainTable, (tableName) =>
          Effect.gen(function* () {
            const db: any = yield* DynamoClient.make({ entities: { Rows }, tables: { MainTable } })
            for (const [op, { run }] of ops) {
              yield* seed(tableName, [pinned.row])
              const got = yield* db.entities.Rows.get({ id: pinned.row.id!.S })
              expect([op, outcomeOf(yield* Effect.exit(run(db.entities.Rows, got)))]).toEqual([
                op,
                pinned.ops[op]!.outcome,
              ])
              const [after] = yield* rowsOf(tableName)
              expect(after?.f).toEqual(pinned.row.f)
            }
          }),
        )
      })
    }
  }

  it.effect("an aggregate's update of its root, a one edge and a many element", () => {
    const line = Schema.Struct({
      lid: Schema.String,
      f: Schema.Cookie,
      note: Schema.optional(Schema.String),
    })
    const Base = Table.make({ schema: look, entities: {} })
    const Root = (Aggregate.make as any)(
      Schema.Struct({
        id: Schema.String,
        f: Schema.Cookie,
        note: Schema.optional(Schema.String),
        one: Schema.Struct({ f: Schema.Cookie, note: Schema.optional(Schema.String) }),
        lines: Schema.Array(line),
      }),
      {
        table: Base,
        schema: look,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "root" },
        root: { entityType: "Root" },
        edges: {
          one: (Aggregate.one as any)({ entityType: "One" }),
          lines: (Aggregate.many as any)({ entityType: "Line", sk: { composite: ["lid"] } }),
        },
      },
    )
    const MUTATIONS: Record<string, (state: any) => any> = {
      noop: (state) => state,
      rootNote: (state) => ({ ...state, note: "changed" }),
      oneNote: (state) => ({ ...state, one: { ...state.one, note: "n" } }),
      lineNote: (state) => ({
        ...state,
        lines: state.lines.map((l: any) => (l.lid === "x" ? { ...l, note: "n" } : l)),
      }),
    }
    const cookiesOf = (rows: ReadonlyArray<Item>) =>
      Object.fromEntries(rows.map((row) => [`${row.__edd_e__!.S}|${row.sk!.S}`, row.f]))
    return onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Root },
          tables: { MainTable: { ...Base, aggregates: { Root } } },
        } as never)
        for (const [op, mutate] of Object.entries(MUTATIONS)) {
          yield* seed(tableName, fixture.aggregate.rows)
          const exit = yield* Effect.exit(
            db.aggregates.Root.update({ id: "a" }, ({ state }: any) => mutate(state)),
          )
          expect([op, outcomeOf(exit)]).toEqual([op, fixture.aggregate.ops[op]!.outcome])
          expect(cookiesOf(yield* rowsOf(tableName))).toEqual(fixture.aggregate.ops[op]!.f)
        }
      }),
    )
  })
})
