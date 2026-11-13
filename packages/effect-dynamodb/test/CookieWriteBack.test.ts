/**
 * A stored cookie reads back as one of Effect's cookies only where writing that cookie stores what
 * was read; elsewhere it's the map 1.39.0 read. The rows are the ones published 1.39.0 wrote, and
 * what 1.39.0 did writing back what it read is pinned beside them
 * (`fixtures/cookie-writeback-1.39.0.json`): every write here stores what 1.39.0 stored.
 *
 * Three kinds of row would not write back as a cookie: one whose expiry 1.39.0 stored as an empty
 * map (a cookie's `Date` would be written as ISO text, or not at all), one holding properties of
 * its own inside it (a `maxAge` given more than a `Duration` holds, a jar's cookie given more than a
 * cookie holds), and a jar whose record isn't keyed by each cookie's name.
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Duration, Effect, Equal, Exit, Layer, Schema } from "effect"
import * as Cookies from "effect/http/Cookies"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Item = Record<string, AttributeValue>
type Op = {
  readonly outcome: string
  readonly f: AttributeValue
  readonly n: AttributeValue | null
}
type EntityCase = {
  readonly row: Item
  readonly readAs: "map" | "instance"
  readonly ops: Record<string, Op>
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/cookie-writeback-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly expires: string
  readonly entity: Record<string, EntityCase>
  readonly aggregate: {
    readonly rows: ReadonlyArray<Item>
    readonly readAs: Record<"root" | "one" | "line", string>
    readonly ops: Record<string, { readonly outcome: string; readonly f: Record<string, unknown> }>
  }
}

const schema = DynamoSchema.make({ name: "look", version: 1 })
const key = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }
const FIELDS = { cookie: Schema.Cookie, jar: Schema.Cookies, list: Schema.Array(Schema.Cookie) }
const COOKIE_PROTO = Object.getPrototypeOf(Cookies.makeCookieUnsafe("a", "b"))

/** The one row whose cookie writes back what's stored, and so reads back as a cookie now. */
const READ_AS_COOKIE = new Set(["cookie.plain"])

const seededTable = (rows: ReadonlyArray<Item>) => {
  const table = makeRecordingTable()
  for (const row of rows) table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row))
  return table
}

const onEntity = <A>(
  name: string,
  options: { readonly immutable: boolean },
  body: (db: any, table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, unknown, any>,
) => {
  const kind = name.split(".")[0] as keyof typeof FIELDS
  const base = Schema.Struct({
    id: Schema.String,
    f: FIELDS[kind] as Schema.Top,
    n: Schema.optional(Schema.Number),
  })
  const model = options.immutable
    ? DynamoModel.configure(base, { f: { immutable: true } } as never)
    : base
  const Rows = Entity.make({ model, entityType: "Row", primaryKey: key } as never) as any
  const Main = Table.make({ schema, entities: { Rows } } as never) as any
  const table = seededTable([fixture.entity[name]!.row])
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({ entities: { Rows }, tables: { Main } } as never)
    return yield* body(db, table)
  }).pipe(
    Effect.provide(Layer.merge(table.layer, Main.layer({ name: "t" }) as Layer.Layer<never>)),
  ) as Effect.Effect<A, unknown>
}

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "ok"
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail") as
    | { readonly error: { readonly _tag: string; readonly message?: string } }
    | undefined
  return error === undefined
    ? "defect"
    : `${error.error._tag}: ${String(error.error.message ?? "").slice(0, 160)}`
}

const storedRow = (table: ReturnType<typeof makeRecordingTable>, row: Item) =>
  table.items.get(`${row.pk!.S}|${row.sk!.S}`)!

/**
 * The writes of what was read. `immutableSetBack` restates an immutable field: its request carries
 * the stored value as a condition's operand, which the recording table compares with the row by
 * content, as DynamoDB does (#243).
 */
const OPS: Record<
  string,
  {
    readonly immutable: boolean
    readonly run: (db: any, got: any) => Effect.Effect<unknown, unknown>
  }
> = {
  putBack: { immutable: false, run: (db, got) => db.entities.Rows.put(got).asEffect() },
  setBack: {
    immutable: false,
    run: (db, got) => db.entities.Rows.update({ id: got.id }).set({ f: got.f, n: 2 }).asEffect(),
  },
  unrelated: {
    immutable: false,
    run: (db, got) => db.entities.Rows.update({ id: got.id }).set({ n: 1 }).asEffect(),
  },
  immutableSetBack: {
    immutable: true,
    run: (db, got) => db.entities.Rows.update({ id: got.id }).set({ f: got.f, n: 2 }).asEffect(),
  },
}

const firstOf = (value: unknown) => (Array.isArray(value) ? value[0] : value)

describe("a cookie 1.39.0 stored reads back as 1.39.0 read it, unless it writes back as stored", () => {
  for (const name of Object.keys(fixture.entity)) {
    it.effect(`${name}: read`, () =>
      onEntity(name, { immutable: false }, (db) =>
        Effect.gen(function* () {
          const pinned = fixture.entity[name]!
          expect(pinned.readAs).toBe("map")
          const got = yield* db.entities.Rows.get({ id: pinned.row.id!.S })
          const value = firstOf(got.f)
          if (READ_AS_COOKIE.has(name)) {
            expect(Object.getPrototypeOf(value)).toBe(COOKIE_PROTO)
            expect(Duration.isDuration(value.options.maxAge)).toBe(true)
            expect(Equal.equals(value.options.maxAge, Duration.seconds(5))).toBe(true)
          } else {
            expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
          }
        }),
      ),
    )
  }
})

describe("a value read from a cookie 1.39.0 stored is written back as 1.39.0 wrote it", () => {
  for (const name of Object.keys(fixture.entity)) {
    for (const [op, { immutable, run }] of Object.entries(OPS)) {
      it.effect(`${name}: ${op}`, () =>
        onEntity(name, { immutable }, (db, table) =>
          Effect.gen(function* () {
            const pinned = fixture.entity[name]!
            const got = yield* db.entities.Rows.get({ id: pinned.row.id!.S })
            table.take()
            const exit = yield* Effect.exit(run(db, got))
            const expected = pinned.ops[op]!
            if (op === "immutableSetBack") {
              // The condition restating the immutable field names the value stored.
              const sent = table.requests.find(({ command }) => command === "UpdateItem")!
              expect(Object.values(sent.input.ExpressionAttributeValues as Item)).toContainEqual(
                pinned.row.f,
              )
            }
            expect(outcomeOf(exit)).toBe(expected.outcome)
            const after = storedRow(table, pinned.row)
            expect(after.f).toEqual(expected.f)
            expect(after.f).toEqual(pinned.row.f)
            expect(after.n ?? null).toEqual(expected.n)
          }),
        ),
      )
    }

    it.effect(`${name}: a condition on what was read names what's stored`, () =>
      onEntity(name, { immutable: false }, (db, table) =>
        Effect.gen(function* () {
          // 1.39.0's condition matched the row (`conditionBack`): the recording table compares the
          // operand with the stored map by content, as DynamoDB does (#243).
          const pinned = fixture.entity[name]!
          const expected = pinned.ops.conditionBack!
          expect(expected.outcome).toBe("ok")
          const got = yield* db.entities.Rows.get({ id: pinned.row.id!.S })
          table.take()
          const exit = yield* Effect.exit(
            db.entities.Rows.update({ id: got.id })
              .set({ n: 1 })
              .condition({ f: got.f })
              .asEffect(),
          )
          const sent = table.requests.find(({ command }) => command === "UpdateItem")!
          const operands = Object.values(sent.input.ExpressionAttributeValues as Item)
          expect(operands).toContainEqual(pinned.row.f)
          expect(outcomeOf(exit)).toBe(expected.outcome)
          const after = storedRow(table, pinned.row)
          expect(after.f).toEqual(expected.f)
          expect(after.n ?? null).toEqual(expected.n)
        }),
      ),
    )
  }
})

describe("an aggregate's cookies 1.39.0 stored are written back as 1.39.0 wrote them", () => {
  const line = Schema.Struct({
    lid: Schema.String,
    f: Schema.Cookie,
    note: Schema.optional(Schema.String),
  })
  const Base = Table.make({ schema, entities: {} } as never) as any
  const Root = Aggregate.make(
    Schema.Struct({
      id: Schema.String,
      f: Schema.Cookie,
      note: Schema.optional(Schema.String),
      one: Schema.Struct({ f: Schema.Cookie, note: Schema.optional(Schema.String) }),
      lines: Schema.Array(line),
    }),
    {
      table: Base,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "root" },
      root: { entityType: "Root" },
      edges: {
        one: Aggregate.one({ entityType: "One" } as never),
        lines: Aggregate.many({ entityType: "Line", sk: { composite: ["lid"] } } as never),
      },
    } as never,
  ) as any
  const onAggregate = <A>(
    body: (
      agg: any,
      table: ReturnType<typeof makeRecordingTable>,
    ) => Effect.Effect<A, unknown, any>,
  ) => {
    const table = seededTable(fixture.aggregate.rows)
    return Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: {},
        aggregates: { Root },
        tables: { Main: { ...Base, aggregates: { Root } } },
      } as never)
      return yield* body(db.aggregates.Root, table)
    }).pipe(
      Effect.provide(Layer.merge(table.layer, Base.layer({ name: "t" }) as Layer.Layer<never>)),
    ) as Effect.Effect<A, unknown>
  }
  const MUTATIONS: Record<string, (state: any) => any> = {
    noop: (state) => state,
    rootNote: (state) => ({ ...state, note: "changed" }),
    oneNote: (state) => ({ ...state, one: { ...state.one, note: "n" } }),
    lineNote: (state) => ({
      ...state,
      lines: state.lines.map((l: any) => (l.lid === "x" ? { ...l, note: "n" } : l)),
    }),
  }
  const cookiesOf = (rows: Iterable<Item>) =>
    Object.fromEntries([...rows].map((row) => [`${row.__edd_e__!.S}|${row.sk!.S}`, row.f]))

  it.effect("read", () =>
    onAggregate((agg) =>
      Effect.gen(function* () {
        expect(fixture.aggregate.readAs).toEqual({ root: "map", one: "map", line: "map" })
        const got = yield* agg.get({ id: "a" })
        for (const value of [got.f, got.one.f, ...got.lines.map((l: any) => l.f)]) {
          expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
        }
      }),
    ),
  )

  for (const [op, mutate] of Object.entries(MUTATIONS)) {
    it.effect(op, () =>
      onAggregate((agg, table) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            agg.update({ id: "a" }, ({ state }: any) => mutate(state)),
          )
          const expected = fixture.aggregate.ops[op]!
          expect(outcomeOf(exit)).toBe(expected.outcome)
          expect(cookiesOf(table.items.values())).toEqual(expected.f)
          expect(cookiesOf(table.items.values())).toEqual(cookiesOf(fixture.aggregate.rows))
        }),
      ),
    )
  }
})

describe("a cookie this release writes reads back as a cookie, and writes back as stored", () => {
  const expiring = () =>
    Cookies.makeCookieUnsafe("a", "b c", { path: "/", expires: new Date(fixture.expires) })
  const VALUES: Record<string, () => unknown> = {
    "cookie.expiry": expiring,
    "jar.expiry": () => Cookies.fromIterable([expiring()]),
    "list.expiry": () => [expiring()],
  }
  for (const [name, make] of Object.entries(VALUES)) {
    for (const [op, { immutable, run }] of Object.entries(OPS)) {
      it.effect(`${name}: ${op}`, () =>
        onEntity(name, { immutable }, (db, table) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "fresh", f: make() }).asEffect()
            const written = structuredClone(
              [...table.items.values()].find((row) => row.id?.S === "fresh")!,
            )
            expect(JSON.stringify(written.f)).toContain(`"expires":{"S":"${fixture.expires}"}`)
            const got = yield* db.entities.Rows.get({ id: "fresh" })
            const value = name === "jar.expiry" ? got.f.cookies.a : firstOf(got.f)
            expect(Object.getPrototypeOf(value)).toBe(COOKIE_PROTO)
            expect(value.options.expires).toEqual(new Date(fixture.expires))
            expect(outcomeOf(yield* Effect.exit(run(db, got)))).toBe("ok")
            expect(storedRow(table, written).f).toEqual(written.f)
          }),
        ),
      )
    }
  }
})
