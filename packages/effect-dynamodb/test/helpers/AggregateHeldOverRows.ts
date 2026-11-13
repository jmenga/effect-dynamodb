/**
 * What a read gives back of a row's value, judged when `create` builds the row (#241, `EDD-9159`).
 *
 * - **A name the library writes on the row** (`pk`, `sk`, `__edd_e__`, the collection sort key's
 *   copy, a context attribute beneath the root), given at the top of a row's value as the caller
 *   gave it: 1.40.0 wrote the library's value over it and every read handed that back. `create`
 *   refuses a value other than the library's, nothing sent; the library's value, or none, is written
 *   byte-identically to 1.40.0.
 * - **Anything else is written and read as on 1.40.0**: a name the library doesn't write on that row
 *   (`gsi1pk`, `lsiNote` where no index writes it, a timestamp, a nested name), a value the schema
 *   can't place exactly (a union, a record), a custom `decompose`, a discriminator, and every
 *   `update`, whatever its value holds: the state an update mutates is what the read gave, and what
 *   the read filled in can't be told from what the caller set, so the library's value replaces it,
 *   as on 1.40.0.
 * - **`update` returns 1.40.0's result**, with one change: a member value's copy of a context
 *   attribute is the value its row now holds, as a `get` after it reads it.
 *
 * `fixtures/aggregate-held-over-rows-1.40.0.json` holds what published 1.40.0 and 1.39.0 did for
 * each shape on DynamoDB Local. One suite, run on a recording table
 * (`AggregateHeldOverRows.test.ts`) and against DynamoDB Local
 * (`connected.aggregate-held-over-rows.test.ts`).
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Table from "../../src/Table.js"
import {
  givenOverRow,
  MIRRORED,
  PARTITION,
  type ReadBack,
  SORT,
  TYPE,
  valueCopiesAsRoot,
} from "./AggregateUpgradeSweep.js"

type Row = Record<string, AttributeValue>
type Request = { readonly command: string; readonly input: unknown }
type Outcome = { readonly ok?: unknown; readonly failed?: string; readonly operation?: string }
type Step = {
  readonly step: string
  readonly update: Outcome
  readonly requests: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
  readonly get: Outcome
}
type Recorded = {
  readonly create: Outcome
  readonly requests: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
  readonly get: Outcome
  readonly steps: ReadonlyArray<Step>
}
type Published = {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.40.0": Record<string, Recorded>
  readonly "1.39.0": Record<string, Recorded>
}
const published: Published = JSON.parse(
  readFileSync(
    new URL("../fixtures/aggregate-held-over-rows-1.40.0.json", import.meta.url),
    "utf8",
  ),
)

const schema = DynamoSchema.make({ name: "held", version: 1 })
export const Main = Table.make({ schema, entities: {} })
/** The local index every table has, the collection sort key's copy `csk` its sort key. */
export const INDEX = { name: "lsi1", sk: "csk" } as const

const S = Schema.String
const N = Schema.Number
const U = Schema.Unknown
const opt = Schema.optional
const one = (extra: Record<string, unknown> = {}) =>
  (Aggregate.one as any)({ entityType: "Note", ...extra })
const many = (extra: Record<string, unknown> = {}) =>
  (Aggregate.many as any)({ entityType: "Line", sk: { composite: ["qty"] }, ...extra })
const sub = (Part: Schema.Top, edges: Record<string, unknown>, discriminator: unknown) =>
  (Aggregate.make as any)(Part, { root: { entityType: "Part" }, edges }).with({ discriminator })
const MIRROR = { name: "held", index: INDEX.name, sk: { field: INDEX.sk, composite: [] } }

type Change = { readonly label: string; readonly change: (state: any) => any }
type Shape = {
  readonly model: Schema.Top
  readonly edges: Record<string, unknown>
  readonly input: unknown
  readonly pk?: string
  readonly collection?: unknown
  readonly context?: ReadonlyArray<string>
  readonly timestamps?: unknown
  readonly steps?: ReadonlyArray<Change>
  /** `create` refused, nothing sent, naming `member`, with this message. */
  readonly refused?: { readonly member: string; readonly message: string }
  /** What 1.40.0's `get` returned after `create`, for a refused shape: not what was given. */
  readonly read140?: unknown
}

const noop: Change = { label: "noop", change: (state) => ({ ...state }) }
const rootTenant: Change = {
  label: "root tenantId t2",
  change: (state) => ({ ...state, tenantId: "t2" }),
}
const unknownOne =
  (note: unknown, extra: Partial<Shape> = {}) =>
  (): Shape => ({
    model: Schema.Struct({ id: S, note: U }),
    edges: { note: one() },
    input: { id: "a", note },
    ...extra,
  })
const unknownMany =
  (line: unknown, extra: Partial<Shape> = {}) =>
  (): Shape => ({
    model: Schema.Struct({ id: S, lines: Schema.Array(U) }),
    edges: { lines: many() },
    input: { id: "a", lines: [line] },
    ...extra,
  })
const ctx =
  (
    model: Record<string, Schema.Top>,
    edges: Record<string, unknown>,
    input: Record<string, unknown>,
    extra: Partial<Shape> = {},
  ) =>
  (): Shape => ({
    model: Schema.Struct({ id: S, tenantId: S, ...model }),
    edges,
    input: { id: "a", tenantId: "t1", ...input },
    context: ["tenantId"],
    steps: [rootTenant, noop],
    ...extra,
  })

/** `create` giving `name`, on `member`'s row, `given` where a read of `member` returns `read`. */
const over = (member: string, name: string, given: string, what: string, read: ReadBack) => ({
  member,
  message: givenOverRow(member, name, given, what, read),
})
export const shapes: Record<string, () => Shape> = {
  "an Unknown one edge holding pk": unknownOne(
    { text: "n", pk: "mine" },
    { refused: over("note", "pk", "mine", PARTITION, undefined) },
  ),
  "an Unknown one edge holding sk": unknownOne(
    { text: "n", sk: "mine" },
    { refused: over("note", "sk", "mine", SORT, undefined) },
  ),
  "an Unknown one edge holding __edd_e__": unknownOne(
    { text: "n", __edd_e__: "mine" },
    { refused: over("note", "__edd_e__", "mine", TYPE, undefined) },
  ),
  // A name the library doesn't write on the row: written, and taken off every read, as on 1.40.0.
  "an Unknown one edge holding gsi1pk": unknownOne({ text: "n", gsi1pk: "mine" }),
  "an Unknown one edge holding lsiNote": unknownOne({ text: "n", lsiNote: "mine" }),
  // A timestamp the library stamps isn't judged: stamped over it, as on 1.40.0.
  "an Unknown one edge holding createdAt, with timestamps": unknownOne(
    { text: "n", createdAt: "mine" },
    { timestamps: true },
  ),
  "an Unknown element holding gsiTag": unknownMany({ qty: 1, gsiTag: "mine" }),
  "a record element holding gsiTag": () => ({
    model: Schema.Struct({ id: S, lines: Schema.Array(Schema.Record(S, U)) }),
    edges: { lines: many() },
    input: { id: "a", lines: [{ qty: 1, gsiTag: "mine" }] },
  }),
  // A custom `decompose` maps the value to rows itself, and its `assemble` maps them back: the
  // value reads back as given, and its rows are written as on 1.40.0.
  "a custom decompose's row holding gsiTag": () => ({
    model: Schema.Struct({ id: S, lines: Schema.Array(Schema.Struct({ qty: N })) }),
    edges: {
      lines: many({
        decompose: (lines: ReadonlyArray<object>) =>
          lines.map((line) => ({ ...line, gsiTag: "mine" })),
        assemble: (rows: ReadonlyArray<{ readonly qty: number }>) =>
          rows.map((row) => ({ qty: row.qty })),
      }),
    },
    input: { id: "a", lines: [{ qty: 1 }] },
  }),
  "a sub-aggregate's Unknown one edge holding gsi1sk": () => {
    const Part = Schema.Struct({ name: S, note: U })
    return {
      model: Schema.Struct({ id: S, part: Part }),
      edges: { part: sub(Part, { note: one() }, { side: 1 }) },
      input: { id: "a", part: { name: "p", note: { text: "n", gsi1sk: "mine" } } },
    }
  },
  "a struct one edge declaring pk (optional), keyed under PK, given mine": () => ({
    pk: "PK",
    model: Schema.Struct({ id: S, note: Schema.Struct({ text: S, pk: opt(S) }) }),
    edges: { note: one() },
    input: { id: "a", note: { text: "n", pk: "mine" } },
  }),
  "an Unknown one edge holding them nested": unknownOne({
    text: "n",
    meta: { pk: "x", sk: "y", __edd_e__: "z", gsi1pk: "w", lsiNote: "v", createdAt: "u" },
  }),
  "an Unknown element holding them nested": unknownMany({ qty: 1, meta: { pk: "x", gsiTag: "w" } }),
  "an Unknown one edge holding names a read leaves": unknownOne({
    text: "n",
    pkg: "x",
    skill: "y",
    gs: "z",
  }),
  "a one edge union, a member declaring csk, given the other member": () => ({
    collection: MIRROR,
    model: Schema.Struct({
      id: S,
      note: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("text"), text: S }),
        Schema.Struct({ kind: Schema.Literal("key"), csk: S }),
      ]),
    }),
    edges: { note: one() },
    input: { id: "a", note: { kind: "text", text: "hello" } },
  }),
  // A union is judged by what a read of the whole value returns: 1.40.0 read back the library's
  // copy, not the value given.
  "a one edge union, a member declaring csk, given that member": () => ({
    collection: MIRROR,
    model: Schema.Struct({
      id: S,
      note: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("text"), text: S }),
        Schema.Struct({ kind: Schema.Literal("key"), csk: S }),
      ]),
    }),
    edges: { note: one() },
    input: { id: "a", note: { kind: "key", csk: "mine" } },
    refused: over("note", "csk", "mine", MIRRORED, "$held#v1#note"),
    read140: { id: "a", note: { kind: "key", csk: "$held#v1#note" } },
  }),
  "a one edge declaring csk (required)": () => ({
    collection: MIRROR,
    model: Schema.Struct({ id: S, note: Schema.Struct({ text: S, csk: S }) }),
    edges: { note: one() },
    input: { id: "a", note: { text: "n", csk: "mine" } },
    refused: over("note", "csk", "mine", MIRRORED, "$held#v1#note"),
    read140: { id: "a", note: { text: "n", csk: "$held#v1#note" } },
  }),
  // Given none, the row holds the copy as it would holding it: written and read as on 1.40.0.
  "a one edge declaring csk (optional), given none": () => ({
    collection: MIRROR,
    model: Schema.Struct({ id: S, note: Schema.Struct({ text: S, csk: opt(S) }) }),
    edges: { note: one() },
    input: { id: "a", note: { text: "n" } },
  }),
  "an Unknown one edge holding csk, the collection sort key's copy, given the copy": () => ({
    collection: MIRROR,
    model: Schema.Struct({ id: S, note: U }),
    edges: { note: one() },
    input: { id: "a", note: { text: "n", csk: "$held#v1#note" } },
  }),
  "context: an Unknown one edge, updates": ctx(
    { note: U },
    { note: one() },
    { note: { text: "n" } },
    {
      steps: [
        rootTenant,
        noop,
        {
          label: "note tenantId other",
          change: (state) => ({ ...state, note: { ...state.note, tenantId: "other" } }),
        },
        {
          label: "note tenantId t2",
          change: (state) => ({ ...state, note: { ...state.note, tenantId: "t2" } }),
        },
        {
          label: "note without tenantId",
          change: (state) => {
            const { tenantId: _, ...note } = state.note
            return { ...state, note }
          },
        },
      ],
    },
  ),
  "context: an Unknown element, updates": ctx(
    { lines: Schema.Array(U) },
    { lines: many() },
    { lines: [{ qty: 1, text: "n" }] },
    {
      steps: [
        rootTenant,
        noop,
        {
          label: "element tenantId other",
          change: (state) => ({
            ...state,
            lines: state.lines.map((line: object) => ({ ...line, tenantId: "other" })),
          }),
        },
      ],
    },
  ),
  "context: a struct one edge declaring tenantId": ctx(
    { note: Schema.Struct({ text: S, tenantId: opt(S) }) },
    { note: one() },
    { note: { text: "n" } },
  ),
  "context: a struct element declaring tenantId": ctx(
    { lines: Schema.Array(Schema.Struct({ qty: N, tenantId: opt(S) })) },
    { lines: many() },
    { lines: [{ qty: 1 }] },
  ),
  "context: a childless sub-aggregate declaring tenantId": () => {
    const Part = Schema.Struct({ name: S, tenantId: opt(S) })
    return ctx({ part: Part }, { part: sub(Part, {}, { side: 1 }) }, { part: { name: "p" } })()
  },
  "context: a sub-aggregate with an edge, both declaring tenantId": () => {
    const Part = Schema.Struct({
      name: S,
      tenantId: opt(S),
      note: Schema.Struct({ text: S, tenantId: opt(S) }),
    })
    return ctx(
      { part: Part },
      { part: sub(Part, { note: one() }, { side: 1 }) },
      { part: { name: "p", note: { text: "n" } } },
    )()
  },
  "context: a custom decompose and assemble": ctx(
    { lines: Schema.Array(Schema.Struct({ qty: N, tenantId: opt(S) })) },
    {
      lines: many({
        decompose: (lines: ReadonlyArray<unknown>) => lines,
        assemble: (rows: ReadonlyArray<{ readonly qty: number; readonly tenantId?: string }>) =>
          rows.map((row) => ({
            qty: row.qty,
            ...(row.tenantId === undefined ? {} : { tenantId: row.tenantId }),
          })),
      }),
    },
    { lines: [{ qty: 1 }] },
  ),
  "a childless sub-aggregate declaring teamNumber as BigInt, its discriminator 1, given 1n": () => {
    const Part = Schema.Struct({ teamNumber: Schema.BigInt, note: S })
    return {
      model: Schema.Struct({ id: S, part: Part }),
      edges: { part: sub(Part, {}, { teamNumber: 1 }) },
      input: { id: "a", part: { teamNumber: 1n, note: "x" } },
      steps: [
        noop,
        { label: "note y", change: (state) => ({ ...state, part: { ...state.part, note: "y" } }) },
      ],
    }
  },
  "two childless sub-aggregates of one model, an update copying one into the other": () => {
    const Part = Schema.Struct({ name: S, side: opt(N) })
    return {
      model: Schema.Struct({ id: S, one: Part, two: Part }),
      edges: { one: sub(Part, {}, { side: 1 }), two: sub(Part, {}, { side: 2 }) },
      input: { id: "a", one: { name: "a" }, two: { name: "b" } },
      steps: [{ label: "two = one", change: (state) => ({ ...state, two: { ...state.one } }) }],
    }
  },
  "two sub-aggregates of one model, an update copying one's elements into the other": () => {
    const Part = Schema.Struct({ lines: Schema.Array(Schema.Struct({ qty: N, side: opt(N) })) })
    const edges = { lines: many() }
    return {
      model: Schema.Struct({ id: S, one: Part, two: Part }),
      edges: { one: sub(Part, edges, { side: 1 }), two: sub(Part, edges, { side: 2 }) },
      input: { id: "a", one: { lines: [{ qty: 1 }] }, two: { lines: [{ qty: 2 }] } },
      steps: [
        {
          label: "two.lines = one.lines",
          change: (state) => ({ ...state, two: { lines: state.one.lines } }),
        },
      ],
    }
  },
}

export interface Harness {
  /** Run `body` on a fresh, empty table keyed by `pk` (`"pk"`) and `sk`, with `lsi1` on `csk`. */
  readonly onTable: <A, E>(
    body: (tableName: string) => Effect.Effect<A, E, any>,
    pk?: string,
  ) => Effect.Effect<A, unknown>
  readonly rows: (tableName: string) => Effect.Effect<ReadonlyArray<Row>>
  /** The requests sent since the last call: commands and inputs, the table's name as `<table>`. */
  readonly requests: (tableName: string) => Effect.Effect<ReadonlyArray<Request>>
}

/** As the fixture holds it: a stamp as `<stamp>`, a `bigint` as `1n`. */
const plain = <A>(value: A): A =>
  value === undefined
    ? value
    : JSON.parse(
        JSON.stringify(value, (_key, v) =>
          typeof v === "bigint"
            ? `${v}n`
            : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
              ? "<stamp>"
              : v,
        ),
      )
const keyOf = (row: Row) => `${(row.pk ?? row.PK)?.S} ${row.sk?.S}`
const sorted = (rows: ReadonlyArray<Row>) =>
  plain([...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0)))
const outcome = (exit: Exit.Exit<unknown, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) return { ok: plain(exit.value) }
  const error = Cause.squash(exit.cause) as { _tag?: string; operation?: string }
  return {
    failed: error._tag ?? "defect",
    ...(error.operation !== undefined && { operation: error.operation }),
  }
}
/**
 * The shapes whose edge has a custom `decompose` and `assemble`: `update` can't tell which of its
 * rows an element's copy of a context attribute came from, so it returns the copy as 1.40.0 did.
 */
const CUSTOM_EDGE: Readonly<Record<string, string>> = {
  "context: a custom decompose and assemble": "lines",
}
const judged = (result: Outcome): Outcome =>
  result.failed === undefined
    ? { ok: result.ok }
    : {
        failed: result.failed,
        ...(result.operation !== undefined && { operation: result.operation }),
      }
const refusal = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  return Cause.squash((exit as Exit.Failure<unknown, unknown>).cause) as {
    readonly _tag?: string
    readonly member?: string
    readonly reason?: string
  }
}

const define = (shape: Shape) =>
  (Aggregate.make as any)(shape.model, {
    table: Main,
    schema,
    pk: { field: shape.pk ?? "pk", composite: ["id"] },
    collection: shape.collection ?? { name: "held" },
    root: { entityType: "Root" },
    edges: shape.edges,
    ...(shape.context !== undefined && { context: shape.context }),
    ...(shape.timestamps !== undefined && { timestamps: shape.timestamps }),
  })

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("what a read gives back of a row's value, judged at create (EDD-9159)", () => {
    it("the fixture is published 1.40.0's and 1.39.0's, for every shape, and they agree", () => {
      expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0", "effect-dynamodb@1.39.0"])
      expect(Object.keys(published["1.40.0"]).sort()).toEqual(Object.keys(shapes).sort())
      expect(published["1.39.0"]).toEqual(published["1.40.0"])
    })

    for (const [label, defineShape] of Object.entries(shapes)) {
      const then = published["1.40.0"][label]!
      const shape = defineShape()
      if (shape.refused !== undefined) {
        const { member, message } = shape.refused
        it(`${label}: 1.40.0 read back the library's value, not the one given; create is refused, nothing sent`, () =>
          Effect.runPromise(
            harness.onTable(
              (tableName) =>
                Effect.gen(function* () {
                  expect(judged(then.create)).toEqual({ ok: plain(shape.input) })
                  expect(judged(then.get)).not.toEqual({ ok: plain(shape.input) })
                  if (shape.read140 !== undefined) {
                    expect(judged(then.get)).toEqual({ ok: shape.read140 })
                  }
                  const db: any = yield* DynamoClient.make({
                    entities: {},
                    aggregates: { A: define(shape) },
                    tables: { Main },
                  } as never)
                  yield* harness.requests(tableName)
                  const error = refusal(yield* Effect.exit(db.aggregates.A.create(shape.input)))
                  expect(error._tag).toBe("AggregateDecompositionError")
                  expect(error.member).toBe(member)
                  expect(error.reason).toBe(message)
                  expect(yield* harness.requests(tableName)).toEqual([])
                  expect(yield* harness.rows(tableName)).toEqual([])
                }),
              shape.pk,
            ),
          ))
        continue
      }
      it(`${label}: sends, stores and reads what 1.40.0 did, and update returns 1.40.0's result with context copies as stored`, () =>
        Effect.runPromise(
          harness.onTable(
            (tableName) =>
              Effect.gen(function* () {
                const db: any = yield* DynamoClient.make({
                  entities: {},
                  aggregates: { A: define(shape) },
                  tables: { Main },
                } as never)
                const A = db.aggregates.A
                yield* harness.requests(tableName)
                expect(judged(outcome(yield* Effect.exit(A.create(shape.input))))).toEqual(
                  judged(then.create),
                )
                expect(plain(yield* harness.requests(tableName))).toEqual(then.requests)
                expect(sorted(yield* harness.rows(tableName))).toEqual(sorted(then.rows))
                expect(judged(outcome(yield* Effect.exit(A.get({ id: "a" }))))).toEqual(
                  judged(then.get),
                )
                yield* harness.requests(tableName)
                for (const [i, { label: step, change }] of (shape.steps ?? [noop]).entries()) {
                  const was = then.steps[i]!
                  expect(was.step).toBe(step)
                  const update = outcome(
                    yield* Effect.exit(A.update({ id: "a" }, ({ state }: any) => change(state))),
                  )
                  const sent = plain(yield* harness.requests(tableName))
                  expect({ step, requests: sent }).toEqual({ step, requests: was.requests })
                  expect({ step, rows: sorted(yield* harness.rows(tableName)) }).toEqual({
                    step,
                    rows: sorted(was.rows),
                  })
                  const get = outcome(yield* Effect.exit(A.get({ id: "a" })))
                  yield* harness.requests(tableName)
                  expect({ step, ...judged(get) }).toEqual({ step, ...judged(was.get) })
                  // 1.40.0's result, each context copy the root's as its row now holds it (#241);
                  // a custom decompose's copies as 1.40.0 returned them.
                  expect({ step, ...judged(update) }).toEqual({
                    step,
                    ...(was.update.ok === undefined || shape.context === undefined
                      ? judged(was.update)
                      : {
                          ok: valueCopiesAsRoot(was.update.ok, shape.context, CUSTOM_EDGE[label]),
                        }),
                  })
                }
              }),
            shape.pk,
          ),
        ))
    }
  })
