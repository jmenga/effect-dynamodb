/**
 * Where an operand is put in the form the attribute holds, and where it's sent as 1.40.0 sent it
 * (#242, the path encoder's `operand`). The stored form is used only where the schema alone
 * determines it: every way a row can hold the compared path that takes the value stores it the
 * same. A union whose members store the path differently, an `Unknown` or `Any`, a suspended
 * schema, a declaration the walk doesn't follow, or a record of such: the operand is sent as
 * given. `contains` compares an element of what the field stores: a list's element, a set's
 * member, a substring of text. A `Date` operand is put in the form the field stores a date. And
 * every operand position goes through it: a bound query's filter, a condition, a transaction's,
 * `Entity.filter`, `Query.filterExpr` on an entity's query, a vector search's filters and an
 * aggregate `list` filter. DynamoDB's own verdicts: `connected.operands-as-stored.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import { DateTime, Duration, Effect, Layer, Redacted, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { createConditionOps } from "../src/internal/Expr.js"
import { createPathBuilder } from "../src/internal/PathBuilder.js"
import { toAttributeValue } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"
import { makeRecordingTable, type Request } from "./helpers/RecordingTable.js"

const schema = DynamoSchema.make({ name: "osf", version: 1 })
const KEY = "$osf#v1#e#id_a|$osf#v1#e"
const json = (value: unknown) => JSON.stringify(value)
const utc = () => DateTime.makeUnsafe(1000)
const ISO = { S: "1970-01-01T00:00:01.000Z" }

const entityOf = (f: Schema.Top) =>
  Entity.make({
    model: Schema.Struct({ id: Schema.String, n: Schema.optional(Schema.Number), f }),
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never) as any

const run = <A>(
  entities: Record<string, unknown>,
  table: ReturnType<typeof makeRecordingTable>,
  body: (db: any) => Effect.Effect<A, unknown, unknown>,
  aggregates: Record<string, unknown> = {},
  Main: any = Table.make({ schema, entities } as never),
) =>
  Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities, aggregates, tables: { Main } } as never)
    return yield* body(db)
  }).pipe(
    Effect.provide(Main.layer({ name: "osf" })),
    Effect.provide(table.layer),
  ) as Effect.Effect<A, unknown>

/** The values a request's condition or filter compares with, but the ownership clause's. */
const operandsOf = (input: Request["input"] | undefined): ReadonlyArray<string> => {
  const expression = `${input?.ConditionExpression ?? ""} ${input?.FilterExpression ?? ""}`
  return Object.entries(input?.ExpressionAttributeValues ?? {})
    .filter(
      ([placeholder]) =>
        !placeholder.startsWith(":et") && new RegExp(`${placeholder}\\b`).test(expression),
    )
    .map(([, value]) => json(value))
}

/**
 * A scan filter, an update's condition and a transaction's, each with what it sent. `requestsOnly`
 * where the in-memory table can't evaluate the expression (a list index, `contains` on a set):
 * DynamoDB's verdicts are the connected suite's.
 */
const everyPosition = (
  db: any,
  table: ReturnType<typeof makeRecordingTable>,
  condition: (t: any, ops: any) => unknown,
  requestsOnly = false,
) =>
  Effect.gen(function* () {
    const settle = <A>(effect: Effect.Effect<A, unknown>) =>
      requestsOnly ? Effect.exit(effect) : effect
    table.take()
    const collected = yield* settle(db.entities.E.scan().filter(condition).collect())
    const found = Array.isArray(collected) ? collected.length : undefined
    const scanned = table.take()[0]?.input
    yield* settle(db.entities.E.update({ id: "a" }).set({ n: 1 }).condition(condition).asEffect())
    const updated = table.take().find((sent) => sent.command === "UpdateItem")?.input
    yield* settle(
      Transaction.transactWrite([
        db.entities.E.update({ id: "a" }).set({ n: 2 }).condition(condition),
      ]),
    )
    const txn = table.take().find((sent) => sent.command === "TransactWriteItems")
    const inTxn = (txn?.input as any)?.TransactItems?.[0]?.Update
    return { found, sent: [operandsOf(scanned), operandsOf(updated), operandsOf(inTxn)] }
  })

describe("a path whose stored form the schema doesn't determine is sent as 1.40.0 sent it", () => {
  const cases: ReadonlyArray<{
    readonly name: string
    readonly f: Schema.Top
    readonly value: () => unknown
    readonly operand: () => unknown
    readonly path: (t: any) => unknown
    /** The in-memory table can't evaluate a list index: the requests alone are judged. */
    readonly requestsOnly?: boolean
  }> = [
    {
      name: "a union whose members store the path differently (DurationFromMillis, Duration)",
      f: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("encoded"), when: Schema.DurationFromMillis }),
        Schema.Struct({ kind: Schema.Literal("raw"), when: Schema.Duration }),
      ]),
      value: () => ({ kind: "raw", when: Duration.millis(1) }),
      operand: () => Duration.millis(1),
      path: (t) => t.f.when,
    },
    {
      name: "a union whose other member is untyped there (DateTimeUtc, Unknown)",
      f: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("encoded"), when: Schema.DateTimeUtc }),
        Schema.Struct({ kind: Schema.Literal("raw"), when: Schema.Unknown }),
      ]),
      value: () => ({ kind: "raw", when: utc() }),
      operand: utc,
      path: (t) => t.f.when,
    },
    {
      name: "a list of such a union",
      f: Schema.Array(
        Schema.Union([
          Schema.Struct({ kind: Schema.Literal("encoded"), when: Schema.DurationFromMillis }),
          Schema.Struct({ kind: Schema.Literal("raw"), when: Schema.Duration }),
        ]),
      ),
      value: () => [{ kind: "raw", when: Duration.millis(1) }],
      operand: () => Duration.millis(1),
      path: (t) => t.f.at(0).when,
      requestsOnly: true,
    },
    {
      name: "a record of an untyped value",
      f: Schema.Record(Schema.String, Schema.Unknown),
      value: () => ({ k: utc() }),
      operand: utc,
      path: (t) => t.f.k,
    },
  ]
  for (const c of cases) {
    it.effect(c.name, () =>
      Effect.gen(function* () {
        const E = entityOf(c.f)
        const table = makeRecordingTable()
        const given = json(toAttributeValue(c.operand()))
        yield* run({ E }, table, (db) =>
          Effect.gen(function* () {
            yield* db.entities.E.put({ id: "a", f: c.value() }).asEffect()
            const { found, sent } = yield* everyPosition(
              db,
              table,
              (t, { eq }) => eq(c.path(t), c.operand()),
              c.requestsOnly,
            )
            if (c.requestsOnly !== true) expect(found).toBe(1)
            for (const values of sent) expect(values).toEqual([given])
          }),
        )
      }),
    )
  }

  it.effect("a suspended schema on the path", () =>
    Effect.gen(function* () {
      const Inner = Schema.Struct({ when: Schema.DateTimeUtc })
      const E = entityOf(Schema.suspend((): Schema.Codec<any, any> => Inner))
      const table = makeRecordingTable()
      yield* run({ E }, table, (db) =>
        Effect.gen(function* () {
          yield* db.entities.E.scan()
            .filter((t: any, { eq }: any) => eq(t.f.when, utc()))
            .collect()
          expect(operandsOf(table.take()[0]?.input)).toEqual([json(toAttributeValue(utc()))])
        }),
      )
    }),
  )
})

describe("a path every way of reaching stores alike is put in the stored form", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly f: Schema.Top }> = [
    {
      name: "a union whose members both store a DateTimeUtc there",
      f: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a"), when: Schema.DateTimeUtc }),
        Schema.Struct({ kind: Schema.Literal("b"), when: Schema.DateTimeUtc }),
      ]),
    },
    {
      name: "a union whose other member can't hold a date there",
      f: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a"), when: Schema.DateTimeUtc }),
        Schema.Struct({ kind: Schema.Literal("b"), when: Schema.Number }),
      ]),
    },
    {
      name: "a union whose other member has no such field",
      f: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a"), when: Schema.DateTimeUtc }),
        Schema.Struct({ kind: Schema.Literal("b") }),
      ]),
    },
    {
      name: "a nullable struct",
      f: Schema.NullOr(Schema.Struct({ kind: Schema.Literal("a"), when: Schema.DateTimeUtc })),
    },
  ]
  for (const c of cases) {
    it.effect(c.name, () =>
      Effect.gen(function* () {
        const E = entityOf(c.f)
        const table = makeRecordingTable()
        yield* run({ E }, table, (db) =>
          Effect.gen(function* () {
            yield* db.entities.E.put({ id: "a", f: { kind: "a", when: utc() } }).asEffect()
            expect(json(table.items.get(KEY)!.f)).toContain(json(ISO))
            const { found, sent } = yield* everyPosition(db, table, (t, { eq }) =>
              eq(t.f.when, utc()),
            )
            expect(found).toBe(1)
            for (const values of sent) expect(values).toEqual([json(ISO)])
          }),
        )
      }),
    )
  }
})

describe("contains compares an element of what the field stores", () => {
  const cases: ReadonlyArray<{
    readonly name: string
    readonly f: Schema.Top
    readonly value: unknown
    readonly operand: unknown
    readonly sent: unknown
  }> = [
    {
      name: "a set's member (NS)",
      f: Schema.ReadonlySet(Schema.DurationFromMillis),
      value: new Set([Duration.millis(1500)]),
      operand: Duration.millis(1500),
      sent: { N: "1500" },
    },
    {
      name: "a set's member (SS)",
      f: Schema.ReadonlySet(Schema.RedactedFromValue(Schema.String)),
      value: new Set([Redacted.make("x")]),
      operand: Redacted.make("x"),
      sent: { S: "x" },
    },
    {
      name: "a list's element",
      f: Schema.Array(Schema.DateTimeUtc),
      value: [utc()],
      operand: utc(),
      sent: ISO,
    },
    {
      name: "a substring of text",
      f: Schema.Redacted(Schema.String),
      value: Redacted.make("hello"),
      operand: Redacted.make("ell"),
      sent: { S: "ell" },
    },
  ]
  for (const c of cases) {
    it.effect(c.name, () =>
      Effect.gen(function* () {
        const E = entityOf(c.f)
        const table = makeRecordingTable()
        yield* run({ E }, table, (db) =>
          Effect.gen(function* () {
            yield* db.entities.E.put({ id: "a", f: c.value }).asEffect()
            const { sent } = yield* everyPosition(
              db,
              table,
              (t, { contains }) => contains(t.f, c.operand),
              true,
            )
            for (const values of sent) expect(values).toEqual([json(c.sent)])
          }),
        )
      }),
    )
  }

  it.effect("a set of instances whose map is what it stores is sent as 1.40.0 sent it", () =>
    Effect.gen(function* () {
      const E = entityOf(Schema.Array(Schema.Duration))
      const table = makeRecordingTable()
      yield* run({ E }, table, (db) =>
        Effect.gen(function* () {
          yield* db.entities.E.scan()
            .filter((t: any, { contains }: any) => contains(t.f, Duration.millis(1)))
            .collect()
          expect(operandsOf(table.take()[0]?.input)).toEqual([
            json(toAttributeValue(Duration.millis(1))),
          ])
        }),
      )
    }),
  )
})

describe("a Date operand is put in the form the field stores a date", () => {
  const cases: ReadonlyArray<{
    readonly name: string
    readonly f: Schema.Top
    readonly sent: unknown
  }> = [
    { name: "Schema.Date, as ISO text", f: Schema.Date, sent: ISO },
    {
      name: "Schema.Date stored as epoch milliseconds",
      f: Schema.Date.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
      sent: { N: "1000" },
    },
  ]
  for (const c of cases) {
    it.effect(c.name, () =>
      Effect.gen(function* () {
        const E = entityOf(c.f)
        const table = makeRecordingTable()
        yield* run({ E }, table, (db) =>
          Effect.gen(function* () {
            yield* db.entities.E.put({ id: "a", f: new Date(1000) }).asEffect()
            expect(json(table.items.get(KEY)!.f)).toBe(json(c.sent))
            const { found, sent } = yield* everyPosition(db, table, (t, { eq }) =>
              eq(t.f, new Date(1000)),
            )
            expect(found).toBe(1)
            for (const values of sent) expect(values).toEqual([json(c.sent)])
          }),
        )
      }),
    )
  }
})

describe("every operand position puts it so", () => {
  it.effect("Query.filterExpr on an entity's query, and Entity.filter", () =>
    Effect.gen(function* () {
      const E = entityOf(Schema.DateTimeUtc)
      const table = makeRecordingTable()
      const t = createPathBuilder<any>()
      const { eq } = createConditionOps<any>()
      yield* run({ E }, table, (db) =>
        Effect.gen(function* () {
          yield* db.entities.E.put({ id: "a", f: utc() }).asEffect()
          table.take()
          const byExpr = yield* Query.collect(Query.filterExpr(E.scan(), eq(t.f, utc())))
          expect(operandsOf(table.take()[0]?.input)).toEqual([json(ISO)])
          const byFilter = yield* Query.collect(
            E.scan().pipe(E.filter((p: any, ops: any) => ops.eq(p.f, utc()))),
          )
          expect(operandsOf(table.take()[0]?.input)).toEqual([json(ISO)])
          expect([byExpr.length, byFilter.length]).toEqual([1, 1])
        }).pipe(Effect.provide(Layer.empty)),
      )
    }),
  )

  it.effect("a vector search's equality filter", () =>
    Effect.gen(function* () {
      const E = Entity.make({
        model: Schema.Struct({
          id: Schema.String,
          text: Schema.String,
          span: Schema.DurationFromMillis,
        }),
        entityType: "E",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
        vectorIndexes: {
          byText: {
            name: "vec1",
            dimensions: 2,
            distance: "cosine",
            source: { fields: ["text"] },
            filters: ["span"],
          },
        },
      })
      const Main = Table.make({ schema, entities: { E } })
      const searched: Array<any> = []
      yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { E }, tables: { Main } })
        yield* db.entities.E.byText([1, 0])
          .filter({ span: Duration.millis(1500) })
          .collect()
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            mockDynamoClientLayer({
              searchVectors: (input) => {
                searched.push(input)
                return Effect.succeed({ Items: [] } as never)
              },
            }),
            Main.layer({ name: "osf" }),
            Layer.succeed(Embedder, { dimensions: 2, embed: () => Effect.succeed([1, 0]) }),
          ),
        ),
      )
      expect(json(searched[0]?.ExpressionAttributeValues?.[":vf0"])).toBe(json({ N: "1500" }))
    }),
  )

  it.effect("an aggregate list filter's contains", () =>
    Effect.gen(function* () {
      const Root = Schema.Struct({
        id: Schema.String,
        tournament: Schema.String,
        spans: Schema.ReadonlySet(Schema.DurationFromMillis),
      })
      const Anchors = Entity.make({
        model: Schema.Struct({ anchorId: Schema.String }),
        entityType: "Anchor",
        primaryKey: {
          pk: { field: "pk", composite: ["anchorId"] },
          sk: { field: "sk", composite: [] },
        },
      })
      const Main = Table.make({ schema, entities: { Anchors } })
      const Matches = Aggregate.make(Root, {
        table: Main,
        schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "match" },
        list: {
          index: "gsi1",
          name: "matchlist",
          pk: { field: "gsi1pk", composite: ["tournament"] },
          sk: { field: "gsi1sk", composite: ["id"] },
        },
        root: { entityType: "MatchItem" },
        edges: {},
      } as never) as any
      const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
      yield* run(
        { Anchors },
        table,
        (db) =>
          Effect.gen(function* () {
            yield* db.aggregates.Matches.create({
              id: "m",
              tournament: "t",
              spans: new Set([Duration.millis(1500)]),
            })
            table.take()
            yield* db.aggregates.Matches.list(
              { tournament: "t" },
              {
                filter: (t: any, { contains }: any) => contains(t.spans, Duration.millis(1500)),
              },
            )
            const request = table.take().find((sent) => sent.input.FilterExpression !== undefined)
            expect(operandsOf(request?.input)).toContain(json({ N: "1500" }))
          }),
        { Matches },
        Main,
      )
    }),
  )
})
