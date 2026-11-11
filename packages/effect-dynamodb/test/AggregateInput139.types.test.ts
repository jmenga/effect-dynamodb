/**
 * Every aggregate input published 1.39.0's input type (`Aggregate.Input`) accepted still compiles.
 * The input type may only add to 1.39.0's: the forms `create` takes an id of the entity's key
 * composite in are added beside each element 1.39.0 typed, never in its place. Each value below
 * compiles against published 1.39.0's type as written (checked against the published package),
 * and fails `pnpm check` here if it stops compiling.
 *
 * - An element with an `id: string` (ref-like to 1.39.0) given as an id, whatever else it declares.
 * - An element's ref-like field given as `${field}Id`, the entity's field or another (`captainId`).
 * - An element holding the entity optionally, given it whole or nothing, as declared.
 * - An element that is the entity given as ids; a union element's ref-like field by id.
 * - A `one` edge's id; a sub-aggregate's element by id.
 *
 * Each over a `Schema.Class` model, whose field name the type doesn't see, and over a
 * `Schema.Struct` model, whose field name it does. Beside them, over the struct, the forms added:
 * the element whole with `${field}Id` given too (an explicit `undefined` included), which 1.39.0's
 * `create` took (`Record<string, unknown>`): neither form refuses the other's key.
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Schema } from "effect"
import { describe, expectTypeOf, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

class Line extends Schema.Class<Line>("Line")({ id: Schema.String, f: Schema.Number }) {}
const Lines = Entity.make({
  model: DynamoModel.configure(Line, { id: { identifier: true } }),
  entityType: "Line",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
class Numbered extends Schema.Class<Numbered>("Numbered")({
  lineId: Schema.Number,
  f: Schema.Number,
}) {}
const NumberedLines = Entity.make({
  model: Numbered,
  entityType: "Numbered",
  primaryKey: { pk: { field: "pk", composite: ["lineId"] }, sk: { field: "sk", composite: [] } },
})
const schema = DynamoSchema.make({ name: "input-139", version: 1 })
const MainTable = Table.make({ schema, entities: { Lines, NumberedLines } })
const many = (entityType: string) => Aggregate.many({ entityType, entity: Lines })

const Part = Schema.Struct({
  lines: Schema.Array(Schema.Struct({ line: Line, qty: Schema.Number })),
})
const Sub = Aggregate.make(Part, {
  root: { entityType: "Part" },
  edges: { lines: many("PartLine") },
})

const Root = Aggregate.make(
  Schema.Struct({
    id: Schema.String,
    refLike: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        line: Schema.optional(Line),
        qty: Schema.optional(Schema.Number),
      }),
    ),
    sheets: Schema.Array(Schema.Struct({ line: Line, qty: Schema.Number })),
    maybeSheets: Schema.Array(Schema.Struct({ line: Schema.optional(Line), qty: Schema.Number })),
    entities: Schema.Array(Line),
    crews: Schema.Array(Schema.Struct({ captain: Line, qty: Schema.Number })),
    kinds: Schema.Array(
      Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a"), line: Line }),
        Schema.Struct({ kind: Schema.Literal("b"), label: Schema.String }),
      ]),
    ),
    numbered: Schema.Array(Schema.Struct({ numbered: Numbered, qty: Schema.Number })),
    line: Line,
    maybeLine: Schema.optional(Line),
    part: Part,
  }),
  {
    table: MainTable,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "agg" },
    root: { entityType: "Root" },
    edges: {
      refLike: many("RefLike"),
      sheets: many("Sheet"),
      maybeSheets: many("MaybeSheet"),
      entities: many("EntityLine"),
      crews: many("Crew"),
      kinds: many("Kind"),
      numbered: Aggregate.many({ entityType: "NumberedSheet", entity: NumberedLines }),
      line: Aggregate.one({ entityType: "OneLine", entity: Lines }),
      maybeLine: Aggregate.one({ entityType: "MaybeLine", entity: Lines }),
      part: Sub.with({ discriminator: { side: 1 } }),
    },
  },
)

type Input = Aggregate.Input<typeof Root>

/**
 * A `Schema.Struct` model with an `id: string`, whose field name (`line`) the type sees: an element
 * naming it takes the id forms beside 1.39.0's, which took the model by id as ref-like.
 */
const LineRow = Schema.Struct({ id: Schema.String, f: Schema.Number })
const LineRows = Entity.make({
  model: LineRow,
  entityType: "Line",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const RowTable = Table.make({ schema, entities: { LineRows } })
const rows = (entityType: string) => Aggregate.many({ entityType, entity: LineRows })
const RowPart = Schema.Struct({
  lines: Schema.Array(Schema.Struct({ line: LineRow, qty: Schema.Number })),
})
const RowSub = Aggregate.make(RowPart, {
  root: { entityType: "Part" },
  edges: { lines: rows("PartLine") },
})
const RowRoot = Aggregate.make(
  Schema.Struct({
    id: Schema.String,
    refLike: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        line: Schema.optional(LineRow),
        qty: Schema.optional(Schema.Number),
      }),
    ),
    sheets: Schema.Array(Schema.Struct({ line: LineRow, qty: Schema.Number })),
    maybeSheets: Schema.Array(
      Schema.Struct({ line: Schema.optional(LineRow), qty: Schema.Number }),
    ),
    entities: Schema.Array(LineRow),
    part: RowPart,
  }),
  {
    table: RowTable,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "agg" },
    root: { entityType: "Root" },
    edges: {
      refLike: rows("RefLike"),
      sheets: rows("Sheet"),
      maybeSheets: rows("MaybeSheet"),
      entities: rows("EntityLine"),
      part: RowSub.with({ discriminator: { side: 1 } }),
    },
  },
)

type RowInput = Aggregate.Input<typeof RowRoot>

const line = new Line({ id: "L", f: 1 })
const numbered = new Numbered({ lineId: 5, f: 1 })

// Compile-enforced: each of these compiles against published 1.39.0's input type.
const _accepted139: ReadonlyArray<Input> = [
  {
    refLike: ["L"],
    sheets: [{ lineId: "L", qty: 1 }],
    maybeSheets: [{ line, qty: 1 }, { qty: 1 }],
    entities: ["L"],
    crews: [{ captainId: "L", qty: 1 }],
    kinds: [
      { kind: "a", lineId: "L" },
      { kind: "b", label: "x" },
    ],
    numbered: [{ numbered, qty: 1 }],
    lineId: "L",
    maybeLineId: "L",
    part: { lines: [{ lineId: "L", qty: 1 }] },
  },
  {
    refLike: [],
    sheets: [],
    maybeSheets: [],
    entities: [],
    crews: [],
    kinds: [],
    numbered: [],
    lineId: "L",
    part: { lines: [] },
  },
]
void _accepted139

// Compile-enforced: each of these compiles against published 1.39.0's input type.
const row = { id: "L", f: 1 }
const _rowsAccepted139: ReadonlyArray<RowInput> = [
  {
    refLike: ["L"],
    sheets: [{ lineId: "L", qty: 1 }],
    maybeSheets: [{ line: row, qty: 1 }, { qty: 1 }],
    entities: ["L"],
    part: { lines: [{ lineId: "L", qty: 1 }] },
  },
]
void _rowsAccepted139

// Compile-enforced: the forms added beside 1.39.0's, the element whole with its id beside it (as
// 1.39.0's `create` took it, `Record<string, unknown>`) among them.
const _rowsAdded: ReadonlyArray<RowInput> = [
  {
    refLike: [
      { id: "x", line: row, qty: 1 },
      { id: "x", lineId: "L" },
    ],
    sheets: [
      { line: row, qty: 1 },
      { line: row, lineId: "L", qty: 1 },
      { line: row, lineId: undefined, qty: 1 },
    ],
    maybeSheets: [
      { lineId: "L", qty: 1 },
      { line: row, lineId: "L", qty: 1 },
      { lineId: undefined, qty: 1 },
    ],
    entities: [row],
    part: { lines: [{ line: row, qty: 1 }] },
  },
]
void _rowsAdded

describe("1.39.0's input forms are kept, the id forms added beside them", () => {
  it("an element with an `id: string` is still taken by id, as 1.39.0 took it", () => {
    expectTypeOf<"L">().toExtend<Input["refLike"][number]>()
    expectTypeOf<"L">().toExtend<Input["entities"][number]>()
    // Where the type sees the field holding the entity, too.
    expectTypeOf<"L">().toExtend<RowInput["refLike"][number]>()
    expectTypeOf<"L">().toExtend<RowInput["entities"][number]>()
  })

  it("an element naming the field holding the entity: whole, its id beside it or not, or by id", () => {
    expectTypeOf<RowInput["sheets"][number]>().toEqualTypeOf<
      | {
          readonly line: typeof LineRow.Type
          readonly qty: number
          readonly lineId?: string | undefined
        }
      | { readonly lineId: string; readonly qty: number }
    >()
  })

  it("an element's ref-like field is still taken by id (`captainId`), whatever its name", () => {
    expectTypeOf<{ readonly lineId: string; readonly qty: number }>().toExtend<
      Input["sheets"][number]
    >()
    expectTypeOf<{ readonly captainId: string; readonly qty: number }>().toExtend<
      Input["crews"][number]
    >()
    expectTypeOf<{ readonly kind: "a"; readonly lineId: string }>().toExtend<
      Input["kinds"][number]
    >()
    expectTypeOf<{ readonly lineId: string; readonly qty: number }>().toExtend<
      Input["part"]["lines"][number]
    >()
  })

  it("a `one` edge still takes the entity's id", () => {
    expectTypeOf<Input["lineId"]>().toEqualTypeOf<string>()
    expectTypeOf<Input["maybeLineId"]>().toEqualTypeOf<string | undefined>()
  })
})
