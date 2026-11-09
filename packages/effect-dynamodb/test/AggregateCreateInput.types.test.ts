/**
 * Type-level tests for what an aggregate's `create` takes (`AggregateCreateInputType`), on the
 * aggregate, on the bound aggregate, and on the typed client's `db.aggregates`.
 *
 * `create` takes the aggregate's own key composites, which its input schema leaves out because a
 * caller supplies them (from a path, say). An edge whose entity one id names takes `${field}Id`, or
 * the entity whole under the field's name, or both, when the id is fetched. A many edge over such
 * an entity takes each element as its id or the entity whole, in any mix, and an element wrapping
 * the entity takes either in the field of the entity's name. The type sees that name for a
 * `Schema.Struct` model; for a `Schema.Class` model an element wrapping the entity is `unknown`, as
 * 1.39.0's `create` took it. An id is a value of the key
 * composite's type, or its stored or JSON form where that is another kind of value; in a union
 * element, a string only, as 1.39.0 fetched. A branded id keeps its brand.
 * Every other field takes its domain value, as `Entity.put`'s type asks, though at run time both
 * also take its wire form. The edges match what `create` does at run time
 * (`AggregateRefHydration.test.ts`).
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { type Effect, Schema } from "effect"
import { describe, expectTypeOf, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

const AppSchema = DynamoSchema.make({ name: "create-input", version: 1 })

const LineId = Schema.String.pipe(Schema.brand("LineId"))
type LineId = typeof LineId.Type

class NumberLine extends Schema.Class<NumberLine>("NumberLine")({
  lineId: Schema.Number,
  f: Schema.Number,
}) {}
class CodecLine extends Schema.Class<CodecLine>("CodecLine")({
  lineId: Schema.NumberFromString,
  f: Schema.Number,
}) {}
class DateLine extends Schema.Class<DateLine>("DateLine")({
  lineId: Schema.Date,
  f: Schema.Number,
}) {}
class BrandLine extends Schema.Class<BrandLine>("BrandLine")({
  lineId: LineId,
  f: Schema.Number,
}) {}
class StringLine extends Schema.Class<StringLine>("StringLine")({
  lineId: Schema.String,
  f: Schema.Number,
}) {}
class PairLine extends Schema.Class<PairLine>("PairLine")({
  tenant: Schema.String,
  lineId: Schema.String,
  f: Schema.Number,
}) {}

const keyedBy = (composite: "lineId") =>
  ({ pk: { field: "pk", composite: [composite] }, sk: { field: "sk", composite: [] } }) as const

const NumberLines = Entity.make({
  model: NumberLine,
  entityType: "NumberLine",
  primaryKey: keyedBy("lineId"),
})
const CodecLines = Entity.make({
  model: CodecLine,
  entityType: "CodecLine",
  primaryKey: keyedBy("lineId"),
})
const DateLines = Entity.make({
  model: DateLine,
  entityType: "DateLine",
  primaryKey: keyedBy("lineId"),
})
const BrandLines = Entity.make({
  model: BrandLine,
  entityType: "BrandLine",
  primaryKey: keyedBy("lineId"),
})
const StringLines = Entity.make({
  model: StringLine,
  entityType: "StringLine",
  primaryKey: keyedBy("lineId"),
})
const PairLines = Entity.make({
  model: PairLine,
  entityType: "PairLine",
  primaryKey: {
    pk: { field: "pk", composite: ["tenant"] },
    sk: { field: "sk", composite: ["lineId"] },
  },
})

/** `Schema.Struct` models: `create` takes the entity in the field its `entityType` names. */
const NumberRow = Schema.Struct({ lineId: Schema.Number, f: Schema.Number })
const StringRow = Schema.Struct({ lineId: Schema.String, f: Schema.Number })
const NumberRows = Entity.make({
  model: NumberRow,
  entityType: "NumberRow",
  primaryKey: keyedBy("lineId"),
})
const StringRows = Entity.make({
  model: StringRow,
  entityType: "StringRow",
  primaryKey: keyedBy("lineId"),
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: {
    NumberLines,
    CodecLines,
    DateLines,
    BrandLines,
    StringLines,
    PairLines,
    NumberRows,
    StringRows,
  },
})

class Team extends Schema.Class<Team>("Team")({
  name: Schema.String,
  captain: NumberLine,
}) {}

const TeamAggregate = Aggregate.make(Team, {
  root: { entityType: "Team" },
  edges: { captain: Aggregate.one({ entityType: "TeamCaptain", entity: NumberLines }) },
})

class Root extends Schema.Class<Root>("Root")({
  id: Schema.String,
  note: Schema.String,
  count: Schema.NumberFromString,
  numberLine: NumberLine,
  codecLine: CodecLine,
  dateLine: Schema.optional(DateLine),
  brandLine: BrandLine,
  pairLine: PairLine,
  refLine: NumberLine,
  numberLines: Schema.Array(NumberLine),
  sheets: Schema.Array(Schema.Struct({ numberRow: NumberRow, qty: Schema.Number })),
  maybeSheets: Schema.Array(
    Schema.Struct({ numberRow: Schema.optional(NumberRow), qty: Schema.Number }),
  ),
  classSheets: Schema.Array(Schema.Struct({ numberLine: NumberLine, qty: Schema.Number })),
  notes: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  team: Team,
}) {}

const RootAggregate = Aggregate.make(Root, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "root" },
  root: { entityType: "Root" },
  edges: {
    numberLine: Aggregate.one({ entityType: "RootNumberLine", entity: NumberLines }),
    codecLine: Aggregate.one({ entityType: "RootCodecLine", entity: CodecLines }),
    dateLine: Aggregate.one({ entityType: "RootDateLine", entity: DateLines }),
    brandLine: Aggregate.one({ entityType: "RootBrandLine", entity: BrandLines }),
    pairLine: Aggregate.one({ entityType: "RootPairLine", entity: PairLines }),
    refLine: Aggregate.ref(NumberLines),
    numberLines: Aggregate.many({
      entityType: "RootNumberLines",
      entity: NumberLines,
      sk: { composite: ["lineId"] },
    }),
    sheets: Aggregate.many({
      entityType: "RootSheet",
      entity: NumberRows,
      sk: { composite: ["qty"] },
    }),
    maybeSheets: Aggregate.many({
      entityType: "RootMaybeSheet",
      entity: NumberRows,
      sk: { composite: ["qty"] },
    }),
    classSheets: Aggregate.many({
      entityType: "RootClassSheet",
      entity: NumberLines,
      sk: { composite: ["qty"] },
    }),
    notes: Aggregate.many({ entityType: "RootNote", sk: { composite: ["id"] } }),
    team: TeamAggregate.with({ discriminator: { teamNumber: 1 } }),
  },
})

type Create = Parameters<typeof RootAggregate.create>[0]

/**
 * A many edge whose element is a union: a nested union of two members wrapping the entity, one of
 * them with a nullable discriminator, a member sharing a discriminator that declares the entity's
 * field a string and an id field of its own, and a member declaring neither. `create` fetches only
 * a string in a union element, as 1.39.0 did, so over a number-keyed entity no member takes an id.
 */
const UnionSheet = Schema.Union([
  Schema.Union([
    Schema.Struct({
      kind: Schema.NullOr(Schema.Literal("a")),
      numberRow: NumberRow,
      qty: Schema.Number,
    }),
    Schema.Struct({
      kind: Schema.Literal("b"),
      numberRow: Schema.optional(NumberRow),
      qty: Schema.Number,
    }),
  ]),
  Schema.Struct({
    kind: Schema.Literal("a"),
    numberRow: Schema.String,
    numberRowId: Schema.String,
    qty: Schema.Number,
  }),
  Schema.Struct({ kind: Schema.Literal("c"), qty: Schema.Number }),
])
class UnionRoot extends Schema.Class<UnionRoot>("UnionRoot")({
  id: Schema.String,
  sheets: Schema.Array(UnionSheet),
}) {}
const UnionAggregate = Aggregate.make(UnionRoot, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "union" },
  root: { entityType: "UnionRoot" },
  edges: {
    sheets: Aggregate.many({
      entityType: "UnionSheet",
      entity: NumberRows,
      sk: { composite: ["qty"] },
    }),
  },
})
type UnionCreate = Parameters<typeof UnionAggregate.create>[0]

/** The same union over a string-keyed entity, the entity itself one of its members. */
const StringUnionSheet = Schema.Union([
  Schema.Union([
    Schema.Struct({
      kind: Schema.NullOr(Schema.Literal("a")),
      stringRow: StringRow,
      qty: Schema.Number,
    }),
    Schema.Struct({
      kind: Schema.Literal("b"),
      stringRow: Schema.optional(StringRow),
      qty: Schema.Number,
    }),
  ]),
  Schema.Struct({
    kind: Schema.Literal("a"),
    stringRow: Schema.String,
    stringRowId: Schema.String,
    qty: Schema.Number,
  }),
  Schema.Struct({ kind: Schema.Literal("c"), qty: Schema.Number }),
  StringRow,
])
class StringUnionRoot extends Schema.Class<StringUnionRoot>("StringUnionRoot")({
  id: Schema.String,
  sheets: Schema.Array(StringUnionSheet),
}) {}
const StringUnionAggregate = Aggregate.make(StringUnionRoot, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "string-union" },
  root: { entityType: "StringUnionRoot" },
  edges: {
    sheets: Aggregate.many({ entityType: "StringUnionSheet", entity: StringRows }),
  },
})
type StringUnionCreate = Parameters<typeof StringUnionAggregate.create>[0]

/** A union element over a `Schema.Class` model, whose field name the type can't see. */
class ClassUnionRoot extends Schema.Class<ClassUnionRoot>("ClassUnionRoot")({
  id: Schema.String,
  sheets: Schema.Array(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), stringLine: StringLine, qty: Schema.Number }),
      Schema.Struct({ kind: Schema.Literal("c"), qty: Schema.Number }),
    ]),
  ),
}) {}
const ClassUnionAggregate = Aggregate.make(ClassUnionRoot, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "class-union" },
  root: { entityType: "ClassUnionRoot" },
  edges: {
    sheets: Aggregate.many({ entityType: "ClassUnionSheet", entity: StringLines }),
  },
})
type ClassUnionCreate = Parameters<typeof ClassUnionAggregate.create>[0]

/** An element holding the entity in a field of another name than the entity's. */
class CrewRoot extends Schema.Class<CrewRoot>("CrewRoot")({
  id: Schema.String,
  crew: Schema.Array(Schema.Struct({ captain: NumberRow, qty: Schema.Number })),
}) {}
const CrewAggregate = Aggregate.make(CrewRoot, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "crew" },
  root: { entityType: "CrewRoot" },
  edges: {
    crew: Aggregate.many({ entityType: "Crew", entity: NumberRows, sk: { composite: ["qty"] } }),
  },
})
type CrewCreate = Parameters<typeof CrewAggregate.create>[0]

const bound = () => Aggregate.bind(RootAggregate)
type BoundCreate = Parameters<Effect.Success<ReturnType<typeof bound>>["create"]>[0]

const client = () =>
  DynamoClient.make({
    entities: { NumberLines },
    aggregates: { RootAggregate },
    tables: { MainTable },
  })
type ClientCreate = Parameters<
  Effect.Success<ReturnType<typeof client>>["aggregates"]["RootAggregate"]["create"]
>[0]

const line = new NumberLine({ lineId: 1, f: 5 })
const row = { lineId: 1, f: 5 }
const base = {
  id: "a",
  note: "n",
  count: 3,
  numberLineId: 1,
  codecLineId: 2,
  brandLineId: "b" as LineId,
  pairLine: new PairLine({ tenant: "t", lineId: "p", f: 1 }),
  refLineId: 1,
  numberLines: [1],
  sheets: [{ numberRowId: 1, qty: 2 }],
  maybeSheets: [{ qty: 2 }],
  classSheets: [{ numberLine: line, qty: 2 }],
  notes: [{ id: "n1", text: "t" }],
  team: { name: "A", captainId: 1 },
} as const satisfies Create

describe("an aggregate's create takes what it takes at run time", () => {
  it("is the same on the aggregate, the bound aggregate and the typed client", () => {
    expectTypeOf<BoundCreate>().toEqualTypeOf<Create>()
    expectTypeOf<ClientCreate>().toEqualTypeOf<Create>()
  })

  it("takes the aggregate's key composites, which its input schema leaves out", () => {
    expectTypeOf<Create["id"]>().toEqualTypeOf<string>()
    expectTypeOf<Aggregate.Input<typeof RootAggregate>>().not.toHaveProperty("id")
  })

  it("takes what the input schema decodes, plus the key", () => {
    expectTypeOf<
      Aggregate.Input<typeof RootAggregate> & { readonly id: string }
    >().toExtend<Create>()
  })

  it("takes an edge's id, the entity whole, or both", () => {
    const { numberLineId: _, ...withoutId } = base
    expectTypeOf({ ...withoutId, numberLine: line }).toExtend<Create>()
    expectTypeOf({ ...withoutId, numberLine: { lineId: 1, f: 5 } }).toExtend<Create>()
    expectTypeOf({ ...base, numberLine: line }).toExtend<Create>()
    const { refLineId: __, ...withoutRef } = base
    expectTypeOf({ ...withoutRef, refLine: line }).toExtend<Create>()
  })

  it("takes an id in its stored or JSON form where that is another kind of value", () => {
    expectTypeOf({ ...base, codecLineId: "2" }).toExtend<Create>()
    expectTypeOf({ ...base, dateLineId: new Date(0) }).toExtend<Create>()
    expectTypeOf({ ...base, dateLineId: "1970-01-01T00:00:00.000Z" }).toExtend<Create>()
  })

  it("keeps a branded id's brand", () => {
    expectTypeOf<
      Extract<Create, { readonly brandLineId: unknown }>["brandLineId"]
    >().toEqualTypeOf<LineId>()
  })

  it("leaves an optional edge out", () => {
    expectTypeOf<typeof base>().not.toHaveProperty("dateLineId")
    expectTypeOf(base).toExtend<Create>()
  })

  it("takes a many edge's elements as ids or the entity whole, in any mix", () => {
    expectTypeOf({ ...base, numberLines: [line, 2, { lineId: 3, f: 1 }] }).toExtend<Create>()
  })

  it("takes an element wrapping the entity with its id or the entity whole", () => {
    expectTypeOf({ ...base, sheets: [{ numberRow: row, qty: 2 }] }).toExtend<Create>()
    expectTypeOf({ ...base, maybeSheets: [{ numberRowId: 1, qty: 2 }] }).toExtend<Create>()
    expectTypeOf({ ...base, maybeSheets: [{ numberRow: row, qty: 2 }] }).toExtend<Create>()
  })

  it("takes a union element as each of its members, nested and nullable ones included", () => {
    expectTypeOf({
      id: "a",
      sheets: [
        { kind: null, numberRow: row, qty: 1 },
        { kind: "a", numberRow: row, qty: 2 },
        { kind: "b", qty: 3 },
        { kind: "a", numberRow: "KEEP", numberRowId: "l", qty: 5 },
        { kind: "c", qty: 6 },
      ],
    } as const).toExtend<UnionCreate>()
  })

  it("takes a string id in a union element's member holding the entity, or as the element", () => {
    const stringRow = { lineId: "l", f: 1 }
    expectTypeOf({
      id: "a",
      sheets: [
        { kind: null, stringRowId: "l", qty: 1 },
        { kind: "a", stringRow, qty: 2 },
        { kind: "b", stringRowId: "l", qty: 3 },
        { kind: "b", qty: 4 },
        { kind: "a", stringRow: "KEEP", stringRowId: "l", qty: 5 },
        { kind: "c", qty: 6 },
        "l",
        stringRow,
      ],
    } as const).toExtend<StringUnionCreate>()
  })

  it("takes an element holding the entity in a field of another name whole", () => {
    expectTypeOf({ id: "a", crew: [{ captain: row, qty: 2 }] } as const).toExtend<CrewCreate>()
  })

  it("takes an element wrapping a class model's entity as 1.39.0's create did: unknown", () => {
    // `create` takes the entity in the field of the class's name, which the type can't see.
    expectTypeOf<Create["classSheets"]>().toEqualTypeOf<ReadonlyArray<unknown>>()
    expectTypeOf<ClassUnionCreate["sheets"]>().toEqualTypeOf<ReadonlyArray<unknown>>()
  })

  it("takes a sub-aggregate's edges the same way", () => {
    expectTypeOf({ ...base, team: { name: "A", captain: line } }).toExtend<Create>()
  })
})

// Compile-enforced: each of these is a type error, and fails `pnpm check` if it compiles.
function _refusals(input: Record<string, unknown>): void {
  const { id: _id, ...withoutKey } = base
  const { numberLineId: _line, ...withoutLine } = base
  // @ts-expect-error — the aggregate's key composite is required
  RootAggregate.create(withoutKey)
  // @ts-expect-error — a required edge takes its id or the entity whole
  RootAggregate.create(withoutLine)
  // @ts-expect-error — a number key takes no string
  RootAggregate.create({ ...base, numberLineId: "1" })
  // @ts-expect-error — a branded key takes no plain string
  RootAggregate.create({ ...base, brandLineId: "b" })
  // @ts-expect-error — an entity keyed by two attributes is given whole, not by one id
  RootAggregate.create({ ...base, pairLineId: "p" })
  // @ts-expect-error — a field takes its domain value, as `Entity.put` does
  RootAggregate.create({ ...base, count: "3" })
  // @ts-expect-error — a many edge's element is an id or the entity, not another object
  RootAggregate.create({ ...base, numberLines: [{ lineId: "x" }] })
  // @ts-expect-error — a record of unknown values is no input
  RootAggregate.create(input)
  // @ts-expect-error — no member of the union element takes a string in `numberRow` for kind "b"
  UnionAggregate.create({ id: "a", sheets: [{ kind: "b", numberRow: "x", qty: 1 }] })
  // @ts-expect-error — a member declaring neither the entity's field nor its id takes no id
  StringUnionAggregate.create({ id: "a", sheets: [{ kind: "c", stringRowId: "l", qty: 1 }] })
  // @ts-expect-error — `create` fetches only a string in a union element: a number id is dropped
  UnionAggregate.create({ id: "a", sheets: [{ kind: null, numberRowId: 1, qty: 1 }] })
  // @ts-expect-error — nor an optional one
  UnionAggregate.create({ id: "a", sheets: [{ kind: "b", numberRowId: 1, qty: 1 }] })
  // @ts-expect-error — a string id of a number-keyed entity fails with EDD-9131
  UnionAggregate.create({ id: "a", sheets: [{ kind: null, numberRowId: "1", qty: 1 }] })
  // @ts-expect-error — a union with no member that is the entity takes no id as the element
  UnionAggregate.create({ id: "a", sheets: ["1"] })
  // @ts-expect-error — `create` takes the entity by id only in the field of its name
  CrewAggregate.create({ id: "a", crew: [{ captainId: 1, qty: 2 }] })
  // @ts-expect-error — a class model's element is unknown, but still an element of an array
  RootAggregate.create({ ...base, classSheets: { numberLine: line, qty: 2 } })
}
void _refusals
