/**
 * Type-level tests for the id an aggregate edge takes in place of its entity (`Aggregate.Input`).
 *
 * An edge whose entity is keyed by one attribute (once, or in both halves of its key) takes an id
 * of that attribute's type, named `${field}Id`: a number for a number key, a bigint for a bigint
 * key, a `Date` for a `Date` key, a string when the key is in the sort key alone. An edge whose
 * entity is keyed by two attributes takes the entity whole, as `create` fetches nothing for it.
 * These match what `create` does at run time (`AggregateRefHydration.test.ts`). A `many` element
 * declared a union is typed as on 1.39.0, as `create` judges it as 1.39.0 did.
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Schema } from "effect"
import { describe, expectTypeOf, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

const AppSchema = DynamoSchema.make({ name: "ref-ids", version: 1 })

class NumberLine extends Schema.Class<NumberLine>("NumberLine")({
  lineId: Schema.Number,
  f: Schema.Number,
}) {}
class BigintLine extends Schema.Class<BigintLine>("BigintLine")({
  lineId: Schema.BigInt,
  f: Schema.Number,
}) {}
class DateLine extends Schema.Class<DateLine>("DateLine")({
  lineId: Schema.Date,
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

const NumberLines = Entity.make({
  model: NumberLine,
  entityType: "NumberLine",
  primaryKey: { pk: { field: "pk", composite: ["lineId"] }, sk: { field: "sk", composite: [] } },
})
const BigintLines = Entity.make({
  model: BigintLine,
  entityType: "BigintLine",
  primaryKey: { pk: { field: "pk", composite: ["lineId"] }, sk: { field: "sk", composite: [] } },
})
const DateLines = Entity.make({
  model: DateLine,
  entityType: "DateLine",
  primaryKey: { pk: { field: "pk", composite: ["lineId"] }, sk: { field: "sk", composite: [] } },
})
const SortKeyLines = Entity.make({
  model: StringLine,
  entityType: "SortKeyLine",
  primaryKey: { pk: { field: "pk", composite: [] }, sk: { field: "sk", composite: ["lineId"] } },
})
const TwiceLines = Entity.make({
  model: StringLine,
  entityType: "TwiceLine",
  primaryKey: {
    pk: { field: "pk", composite: ["lineId"] },
    sk: { field: "sk", composite: ["lineId"] },
  },
})
const PairLines = Entity.make({
  model: DynamoModel.configure(PairLine, { lineId: { identifier: true } }),
  entityType: "PairLine",
  primaryKey: {
    pk: { field: "pk", composite: ["tenant"] },
    sk: { field: "sk", composite: ["lineId"] },
  },
})

/** An entity with an `id: string` field, which 1.39.0's union element typing takes for a ref. */
class IdLine extends Schema.Class<IdLine>("IdLine")({ id: Schema.Number, f: Schema.Number }) {}
class StringIdLine extends Schema.Class<StringIdLine>("StringIdLine")({
  id: Schema.String,
  f: Schema.Number,
}) {}
const IdLines = Entity.make({
  model: IdLine,
  entityType: "IdLine",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const StringIdLines = Entity.make({
  model: StringIdLine,
  entityType: "StringIdLine",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: {
    NumberLines,
    BigintLines,
    DateLines,
    SortKeyLines,
    TwiceLines,
    PairLines,
    IdLines,
    StringIdLines,
  },
})

class Root extends Schema.Class<Root>("Root")({
  id: Schema.String,
  numberLine: NumberLine,
  bigintLine: BigintLine,
  dateLine: Schema.optional(DateLine),
  sortKeyLine: StringLine,
  twiceLine: StringLine,
  pairLine: PairLine,
  numberLines: Schema.Array(NumberLine),
  sheets: Schema.Array(Schema.Struct({ numberLine: NumberLine, qty: Schema.Number })),
  maybeSheets: Schema.Array(
    Schema.Struct({ numberLine: Schema.optional(NumberLine), qty: Schema.Number }),
  ),
  kinds: Schema.Array(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), numberLine: NumberLine }),
      Schema.Struct({ kind: Schema.Literal("b"), label: Schema.String }),
    ]),
  ),
  pairSheets: Schema.Array(Schema.Struct({ pairLine: PairLine, qty: Schema.Number })),
  idKinds: Schema.Array(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("a"), stringIdLine: StringIdLine }),
      Schema.Struct({ kind: Schema.Literal("b"), idLine: IdLine }),
    ]),
  ),
  notes: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
}) {}

const RootAggregate = Aggregate.make(Root, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "root" },
  root: { entityType: "Root" },
  edges: {
    numberLine: Aggregate.one({ entityType: "RootNumberLine", entity: NumberLines }),
    bigintLine: Aggregate.one({ entityType: "RootBigintLine", entity: BigintLines }),
    dateLine: Aggregate.one({ entityType: "RootDateLine", entity: DateLines }),
    sortKeyLine: Aggregate.one({ entityType: "RootSortKeyLine", entity: SortKeyLines }),
    twiceLine: Aggregate.ref(TwiceLines),
    pairLine: Aggregate.one({ entityType: "RootPairLine", entity: PairLines }),
    numberLines: Aggregate.many({
      entityType: "RootNumberLines",
      entity: NumberLines,
      sk: { composite: ["lineId"] },
    }),
    sheets: Aggregate.many({
      entityType: "RootSheet",
      entity: NumberLines,
      sk: { composite: ["qty"] },
    }),
    maybeSheets: Aggregate.many({
      entityType: "RootMaybeSheet",
      entity: NumberLines,
      sk: { composite: ["qty"] },
    }),
    kinds: Aggregate.many({ entityType: "RootKind", entity: NumberLines }),
    pairSheets: Aggregate.many({
      entityType: "RootPairSheet",
      entity: PairLines,
      sk: { composite: ["qty"] },
    }),
    notes: Aggregate.many({ entityType: "RootNote", sk: { composite: ["id"] } }),
    idKinds: Aggregate.many({ entityType: "RootIdKind", entity: StringIdLines }),
  },
})

type Input = Aggregate.Input<typeof RootAggregate>

describe("an aggregate edge takes an id of its entity's key attribute", () => {
  it("a number key takes a number", () => {
    expectTypeOf<Input["numberLineId"]>().toEqualTypeOf<number>()
    expectTypeOf<Input>().not.toHaveProperty("numberLine")
  })

  it("a bigint key takes a bigint", () => {
    expectTypeOf<Input["bigintLineId"]>().toEqualTypeOf<bigint>()
  })

  it("a Date key takes a Date, optional when the edge is", () => {
    expectTypeOf<Input["dateLineId"]>().toEqualTypeOf<Date | undefined>()
  })

  it("a key in the sort key alone takes a string, not never", () => {
    expectTypeOf<Input["sortKeyLineId"]>().toEqualTypeOf<string>()
  })

  it("a key whose attribute is in both halves takes that attribute", () => {
    expectTypeOf<Input["twiceLineId"]>().toEqualTypeOf<string>()
  })

  it("an entity keyed by two attributes is taken whole", () => {
    expectTypeOf<Input>().toHaveProperty("pairLine")
    expectTypeOf<Input>().not.toHaveProperty("pairLineId")
  })

  it("a many edge of ids takes ids of the key attribute", () => {
    expectTypeOf<Input["numberLines"]>().toEqualTypeOf<ReadonlyArray<number>>()
  })

  it("a many element wrapping the entity takes its id", () => {
    expectTypeOf<Input["sheets"][number]>().toEqualTypeOf<{
      readonly numberLineId: number
      readonly qty: number
    }>()
  })

  it("a many element holding the entity optionally takes an optional id", () => {
    expectTypeOf<Input["maybeSheets"][number]>().toEqualTypeOf<{
      readonly numberLineId?: number | undefined
      readonly qty: number
    }>()
  })

  it("a many element that is a union is typed as on 1.39.0: as declared, holding no ref-like field", () => {
    expectTypeOf<Input["kinds"][number]>().toEqualTypeOf<
      | { readonly kind: "a"; readonly numberLine: NumberLine }
      | { readonly kind: "b"; readonly label: string }
    >()
  })

  it("a union element's field of a class with an `id: string` takes an id, as on 1.39.0", () => {
    // 1.39.0's typing: the edge entity's partition key composite's type, for any such field.
    expectTypeOf<Input["idKinds"][number]>().toEqualTypeOf<
      | { readonly kind: "a"; readonly stringIdLineId: string }
      | { readonly kind: "b"; readonly idLine: IdLine }
    >()
  })

  it("a many element wrapping an entity keyed by two attributes is taken as given", () => {
    expectTypeOf<Input["pairSheets"][number]>().toEqualTypeOf<{
      readonly pairLine: PairLine
      readonly qty: number
    }>()
  })

  it("a many edge with no entity takes its elements as given, an `id` field included", () => {
    expectTypeOf<Input["notes"][number]>().toEqualTypeOf<{
      readonly id: string
      readonly text: string
    }>()
  })
})

// Compile-enforced: each of these is a type error, and fails `pnpm check` if it compiles.
function _refusals(input: Input): void {
  // @ts-expect-error — a number key takes no string
  const _numberAsString: Input["numberLineId"] = "5"
  // @ts-expect-error — a bigint key takes no number
  const _bigintAsNumber: Input["bigintLineId"] = 5
  // @ts-expect-error — a many edge of number ids takes no strings
  const _numbersAsStrings: Input["numberLines"] = ["5"]
  // @ts-expect-error — an entity keyed by two attributes is given whole, not by one id
  const _pairId: string = input.pairLineId
  // @ts-expect-error — a sort-key-only key takes a string, so it is not `never`
  const _sortKeyNever: never = input.sortKeyLineId
  // @ts-expect-error — an element wrapping the entity takes its id, not the entity
  const _sheetLine: NumberLine = input.sheets[0]!.numberLine
  // @ts-expect-error — an element with no entity to fetch keeps its fields, so has no `idId`
  const _noteId: string = input.notes[0]!.idId
  void _numberAsString
  void _bigintAsNumber
  void _numbersAsStrings
  void _pairId
  void _sortKeyNever
  void _sheetLine
  void _noteId
}
void _refusals
