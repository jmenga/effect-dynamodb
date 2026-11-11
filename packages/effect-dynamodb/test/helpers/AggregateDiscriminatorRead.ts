/**
 * The attributes the library writes on an edge's rows beside its value stay out of the value on a
 * read (#241): a sub-aggregate's discriminator, written on every row beneath it, a `one` edge's own
 * discriminator, and the aggregate's key attributes not named `pk` or `sk` (the collection sort
 * key's mirror, `csk`, and a partition key attribute named `PK`). A value decoded through a struct
 * drops them anyway; `Schema.Unknown` (alone, suspended or in a union of schemas known exactly) was
 * handed them back inside, by 1.39.0 and 1.40.0 alike. Exact or absent: a value that can hold one
 * (a struct declaring the name, a record) keeps it as before, a value whose schema can't be seen
 * into (a declaration, a transformation, a union with such a member) reads exactly as 1.40.0 read
 * it, and a custom `assemble` is still handed them.
 *
 * Nothing written changes for this: `create` and a no-op `update` send and store what 1.40.0 did,
 * and the no-op `update` still sends only its read. A union member that renames a field and is given
 * its domain value is now stored in its stored form, `line` where 1.40.0 stored `text`, and read
 * through its transformation, which takes only its own fields: `helpers/AggregateWholeElements.ts`.
 *
 * `fixtures/aggregate-discriminator-read-1.39.0.json` holds what published 1.39.0 and 1.40.0 did
 * for each of `shapes` on DynamoDB Local, and `fixtures/aggregate-discriminator-read-opaque-1.40.0.json`
 * for each of `opaqueShapes`. One suite, run on a recording table
 * (`AggregateDiscriminatorRead.test.ts`) and against DynamoDB Local
 * (`connected.aggregate-discriminator-read.test.ts`).
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema, SchemaGetter } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Table from "../../src/Table.js"
import { renamedAttribute, storedAsNow } from "./AggregateWholeElements.js"

type Row = Record<string, AttributeValue>
type Request = { readonly command: string; readonly input: unknown }
type Outcome = {
  readonly ok?: unknown
  readonly failed?: string
  readonly operation?: string | undefined
  readonly cause?: string
}
type Recorded = {
  readonly create: Outcome
  readonly requests: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
  readonly get: Outcome
  readonly update: Outcome
  readonly updateRequests: ReadonlyArray<Request>
  readonly updateRows: ReadonlyArray<Row>
  readonly getAfterUpdate: Outcome
}

type Published = {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.39.0": Record<string, Recorded>
  readonly "1.40.0": Record<string, Recorded>
}
const fixture = (name: string): Published =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"))
const published = fixture("aggregate-discriminator-read-1.39.0.json")
const publishedOpaque = fixture("aggregate-discriminator-read-opaque-1.40.0.json")

const schema = DynamoSchema.make({ name: "disc", version: 1 })
export const Main = Table.make({ schema, entities: {} })

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
const isObject = (x: unknown): x is object => typeof x === "object" && x !== null

type Shape = {
  readonly model: Schema.Top
  readonly edges: Record<string, unknown>
  /** The aggregate's `collection`, when it isn't `{ name: "agg" }`. */
  readonly collection?: unknown
  /** The partition key attribute, when it isn't `pk`. */
  readonly pk?: string
  readonly input: unknown
  /** What a read returns. */
  readonly read: unknown
  /** What published 1.40.0's read returned. */
  readonly published: unknown
  /**
   * An element whose schema shows no fields, which 1.40.0 stored as its domain value: its row as
   * this release stores it (`helpers/AggregateWholeElements.ts`).
   */
  readonly nowStored?: (row: Row) => Row
  /**
   * A value declaring a field named like a key attribute its rows hold: 1.40.0 read the key text back
   * in it, whatever was given. `Aggregate.make` now refuses it (`EDD-9159`); this is the message.
   */
  readonly refused?: string
}

const sheets = () => Aggregate.many({ entityType: "Sheet", sk: { composite: ["qty"] } } as never)

/** A `many` edge of `element`s: on the root, or on a sub-aggregate bound with `side: 1`. */
const manyShape = (
  element: Schema.Top,
  value: unknown,
  sub: boolean,
  read: unknown,
  publishedRead: unknown,
): Shape => {
  if (!sub) {
    return {
      model: Schema.Struct({ id: Schema.String, lines: Schema.Array(element as never) }),
      edges: { lines: sheets() },
      input: { id: "a", lines: [value] },
      read: { id: "a", lines: [read] },
      published: { id: "a", lines: [publishedRead] },
    }
  }
  const Part = Schema.Struct({ lines: Schema.Array(element as never) })
  const Sub = (Aggregate.make as any)(Part, {
    root: { entityType: "Part" },
    edges: { lines: sheets() },
  })
  return {
    model: Schema.Struct({ id: Schema.String, part: Part }),
    edges: { part: Sub.with({ discriminator: { side: 1 } }) },
    input: { id: "a", part: { lines: [value] } },
    read: { id: "a", part: { lines: [read] } },
    published: { id: "a", part: { lines: [publishedRead] } },
  }
}

const note = { qty: 1, note: "n" }
const own = { kind: "own", qty: 3, text: "KEEP" }

export const shapes: Record<string, () => Shape> = {
  "a union member renaming a field, given its domain value": () => ({
    ...manyShape(renaming(), own, false, own, own),
    nowStored: renamedAttribute("text", "line"),
  }),
  // A union with a transformation member can't be seen into. 1.40.0 read the domain value it stored
  // as it was, the discriminator with it; the stored form is read through the transformation.
  "sub-aggregate, a union member renaming a field, given its domain value": () => ({
    ...manyShape(renaming(), own, true, own, { ...own, side: 1 }),
    nowStored: renamedAttribute("text", "line"),
  }),
  "sub-aggregate, an Unknown element": () =>
    manyShape(Schema.Unknown, note, true, note, { ...note, side: 1 }),
  // A declaration can't be seen into: read as 1.40.0 read it.
  "sub-aggregate, a declared element": () =>
    manyShape(Schema.declare(isObject), note, true, { ...note, side: 1 }, { ...note, side: 1 }),
  "sub-aggregate, a struct element declaring the discriminator's name": () =>
    manyShape(
      Schema.Struct({ qty: Schema.Number, side: Schema.Number }),
      { qty: 1, side: 1 },
      true,
      { qty: 1, side: 1 },
      { qty: 1, side: 1 },
    ),
  "sub-aggregate, a record element": () =>
    manyShape(
      Schema.Record(Schema.String, Schema.Unknown),
      note,
      true,
      { ...note, side: 1 },
      { ...note, side: 1 },
    ),
  "sub-aggregate, an Unknown one edge": () => {
    const Part = Schema.Struct({ title: Schema.String, note: Schema.Unknown })
    const Sub = (Aggregate.make as any)(Part, {
      root: { entityType: "Part" },
      edges: { note: Aggregate.one({ entityType: "Note" } as never) },
    })
    return {
      model: Schema.Struct({ id: Schema.String, part: Part }),
      edges: { part: Sub.with({ discriminator: { side: 1 } }) },
      input: { id: "a", part: { title: "p", note: { text: "n" } } },
      read: { id: "a", part: { title: "p", note: { text: "n" } } },
      published: { id: "a", part: { title: "p", note: { text: "n", side: 1 } } },
    }
  },
  "an Unknown one edge with its own discriminator": () => ({
    model: Schema.Struct({ id: Schema.String, note: Schema.Unknown }),
    edges: {
      note: Aggregate.one({ entityType: "Note", discriminator: { slot: "main" } } as never),
    },
    input: { id: "a", note: { text: "n" } },
    read: { id: "a", note: { text: "n" } },
    published: { id: "a", note: { text: "n", slot: "main" } },
  }),
  "sub-aggregate, an Unknown element with a custom assemble": () => {
    const Part = Schema.Struct({ lines: Schema.Array(Schema.Unknown) })
    const Sub = (Aggregate.make as any)(Part, {
      root: { entityType: "Part" },
      edges: {
        lines: Aggregate.many({
          entityType: "Sheet",
          sk: { composite: ["qty"] },
          assemble: (items: ReadonlyArray<unknown>) => items,
          decompose: (value: unknown) => value,
        } as never),
      },
    })
    const read = { id: "a", part: { lines: [{ ...note, side: 1 }] } }
    return {
      model: Schema.Struct({ id: Schema.String, part: Part }),
      edges: { part: Sub.with({ discriminator: { side: 1 } }) },
      input: { id: "a", part: { lines: [note] } },
      read,
      published: read,
    }
  },
}

/** Assembled off the local index `lsi1`, whose sort key is the collection sort key's mirror. */
const mirrored = { name: "agg", index: "lsi1", sk: { field: "csk", composite: [] } }
/** The local index every table has, for the shapes assembled off it. */
export const INDEX = { name: "lsi1", sk: "csk" } as const

shapes["an Unknown element, the collection sort key mirrored in csk"] = () => ({
  model: Schema.Struct({ id: Schema.String, lines: Schema.Array(Schema.Unknown) }),
  edges: { lines: sheets() },
  collection: mirrored,
  input: { id: "a", lines: [note] },
  read: { id: "a", lines: [note] },
  published: { id: "a", lines: [{ ...note, csk: "$disc#v1#sheet#0000000000000001" }] },
})
shapes["an Unknown one edge, the collection sort key mirrored in csk"] = () => ({
  model: Schema.Struct({ id: Schema.String, note: Schema.Unknown }),
  edges: { note: Aggregate.one({ entityType: "Note" } as never) },
  collection: mirrored,
  input: { id: "a", note: { text: "n" } },
  read: { id: "a", note: { text: "n" } },
  published: { id: "a", note: { text: "n", csk: "$disc#v1#note" } },
})
shapes["a struct element declaring csk, the collection sort key mirrored in csk"] = () => {
  // 1.40.0 read the mirror back in the struct's `csk`, given none. Refused at make now.
  const read = { id: "a", lines: [{ qty: 1, csk: "$disc#v1#sheet#0000000000000001" }] }
  return {
    model: Schema.Struct({
      id: Schema.String,
      lines: Schema.Array(
        Schema.Struct({ qty: Schema.Number, csk: Schema.optional(Schema.String) }),
      ),
    }),
    edges: { lines: sheets() },
    collection: mirrored,
    input: { id: "a", lines: [{ qty: 1 }] },
    read,
    published: read,
    refused:
      '[EDD-9159] Aggregate "Root": an element of edge "lines" declares a field "csk", which is ' +
      "also the attribute holding the collection sort key's copy.",
  }
}

const requiresSide = (u: unknown): u is { readonly side: 1 } =>
  isObject(u) && (u as { readonly side?: unknown }).side === 1
const identity = {
  decode: SchemaGetter.transform((x: unknown) => x),
  encode: SchemaGetter.transform((x: unknown) => x),
}
const sideNote = { ...note, side: 1 }
/** Keyed under `PK`, assembled off `lsi1` (`PK`, `csk`). */
const underPK = { collection: mirrored, pk: "PK" } as const

/** Shapes captured in `fixtures/aggregate-discriminator-read-opaque-1.40.0.json`. */
export const opaqueShapes: Record<string, () => Shape> = {
  "sub-aggregate, a declared element requiring the discriminator": () =>
    manyShape(
      Schema.declare(
        (u): u is { qty: number; side: 1 } =>
          requiresSide(u) && typeof (u as { qty?: unknown }).qty === "number",
      ),
      { qty: 1, side: 1 },
      true,
      { side: 1, qty: 1 },
      { side: 1, qty: 1 },
    ),
  "sub-aggregate, a union of a struct and a declared element": () =>
    manyShape(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a"), qty: Schema.Number }),
        Schema.declare(isObject),
      ]),
      note,
      true,
      sideNote,
      sideNote,
    ),
  "sub-aggregate, a transformed element": () =>
    manyShape(
      (Schema.Struct({ qty: Schema.Number, note: Schema.String }) as any).pipe(
        Schema.decodeTo(Schema.Unknown, identity as never),
      ),
      note,
      true,
      note,
      note,
    ),
  // Known exactly: `Unknown` behind a suspension, or beside a struct in a union.
  "sub-aggregate, a suspended Unknown element": () =>
    manyShape(
      Schema.suspend(() => Schema.Unknown),
      note,
      true,
      note,
      sideNote,
    ),
  "sub-aggregate, a union of a struct and Unknown": () =>
    manyShape(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a"), qty: Schema.Number }),
        Schema.Unknown,
      ]),
      note,
      true,
      note,
      sideNote,
    ),
  "sub-aggregate, a declared one edge requiring the discriminator": () => {
    const Part = Schema.Struct({ title: Schema.String, note: Schema.declare(requiresSide) })
    const Sub = (Aggregate.make as any)(Part, {
      root: { entityType: "Part" },
      edges: { note: Aggregate.one({ entityType: "Note" } as never) },
    })
    const read = { id: "a", part: { title: "p", note: { side: 1, text: "n" } } }
    return {
      model: Schema.Struct({ id: Schema.String, part: Part }),
      edges: { part: Sub.with({ discriminator: { side: 1 } }) },
      input: { id: "a", part: { title: "p", note: { text: "n", side: 1 } } },
      read,
      published: read,
    }
  },
  "an Unknown element, keyed under PK": () => ({
    model: Schema.Struct({ id: Schema.String, lines: Schema.Array(Schema.Unknown) }),
    edges: { lines: sheets() },
    ...underPK,
    input: { id: "a", lines: [note] },
    read: { id: "a", lines: [note] },
    published: {
      id: "a",
      lines: [{ ...note, csk: "$disc#v1#sheet#0000000000000001", PK: "$disc#v1#agg#a" }],
    },
  }),
  "an Unknown one edge, keyed under PK": () => ({
    model: Schema.Struct({ id: Schema.String, note: Schema.Unknown }),
    edges: { note: Aggregate.one({ entityType: "Note" } as never) },
    ...underPK,
    input: { id: "a", note: { text: "n" } },
    read: { id: "a", note: { text: "n" } },
    published: { id: "a", note: { text: "n", csk: "$disc#v1#note", PK: "$disc#v1#agg#a" } },
  }),
  "a struct element declaring PK, keyed under PK": () => {
    // 1.40.0 read the partition key back in the struct's `PK`, given none. Refused at make now.
    const read = { id: "a", lines: [{ qty: 1, PK: "$disc#v1#agg#a" }] }
    return {
      model: Schema.Struct({
        id: Schema.String,
        lines: Schema.Array(
          Schema.Struct({ qty: Schema.Number, PK: Schema.optional(Schema.String) }),
        ),
      }),
      edges: { lines: sheets() },
      ...underPK,
      input: { id: "a", lines: [{ qty: 1 }] },
      read,
      published: read,
      refused:
        '[EDD-9159] Aggregate "Root": an element of edge "lines" declares a field "PK", which is ' +
        "also the attribute holding the partition key.",
    }
  },
}

export interface Harness {
  /** Run `body` on a fresh, empty table named `tableName`, keyed by `pk` (`"pk"`) and `sk`. */
  readonly onTable: <A, E>(
    body: (tableName: string) => Effect.Effect<A, E, any>,
    pk?: string,
  ) => Effect.Effect<A, unknown>
  /** Every row of the table. */
  readonly rows: (tableName: string) => Effect.Effect<ReadonlyArray<Row>>
  /** The requests sent since the last call: commands and inputs, the table's name as `<table>`. */
  readonly requests: (tableName: string) => Effect.Effect<ReadonlyArray<Request>>
}

const keyOf = (row: Row) => `${(row.pk ?? row.PK)?.S} ${row.sk?.S}`
const sorted = (rows: ReadonlyArray<Row>) =>
  [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))

const outcome = (exit: Exit.Exit<unknown, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value)) }
  const error = Cause.squash(exit.cause) as { _tag?: string; operation?: string }
  return { failed: error._tag ?? "defect", operation: error.operation }
}

/** An outcome as compared: a value, or a failure by its tag and operation. */
const judged = (result: Outcome) =>
  result.failed === undefined
    ? { ok: result.ok }
    : { failed: result.failed, operation: result.operation }

const run = (harness: Harness, shape: Shape) =>
  harness.onTable(
    (tableName) =>
      Effect.gen(function* () {
        const A = (Aggregate.make as any)(shape.model, {
          table: Main,
          schema,
          pk: { field: shape.pk ?? "pk", composite: ["id"] },
          collection: shape.collection ?? { name: "agg" },
          root: { entityType: "Root" },
          edges: shape.edges,
        })
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { A },
          tables: { Main },
        } as never)
        yield* harness.requests(tableName)
        const create = outcome(yield* Effect.exit(db.aggregates.A.create(shape.input)))
        const requests = yield* harness.requests(tableName)
        const rows = sorted(yield* harness.rows(tableName))
        const get = outcome(yield* Effect.exit(db.aggregates.A.get({ id: "a" })))
        yield* harness.requests(tableName)
        const update = outcome(
          yield* Effect.exit(
            db.aggregates.A.update({ id: "a" }, ({ state }: any) => ({ ...state })),
          ),
        )
        const updateRequests = yield* harness.requests(tableName)
        const updateRows = sorted(yield* harness.rows(tableName))
        const getAfterUpdate = outcome(yield* Effect.exit(db.aggregates.A.get({ id: "a" })))
        return {
          create,
          requests,
          rows,
          get,
          update,
          updateRequests,
          updateRows,
          getAfterUpdate,
        } satisfies Recorded
      }),
    shape.pk,
  )

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("a discriminator written on an edge's rows stays out of its value on a read", () => {
    it("the fixture is published 1.39.0's and 1.40.0's, for every shape", () => {
      expect(published.generatedFrom).toEqual(["effect-dynamodb@1.39.0", "effect-dynamodb@1.40.0"])
      expect(Object.keys(published["1.39.0"]).sort()).toEqual(Object.keys(shapes).sort())
      expect(Object.keys(published["1.40.0"]).sort()).toEqual(Object.keys(shapes).sort())
    })

    it("1.39.0 did what 1.40.0 did, but refused a union member's domain value", () => {
      for (const [label, was] of Object.entries(published["1.39.0"])) {
        const then = published["1.40.0"][label]!
        if (label.includes("given its domain value")) {
          expect({ label, ...judged(was.create) }).toEqual({
            label,
            failed: "ValidationError",
            operation: "aggregate.create",
          })
          expect(was.rows).toEqual([])
          continue
        }
        expect({ label, ...was }).toEqual({ label, ...then })
      }
    })

    it("the opaque fixture is published 1.39.0's and 1.40.0's, which did the same", () => {
      expect(publishedOpaque.generatedFrom).toEqual([
        "effect-dynamodb@1.39.0",
        "effect-dynamodb@1.40.0",
      ])
      expect(Object.keys(publishedOpaque["1.40.0"]).sort()).toEqual(
        Object.keys(opaqueShapes).sort(),
      )
      expect(publishedOpaque["1.39.0"]).toEqual(publishedOpaque["1.40.0"])
    })

    for (const [set, thenSet] of [
      [shapes, published["1.40.0"]],
      [opaqueShapes, publishedOpaque["1.40.0"]],
    ] as const) {
      for (const [label, define] of Object.entries(set)) {
        it(`${label}: sends and stores what 1.40.0 did, and reads back the value`, () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const shape = define()
              const then = thenSet[label]!
              if (shape.refused !== undefined) {
                // 1.40.0 stored it and read the key text back in the field, given none.
                expect({ ...judged(then.get) }).toEqual({ ok: shape.published })
                const refusal = yield* Effect.exit(run(harness, shape))
                expect(Exit.isFailure(refusal)).toBe(true)
                expect(Cause.pretty((refusal as Exit.Failure<unknown, unknown>).cause)).toContain(
                  shape.refused,
                )
                return
              }
              const actual = yield* run(harness, shape)
              const now =
                shape.nowStored === undefined
                  ? { row: (row: Row) => row, requests: (sent: unknown) => sent }
                  : storedAsNow("Sheet", shape.nowStored)
              expect(judged(actual.create)).toEqual(judged(then.create))
              expect(actual.requests).toEqual(now.requests(then.requests))
              expect(actual.rows).toEqual(sorted(then.rows.map(now.row)))
              // A no-op update sends its read and nothing else.
              expect(actual.updateRequests.map((request) => request.command)).toEqual(["Query"])
              expect(actual.updateRequests).toEqual(then.updateRequests)
              expect(actual.updateRows).toEqual(sorted(then.updateRows.map(now.row)))
              for (const step of ["get", "update", "getAfterUpdate"] as const) {
                expect({ step, ...judged(then[step]) }).toEqual({ step, ok: shape.published })
                expect({ step, ...judged(actual[step]) }).toEqual({ step, ok: shape.read })
              }
            }),
          ))
      }
    }
  })
