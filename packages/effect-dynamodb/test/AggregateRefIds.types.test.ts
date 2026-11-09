/**
 * Type-level tests for the id an aggregate edge takes in place of its entity (`Aggregate.Input`).
 *
 * An edge whose entity is keyed by one attribute (once, or in both halves of its key) takes an id
 * of that attribute's type, named `${field}Id`: a number for a number key, a bigint for a bigint
 * key, a `Date` for a `Date` key, a string when the key is in the sort key alone. An edge whose
 * entity is keyed by two attributes takes the entity whole, as `create` fetches nothing for it.
 * These match what `create` does at run time (`AggregateRefHydration.test.ts`).
 *
 * A `many` element is judged from its schema, never its domain type. One that is the entity takes
 * its id or the entity whole. One that names the field holding the entity takes the element whole,
 * or with that field's id in its place: a `Schema.Struct` or `Schema.Class` (no union, no
 * transformation) whose field of the entity's name is the entity's model, under `Schema.optional`
 * at most, and which declares no `${field}Id` itself. `create` takes the field's name from the
 * model's identifier, or from the `entityType` for a model with none, so the type sees it only for
 * a `Schema.Struct` model (in a `DynamoModel.configure` wrapper or not) and an `entityType` that is
 * one literal. Every other element is typed exactly as on 1.39.0, as `create` judges it as 1.39.0
 * did.
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Option, Schema, SchemaGetter } from "effect"
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

/** A `Schema.Struct` model: `create` takes the entity in the field its `entityType` names. */
const NumberRow = Schema.Struct({ lineId: Schema.Number, f: Schema.Number })
const NumberRows = Entity.make({
  model: NumberRow,
  entityType: "NumberRow",
  primaryKey: { pk: { field: "pk", composite: ["lineId"] }, sk: { field: "sk", composite: [] } },
})
/** The same model in a `DynamoModel.configure` wrapper, which has no identifier either. */
const ConfiguredRows = Entity.make({
  model: DynamoModel.configure(NumberRow, { f: { immutable: true } }),
  entityType: "ConfiguredRow",
  primaryKey: { pk: { field: "pk", composite: ["lineId"] }, sk: { field: "sk", composite: [] } },
})
/** A `Schema.Struct` model keyed by a string. */
const StringRow = Schema.Struct({ id: Schema.String, f: Schema.Number })
const StringRows = Entity.make({
  model: StringRow,
  entityType: "StringRow",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
/** An entity type the type sees only as `string`, over a model with an `id: string`. */
const IdRow = Schema.Struct({ id: Schema.String, f: Schema.Number })
const looseRowType: string = "LooseRow"
const LooseRows = Entity.make({
  model: IdRow,
  entityType: looseRowType,
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
/** A class named otherwise than its entity type: `create` takes the class's name, `lineItem`. */
class LineItem extends Schema.Class<LineItem>("LineItem")({
  lineId: Schema.Number,
  f: Schema.Number,
}) {}
const LineItems = Entity.make({
  model: LineItem,
  entityType: "Line",
  primaryKey: { pk: { field: "pk", composite: ["lineId"] }, sk: { field: "sk", composite: [] } },
})
/** A class in a `DynamoModel.configure` wrapper: `create` takes the `entityType`. */
const ConfiguredLines = Entity.make({
  model: DynamoModel.configure(NumberLine, { f: { immutable: true } }),
  entityType: "ConfiguredLine",
  primaryKey: { pk: { field: "pk", composite: ["lineId"] }, sk: { field: "sk", composite: [] } },
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
    NumberRows,
    StringRows,
    ConfiguredRows,
    LooseRows,
    LineItems,
    ConfiguredLines,
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
  crews: Schema.Array(Schema.Struct({ captain: NumberLine, qty: Schema.Number })),
  labels: Schema.Array(Schema.Struct({ numberLine: Schema.String, qty: Schema.Number })),
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
  rowSheets: Schema.Array(Schema.Struct({ numberRow: NumberRow, qty: Schema.Number })),
  maybeRowSheets: Schema.Array(
    Schema.Struct({ numberRow: Schema.optional(NumberRow), qty: Schema.Number }),
  ),
  rowCrews: Schema.Array(Schema.Struct({ captain: NumberRow, qty: Schema.Number })),
  rowLabels: Schema.Array(Schema.Struct({ numberRow: Schema.String, qty: Schema.Number })),
  configuredRowSheets: Schema.Array(
    Schema.Struct({ configuredRow: NumberRow, qty: Schema.Number }),
  ),
  rows: Schema.Array(NumberRow),
  stringRowSheets: Schema.Array(Schema.Struct({ stringRow: StringRow, qty: Schema.Number })),
  maybeStringRowSheets: Schema.Array(
    Schema.Struct({ stringRow: Schema.optional(StringRow), qty: Schema.Number }),
  ),
  optionRowSheets: Schema.Array(
    Schema.Struct({ numberRow: Schema.Option(Schema.String), qty: Schema.Number }),
  ),
  nullRowSheets: Schema.Array(
    Schema.Struct({ numberRow: Schema.NullOr(NumberRow), qty: Schema.Number }),
  ),
  ownIdRowSheets: Schema.Array(
    Schema.Struct({
      numberRow: Schema.Option(Schema.String),
      numberRowId: Schema.optional(Schema.Number),
      qty: Schema.Number,
    }),
  ),
  declaredIdRowSheets: Schema.Array(
    Schema.Struct({ numberRow: NumberRow, numberRowId: Schema.Number, qty: Schema.Number }),
  ),
  sameRowKinds: Schema.Array(
    Schema.Union([
      Schema.Struct({ numberRow: NumberRow, qty: Schema.Number }),
      Schema.Struct({ numberRow: NumberRow, qty: Schema.NumberFromString }),
    ]),
  ),
  codecRowSheets: Schema.Array(
    Schema.Struct({ numberRow: NumberRow, qty: Schema.Number }).pipe(
      Schema.decodeTo(Schema.Struct({ numberRow: NumberRow, qty: Schema.Number }), {
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  ),
  looseSheets: Schema.Array(
    Schema.Struct({ looseRow: IdRow, captain: IdRow, other: NumberRow, qty: Schema.Number }),
  ),
  idSheets: Schema.Array(
    Schema.Struct({ stringIdLine: StringIdLine, captain: StringIdLine, qty: Schema.Number }),
  ),
  itemSheets: Schema.Array(
    Schema.Struct({ line: LineItem, lineItem: LineItem, qty: Schema.Number }),
  ),
  configuredLineSheets: Schema.Array(
    Schema.Struct({ configuredLine: NumberLine, qty: Schema.Number }),
  ),
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
    crews: Aggregate.many({
      entityType: "RootCrew",
      entity: NumberLines,
      sk: { composite: ["qty"] },
    }),
    labels: Aggregate.many({
      entityType: "RootLabel",
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
    rowSheets: Aggregate.many({
      entityType: "RootRowSheet",
      entity: NumberRows,
      sk: { composite: ["qty"] },
    }),
    maybeRowSheets: Aggregate.many({
      entityType: "RootMaybeRowSheet",
      entity: NumberRows,
      sk: { composite: ["qty"] },
    }),
    rowCrews: Aggregate.many({
      entityType: "RootRowCrew",
      entity: NumberRows,
      sk: { composite: ["qty"] },
    }),
    rowLabels: Aggregate.many({
      entityType: "RootRowLabel",
      entity: NumberRows,
      sk: { composite: ["qty"] },
    }),
    configuredRowSheets: Aggregate.many({
      entityType: "RootConfiguredRowSheet",
      entity: ConfiguredRows,
      sk: { composite: ["qty"] },
    }),
    looseSheets: Aggregate.many({
      entityType: "RootLooseSheet",
      entity: LooseRows,
      sk: { composite: ["qty"] },
    }),
    idSheets: Aggregate.many({
      entityType: "RootIdSheet",
      entity: StringIdLines,
      sk: { composite: ["qty"] },
    }),
    itemSheets: Aggregate.many({
      entityType: "RootItemSheet",
      entity: LineItems,
      sk: { composite: ["qty"] },
    }),
    configuredLineSheets: Aggregate.many({
      entityType: "RootConfiguredLineSheet",
      entity: ConfiguredLines,
      sk: { composite: ["qty"] },
    }),
    rows: Aggregate.many({
      entityType: "RootRow",
      entity: NumberRows,
      sk: { composite: ["lineId"] },
    }),
    stringRowSheets: Aggregate.many({
      entityType: "RootStringRowSheet",
      entity: StringRows,
      sk: { composite: ["qty"] },
    }),
    maybeStringRowSheets: Aggregate.many({
      entityType: "RootMaybeStringRowSheet",
      entity: StringRows,
      sk: { composite: ["qty"] },
    }),
    optionRowSheets: Aggregate.many({
      entityType: "RootOptionRowSheet",
      entity: NumberRows,
      sk: { composite: ["qty"] },
    }),
    nullRowSheets: Aggregate.many({
      entityType: "RootNullRowSheet",
      entity: NumberRows,
      sk: { composite: ["qty"] },
    }),
    ownIdRowSheets: Aggregate.many({
      entityType: "RootOwnIdRowSheet",
      entity: NumberRows,
      sk: { composite: ["qty"] },
    }),
    declaredIdRowSheets: Aggregate.many({
      entityType: "RootDeclaredIdRowSheet",
      entity: NumberRows,
      sk: { composite: ["qty"] },
    }),
    sameRowKinds: Aggregate.many({ entityType: "RootSameRowKind", entity: NumberRows }),
    codecRowSheets: Aggregate.many({ entityType: "RootCodecRowSheet", entity: NumberRows }),
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

  it("a many edge of the entity takes ids of the key attribute, or the entity whole", () => {
    expectTypeOf<Input["numberLines"]>().toEqualTypeOf<ReadonlyArray<number | NumberLine>>()
    expectTypeOf<Input["rows"]>().toEqualTypeOf<ReadonlyArray<number | typeof NumberRow.Type>>()
  })

  it("a many element wrapping the entity takes it whole, or its id", () => {
    expectTypeOf<Input["rowSheets"][number]>().toEqualTypeOf<
      | {
          readonly numberRow: typeof NumberRow.Type
          readonly qty: number
          readonly numberRowId?: never
        }
      | { readonly numberRowId: number; readonly qty: number; readonly numberRow?: never }
    >()
  })

  it("a many element holding the entity optionally takes it whole or by id, either optional", () => {
    expectTypeOf<Input["maybeRowSheets"][number]>().toEqualTypeOf<
      | {
          readonly numberRow?: typeof NumberRow.Type | undefined
          readonly qty: number
          readonly numberRowId?: never
        }
      | {
          readonly numberRowId?: number | undefined
          readonly qty: number
          readonly numberRow?: never
        }
    >()
  })

  it("a string keyed struct entity's element takes it whole or by id, optional or not", () => {
    expectTypeOf<Input["stringRowSheets"][number]>().toEqualTypeOf<
      | {
          readonly stringRow: typeof StringRow.Type
          readonly qty: number
          readonly stringRowId?: never
        }
      | { readonly stringRowId: string; readonly qty: number; readonly stringRow?: never }
    >()
    expectTypeOf<Input["maybeStringRowSheets"][number]>().toEqualTypeOf<
      | {
          readonly stringRow?: typeof StringRow.Type | undefined
          readonly qty: number
          readonly stringRowId?: never
        }
      | {
          readonly stringRowId?: string | undefined
          readonly qty: number
          readonly stringRow?: never
        }
    >()
  })

  it("a many element holding the entity in a field of another name takes it whole", () => {
    // `create` takes the entity by id only in the field of its name (`numberRow`).
    expectTypeOf<Input["rowCrews"][number]>().toEqualTypeOf<{
      readonly captain: typeof NumberRow.Type
      readonly qty: number
    }>()
  })

  it("a many element declaring the entity's field a scalar takes it as declared", () => {
    expectTypeOf<Input["rowLabels"][number]>().toEqualTypeOf<{
      readonly numberRow: string
      readonly qty: number
    }>()
  })

  it("a configured struct model's element takes it in the field its entity type names", () => {
    expectTypeOf<Input["configuredRowSheets"][number]>().toEqualTypeOf<
      | {
          readonly configuredRow: typeof NumberRow.Type
          readonly qty: number
          readonly configuredRowId?: never
        }
      | { readonly configuredRowId: number; readonly qty: number; readonly configuredRow?: never }
    >()
  })
})

describe("an element whose schema doesn't name the field holding the entity is typed as on 1.39.0", () => {
  // Each of these compiles against 1.39.0's declarations as given here, and `create` takes it as
  // 1.39.0 did: a `${field}Id` is fetched only when it is a string.

  it("a field of the entity's name declared an `Option`: as declared", () => {
    expectTypeOf<Input["optionRowSheets"][number]>().toEqualTypeOf<{
      readonly numberRow: Option.Option<string>
      readonly qty: number
    }>()
  })

  it("a field of the entity's name declared nullable: as declared", () => {
    expectTypeOf<Input["nullRowSheets"][number]>().toEqualTypeOf<{
      readonly numberRow: typeof NumberRow.Type | null
      readonly qty: number
    }>()
  })

  it("an element declaring its own `numberRowId`: as declared, that field its own data", () => {
    expectTypeOf<Input["ownIdRowSheets"][number]>().toEqualTypeOf<{
      readonly numberRow: Option.Option<string>
      readonly numberRowId?: number | undefined
      readonly qty: number
    }>()
    expectTypeOf<Input["declaredIdRowSheets"][number]>().toEqualTypeOf<{
      readonly numberRow: typeof NumberRow.Type
      readonly numberRowId: number
      readonly qty: number
    }>()
  })

  it("a union whose members have one domain type is still a union: as declared", () => {
    expectTypeOf<Input["sameRowKinds"][number]>().toEqualTypeOf<{
      readonly numberRow: typeof NumberRow.Type
      readonly qty: number
    }>()
  })

  it("a struct through a transformation: as declared", () => {
    expectTypeOf<Input["codecRowSheets"][number]>().toEqualTypeOf<{
      readonly numberRow: typeof NumberRow.Type
      readonly qty: number
    }>()
  })
})

describe("a many element whose entity's field name the type can't see is typed as on 1.39.0", () => {
  // 1.39.0 took a field whose type has an `id: string` (and no index signature) as `${field}Id`,
  // whatever its name, and every other field as declared.

  it("an entity type typed `string` names no field: every field as 1.39.0 typed it", () => {
    // Not every field holding a record: `Uncapitalize<string>` would match each of them.
    expectTypeOf<Input["looseSheets"][number]>().toEqualTypeOf<{
      readonly looseRowId: string
      readonly captainId: string
      readonly other: typeof NumberRow.Type
      readonly qty: number
    }>()
  })

  it("a class named as its entity type, with no `id: string`: taken as declared", () => {
    expectTypeOf<Input["sheets"][number]>().toEqualTypeOf<{
      readonly numberLine: NumberLine
      readonly qty: number
    }>()
    expectTypeOf<Input["maybeSheets"][number]>().toEqualTypeOf<{
      readonly numberLine?: NumberLine | undefined
      readonly qty: number
    }>()
    expectTypeOf<Input["crews"][number]>().toEqualTypeOf<{
      readonly captain: NumberLine
      readonly qty: number
    }>()
    expectTypeOf<Input["labels"][number]>().toEqualTypeOf<{
      readonly numberLine: string
      readonly qty: number
    }>()
  })

  it("a class named as its entity type, with an `id: string`: each such field by id", () => {
    // As on 1.39.0. `create` fetches `stringIdLineId`; it takes `captain` only whole.
    expectTypeOf<Input["idSheets"][number]>().toEqualTypeOf<{
      readonly stringIdLineId: string
      readonly captainId: string
      readonly qty: number
    }>()
  })

  it("a class named otherwise than its entity type: taken as declared", () => {
    // `create` names the field by the class (`lineItem`), not by the entity type (`line`).
    expectTypeOf<Input["itemSheets"][number]>().toEqualTypeOf<{
      readonly line: LineItem
      readonly lineItem: LineItem
      readonly qty: number
    }>()
  })

  it("a class in a configure wrapper: taken as declared", () => {
    expectTypeOf<Input["configuredLineSheets"][number]>().toEqualTypeOf<{
      readonly configuredLine: NumberLine
      readonly qty: number
    }>()
  })
})

describe("a many element that is a union", () => {
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
})

describe("a many element with no entity one id names is taken as given", () => {
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
  // @ts-expect-error — an element wrapping the entity may be given by id, so its field may be absent
  const _sheetRow: typeof NumberRow.Type = input.rowSheets[0]!.numberRow
  // @ts-expect-error — an element with no entity to fetch keeps its fields, so has no `idId`
  const _noteId: string = input.notes[0]!.idId
  // @ts-expect-error — a field of another name than the entity's is not taken by id
  const _captainId: number = input.rowCrews[0]!.captainId
  // @ts-expect-error — an entity type typed `string` names no field
  const _looseOtherId: number = input.looseSheets[0]!.otherId
  // @ts-expect-error — a class named otherwise than its entity type: no field by the entity type
  const _itemLineId: number = input.itemSheets[0]!.lineId
  void _numberAsString
  void _bigintAsNumber
  void _numbersAsStrings
  void _pairId
  void _sortKeyNever
  void _sheetRow
  void _noteId
  void _captainId
  void _looseOtherId
  void _itemLineId
}
void _refusals

// Compile-enforced: each of these is a valid input, and fails `pnpm check` if it doesn't compile.
const _accepted: ReadonlyArray<Partial<Input>> = [
  {
    rowSheets: [
      { numberRow: { lineId: 5, f: 1 }, qty: 1 },
      { numberRowId: 5, qty: 1 },
    ],
  },
  {
    maybeRowSheets: [
      { qty: 1 },
      { numberRow: { lineId: 5, f: 1 }, qty: 1 },
      { numberRowId: 5, qty: 1 },
    ],
  },
  {
    stringRowSheets: [
      { stringRow: { id: "L", f: 1 }, qty: 1 },
      { stringRowId: "L", qty: 1 },
    ],
  },
  { maybeStringRowSheets: [{ qty: 1 }, { stringRow: { id: "L", f: 1 }, qty: 1 }] },
  { maybeStringRowSheets: [{ stringRowId: "L", qty: 1 }] },
  { rows: [5, { lineId: 5, f: 1 }] },
  { optionRowSheets: [{ numberRow: Option.some("KEEP"), qty: 1 }] },
  { ownIdRowSheets: [{ numberRow: Option.some("KEEP"), numberRowId: 5, qty: 1 }] },
  { sameRowKinds: [{ numberRow: { lineId: 5, f: 1 }, qty: 1 }] },
]
void _accepted

// Compile-enforced: no id form is advertised where `create` doesn't take one.
function _idRefusals(): void {
  // @ts-expect-error — the whole and the id forms exclude each other
  const _both: Input["rowSheets"][number] = {
    numberRow: { lineId: 5, f: 1 },
    numberRowId: 5,
    qty: 1,
  }
  // @ts-expect-error — a field declared an `Option` is not taken by id
  const _optionId: Input["optionRowSheets"][number] = { numberRowId: 5, qty: 1 }
  // @ts-expect-error — a field declared nullable is not taken by id
  const _nullId: Input["nullRowSheets"][number] = { numberRowId: 5, qty: 1 }
  // @ts-expect-error — a union element is not taken by a number id
  const _unionId: Input["sameRowKinds"][number] = { numberRowId: 5, qty: 1 }
  // @ts-expect-error — a transformed element is not taken by a number id
  const _codecId: Input["codecRowSheets"][number] = { numberRowId: 5, qty: 1 }
  // @ts-expect-error — an element declaring `${field}Id` keeps its field
  const _declaredId: Input["declaredIdRowSheets"][number] = { numberRowId: 5, qty: 1 }
  void _both
  void _optionId
  void _nullId
  void _unionId
  void _codecId
  void _declaredId
}
void _idRefusals
