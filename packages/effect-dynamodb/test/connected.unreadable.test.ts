/**
 * What `[EDD-9125]` points to and what it leaves standing, against DynamoDB Local: every replacement
 * a refusal names, on every owner; what reads back changed, as the modeling guide says; what can't be
 * judged at load; and an aggregate's `update`, which hands back the state's plain form.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
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
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
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
  readonly [
    name: string,
    field: Schema.Top,
    value: unknown,
    check: (read: unknown) => void,
    skipOwners?: ReadonlyArray<string>,
  ]
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
  it.effect("a Schema.Duration reads back as a plain object its functions still work on", () =>
    onEntity(Schema.Duration, (rows) =>
      Effect.gen(function* () {
        const second = Duration.seconds(1)
        yield* rows.put({ id: "a", f: second }).asEffect()
        const read = (yield* rows.get({ id: "a" })).f
        expect(Duration.toMillis(read)).toBe(1000)
        expect(Duration.toMillis(Duration.sum(read, second))).toBe(2000)
        expect(Duration.format(read)).toBe(Duration.format(second))
        expect(Equal.equals(read, second)).toBe(false)
        expect(read.pipe).toBeUndefined()
        expect(Object.getPrototypeOf(read)).toBe(Object.prototype)
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
    "a Schema.BigInt past 2^53 is read by a declaration over bigint, not its replacement",
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

          yield* overBigint.append({ id: "b" }, [{ _tag: "Noted", big: 5n }], 0)
          const small = yield* Effect.flip(overBigint.read({ id: "b" }))
          expect((small as { readonly _tag: string })._tag).toBe("ValidationError")
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

  it.effect("a Schema.BigDecimal below 2^53 reads back, and its arithmetic throws", () =>
    onEntity(Schema.BigDecimal, (rows) =>
      Effect.gen(function* () {
        const value = BigDecimal.fromStringUnsafe("1.5")
        yield* rows.put({ id: "a", f: value }).asEffect()
        const read = (yield* rows.get({ id: "a" })).f
        expect(BigDecimal.format(read)).toBe("1.5")
        expect(() => BigDecimal.sum(read, value)).toThrow("Cannot mix BigInt")
      }),
    ),
  )

  it.effect("a Schema.BigDecimal once normalised dies at put, and writes nothing", () =>
    onEntity(Schema.BigDecimal, (rows, tableName) =>
      Effect.gen(function* () {
        const value = BigDecimal.normalize(BigDecimal.fromStringUnsafe("1.5"))
        const exit = yield* Effect.exit(rows.put({ id: "a", f: value }).asEffect())
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* rowsOf(tableName)).toEqual([])
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

  it.effect("a Schema.SemVer reads back as a plain object its functions still work on", () =>
    onEntity(Schema.SemVer, (rows) =>
      Effect.gen(function* () {
        const value = Schema.decodeUnknownSync(Schema.SemVerFromString)("1.2.3")
        yield* rows.put({ id: "a", f: value }).asEffect()
        const read = (yield* rows.get({ id: "a" })).f
        expect(SemVer.format(read)).toBe("1.2.3")
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

describeConnected("what can't be judged at load", () => {
  class Point {
    constructor(
      readonly x: number,
      readonly y: number,
    ) {}
  }

  it.effect("a Schema.instanceOf is written and can't be read: the guide says so", () =>
    onEntity(Schema.instanceOf(Point), (rows) =>
      Effect.gen(function* () {
        yield* rows.put({ id: "a", f: new Point(1, 2) }).asEffect()
        const failure = yield* Effect.flip(rows.get({ id: "a" }))
        expect((failure as { readonly _tag: string })._tag).toBe("ValidationError")
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
