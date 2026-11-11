/**
 * A discriminator the library writes on an edge's rows stays out of the edge's value on a read
 * (#241). A sub-aggregate's discriminator is written on every row beneath it, and a `one` edge's
 * on its row. A value decoded through a struct drops it anyway; a value that keeps what it's given
 * (`Schema.Unknown`, a declaration, a union member falling back to one) was handed it back inside,
 * by 1.39.0 and 1.40.0 alike. A value that can hold it (a struct declaring the name, a record)
 * keeps it as before, and a custom `assemble` is still handed it.
 *
 * Nothing written changes: `create` and a no-op `update` send and store what 1.40.0 did, and the
 * no-op `update` still sends only its read. A union member that renames a field and is given its
 * domain value is still stored under the domain name (`text`, not `line`), as 1.40.0 stores it.
 *
 * `fixtures/aggregate-discriminator-read-1.39.0.json` holds what published 1.39.0 and 1.40.0 did
 * for each shape on DynamoDB Local. One suite, run on a recording table
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

const published = JSON.parse(
  readFileSync(
    new URL("../fixtures/aggregate-discriminator-read-1.39.0.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly generatedFrom: ReadonlyArray<string>
  readonly "1.39.0": Record<string, Recorded>
  readonly "1.40.0": Record<string, Recorded>
}

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
  readonly input: unknown
  /** What a read returns. */
  readonly read: unknown
  /** What published 1.40.0's read returned. */
  readonly published: unknown
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
  "a union member renaming a field, given its domain value": () =>
    manyShape(renaming(), own, false, own, own),
  "sub-aggregate, a union member renaming a field, given its domain value": () =>
    manyShape(renaming(), own, true, own, { ...own, side: 1 }),
  "sub-aggregate, an Unknown element": () =>
    manyShape(Schema.Unknown, note, true, note, { ...note, side: 1 }),
  "sub-aggregate, a declared element": () =>
    manyShape(Schema.declare(isObject), note, true, note, { ...note, side: 1 }),
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

export interface Harness {
  /** Run `body` on a fresh, empty table named `tableName`. */
  readonly onTable: <A, E>(
    body: (tableName: string) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
  /** Every row of the table. */
  readonly rows: (tableName: string) => Effect.Effect<ReadonlyArray<Row>>
  /** The requests sent since the last call: commands and inputs, the table's name as `<table>`. */
  readonly requests: (tableName: string) => Effect.Effect<ReadonlyArray<Request>>
}

const keyOf = (row: Row) => `${row.pk?.S} ${row.sk?.S}`
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
  harness.onTable((tableName) =>
    Effect.gen(function* () {
      const A = (Aggregate.make as any)(shape.model, {
        table: Main,
        schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "agg" },
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
        yield* Effect.exit(db.aggregates.A.update({ id: "a" }, ({ state }: any) => ({ ...state }))),
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

    for (const [label, define] of Object.entries(shapes)) {
      it(`${label}: sends and stores what 1.40.0 did, and reads back the value`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const shape = define()
            const then = published["1.40.0"][label]!
            const actual = yield* run(harness, shape)
            expect(judged(actual.create)).toEqual(judged(then.create))
            expect(actual.requests).toEqual(then.requests)
            expect(actual.rows).toEqual(sorted(then.rows))
            // A no-op update sends its read and nothing else.
            expect(actual.updateRequests.map((request) => request.command)).toEqual(["Query"])
            expect(actual.updateRequests).toEqual(then.updateRequests)
            expect(actual.updateRows).toEqual(sorted(then.updateRows))
            for (const step of ["get", "update", "getAfterUpdate"] as const) {
              expect({ step, ...judged(then[step]) }).toEqual({ step, ok: shape.published })
              expect({ step, ...judged(actual[step]) }).toEqual({ step, ok: shape.read })
            }
          }),
        ))
    }
  })
