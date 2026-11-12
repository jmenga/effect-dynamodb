/**
 * Context attributes, and a value that keeps what it's given (#241). An aggregate's `context` copies
 * root fields onto every edge's row, over what the edge's value holds there. A value that keeps what
 * it's given (`Schema.Unknown`, a record) is stored as the row's attributes, so its row is its value:
 * a read hands it back with the row's context attributes inside, as on 1.39.0 and 1.40.0, since
 * nothing stored tells them from the value's own. `create` given, at the top of an edge's value, a
 * context attribute (declared or not) or the collection sort key's copy with another value than the
 * one the library writes there read back the library's on 1.40.0, so it's refused (`EDD-9159`),
 * nothing sent; given the library's value, or none, it's written byte-identically to 1.40.0. A
 * discriminator is the library's to fill: written with its value whatever the value holds, as on
 * 1.40.0. A custom `assemble` is handed the rows with them, as before. `update` isn't judged: its
 * state is the read's, and what the read filled in can't be told from what the caller set, so the
 * library's value replaces a value given there, as on 1.40.0; it returns 1.40.0's result with each
 * member value's copy of a context attribute as its row now holds it.
 *
 * `fixtures/aggregate-context-read-1.40.0.json` holds what published 1.39.0 and 1.40.0 did for each
 * shape on DynamoDB Local. One suite, run on a recording table (`AggregateContextRead.test.ts`) and
 * against DynamoDB Local (`connected.aggregate-context-read.test.ts`).
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Table from "../../src/Table.js"
import { CONTEXT, customOverRow, givenOverRow, MIRRORED } from "./AggregateUpgradeSweep.js"

type Row = Record<string, AttributeValue>
type Outcome = { readonly ok?: unknown; readonly failed?: string; readonly operation?: string }
type Recorded = {
  readonly create: Outcome
  readonly rows: ReadonlyArray<Row>
  readonly get: Outcome
  readonly noop: Outcome
  readonly getAfterUpdate: Outcome
}
type Published = {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.39.0": Record<string, Recorded>
  readonly "1.40.0": Record<string, Recorded>
}
const published: Published = JSON.parse(
  readFileSync(new URL("../fixtures/aggregate-context-read-1.40.0.json", import.meta.url), "utf8"),
)

const schema = DynamoSchema.make({ name: "ctx", version: 1 })
export const Main = Table.make({ schema, entities: {} })
/** The local index the collection sort key's copy is assembled off. */
export const INDEX = { name: "lsi1", sk: "csk" } as const

type Shape = {
  readonly model: Schema.Top
  readonly edges: Record<string, unknown>
  readonly input: unknown
  readonly context?: ReadonlyArray<string>
  readonly collection?: unknown
  /** Refused at `create`, nothing sent, with this message, naming `member`. */
  readonly refused?: string
  readonly member?: string
}

const S = Schema.String
const many = (extra: Record<string, unknown> = {}) =>
  (Aggregate.many as any)({ entityType: "Line", sk: { composite: ["qty"] }, ...extra })
const one = () => (Aggregate.one as any)({ entityType: "Note" })
const root = (fields: Record<string, Schema.Top>) =>
  Schema.Struct({ id: S, tenantId: S, ...fields })

const unknownOne = (note: Record<string, unknown>, now: Partial<Shape>) => (): Shape => ({
  model: root({ note: Schema.Unknown }),
  edges: { note: one() },
  input: { id: "a", tenantId: "t1", note },
  ...now,
})
const unknownMany = (line: Record<string, unknown>, now: Partial<Shape>) => (): Shape => ({
  model: root({ lines: Schema.Array(Schema.Unknown) }),
  edges: { lines: many() },
  input: { id: "a", tenantId: "t1", lines: [line] },
  ...now,
})
const structOne =
  (note: Record<string, unknown>, now: Partial<Shape> = {}) =>
  (): Shape => ({
    model: root({ note: Schema.Struct({ text: S, tenantId: Schema.optional(S) }) }),
    edges: { note: one() },
    input: { id: "a", tenantId: "t1", note },
    ...now,
  })
const subUnknown = (line: Record<string, unknown>) => (): Shape => {
  const Part = Schema.Struct({ lines: Schema.Array(Schema.Unknown) })
  const Sub = (Aggregate.make as any)(Part, {
    root: { entityType: "Part" },
    edges: { lines: many() },
  })
  return {
    model: root({ part: Part }),
    edges: { part: Sub.with({ discriminator: { side: 1 } }) },
    input: { id: "a", tenantId: "t1", part: { lines: [line] } },
    context: [],
  }
}

export const shapes: Record<string, () => Shape> = {
  // The row is the value: it reads back with the row's context attributes, as on 1.40.0.
  "an Unknown one edge holding no tenantId": unknownOne({ text: "n" }, {}),
  "an Unknown one edge holding the root's tenantId": unknownOne({ text: "n", tenantId: "t1" }, {}),
  "an Unknown one edge holding another tenantId": unknownOne(
    { text: "n", tenantId: "other" },
    { refused: givenOverRow("note", "tenantId", "other", CONTEXT, "t1"), member: "note" },
  ),
  "an Unknown element holding no tenantId": unknownMany({ qty: 1, text: "n" }, {}),
  "an Unknown element holding the root's tenantId": unknownMany(
    { qty: 1, text: "n", tenantId: "t1" },
    {},
  ),
  "an Unknown element holding another tenantId": unknownMany(
    { qty: 1, text: "n", tenantId: "other" },
    { refused: givenOverRow("lines", "tenantId", "other", CONTEXT, "t1"), member: "lines" },
  ),
  // A custom `assemble` is handed the rows with the context attributes, the library's copy over the
  // row's own: 1.40.0 read back "t1", not the value given, judged by what a read of the edge returns.
  "an Unknown element with a custom assemble holding another tenantId": () => ({
    model: root({ lines: Schema.Array(Schema.Unknown) }),
    edges: {
      lines: many({
        assemble: (items: ReadonlyArray<unknown>) => items,
        decompose: (value: unknown) => value,
      }),
    },
    input: { id: "a", tenantId: "t1", lines: [{ qty: 1, text: "n", tenantId: "other" }] },
    refused: customOverRow(
      "lines",
      "tenantId",
      "other",
      CONTEXT,
      { shown: '[{ "qty": 1, "text": "n", "tenantId": "other" }]' },
      { shown: '[{ "qty": 1, "text": "n", "tenantId": "t1" }]' },
    ),
    member: "lines",
  }),
  // A value declaring the context field reads the root's value back, the copy `context` makes:
  // given another, 1.40.0 read back the root's.
  "a struct one edge declaring tenantId, given none": structOne({ text: "n" }),
  "a struct one edge declaring tenantId, given the root's": structOne({
    text: "n",
    tenantId: "t1",
  }),
  "a struct one edge declaring tenantId, given another": structOne(
    { text: "n", tenantId: "other" },
    { refused: givenOverRow("note", "tenantId", "other", CONTEXT, "t1"), member: "note" },
  ),
  "a sub-aggregate declaring tenantId, given another": () => {
    const Part = Schema.Struct({ name: S, tenantId: Schema.optional(S) })
    const Sub = (Aggregate.make as any)(Part, { root: { entityType: "Part" }, edges: {} })
    return {
      model: root({ part: Part }),
      edges: { part: Sub.with({ discriminator: { side: 1 } }) },
      input: { id: "a", tenantId: "t1", part: { name: "p", tenantId: "other" } },
      refused: givenOverRow("part", "tenantId", "other", CONTEXT, "t1"),
      member: "part",
    }
  },
  // The discriminator is the library's to fill, whatever the value holds, as on 1.40.0.
  "sub-aggregate, an Unknown element holding its discriminator's value": subUnknown({
    qty: 1,
    text: "n",
    side: 1,
  }),
  "sub-aggregate, an Unknown element holding another value in its discriminator": subUnknown({
    qty: 1,
    text: "n",
    side: 2,
  }),
  "an Unknown one edge holding csk, the collection sort key's copy": unknownOne(
    { text: "n", csk: "mine" },
    {
      collection: { name: "ctx", index: INDEX.name, sk: { field: INDEX.sk, composite: [] } },
      refused: givenOverRow("note", "csk", "mine", MIRRORED, "$ctx#v1#note"),
      member: "note",
    },
  ),
}

export interface Harness {
  /** Run `body` on a fresh, empty table keyed by `pk` and `sk` (local index `lsi1` on `csk`). */
  readonly onTable: <A, E>(
    body: (tableName: string) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
  readonly rows: (tableName: string) => Effect.Effect<ReadonlyArray<Row>>
  /** The commands sent since the last call. */
  readonly commands: (tableName: string) => Effect.Effect<ReadonlyArray<string>>
}

const bySortKey = (rows: ReadonlyArray<Row>) =>
  [...rows].sort((a, b) => ((a.sk?.S ?? "") < (b.sk?.S ?? "") ? -1 : 1))
const outcome = (exit: Exit.Exit<unknown, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value)) }
  const error = Cause.squash(exit.cause) as { _tag?: string; operation?: string }
  return { failed: error._tag ?? "defect" }
}
const judged = (result: Outcome): Outcome =>
  result.failed === undefined ? { ok: result.ok } : { failed: result.failed }

const bind = (shape: Shape) =>
  Effect.gen(function* () {
    const A = (Aggregate.make as any)(shape.model, {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: shape.collection ?? { name: "ctx" },
      context: shape.context ?? ["tenantId"],
      root: { entityType: "Root" },
      edges: shape.edges,
    })
    const db: any = yield* DynamoClient.make({
      entities: {},
      aggregates: { A },
      tables: { Main },
    } as never)
    return db.aggregates.A
  })

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("context attributes and a value that keeps what it's given (EDD-9159)", () => {
    it("the fixture is published 1.39.0's and 1.40.0's, for every shape, and they agree", () => {
      expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0", "effect-dynamodb@1.39.0"])
      expect(Object.keys(published["1.40.0"]).sort()).toEqual(Object.keys(shapes).sort())
      expect(published["1.39.0"]).toEqual(published["1.40.0"])
    })

    for (const [label, define] of Object.entries(shapes)) {
      const then = published["1.40.0"][label]!
      const shape = define()
      if (shape.refused !== undefined) {
        it(`${label}: 1.40.0 read back the library's value, not the one given; create is refused, nothing sent`, () =>
          Effect.runPromise(
            harness.onTable((tableName) =>
              Effect.gen(function* () {
                expect(judged(then.create)).toEqual({ ok: shape.input })
                expect(judged(then.get)).not.toEqual({ ok: shape.input })
                const A = yield* bind(shape)
                yield* harness.commands(tableName)
                const exit = yield* Effect.exit(A.create(shape.input))
                const error = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause) as {
                  _tag?: string
                  member?: string
                  reason?: string
                }
                expect(error._tag).toBe("AggregateDecompositionError")
                expect(error.member).toBe(shape.member)
                expect(error.reason).toBe(shape.refused)
                expect(yield* harness.commands(tableName)).toEqual([])
                expect(yield* harness.rows(tableName)).toEqual([])
              }),
            ),
          ))
        continue
      }
      it(`${label}: stores and reads back what 1.40.0 did; a no-op update returns what a get after it reads`, () =>
        Effect.runPromise(
          harness.onTable((tableName) =>
            Effect.gen(function* () {
              const A = yield* bind(shape)
              const create = outcome(yield* Effect.exit(A.create(shape.input)))
              const rows = bySortKey(yield* harness.rows(tableName))
              const get = outcome(yield* Effect.exit(A.get({ id: "a" })))
              yield* harness.commands(tableName)
              const noop = outcome(
                yield* Effect.exit(A.update({ id: "a" }, ({ state }: any) => ({ ...state }))),
              )
              // A no-op update sends its read and nothing else.
              expect(yield* harness.commands(tableName)).toEqual(["Query"])
              const getAfterUpdate = outcome(yield* Effect.exit(A.get({ id: "a" })))
              expect(judged(create)).toEqual(judged(then.create))
              expect(rows).toEqual(bySortKey(then.rows))
              for (const [step, now] of [
                ["get", get],
                ["getAfterUpdate", getAfterUpdate],
              ] as const) {
                expect({ step, ...judged(now) }).toEqual({ step, ...judged(then[step]) })
              }
              // What a `get` right after reads (#241).
              expect(judged(noop)).toEqual(judged(getAfterUpdate))
            }),
          ),
        ))
    }

    it("an update changing the root's context field rewrites the edges, a value declaring it reads the new one", () =>
      Effect.runPromise(
        harness.onTable(() =>
          Effect.gen(function* () {
            const A = yield* bind(
              shapes["a struct one edge declaring tenantId, given the root's"]!(),
            )
            yield* A.create({ id: "a", tenantId: "t1", note: { text: "n", tenantId: "t1" } })
            yield* A.update({ id: "a" }, ({ state }: any) => ({ ...state, tenantId: "t2" }))
            expect(JSON.parse(JSON.stringify(yield* A.get({ id: "a" })))).toEqual({
              id: "a",
              tenantId: "t2",
              note: { text: "n", tenantId: "t2" },
            })
          }),
        ),
      ))

    // `update` isn't judged: a value given there is replaced by the library's, as on 1.40.0. The
    // row holds `t1` already, so there's nothing to write either way; the update returns the copy
    // its row holds, as a get after it reads it, where 1.40.0 returned the value given.
    for (const given of ["t1", "other"]) {
      it(`an update putting the context's name into a value that keeps what it's given, holding ${given}: written as on 1.40.0, and returns the copy its row holds`, () =>
        Effect.runPromise(
          harness.onTable((tableName) =>
            Effect.gen(function* () {
              const A = yield* bind(shapes["an Unknown one edge holding no tenantId"]!())
              yield* A.create({ id: "a", tenantId: "t1", note: { text: "n" } })
              const before = bySortKey(yield* harness.rows(tableName))
              yield* harness.commands(tableName)
              const exit = yield* Effect.exit(
                A.update({ id: "a" }, ({ state }: any) => ({
                  ...state,
                  note: { ...state.note, tenantId: given },
                })),
              )
              expect(yield* harness.commands(tableName)).toEqual(["Query"])
              expect(bySortKey(yield* harness.rows(tableName))).toEqual(before)
              const read = { id: "a", tenantId: "t1", note: { text: "n", tenantId: "t1" } }
              expect(outcome(exit)).toEqual({ ok: read })
              expect(outcome(yield* Effect.exit(A.get({ id: "a" })))).toEqual({ ok: read })
            }),
          ),
        ))
    }
  })
