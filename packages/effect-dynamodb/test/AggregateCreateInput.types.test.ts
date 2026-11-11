/**
 * Type-level tests for what an aggregate's `create` takes (`AggregateCreateInputType`), on the
 * aggregate, on the bound aggregate, and on the typed client's `db.aggregates`.
 *
 * `create`'s type refuses exactly the inputs published 1.39.0's `create` failed on at run time, as
 * an error or as wrong stored data, and takes everything that worked there: 1.39.0 typed its input
 * `Record<string, unknown>`, so a refusal must never break code that worked. Each refusal below
 * names what 1.39.0 did with it, and `AggregateCreateRefusals.test.ts` runs each against the
 * fixture generated from 1.39.0.
 *
 * - An input typed with a string index signature (`Record<string, unknown>`, parsed JSON) is taken
 *   as it is and judged at run time.
 * - The aggregate's own key composites, which its input schema leaves out because a caller
 *   supplies them (from a path, say).
 * - An edge whose entity one id names takes `${field}Id`, or the entity whole under the field's
 *   name, or both. Beside the entity whole, a `${field}Id` of another kind than a string is ignored;
 *   where the model declares `${field}Id`, it is the model's own data.
 * - A many edge over such an entity takes each element as its id or the entity whole, in any mix,
 *   and an element wrapping the entity takes either in the field of the entity's name, where its
 *   schema declares that field the entity's own model schema and declares no `${field}Id` of its
 *   own, beside the element as 1.39.0's input type typed it. The type sees that name for a
 *   `Schema.Struct` model. Every other element (a union, a field of another name or another schema,
 *   an element over a `Schema.Class` model) is `unknown`: `create` judges it as 1.39.0 did.
 * - An id is a value of the key composite's type, or its stored or JSON form: a branded id's plain
 *   string included.
 * - Every other value is its domain value or its stored form, mixed at any depth, a date in any
 *   form 1.39.0 took (a `DateTime`, a `Date`, a date string, an epoch number; a `Date` field no
 *   `DateTime`), with keys the schema doesn't declare, which `create` ignores.
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, type Effect, Schema, SchemaGetter } from "effect"
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

/**
 * Elements whose schema doesn't name the field holding the entity by its model schema, as `create`
 * judges them: the field an `Option`, a union of two members of one domain type, an element
 * declaring its own `numberRowId`, and the same struct through a transformation.
 */
const ownedSheet = Schema.Struct({ numberRow: NumberRow, qty: Schema.Number })
class OtherRoot extends Schema.Class<OtherRoot>("OtherRoot")({
  id: Schema.String,
  optionSheets: Schema.Array(
    Schema.Struct({ numberRow: Schema.Option(Schema.String), qty: Schema.Number }),
  ),
  sameDomain: Schema.Array(
    Schema.Union([
      ownedSheet,
      Schema.Struct({ numberRow: NumberRow, qty: Schema.NumberFromString }),
    ]),
  ),
  ownIdSheets: Schema.Array(
    Schema.Struct({ numberRow: NumberRow, numberRowId: Schema.Number, qty: Schema.Number }),
  ),
  codecSheets: Schema.Array(
    ownedSheet.pipe(
      Schema.decodeTo(ownedSheet, {
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  ),
}) {}
const otherEdge = (entityType: string) =>
  Aggregate.many({ entityType, entity: NumberRows, sk: { composite: ["qty"] } })
const OtherAggregate = Aggregate.make(OtherRoot, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "other" },
  root: { entityType: "OtherRoot" },
  edges: {
    optionSheets: otherEdge("OptionSheet"),
    sameDomain: otherEdge("SameDomainSheet"),
    ownIdSheets: otherEdge("OwnIdSheet"),
    codecSheets: otherEdge("CodecSheet"),
  },
})
type OtherCreate = Parameters<typeof OtherAggregate.create>[0]

/**
 * 1.39.0's input forms, over a `Schema.Struct` model with an `id: string` (ref-like to 1.39.0's
 * input type) whose field name (`idRow`) the type sees, beside the forms added: the entity whole
 * with its id beside it, and an explicit `undefined` id, on `one` edges and on elements alike.
 */
const IdRow = Schema.Struct({ id: Schema.String, f: Schema.Number })
const IdRows = Entity.make({
  model: IdRow,
  entityType: "IdRow",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const IdTable = Table.make({ schema: AppSchema, entities: { IdRows } })
class IdRoot extends Schema.Class<IdRoot>("IdRoot")({
  id: Schema.String,
  idRow: IdRow,
  maybeRow: Schema.optionalKey(IdRow),
  optionalRow: Schema.optional(IdRow),
  refLike: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      idRow: Schema.optional(IdRow),
      qty: Schema.optional(Schema.Number),
    }),
  ),
  sheets: Schema.Array(Schema.Struct({ idRow: IdRow, qty: Schema.Number })),
  maybeSheets: Schema.Array(Schema.Struct({ idRow: Schema.optional(IdRow), qty: Schema.Number })),
  keySheets: Schema.Array(Schema.Struct({ idRow: Schema.optionalKey(IdRow), qty: Schema.Number })),
  crew: Schema.Array(Schema.Struct({ captain: IdRow, qty: Schema.Number })),
  entities: Schema.Array(IdRow),
}) {}
const idEdge = (entityType: string) => Aggregate.many({ entityType, entity: IdRows })
const IdAggregate = Aggregate.make(IdRoot, {
  table: IdTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "id-root" },
  root: { entityType: "IdRoot" },
  edges: {
    idRow: Aggregate.one({ entityType: "IdRootRow", entity: IdRows }),
    maybeRow: Aggregate.one({ entityType: "IdRootMaybeRow", entity: IdRows }),
    optionalRow: Aggregate.one({ entityType: "IdRootOptionalRow", entity: IdRows }),
    refLike: idEdge("IdRefLike"),
    sheets: idEdge("IdSheet"),
    maybeSheets: idEdge("IdMaybeSheet"),
    keySheets: idEdge("IdKeySheet"),
    crew: idEdge("IdCrew"),
    entities: idEdge("IdEntity"),
  },
})
type IdCreate = Parameters<typeof IdAggregate.create>[0]

const idRow = { id: "L", f: 1 }

// Compile-enforced: each of these compiles against published 1.39.0's input type
// (`Aggregate.Input`), and fails `pnpm check` here if it stops compiling.
const _idAccepted139: ReadonlyArray<IdCreate> = [
  {
    id: "a",
    idRowId: "L",
    maybeRowId: "L",
    refLike: ["L"],
    sheets: [{ idRowId: "L", qty: 1 }],
    maybeSheets: [{ idRow, qty: 1 }, { qty: 1 }],
    keySheets: [{ idRow, qty: 1 }, { qty: 1 }],
    crew: [{ captainId: "L", qty: 1 }],
    entities: ["L"],
  },
]
void _idAccepted139

// Compile-enforced: the forms added beside 1.39.0's, which 1.39.0's `create`
// (`Record<string, unknown>`) took and ran: the entity whole with its id beside it, and an
// explicit `undefined` id, on `one` edges and on elements alike.
const _idAdded: ReadonlyArray<IdCreate> = [
  {
    id: "a",
    idRow,
    idRowId: "L",
    maybeRow: idRow,
    maybeRowId: "L",
    optionalRow: idRow,
    optionalRowId: "L",
    refLike: [
      { id: "x", idRow, qty: 1 },
      { id: "x", idRowId: "L" },
    ],
    sheets: [
      { idRow, qty: 1 },
      { idRow, idRowId: "L", qty: 1 },
      { idRow, idRowId: undefined, qty: 1 },
    ],
    maybeSheets: [
      { idRowId: "L", qty: 1 },
      { idRow, idRowId: "L", qty: 1 },
      { idRowId: undefined, qty: 1 },
    ],
    keySheets: [
      { idRowId: "L", qty: 1 },
      { idRow, idRowId: "L", qty: 1 },
      { idRowId: undefined, qty: 1 },
    ],
    crew: [{ captain: idRow, qty: 1 }],
    entities: [idRow, "L"],
  },
  {
    id: "a",
    idRow,
    idRowId: undefined,
    maybeRowId: undefined,
    optionalRowId: undefined,
    refLike: [],
    sheets: [],
    maybeSheets: [],
    keySheets: [],
    crew: [],
    entities: [],
  },
]
void _idAdded

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

  it("takes a branded id's plain string, which 1.39.0's create fetched", () => {
    expectTypeOf<Extract<Create, { readonly brandLineId: unknown }>["brandLineId"]>().toEqualTypeOf<
      LineId | string
    >()
    expectTypeOf({ ...base, brandLineId: "b" }).toExtend<Create>()
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

  it("takes a union element as 1.39.0's create did: unknown", () => {
    // `create` judges a union element as 1.39.0 did: a string id, whatever the member.
    expectTypeOf<UnionCreate["sheets"]>().toEqualTypeOf<ReadonlyArray<unknown>>()
    expectTypeOf<StringUnionCreate["sheets"]>().toEqualTypeOf<ReadonlyArray<unknown>>()
    expectTypeOf({
      id: "a",
      sheets: [
        { kind: null, numberRow: row, qty: 1 },
        { kind: "b", qty: 3 },
        { kind: "a", numberRow: "KEEP", numberRowId: "l", qty: 5 },
      ],
    } as const).toExtend<UnionCreate>()
  })

  it("takes an element holding the entity in a field of another name as 1.39.0's create did", () => {
    expectTypeOf<CrewCreate["crew"]>().toEqualTypeOf<ReadonlyArray<unknown>>()
    expectTypeOf({ id: "a", crew: [{ captain: row, qty: 2 }] } as const).toExtend<CrewCreate>()
  })

  it("takes an element whose schema doesn't name the entity's field as 1.39.0's create did", () => {
    expectTypeOf<OtherCreate["optionSheets"]>().toEqualTypeOf<ReadonlyArray<unknown>>()
    expectTypeOf<OtherCreate["sameDomain"]>().toEqualTypeOf<ReadonlyArray<unknown>>()
    expectTypeOf<OtherCreate["ownIdSheets"]>().toEqualTypeOf<ReadonlyArray<unknown>>()
    expectTypeOf<OtherCreate["codecSheets"]>().toEqualTypeOf<ReadonlyArray<unknown>>()
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

/**
 * The fixture generator's input (`AggregateCreateRefusals.test.ts`): every edge given whole, which
 * 1.39.0 created. Each case below changes one thing in it, so what 1.39.0 did is that change's.
 */
const wholeBase = {
  id: "a",
  note: "n",
  count: "3",
  numberLine: { lineId: 1, f: 5 },
  codecLine: { lineId: "2", f: 6 },
  brandLine: { lineId: "b", f: 7 },
  pairLine: { tenant: "t", lineId: "p", f: 8 },
  refLine: { lineId: 1, f: 5 },
  numberLines: [{ lineId: 1, f: 5 }],
  sheets: [{ numberRow: row, qty: 2 }],
  maybeSheets: [{ qty: 2 }],
  classSheets: [{ numberLine: line, qty: 2 }],
  notes: [{ id: "n1", text: "t" }],
  team: { name: "A", captain: line },
}

/** Fields of each date kind and of a codec, at the root, in a struct and in a many element. */
class Fields extends Schema.Class<Fields>("Fields")({
  id: Schema.String,
  count: Schema.NumberFromString,
  at: Schema.DateTimeUtcFromString,
  epoch: DynamoModel.DateEpochMs,
  utc: Schema.DateTimeUtc,
  when: Schema.Date,
  nested: Schema.Struct({ at: Schema.DateTimeUtcFromString, n: Schema.NumberFromString }),
  tags: Schema.Array(Schema.Struct({ n: Schema.NumberFromString })),
}) {}
const FieldsAggregate = Aggregate.make(Fields, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "fields" },
  root: { entityType: "Fields" },
  edges: { tags: Aggregate.many({ entityType: "FieldsTag", sk: { composite: ["n"] } }) },
})
const iso = "2026-01-02T03:04:05.000Z"
const utc = DateTime.makeUnsafe(iso)
const ms = Date.parse(iso)
const fields = {
  id: "a",
  count: 3,
  at: utc,
  epoch: utc,
  utc,
  when: new Date(iso),
  nested: { at: utc, n: 1 },
  tags: [{ n: 1 }],
}

/** A model declaring the `one` edge's `${field}Id` itself: its own data, never an id to fetch. */
const declaresId = Aggregate.make(
  Schema.Struct({
    id: Schema.String,
    numberLine: NumberLine,
    numberLineId: Schema.optional(Schema.Number),
  }),
  {
    table: MainTable,
    schema: AppSchema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "declares-id" },
    root: { entityType: "DeclaresId" },
    edges: { numberLine: Aggregate.one({ entityType: "DeclaresIdLine", entity: NumberLines }) },
  },
)

// Compile-enforced: `create` takes each of these, each of which worked on published 1.39.0
// (`AggregateCreateRefusals.test.ts`), or which this release takes and 1.39.0 died on or dropped.
// Never called: the calls are only compiled.
function _accepted(
  record: Record<string, unknown>,
  parsed: ReturnType<typeof JSON.parse>,
  open: { readonly [key: string]: unknown },
): void {
  // Input typed with a string index signature: taken as it is, judged at run time.
  RootAggregate.create(record)
  RootAggregate.create(parsed)
  RootAggregate.create(open)
  // 1.39.0: created.
  RootAggregate.create(wholeBase)
  RootAggregate.create({ ...wholeBase, count: 3 })
  RootAggregate.create({ ...wholeBase, pairLineId: 5 })
  RootAggregate.create({ ...wholeBase, brandLineId: 5 })
  RootAggregate.create({ ...wholeBase, typo: 1 })
  RootAggregate.create({ ...wholeBase, sheets: [{ numberRow: row, qty: 2, typo: 1 }] })
  // 1.39.0: created, storing `NaN` and reading `null`. The type can't tell `"x"` from `"3"`.
  RootAggregate.create({ ...wholeBase, count: "x" })
  // 1.39.0 died (no identifier) or dropped the number id; now created.
  const { numberLine: _n, ...withoutNumberLine } = wholeBase
  const { brandLine: _b, ...withoutBrandLine } = wholeBase
  RootAggregate.create({ ...withoutNumberLine, numberLineId: 1 })
  RootAggregate.create({ ...withoutBrandLine, brandLineId: "b" })
  RootAggregate.create({ ...wholeBase, sheets: [{ numberRowId: 1, qty: 2 }] })
  // 1.39.0: created, every date and codec form.
  FieldsAggregate.create(fields)
  FieldsAggregate.create({ ...fields, count: "3" })
  FieldsAggregate.create({ ...fields, at: iso })
  FieldsAggregate.create({ ...fields, at: new Date(iso) })
  FieldsAggregate.create({ ...fields, at: ms })
  FieldsAggregate.create({ ...fields, epoch: ms })
  FieldsAggregate.create({ ...fields, epoch: new Date(iso) })
  FieldsAggregate.create({ ...fields, epoch: iso })
  FieldsAggregate.create({ ...fields, utc: new Date(iso) })
  FieldsAggregate.create({ ...fields, utc: iso })
  FieldsAggregate.create({ ...fields, utc: ms })
  FieldsAggregate.create({ ...fields, when: iso })
  FieldsAggregate.create({ ...fields, when: ms })
  FieldsAggregate.create({ ...fields, nested: { at: iso, n: "1" } })
  FieldsAggregate.create({ ...fields, nested: { at: iso, n: 1 } })
  FieldsAggregate.create({ ...fields, tags: [{ n: "1" }] })
  FieldsAggregate.create({ ...fields, typo: 1 })
  FieldsAggregate.create({ ...fields, tags: [{ n: 1, typo: 1 }] })
  // 1.39.0: created (#214's fixture). The model's own `numberLineId`, the entity whole beside it.
  declaresId.create({ id: "a", numberLine: { lineId: 6, f: 99 }, numberLineId: 5 })
  declaresId.create({ id: "a", numberLine: { lineId: 6, f: 99 } })
}
void _accepted

describe("create's type refuses only what 1.39.0's create failed on", () => {
  // Each refusal names what published 1.39.0 did with the input (the fixture's `create`). The
  // calls are compiled, never run.
  it("an input without the aggregate's key composite (1.39.0: ValidationError)", () => {
    const { id: _id, ...withoutKey } = wholeBase
    // @ts-expect-error — the aggregate's key composite is required
    void (() => RootAggregate.create(withoutKey))
  })

  it("an input without a required one edge, neither id nor whole (1.39.0: ValidationError)", () => {
    const { numberLine: _line, ...withoutLine } = wholeBase
    // @ts-expect-error — a required edge takes its id or the entity whole
    void (() => RootAggregate.create(withoutLine))
  })

  it("a number-keyed one edge's id as a string (1.39.0: died, Missing composite attribute)", () => {
    const { numberLine: _line, ...withoutLine } = wholeBase
    // @ts-expect-error — a number key takes no string
    void (() => RootAggregate.create({ ...withoutLine, numberLineId: "1" }))
  })

  it("a string id for an entity keyed by two attributes (1.39.0: died, Missing composite attribute)", () => {
    const { pairLine: _pair, ...withoutPair } = wholeBase
    // @ts-expect-error — given whole, not by one id
    void (() => RootAggregate.create({ ...withoutPair, pairLineId: "p" }))
    // @ts-expect-error — nor beside the entity whole, where it's fetched
    void (() => RootAggregate.create({ ...wholeBase, pairLineId: "p" }))
  })

  it("a field given a value of another type (1.39.0: ValidationError)", () => {
    // @ts-expect-error — a number field takes no boolean
    void (() => RootAggregate.create({ ...wholeBase, count: true }))
  })

  it("a many element that is the entity given another object (1.39.0: ValidationError)", () => {
    // @ts-expect-error — an id or the entity, not another object
    void (() => RootAggregate.create({ ...wholeBase, numberLines: [{ lineId: "x" }] }))
  })

  it("a many element naming the entity's field given a string id of a number key (1.39.0: died, Missing composite attribute)", () => {
    // @ts-expect-error — an id of its key's type
    void (() => RootAggregate.create({ ...wholeBase, sheets: [{ numberRowId: "1", qty: 2 }] }))
  })

  it("a many element without its entity (1.39.0: ValidationError)", () => {
    // @ts-expect-error — the entity by id or whole, not neither
    void (() => RootAggregate.create({ ...wholeBase, sheets: [{ qty: 2 }] }))
  })

  it("a many edge given one element, not a list (1.39.0: ValidationError)", () => {
    // @ts-expect-error — a class model's element is unknown, but still an element of a list
    void (() => RootAggregate.create({ ...wholeBase, classSheets: { numberLine: line, qty: 2 } }))
  })

  it("a Date field given a DateTime (1.39.0: ValidationError)", () => {
    // @ts-expect-error — a `Date` field takes a `Date`, a date string or an epoch number
    void (() => FieldsAggregate.create({ ...fields, when: utc }))
  })

  it("an id the model declares itself, without the entity whole (1.39.0: ValidationError)", () => {
    // @ts-expect-error — a number the model declares is its data, never fetched
    void (() => declaresId.create({ id: "a", numberLineId: 5 }))
  })
})
