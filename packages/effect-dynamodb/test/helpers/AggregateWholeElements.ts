/**
 * A `many` element whose schema shows no fields of its own is stored in its stored form (#241): a
 * union (a member renaming a field among them, `line` stored and `text` held) or a transformation
 * of the whole element (`Schema.encodeKeys`, a struct decoded to another). Up to 1.40.0 no encoder
 * reached it, so the element was stored as the domain value it held: `text` where its schema stores
 * `line`, a `Schema.NumberFromString` as a number, a date as a `DateTime`'s internal fields.
 *
 * - `create` and a changed `update` store the element encoded through its schema, exactly once,
 *   whether it was given as its domain value or already in its stored form, and a read returns the
 *   domain value, as 1.40.0's did.
 * - Rows 1.40.0 stored (the domain value) read as before, through the same tolerant decode. An
 *   `update` that changes nothing sends only its read and writes nothing; one that changes the
 *   group rewrites the element in its stored form.
 * - Every other request and row is 1.40.0's.
 *
 * `fixtures/aggregate-whole-elements-1.40.0.json` holds what published 1.40.0 and 1.39.0 did for
 * each shape. One suite, run on a recording table (`AggregateWholeElements.test.ts`) and against
 * DynamoDB Local (`connected.aggregate-whole-elements.test.ts`).
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, DateTime, Effect, Exit, Schema, SchemaGetter } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Table from "../../src/Table.js"

type Row = Record<string, AttributeValue>
type Request = { readonly command: string; readonly input: unknown }
type Recorded = {
  readonly create: { readonly ok?: unknown; readonly failed?: string }
  readonly requests: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
  readonly get: { readonly ok?: unknown; readonly failed?: string }
  readonly noop: { readonly ok?: unknown }
  readonly noopRequests: ReadonlyArray<Request>
  readonly update: { readonly ok?: unknown }
  readonly updateRequests: ReadonlyArray<Request>
  readonly updateRows: ReadonlyArray<Row>
  readonly getAfterUpdate: { readonly ok?: unknown }
}

const published = JSON.parse(
  readFileSync(
    new URL("../fixtures/aggregate-whole-elements-1.40.0.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.40.0": Record<string, Recorded>
  readonly "1.39.0": Record<string, Recorded>
}

const schema = DynamoSchema.make({ name: "whole", version: 1 })

const rename = {
  decode: SchemaGetter.transform(({ line, ...rest }: any) => ({ ...rest, text: line })),
  encode: SchemaGetter.transform(({ text, ...rest }: any) => ({ ...rest, line: text })),
}
/** A union whose second member renames a field: `line` stored, `text` held. */
const renaming = () =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("ref"), qty: Schema.Number, line: Schema.String }),
    (
      Schema.Struct({ kind: Schema.Literal("own"), qty: Schema.Number, line: Schema.String }) as any
    ).pipe(Schema.decodeTo(Schema.Unknown, rename as never)),
  ] as never) as unknown as Schema.Top
const encodeKeys = () =>
  Schema.Struct({ qty: Schema.Number, text: Schema.String }).pipe(
    Schema.encodeKeys({ text: "line" }),
  ) as unknown as Schema.Top
const structToStruct = () =>
  (Schema.Struct({ qty: Schema.Number, line: Schema.String }) as any).pipe(
    Schema.decodeTo(Schema.Struct({ qty: Schema.Number, text: Schema.String }), rename as never),
  ) as Schema.Top
const numberMember = () =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("a"), qty: Schema.Number, n: Schema.NumberFromString }),
    Schema.Struct({ kind: Schema.Literal("b"), qty: Schema.Number }),
  ]) as unknown as Schema.Top
const nullableDate = () =>
  Schema.NullOr(
    Schema.Struct({ qty: Schema.Number, at: Schema.DateTimeUtcFromString }),
  ) as unknown as Schema.Top

/** A codec storing its text with a space after it: encoded twice, it would hold two. */
const padded = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((s: string) => s.trimEnd()),
    encode: SchemaGetter.transform((s: string) => `${s} `),
  }),
)
const paddedMember = () =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("a"), qty: Schema.Number, p: padded }),
    Schema.Struct({ kind: Schema.Literal("b"), qty: Schema.Number }),
  ]) as unknown as Schema.Top

const at = DateTime.makeUnsafe("2024-05-06T07:08:09.000Z")
const S = (s: string): AttributeValue => ({ S: s })
const N = (n: string): AttributeValue => ({ N: n })

type Shape = {
  readonly model: Schema.Top
  readonly edges: Record<string, unknown>
  readonly input: unknown
  /** The element's attributes on its row, other than `pk`, `sk` and `__edd_e__`. */
  readonly stored: Row
  /** What a read of the rows in their stored form returns, where it isn't what 1.40.0's read did. */
  readonly read?: unknown
  /** An update changing the group the element is in, where setting the root's title doesn't. */
  readonly changeGroup?: (state: any) => unknown
}

const lines = () => Aggregate.many({ entityType: "Line", sk: { composite: ["qty"] } } as never)
const rootShape = (element: () => Schema.Top, value: unknown, stored: Row): Shape => ({
  model: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    lines: Schema.Array(element() as never),
  }),
  edges: { lines: lines() },
  input: { id: "a", title: "t", lines: [value] },
  stored,
})

const renamed = { kind: S("own"), qty: N("3"), line: S("KEEP") }
const keyed = { qty: N("3"), line: S("KEEP") }

export const shapes: Record<string, () => Shape> = {
  "a union member renaming a field, given its domain value": () =>
    rootShape(renaming, { kind: "own", qty: 3, text: "KEEP" }, renamed),
  "a union member renaming a field, given its stored form": () =>
    rootShape(renaming, { kind: "own", qty: 3, line: "KEEP" }, renamed),
  "an element through Schema.encodeKeys, given its domain value": () =>
    rootShape(encodeKeys, { qty: 3, text: "KEEP" }, keyed),
  "an element through Schema.encodeKeys, given its stored form": () =>
    rootShape(encodeKeys, { qty: 3, line: "KEEP" }, keyed),
  "a struct decoded to another, given its domain value": () =>
    rootShape(structToStruct, { qty: 3, text: "KEEP" }, keyed),
  "a union member holding a NumberFromString": () =>
    rootShape(numberMember, { kind: "a", qty: 3, n: 5 }, { kind: S("a"), qty: N("3"), n: S("5") }),
  "a nullable struct holding a DateTimeUtcFromString": () =>
    rootShape(nullableDate, { qty: 3, at }, { qty: N("3"), at: S("2024-05-06T07:08:09.000Z") }),
  "sub-aggregate, a union member renaming a field, given its domain value": () => {
    const Part = Schema.Struct({ name: Schema.String, lines: Schema.Array(renaming() as never) })
    const Sub = (Aggregate.make as any)(Part, {
      root: { entityType: "Part" },
      edges: { lines: lines() },
    })
    return {
      model: Schema.Struct({ id: Schema.String, title: Schema.String, part: Part }),
      edges: { part: Sub.with({ discriminator: { side: 1 } }) },
      input: {
        id: "a",
        title: "t",
        part: { name: "p", lines: [{ kind: "own", qty: 3, text: "KEEP" }] },
      },
      stored: { side: N("1"), ...renamed },
      // Read through the member's transformation, which takes only its own fields: 1.40.0 read the
      // domain value it stored as it was, the sub-aggregate's discriminator with it.
      read: {
        id: "a",
        title: "t",
        part: { name: "p", lines: [{ kind: "own", qty: 3, text: "KEEP" }] },
      },
      // The element is in the sub-aggregate's group, which the root's title isn't.
      changeGroup: (state: any) => ({ ...state, part: { ...state.part, name: "p2" } }),
    }
  },
}

const isLine = (item: Row): boolean => item.__edd_e__?.S === "Line"

/**
 * What 1.40.0 sent and stored, with each row of `entityType` changed by `change` into the form this
 * release stores it in: `row` for a row, `requests` for each item the requests put.
 */
export const storedAsNow = (entityType: string, change: (row: Row) => Row) => {
  const row = (item: Row): Row => (item.__edd_e__?.S === entityType ? change(item) : item)
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (value === null || typeof value !== "object") return value
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] =
        key === "Item" && inner !== null && typeof inner === "object"
          ? row(inner as Row)
          : walk(inner)
    }
    return out
  }
  return { row, requests: (sent: ReadonlyArray<Request>): unknown => walk(sent) }
}

/** A row with its `from` attribute under the name `to`. */
export const renamedAttribute =
  (from: string, to: string) =>
  (row: Row): Row => {
    const { [from]: value, ...rest } = row
    return value === undefined ? row : { ...rest, [to]: value }
  }

/** `item` with the element's attributes replaced by `stored`, if it's the element's row. */
const storedRow = (item: Row, stored: Row): Row =>
  storedAsNow("Line", (row) => ({
    pk: row.pk!,
    sk: row.sk!,
    __edd_e__: row.__edd_e__!,
    ...stored,
  })).row(item)
/** `requests` with each item put for the element holding `stored`. */
const storedRequests = (requests: ReadonlyArray<Request>, stored: Row): unknown =>
  storedAsNow("Line", (row) => ({
    pk: row.pk!,
    sk: row.sk!,
    __edd_e__: row.__edd_e__!,
    ...stored,
  })).requests(requests)
const bySortKey = (rows: ReadonlyArray<Row>) =>
  [...rows].sort((a, b) => (a.sk?.S ?? "").localeCompare(b.sk?.S ?? ""))
/** A value as JSON has it: a date as its ISO text, as the fixture holds it. */
const plain = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value))

export interface Harness {
  /** Runs `body` on a fresh table with a `DynamoClient` bound to it. */
  readonly onTable: <A, E>(
    body: (tableName: string) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
  /** The table's rows. */
  readonly rows: (tableName: string) => Effect.Effect<ReadonlyArray<Row>>
  /** The requests sent since last asked, the table's name as `<table>`. */
  readonly requests: (tableName: string) => Effect.Effect<ReadonlyArray<Request>>
  /** Puts `rows` in the table as they are. */
  readonly seed: (tableName: string, rows: ReadonlyArray<Row>) => Effect.Effect<void>
}

type Run = {
  readonly create: { readonly ok?: unknown; readonly failed?: string }
  readonly requests: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
  readonly get: { readonly ok?: unknown; readonly failed?: string }
  readonly noop: { readonly ok?: unknown; readonly failed?: string }
  readonly noopRequests: ReadonlyArray<Request>
  readonly noopRows: ReadonlyArray<Row>
  readonly update: { readonly ok?: unknown; readonly failed?: string }
  readonly updateRequests: ReadonlyArray<Request>
  readonly updateRows: ReadonlyArray<Row>
  readonly getAfterUpdate: { readonly ok?: unknown; readonly failed?: string }
  /** After `changeGroup`, where the shape has one. */
  readonly groupRows?: ReadonlyArray<Row>
  readonly getAfterGroup?: { readonly ok?: unknown; readonly failed?: string }
}

const outcome = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit)
    ? { ok: plain(exit.value) }
    : { failed: String((Cause.squash(exit.cause) as any)?._tag ?? "Error") }

/** The steps the fixture recorded, on a fresh table holding `seeded`: `create` only when none. */
const run = (harness: Harness, shape: Shape, seeded: ReadonlyArray<Row>) =>
  harness.onTable(
    (tableName) =>
      Effect.gen(function* () {
        if (seeded.length > 0) yield* harness.seed(tableName, seeded)
        const Main = Table.make({ schema, entities: {} })
        const A = (Aggregate.make as any)(shape.model, {
          table: Main,
          schema,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "whole" },
          root: { entityType: "Root" },
          edges: shape.edges,
        })
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { A },
          tables: { Main },
        } as never).pipe(Effect.provide(Main.layer({ name: tableName })))
        const step = (effect: Effect.Effect<unknown, unknown>) =>
          Effect.map(
            Effect.exit(effect.pipe(Effect.provide(Main.layer({ name: tableName })))),
            outcome,
          )
        const rows = () => Effect.map(harness.rows(tableName), bySortKey)
        yield* harness.requests(tableName)
        const create =
          seeded.length > 0 ? { ok: undefined } : yield* step(db.aggregates.A.create(shape.input))
        const requests = yield* harness.requests(tableName)
        const created = yield* rows()
        const get = yield* step(db.aggregates.A.get({ id: "a" }))
        yield* harness.requests(tableName)
        const noop = yield* step(
          db.aggregates.A.update({ id: "a" }, ({ state }: any) => ({ ...state })),
        )
        const noopRequests = yield* harness.requests(tableName)
        const noopRows = yield* rows()
        const update = yield* step(
          db.aggregates.A.update({ id: "a" }, ({ state }: any) => ({ ...state, title: "t2" })),
        )
        const updateRequests = yield* harness.requests(tableName)
        const updateRows = yield* rows()
        const getAfterUpdate = yield* step(db.aggregates.A.get({ id: "a" }))
        const changeGroup = shape.changeGroup
        const group =
          changeGroup === undefined
            ? {}
            : {
                groupRows: yield* Effect.andThen(
                  step(db.aggregates.A.update({ id: "a" }, ({ state }: any) => changeGroup(state))),
                  rows(),
                ),
                getAfterGroup: yield* step(db.aggregates.A.get({ id: "a" })),
              }
        return {
          ...group,
          create,
          requests,
          rows: created,
          get,
          noop,
          noopRequests,
          noopRows,
          update,
          updateRequests,
          updateRows,
          getAfterUpdate,
        } satisfies Run
      }) as Effect.Effect<Run, unknown, any>,
  )

const retitled = (value: unknown) => ({ ...(value as object), title: "t2" })

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("a many element whose schema shows no fields is stored in its stored form", () => {
    it("the fixture is the one published 1.40.0 and 1.39.0 produced", () => {
      expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0", "effect-dynamodb@1.39.0"])
      expect(Object.keys(published["1.40.0"]).sort()).toEqual(Object.keys(shapes).sort())
    })

    for (const [label, define] of Object.entries(shapes)) {
      const then = published["1.40.0"][label]!

      it(`${label}: create and a changed update store the element encoded once, and reads return the value`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const shape = define()
            const actual = yield* run(harness, shape, [])
            // 1.40.0 stored the element as the domain value it held; everything else is 1.40.0's.
            const element = actual.rows.filter(isLine)
            expect(element.map(({ pk, sk, __edd_e__, ...rest }) => rest)).toEqual([shape.stored])
            expect(element.map(({ pk, sk, __edd_e__, ...rest }) => rest)).not.toEqual(
              then.rows.filter(isLine).map(({ pk, sk, __edd_e__, ...rest }) => rest),
            )
            expect(actual.create).toEqual(then.create)
            expect(actual.requests).toEqual(storedRequests(then.requests, shape.stored))
            expect(actual.rows).toEqual(then.rows.map((row) => storedRow(row, shape.stored)))
            const read = shape.read === undefined ? then.get : { ok: shape.read }
            expect(actual.get).toEqual(read)
            expect(actual.noopRequests).toEqual(then.noopRequests)
            expect(actual.noopRequests.map((request) => request.command)).toEqual(["Query"])
            expect(actual.noop).toEqual(read)
            expect(actual.updateRequests).toEqual(storedRequests(then.updateRequests, shape.stored))
            expect(actual.updateRows).toEqual(
              then.updateRows.map((row) => storedRow(row, shape.stored)),
            )
            expect(actual.update).toEqual({ ok: retitled(read.ok) })
            expect(actual.getAfterUpdate).toEqual({ ok: retitled(read.ok) })
          }),
        ))

      it(`${label}: rows 1.40.0 stored read as before, a no-op writes nothing, and a changed update of the element's group stores it encoded`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const shape = define()
            const actual = yield* run(harness, shape, then.rows)
            expect(actual.get).toEqual(then.get)
            expect(actual.noop).toEqual(then.noop)
            expect(actual.noopRequests).toEqual(then.noopRequests)
            expect(actual.noopRows).toEqual(then.rows)
            expect(actual.getAfterUpdate).toEqual(then.getAfterUpdate)
            if (shape.changeGroup === undefined) {
              // The root's title is in the element's group.
              expect(actual.updateRequests).toEqual(
                storedRequests(then.updateRequests, shape.stored),
              )
              expect(actual.updateRows).toEqual(
                then.updateRows.map((row) => storedRow(row, shape.stored)),
              )
              return
            }
            // The title's write leaves the element's group as it is, then a change of that group
            // rewrites it.
            expect(actual.updateRequests).toEqual(then.updateRequests)
            expect(actual.updateRows).toEqual(then.updateRows)
            expect(actual.groupRows!.filter(isLine)).toEqual(
              then.updateRows.filter(isLine).map((row) => storedRow(row, shape.stored)),
            )
            expect(actual.getAfterGroup).toEqual({
              ok: {
                ...(shape.read as any),
                title: "t2",
                part: { ...(shape.read as any).part, name: "p2" },
              },
            })
          }),
        ))
    }

    it("rows 1.39.0 stored read as 1.40.0 reads them, where 1.39.0 couldn't read them back", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const stored = Object.entries(published["1.39.0"]).filter(
            ([, then]) => then.create.ok !== undefined,
          )
          expect(stored.map(([label]) => label).sort()).toEqual([
            "a nullable struct holding a DateTimeUtcFromString",
            "a union member holding a NumberFromString",
            "a union member renaming a field, given its stored form",
            "an element through Schema.encodeKeys, given its stored form",
          ])
          for (const [label, then] of stored) {
            const actual = yield* run(harness, shapes[label]!(), then.rows)
            expect({ label, get: actual.get }).toEqual({
              label,
              get: published["1.40.0"][label]!.get,
            })
            expect({ label, after: actual.getAfterUpdate }).toEqual({
              label,
              after: { ok: retitled((published["1.40.0"][label]!.get as { ok: unknown }).ok) },
            })
          }
        }),
      ))

    it("a transformed field in a union member is encoded once, and a no-op writes nothing", () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const value = { kind: "a", qty: 3, p: "x" }
          const actual = yield* run(harness, rootShape(paddedMember, value, {}), [])
          expect(actual.rows.filter(isLine).map(({ pk, sk, __edd_e__, ...rest }) => rest)).toEqual([
            { kind: S("a"), qty: N("3"), p: S("x ") },
          ])
          expect(actual.get).toEqual({ ok: { id: "a", title: "t", lines: [value] } })
          expect(actual.noopRequests.map((request) => request.command)).toEqual(["Query"])
          expect(actual.noopRows).toEqual(actual.rows)
          expect(actual.updateRows.filter(isLine)).toEqual(actual.rows.filter(isLine))
          expect(actual.getAfterUpdate).toEqual({ ok: { id: "a", title: "t2", lines: [value] } })
        }),
      ))
  })
