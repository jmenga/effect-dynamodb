/**
 * Type-level tests for what an aggregate's `create` takes (`AggregateCreateInputType`), on the
 * aggregate, on the bound aggregate, and on the typed client's `db.aggregates`.
 *
 * `create` takes the aggregate's own key composites, which its input schema leaves out because a
 * caller supplies them (from a path, say). An edge whose entity one id names takes `${field}Id`, or
 * the entity whole under the field's name, or both, when the id is fetched. A many edge over such
 * an entity takes each element as its id or the entity whole, in any mix, and an element wrapping
 * the entity takes either for each field holding it. An id is a value of the key composite's type,
 * or its stored or JSON form where that is another kind of value. A branded id keeps its brand.
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
const PairLines = Entity.make({
  model: PairLine,
  entityType: "PairLine",
  primaryKey: {
    pk: { field: "pk", composite: ["tenant"] },
    sk: { field: "sk", composite: ["lineId"] },
  },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { NumberLines, CodecLines, DateLines, BrandLines, PairLines },
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
  sheets: Schema.Array(Schema.Struct({ numberLine: NumberLine, qty: Schema.Number })),
  maybeSheets: Schema.Array(
    Schema.Struct({ numberLine: Schema.optional(NumberLine), qty: Schema.Number }),
  ),
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
      entity: NumberLines,
      sk: { composite: ["qty"] },
    }),
    maybeSheets: Aggregate.many({
      entityType: "RootMaybeSheet",
      entity: NumberLines,
      sk: { composite: ["qty"] },
    }),
    notes: Aggregate.many({ entityType: "RootNote", sk: { composite: ["id"] } }),
    team: TeamAggregate.with({ discriminator: { teamNumber: 1 } }),
  },
})

type Create = Parameters<typeof RootAggregate.create>[0]

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
  sheets: [{ numberLineId: 1, qty: 2 }],
  maybeSheets: [{ qty: 2 }],
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
    expectTypeOf({ ...base, sheets: [{ numberLine: line, qty: 2 }] }).toExtend<Create>()
    expectTypeOf({ ...base, maybeSheets: [{ numberLineId: 1, qty: 2 }] }).toExtend<Create>()
    expectTypeOf({ ...base, maybeSheets: [{ numberLine: line, qty: 2 }] }).toExtend<Create>()
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
}
void _refusals
