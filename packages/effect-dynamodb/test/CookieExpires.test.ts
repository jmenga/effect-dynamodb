/**
 * A cookie's `expires` is a `Date`, which the marshaller stores as an empty map: 1.39.0 stored every
 * cookie without its expiry. One of Effect's cookies is now written with its expiry as ISO text,
 * wherever it's written: in a field typed as a cookie, in one that isn't (an `Unknown` field, a
 * declaration of one's own holding a cookie) and as a condition's operand. A field typed as a cookie
 * reads it back as the `Date`. Everything else written is what 1.39.0 wrote
 * (`fixtures/cookie-expires-1.39.0.json`), byte for byte.
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { BigDecimal, DateTime, Duration, Effect, Hash, Layer, Option, Schema } from "effect"
import * as Cookies from "effect/http/Cookies"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { readModelTag } from "../src/internal/ProjectionEngine.js"
import { fromAttributeValue, toAttributeMap, toAttributeValue } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable, type Request } from "./helpers/RecordingTable.js"

type Pinned = {
  readonly outcome: string
  readonly requests: ReadonlyArray<Record<string, unknown>>
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/cookie-expires-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly expires: string
  readonly [group: string]: unknown
}
const scenarioOf = (group: string, name: string): Pinned =>
  (fixture[group] as Record<string, Pinned>)[name]!

const EXPIRES = "2030-01-02T03:04:05.678Z"
const dated = () =>
  Cookies.makeCookieUnsafe("a", "b c", {
    path: "/",
    expires: new Date(EXPIRES),
    maxAge: Duration.seconds(5),
    httpOnly: true,
  })
const plain = () => Cookies.makeCookieUnsafe("p", "q", { secure: true })
const jar = () => Cookies.fromIterable([plain(), dated()])

const schema = DynamoSchema.make({ name: "look", version: 1 })
const key = (name: string) => ({
  pk: { field: "pk", composite: [name] },
  sk: { field: "sk", composite: [] },
})

// ---------------------------------------------------------------------------
// The generator's cases, on the library as it stands
// ---------------------------------------------------------------------------

const Model = Schema.Struct({
  id: Schema.String,
  f: Schema.optional(Schema.Cookie),
  l: Schema.optional(Schema.Array(Schema.Cookie)),
  j: Schema.optional(Schema.Cookies),
  o: Schema.optional(Schema.Option(Schema.Cookie)),
  u: Schema.optional(Schema.Unknown),
  ua: Schema.optional(Schema.Union([Schema.Unknown, Schema.Cookie])),
  cu: Schema.optional(Schema.Union([Schema.Cookie, Schema.Unknown])),
})
const Rows = Entity.make({ model: Model, entityType: "Row", primaryKey: key("id") } as never) as any
const RowsTable = Table.make({ schema, entities: { Rows } } as never) as any

const Base = Table.make({ schema, entities: {} } as never) as any
const Root = Aggregate.make(
  Schema.Struct({
    id: Schema.String,
    f: Schema.Cookie,
    g: Schema.Struct({ c: Schema.Cookie, at: Schema.DateTimeUtc }),
    u: Schema.Unknown,
  }),
  {
    table: Base,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "root" },
    root: { entityType: "Root" },
    edges: {},
  } as never,
) as any
const Tally = EventStore.makeStream({
  table: Base,
  streamName: "Tally",
  events: [Schema.Struct({ _tag: Schema.tag("Noted"), f: Schema.Cookie, u: Schema.Unknown })],
  streamId: { composite: ["id"] },
} as never) as any

class Target extends Schema.Class<Target>("Target")({
  targetId: Schema.String.pipe(DynamoModel.identifier),
  f: Schema.Cookie,
}) {}
class Holder extends Schema.Class<Holder>("Holder")({
  id: Schema.String,
  target: Target.pipe(DynamoModel.ref),
}) {}
const Targets = Entity.make({
  model: Target,
  entityType: "Target",
  primaryKey: key("targetId"),
} as never) as any
const Holders = Entity.make({
  model: Holder,
  entityType: "Holder",
  primaryKey: key("id"),
  refs: { target: { entity: Targets } },
} as never) as any
const RefTable = Table.make({ schema, entities: { Targets, Holders } } as never) as any

const EventsTable = Table.make({ schema, entities: {} } as never) as any
const Orders = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [Schema.Struct({ _tag: Schema.tag("Noted"), n: Schema.Number })],
  streamId: { composite: ["orderId"] },
} as never) as any
const Summaries = Entity.make({
  model: Schema.Struct({
    orderId: Schema.String,
    rev: Schema.Number,
    f: Schema.optional(Schema.Cookie),
  }),
  entityType: "Summary",
  primaryKey: key("orderId"),
} as never) as any
const ReadTable = Table.make({ schema, entities: { Summaries } } as never) as any
const Notifying = EventStore.projection({
  stream: Orders,
  readModel: Summaries,
  key: (id: any) => ({ orderId: id.orderId }),
  initial: (id: any) => ({ orderId: id.orderId, rev: 0 }),
  evolve: (state: any) => Effect.succeed({ ...state, f: dated() }),
  checkpoint: "rev",
  revision: "rev",
  outbox: {
    schema: Schema.Struct({ c: Schema.Cookie, u: Schema.Unknown }),
    effects: () => [{ c: dated(), u: dated() }],
  },
} as never) as any

const READS = new Set(["GetItem", "Query", "Scan", "BatchGetItem", "TransactGetItems"])

/** A case's writes, as the generator pinned them, on a fresh table. */
const writesOf = (
  layer: Layer.Layer<any, any, any>,
  body: Effect.Effect<unknown, unknown, any>,
  table = makeRecordingTable(),
) =>
  body.pipe(
    Effect.ignore,
    Effect.provide(layer),
    Effect.provide(table.layer),
    Effect.map(() =>
      table.requests
        .filter(({ command }) => !READS.has(command))
        .map(({ command, input }: Request) =>
          JSON.parse(
            JSON.stringify({
              op: command[0]!.toLowerCase() + command.slice(1),
              Item: input.Item,
              TransactItems: input.TransactItems,
              RequestItems: input.RequestItems,
              ExpressionAttributeValues: input.ExpressionAttributeValues,
              ConditionExpression: input.ConditionExpression,
              UpdateExpression: input.UpdateExpression,
            }),
          ),
        ),
    ),
  ) as unknown as Effect.Effect<ReadonlyArray<Record<string, unknown>>>

const onRows = (body: (db: any) => Effect.Effect<unknown, unknown, any>) =>
  writesOf(
    RowsTable.layer({ name: "t" }),
    Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: { Rows },
        tables: { Main: RowsTable },
      } as never)
      yield* body(db)
    }),
  )

const CASES: ReadonlyArray<
  readonly [
    group: string,
    name: string,
    run: () => Effect.Effect<ReadonlyArray<Record<string, unknown>>>,
    dated: ReadonlyArray<string>,
  ]
> = [
  [
    "entity",
    "put",
    () => onRows((db) => db.entities.Rows.put({ id: "a", f: dated() }).asEffect()),
    ["0.Item.f"],
  ],
  [
    "entity",
    "conditionedPut",
    () =>
      onRows((db) =>
        db.entities.Rows.put({ id: "a", f: dated() })
          .condition((t: any, { eq }: any) => eq(t.f, dated()))
          .asEffect(),
      ),
    // The condition's operand too: 1.39.0 compared against a cookie with no expiry.
    ["0.Item.f", "0.ExpressionAttributeValues.:e1"],
  ],
  [
    "entity",
    "updateSet",
    () => onRows((db) => db.entities.Rows.update({ id: "a" }).set({ f: dated() }).asEffect()),
    ["0.ExpressionAttributeValues.:u0"],
  ],
  [
    "entity",
    "pathSet",
    () =>
      onRows((db) =>
        db.entities.Rows.update({ id: "a" })
          .pathSet({ segments: ["f"], value: dated() })
          .asEffect(),
      ),
    ["0.ExpressionAttributeValues.:ps1"],
  ],
  [
    "entity",
    "listPut",
    () => onRows((db) => db.entities.Rows.put({ id: "a", l: [plain(), dated()] }).asEffect()),
    ["0.Item.l.1"],
  ],
  [
    "entity",
    "listAppend",
    () =>
      onRows((db) =>
        db.entities.Rows.update({ id: "a" })
          .append({ l: [dated()] })
          .asEffect(),
      ),
    ["0.ExpressionAttributeValues.:u0.0"],
  ],
  [
    "entity",
    "jar",
    () => onRows((db) => db.entities.Rows.put({ id: "a", j: jar() }).asEffect()),
    ["0.Item.j.cookies.a"],
  ],
  [
    "entity",
    "option",
    () => onRows((db) => db.entities.Rows.put({ id: "a", o: Option.some(dated()) }).asEffect()),
    ["0.Item.o.value"],
  ],
  [
    "entity",
    "unknown",
    () => onRows((db) => db.entities.Rows.put({ id: "a", u: dated() }).asEffect()),
    ["0.Item.u"],
  ],
  [
    "entity",
    "unknownFirst",
    () => onRows((db) => db.entities.Rows.put({ id: "a", ua: dated() }).asEffect()),
    ["0.Item.ua"],
  ],
  [
    "entity",
    "cookieFirst",
    () => onRows((db) => db.entities.Rows.put({ id: "a", cu: dated() }).asEffect()),
    ["0.Item.cu"],
  ],
  [
    "entity",
    "batchPut",
    () => onRows((db) => Batch.write([db.entities.Rows.put({ id: "a", f: dated() })] as never)),
    ["0.RequestItems.t.0.PutRequest.Item.f"],
  ],
  [
    "entity",
    "transactionPut",
    () =>
      onRows((db) =>
        Transaction.transactWrite([db.entities.Rows.put({ id: "a", f: dated() })] as never),
      ),
    ["0.TransactItems.0.Put.Item.f"],
  ],
  [
    "aggregate",
    "create",
    () =>
      writesOf(
        Base.layer({ name: "t" }),
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: {},
            aggregates: { Root },
            tables: { Main: { ...Base, aggregates: { Root } } },
          } as never)
          yield* db.aggregates.Root.create({
            id: "a",
            f: dated(),
            g: { c: dated(), at: DateTime.makeUnsafe("2025-01-01T00:00:00.000Z") },
            u: dated(),
          })
        }),
      ),
    [
      "0.TransactItems.0.Put.Item.f",
      "0.TransactItems.0.Put.Item.g.c",
      "0.TransactItems.0.Put.Item.u",
    ],
  ],
  [
    "stream",
    "append",
    () =>
      writesOf(
        Base.layer({ name: "t" }),
        Tally.append({ id: "a" }, [{ _tag: "Noted", f: dated(), u: dated() }], 0),
      ),
    ["0.Item.data.f", "0.Item.data.u"],
  ],
  [
    "ref",
    "splice",
    () =>
      writesOf(
        RefTable.layer({ name: "t" }),
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: { Targets, Holders },
            tables: { Main: RefTable },
          } as never)
          yield* db.entities.Targets.put({ targetId: "t1", f: dated() }).asEffect()
          yield* db.entities.Holders.put({ id: "h1", targetId: "t1" }).asEffect()
        }),
      ),
    ["0.Item.f", "1.Item.target.f"],
  ],
  [
    "projection",
    "apply",
    () => {
      const layer = Layer.mergeAll(
        EventsTable.layer({ name: "events" }),
        ReadTable.layer({ name: "read" }),
      )
      return Effect.gen(function* () {
        const events = yield* Effect.gen(function* () {
          yield* Orders.append({ orderId: "o1" }, [{ _tag: "Noted", n: 1 }], 0)
          return (yield* Orders.read({ orderId: "o1" })) as ReadonlyArray<unknown>
        }).pipe(Effect.provide(layer), Effect.provide(makeRecordingTable().layer)) as Effect.Effect<
          ReadonlyArray<unknown>
        >
        expect(events).toHaveLength(1)
        return yield* writesOf(layer, Notifying.apply(events[0]))
      })
    },
    [
      "0.TransactItems.0.Put.Item.f",
      "0.TransactItems.1.Put.Item.effect.c",
      "0.TransactItems.1.Put.Item.effect.u",
    ],
  ],
]

/**
 * Each `options.expires` written as ISO text, by where its cookie sits (the path to the cookie's
 * map), and the requests with each put back to the empty map 1.39.0 wrote.
 */
const isoExpiries = (requests: unknown) => {
  const at: Array<string> = []
  const walk = (node: unknown, path: ReadonlyArray<string>): unknown => {
    if (Array.isArray(node)) return node.map((entry, i) => walk(entry, [...path, String(i)]))
    if (typeof node !== "object" || node === null) return node
    const out: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(node)) {
      const expires = (value as { readonly S?: unknown } | undefined)?.S
      if (name === "expires" && typeof expires === "string") {
        // `<cookie>.M.options.M.expires`: the cookie is four steps up.
        at.push(
          path
            .slice(0, -3)
            .filter((step) => !["M", "L"].includes(step))
            .join("."),
        )
        expect(expires).toBe(EXPIRES)
        out[name] = { M: {} }
        continue
      }
      out[name] = walk(value, [...path, name])
    }
    return out
  }
  return { at, as139: walk(requests, []) }
}

/** A stream event's write token and timestamp: each append's own, never the same twice. */
const VOLATILE = new Set(["__edd_wt__", "timestamp"])
const steady = (node: unknown): unknown =>
  Array.isArray(node)
    ? node.map(steady)
    : typeof node === "object" && node !== null
      ? Object.fromEntries(
          Object.entries(node)
            .filter(([name]) => !VOLATILE.has(name))
            .map(([name, value]) => [name, steady(value)]),
        )
      : node

/**
 * `requests` without the read-model tag 1.41.0 writes on each outbox item (`__edd_rm__`, #237),
 * which is the projection's read model's, and how many items held it.
 */
/**
 * The requests without what 1.41.0 adds to an outbox item's `Put` (#237): the read model's tag on
 * the item, and the condition that it replaces no other read model's item. Each is checked.
 */
const untagged = (requests: unknown): { readonly tagged: number; readonly as139: unknown } => {
  let tagged = 0
  let guarded = 0
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (typeof node !== "object" || node === null) return node
    const out: Record<string, unknown> = {}
    const guard = (node as Record<string, unknown>).ConditionExpression
    const outboxGuard = guard === "attribute_not_exists(#pk) OR #rm = :rm"
    if (outboxGuard) {
      expect((node as Record<string, unknown>).ExpressionAttributeNames).toEqual({
        "#pk": "pk",
        "#rm": "__edd_rm__",
      })
      expect((node as Record<string, unknown>).ExpressionAttributeValues).toEqual({
        ":rm": { S: readModelTag(Summaries) },
      })
      guarded++
    }
    for (const [name, value] of Object.entries(node)) {
      if (name === "__edd_rm__") {
        expect(value).toEqual({ S: readModelTag(Summaries) })
        tagged++
        continue
      }
      if (
        outboxGuard &&
        (name === "ConditionExpression" ||
          name === "ExpressionAttributeNames" ||
          name === "ExpressionAttributeValues")
      ) {
        continue
      }
      out[name] = walk(value)
    }
    return out
  }
  const as139 = walk(requests)
  expect(guarded).toBe(tagged)
  return { as139, tagged }
}

describe("a cookie's expiry is written as ISO text wherever the cookie is written", () => {
  for (const [group, name, run, typed] of CASES) {
    it.effect(
      `${group} ${name}: what 1.39.0 sent, but each cookie's expiry, and each outbox item's read model and condition`,
      () =>
        Effect.gen(function* () {
          const expected = scenarioOf(group, name)
          expect(expected.outcome).toBe("ok")
          const sent = yield* run()
          const { at, as139 } = isoExpiries(sent)
          const { tagged, as139: plain } = untagged(as139)
          expect(tagged).toBe(group === "projection" ? 1 : 0)
          expect(steady(plain)).toEqual(steady(expected.requests))
          expect(at).toEqual(typed)
        }),
    )
  }
})

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const COOKIE_PROTO = Object.getPrototypeOf(dated())

/** The cookie `dated()` makes, read back: a real one, with every field and the expiry's `Date`. */
const expectDated = (value: unknown) => {
  const cookie = value as Cookies.Cookie
  expect(Object.getPrototypeOf(cookie)).toBe(COOKIE_PROTO)
  expect(Cookies.isCookie(cookie)).toBe(true)
  const { expires, maxAge, ...options } = cookie.options!
  expect(expires).toBeInstanceOf(Date)
  expect(expires!.toISOString()).toBe(EXPIRES)
  expect(Duration.toMillis(maxAge as Duration.Duration)).toBe(5000)
  expect({ ...cookie, options }).toEqual({
    name: "a",
    value: "b c",
    valueEncoded: "b%20c",
    options: { path: "/", httpOnly: true },
  })
}

const onTable = <A>(
  layer: Layer.Layer<any, any, any>,
  table: ReturnType<typeof makeRecordingTable>,
  body: Effect.Effect<A, unknown, any>,
) => body.pipe(Effect.provide(layer), Effect.provide(table.layer)) as unknown as Effect.Effect<A>

const rows = (body: (db: any) => Effect.Effect<void, unknown, any>) => {
  const table = makeRecordingTable()
  return onTable(
    RowsTable.layer({ name: "t" }),
    table,
    Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: { Rows },
        tables: { Main: RowsTable },
      } as never)
      yield* body(db)
    }),
  )
}

describe("a cookie's expiry reads back as the Date written", () => {
  it.effect("an entity's get, scan and batch get, in a field, a list, a jar and an option", () =>
    rows((db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put({
          id: "a",
          f: dated(),
          l: [plain(), dated()],
          j: jar(),
          o: Option.some(dated()),
          cu: dated(),
        }).asEffect()
        const got = yield* db.entities.Rows.get({ id: "a" })
        const [scanned] = yield* db.entities.Rows.scan().collect()
        const [batched] = yield* Batch.get([db.entities.Rows.get({ id: "a" })])
        for (const read of [got, scanned, batched]) {
          expectDated(read.f)
          expectDated(read.l[1])
          expect(read.l[0].options).toEqual({ secure: true })
          expect(Cookies.isCookies(read.j)).toBe(true)
          expectDated(read.j.cookies.a)
          expect(Option.isSome(read.o)).toBe(true)
          expectDated(read.o.value)
          expectDated(read.cu)
        }
      }),
    ),
  )

  it.effect("an entity's update set and path set", () =>
    rows((db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put({ id: "a" }).asEffect()
        yield* db.entities.Rows.update({ id: "a" }).set({ f: dated() }).asEffect()
        expectDated((yield* db.entities.Rows.get({ id: "a" })).f)
        yield* db.entities.Rows.put({ id: "b" }).asEffect()
        yield* db.entities.Rows.update({ id: "b" })
          .pathSet({ segments: ["f"], value: dated() })
          .asEffect()
        expectDated((yield* db.entities.Rows.get({ id: "b" })).f)
      }),
    ),
  )

  it.effect("a put returns the cookie it was given", () =>
    rows((db) =>
      Effect.gen(function* () {
        const cookie = dated()
        const put = yield* db.entities.Rows.put({ id: "a", f: cookie }).asEffect()
        expect(put.f).toBe(cookie)
      }),
    ),
  )

  it.effect(
    "a row 1.39.0 wrote, its expiry an empty map, reads back as the map 1.39.0 read",
    () => {
      // A cookie made of it would be written back without the expiry the row holds.
      const table = makeRecordingTable()
      const stored = scenarioOf("entity", "put").requests[0]!.Item as Record<string, AttributeValue>
      expect(stored.f).toMatchObject({ M: { options: { M: { expires: { M: {} } } } } })
      table.items.set(`${stored.pk!.S}|${stored.sk!.S}`, stored)
      return onTable(
        RowsTable.layer({ name: "t" }),
        table,
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: { Rows },
            tables: { Main: RowsTable },
          } as never)
          const got = yield* db.entities.Rows.get({ id: "a" })
          expect(Object.getPrototypeOf(got.f)).toBe(Object.prototype)
          expect(got.f).toEqual(fromAttributeValue(stored.f!))
          expect(got.f.options.expires).toEqual({})
        }),
      )
    },
  )

  it.effect("an aggregate's get, and an update that changes nothing writes nothing", () => {
    const table = makeRecordingTable()
    return onTable(
      Base.layer({ name: "t" }),
      table,
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Root },
          tables: { Main: { ...Base, aggregates: { Root } } },
        } as never)
        yield* db.aggregates.Root.create({
          id: "a",
          f: dated(),
          g: { c: dated(), at: DateTime.makeUnsafe("2025-01-01T00:00:00.000Z") },
          u: dated(),
        })
        const got = yield* db.aggregates.Root.get({ id: "a" })
        expectDated(got.f)
        expectDated(got.g.c)
        table.take()
        yield* db.aggregates.Root.update({ id: "a" }, ({ state }: any) => state)
        expect(table.requests.map(({ command }) => command)).not.toContain("TransactWriteItems")
      }),
    )
  })

  it.effect("a stream's read", () =>
    onTable(
      Base.layer({ name: "t" }),
      makeRecordingTable(),
      Effect.gen(function* () {
        yield* Tally.append({ id: "a" }, [{ _tag: "Noted", f: dated(), u: dated() }], 0)
        const [event] = yield* Tally.read({ id: "a" })
        expectDated(event.data.f)
      }),
    ),
  )

  it.effect("a ref field's target, read with the row holding it", () =>
    onTable(
      RefTable.layer({ name: "t" }),
      makeRecordingTable(),
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: { Targets, Holders },
          tables: { Main: RefTable },
        } as never)
        yield* db.entities.Targets.put({ targetId: "t1", f: dated() }).asEffect()
        yield* db.entities.Holders.put({ id: "h1", targetId: "t1" }).asEffect()
        expectDated((yield* db.entities.Holders.get({ id: "h1" })).target.f)
      }),
    ),
  )
})

describe("a check on a cookie sees the cookie written", () => {
  const withExpiry = Schema.makeFilter(
    (cookie: Cookies.Cookie) => cookie.options?.expires instanceof Date || "an expiry",
  )
  const Checked = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      f: Schema.optional(Schema.Cookie.check(withExpiry)),
    }),
    entityType: "Checked",
    primaryKey: key("id"),
  } as never) as any
  const CheckedTable = Table.make({ schema, entities: { Checked } } as never) as any

  it.effect("a put, an update set and a path set", () =>
    onTable(
      CheckedTable.layer({ name: "t" }),
      makeRecordingTable(),
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: { Checked },
          tables: { Main: CheckedTable },
        } as never)
        yield* db.entities.Checked.put({ id: "a", f: dated() }).asEffect()
        yield* db.entities.Checked.update({ id: "a" }).set({ f: dated() }).asEffect()
        yield* db.entities.Checked.update({ id: "a" })
          .pathSet({ segments: ["f"], value: dated() })
          .asEffect()
        expectDated((yield* db.entities.Checked.get({ id: "a" })).f)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// What the marshaller does, and doesn't
// ---------------------------------------------------------------------------

const ISO = { S: EXPIRES }
const expiryIn = (attribute: AttributeValue | undefined) => attribute?.M?.options?.M?.expires

describe("the marshaller gives one of Effect's cookies its expiry, and changes nothing else", () => {
  it("as a field, in a list, a map, a `Map`, a jar and a class of one's own", () => {
    class Session {
      constructor(readonly cookie: Cookies.Cookie) {}
    }
    const stored = toAttributeMap({
      f: dated(),
      l: [plain(), dated()],
      m: { k: dated() },
      map: new Map([["k", dated()]]),
      j: jar(),
      s: new Session(dated()),
    })
    expect(expiryIn(stored.f)).toEqual(ISO)
    expect(expiryIn(stored.l!.L![1])).toEqual(ISO)
    expect(expiryIn(stored.m!.M!.k)).toEqual(ISO)
    expect(expiryIn(stored.map!.M!.k)).toEqual(ISO)
    expect(expiryIn(stored.j!.M!.cookies!.M!.a)).toEqual(ISO)
    expect(expiryIn(stored.s!.M!.cookie)).toEqual(ISO)
    expect(toAttributeValue(dated()).M!.options!.M!.expires).toEqual(ISO)
  })

  it("everything but the expiry is what marshalling made, options a prototype gives included", () => {
    // Options inheriting one: the marshaller stores a prototype's enumerable properties.
    const options = Object.assign(Object.create({ sameSite: "lax" }), {
      path: "/",
      expires: new Date(EXPIRES),
    })
    const cookie = Object.assign(Object.create(COOKIE_PROTO), dated(), { options })
    const stored = toAttributeValue(cookie)
    expect(stored.M!.options!.M).toEqual({
      path: { S: "/" },
      expires: ISO,
      sameSite: { S: "lax" },
    })
    // The same bytes as a cookie with no expiry, but for the expiry.
    delete options.expires
    const undated = toAttributeValue(cookie)
    expect({ ...stored.M!.options!.M, expires: undefined }).toEqual({
      ...undated.M!.options!.M,
      expires: undefined,
    })
    expect({ ...stored.M, options: undefined }).toEqual({ ...undated.M, options: undefined })
  })

  it("an expiry the options inherit is written too", () => {
    const options = Object.create({ expires: new Date(EXPIRES) })
    const cookie = Object.assign(Object.create(COOKIE_PROTO), dated(), { options })
    expect(expiryIn(toAttributeValue(cookie))).toEqual(ISO)
  })

  it("positions after an element a list leaves out", () => {
    const stored = toAttributeMap({ l: [undefined, plain(), undefined, dated(), dated()] })
    expect(stored.l!.L).toHaveLength(3)
    expect(expiryIn(stored.l!.L![1])).toEqual(ISO)
    expect(expiryIn(stored.l!.L![2])).toEqual(ISO)
  })

  it("a map shaped like a cookie, an invalid date and no expiry are left as marshalled", () => {
    const lookalike = { ...dated(), "~effect/http/Cookies/Cookie": "~effect/http/Cookies/Cookie" }
    expect(expiryIn(toAttributeValue(lookalike))).toEqual({ M: {} })
    const invalid = Cookies.makeCookieUnsafe("a", "b", { expires: new Date(Number.NaN) })
    expect(expiryIn(toAttributeValue(invalid))).toEqual({ M: {} })
    expect(toAttributeValue(plain()).M!.options!.M).toEqual({ secure: { BOOL: true } })
    // A row 1.39.0 wrote, read into an untyped field and written again, stays as it was.
    const from139 = fromAttributeValue(toAttributeValue(lookalike)) as object
    expect(expiryIn(toAttributeValue(from139))).toEqual({ M: {} })
  })

  it("calls no getter: each is read once, by marshalling, and a cookie behind one isn't dated", () => {
    let reads = 0
    const item = {
      get n() {
        return ++reads
      },
      f: dated(),
      get hidden() {
        reads++
        return dated()
      },
    }
    const stored = toAttributeMap(item)
    expect(reads).toBe(2)
    expect(stored.n).toEqual({ N: "1" })
    expect(expiryIn(stored.f)).toEqual(ISO)
    expect(expiryIn(stored.hidden)).toEqual({ M: {} })
  })

  it("an item with an empty set to leave out, and one holding a cached decimal", () => {
    expect(expiryIn(toAttributeMap({ f: dated(), tags: new Set<string>() }).f)).toEqual(ISO)
    const decimal = BigDecimal.fromStringUnsafe("1.50")
    Hash.hash(decimal)
    expect(expiryIn(toAttributeMap({ f: dated(), d: decimal }).f)).toEqual(ISO)
  })
})

describe("a cookie where the schema doesn't type one", () => {
  it.effect("an `Unknown` field reads back the map stored, its expiry the ISO text", () =>
    rows((db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put({ id: "a", u: dated() }).asEffect()
        const got = yield* db.entities.Rows.get({ id: "a" })
        expect(Object.getPrototypeOf(got.u)).toBe(Object.prototype)
        expect(got.u.options.expires).toBe(EXPIRES)
      }),
    ),
  )

  it.effect(
    "a declaration of one's own holding a cookie is handed that text when it's read",
    () => {
      class Session {
        constructor(readonly cookie: Cookies.Cookie) {}
      }
      const seen: Array<unknown> = []
      const SessionSchema = Schema.declare((u: unknown): u is Session => {
        seen.push((u as Session | undefined)?.cookie?.options?.expires)
        return typeof u === "object" && u !== null && "cookie" in u
      })
      const Sessions = Entity.make({
        model: Schema.Struct({ id: Schema.String, s: SessionSchema }),
        entityType: "Session",
        primaryKey: key("id"),
      } as never) as any
      const SessionsTable = Table.make({ schema, entities: { Sessions } } as never) as any
      const table = makeRecordingTable()
      return onTable(
        SessionsTable.layer({ name: "t" }),
        table,
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: { Sessions },
            tables: { Main: SessionsTable },
          } as never)
          yield* db.entities.Sessions.put({ id: "a", s: new Session(dated()) }).asEffect()
          expect(expiryIn([...table.items.values()][0]!.s!.M!.cookie)).toEqual(ISO)
          seen.length = 0
          const got = yield* db.entities.Sessions.get({ id: "a" })
          expect(seen).toEqual([EXPIRES])
          expect(got.s.cookie.options.expires).toBe(EXPIRES)
        }),
      )
    },
  )
})

describe("a condition on a cookie", () => {
  const conditioned = (db: any) =>
    db.entities.Rows.update({ id: "a" })
      .set({ l: [] })
      .condition((t: any, { eq }: any) => eq(t.f, dated()))
      .asEffect()

  it.effect("matches the row holding that cookie", () =>
    rows((db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put({ id: "a", f: dated() }).asEffect()
        yield* conditioned(db)
      }),
    ),
  )

  it.effect("doesn't match a row 1.39.0 wrote, whose expiry was lost", () => {
    // 1.39.0 sent the operand without its expiry too, so its condition matched such a row
    // whatever the cookie's date had been.
    const table = makeRecordingTable()
    const stored = scenarioOf("entity", "put").requests[0]!.Item as Record<string, AttributeValue>
    expect(expiryIn(stored.f)).toEqual({ M: {} })
    table.items.set(`${stored.pk!.S}|${stored.sk!.S}`, stored)
    const operand139 = scenarioOf("entity", "conditionedPut").requests[0]!
      .ExpressionAttributeValues as Record<string, AttributeValue>
    expect(expiryIn(operand139[":e1"])).toEqual({ M: {} })
    return onTable(
      RowsTable.layer({ name: "t" }),
      table,
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: { Rows },
          tables: { Main: RowsTable },
        } as never)
        const refused = yield* Effect.flip(conditioned(db))
        expect((refused as { readonly _tag: string })._tag).toBe("ConditionalCheckFailed")
      }),
    )
  })
})

describe("an aggregate holding a cookie runs its other fields' checks as often as one that doesn't", () => {
  const counted = () => {
    const calls = { count: 0 }
    const check = Schema.makeFilter(() => {
      calls.count++
      return true
    })
    return { calls, check }
  }
  const runsOf = (withCookie: boolean) => {
    const { calls, check } = counted()
    const Plain = Table.make({ schema, entities: {} } as never) as any
    const Counted = Aggregate.make(
      Schema.Struct({
        id: Schema.String,
        n: Schema.Number.check(check),
        ...(withCookie ? { f: Schema.Cookie } : {}),
      }),
      {
        table: Plain,
        schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "counted" },
        root: { entityType: "Counted" },
        edges: {},
      } as never,
    ) as any
    return onTable(
      Plain.layer({ name: "t" }),
      makeRecordingTable(),
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Counted },
          tables: { Main: { ...Plain, aggregates: { Counted } } },
        } as never)
        const runs: Array<number> = []
        const step = () => {
          runs.push(calls.count)
          calls.count = 0
        }
        yield* db.aggregates.Counted.create({
          id: "a",
          n: 1,
          ...(withCookie ? { f: dated() } : {}),
        })
        step()
        yield* db.aggregates.Counted.get({ id: "a" })
        step()
        yield* db.aggregates.Counted.update({ id: "a" }, ({ state }: any) => ({ ...state, n: 2 }))
        step()
        return runs
      }),
    )
  }

  it.effect("on create, get and update", () =>
    Effect.gen(function* () {
      const without = yield* runsOf(false)
      expect(without.every((count) => count > 0)).toBe(true)
      expect(yield* runsOf(true)).toEqual(without)
    }),
  )
})
