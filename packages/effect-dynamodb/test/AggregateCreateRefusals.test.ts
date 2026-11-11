/**
 * What `create` does at run time with each input its type refuses or newly takes, beside what
 * published 1.39.0 did (`test/fixtures/create-refusals-1.39.0.json`, generated against 1.39.0 on
 * DynamoDB Local with request capture). `create`'s type refuses exactly the inputs 1.39.0 failed
 * on (an error, or wrong stored data) and takes everything that worked there
 * (`AggregateCreateInput.types.test.ts` pins the type of each). So each input the type refuses
 * fails here too, writing nothing, and each it takes creates what 1.39.0 created.
 *
 * The definitions mirror the fixture generator's, which mirror the type test's.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, DateTime, Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/create-refusals-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly generatedFrom: string
  readonly cases: Record<
    string,
    {
      readonly create: string
      readonly requests: ReadonlyArray<string>
      readonly written: number
      readonly get: string
    }
  >
}

const json = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v))

// The fixture's definitions: they must stay what its generator declared.
const AppSchema = DynamoSchema.make({ name: "create-input", version: 1 })
const LineId = Schema.String.pipe(Schema.brand("LineId"))
class NumberLine extends Schema.Class<NumberLine>("NumberLine")({
  lineId: Schema.Number,
  f: Schema.Number,
}) {}
class CodecLine extends Schema.Class<CodecLine>("CodecLine")({
  lineId: Schema.NumberFromString,
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
class BrandIdLine extends Schema.Class<BrandIdLine>("BrandIdLine")({
  lineId: LineId,
  f: Schema.Number,
}) {}
const keyedBy = (composite: "lineId") =>
  ({ pk: { field: "pk", composite: [composite] }, sk: { field: "sk", composite: [] } }) as const
const NumberRow = Schema.Struct({ lineId: Schema.Number, f: Schema.Number })
const entities = {
  NumberLines: Entity.make({
    model: NumberLine,
    entityType: "NumberLine",
    primaryKey: keyedBy("lineId"),
  }),
  CodecLines: Entity.make({
    model: CodecLine,
    entityType: "CodecLine",
    primaryKey: keyedBy("lineId"),
  }),
  BrandLines: Entity.make({
    model: BrandLine,
    entityType: "BrandLine",
    primaryKey: keyedBy("lineId"),
  }),
  PairLines: Entity.make({
    model: PairLine,
    entityType: "PairLine",
    primaryKey: {
      pk: { field: "pk", composite: ["tenant"] },
      sk: { field: "sk", composite: ["lineId"] },
    },
  }),
  NumberRows: Entity.make({
    model: NumberRow,
    entityType: "NumberRow",
    primaryKey: keyedBy("lineId"),
  }),
  BrandIdLines: Entity.make({
    model: DynamoModel.configure(BrandIdLine, { lineId: { identifier: true } }),
    entityType: "BrandIdLine",
    primaryKey: keyedBy("lineId"),
  }),
}

class Team extends Schema.Class<Team>("Team")({ name: Schema.String, captain: NumberLine }) {}
const TeamAggregate = Aggregate.make(Team, {
  root: { entityType: "Team" },
  edges: { captain: Aggregate.one({ entityType: "TeamCaptain", entity: entities.NumberLines }) },
})
class Root extends Schema.Class<Root>("Root")({
  id: Schema.String,
  note: Schema.String,
  count: Schema.NumberFromString,
  numberLine: NumberLine,
  codecLine: CodecLine,
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
class Branded extends Schema.Class<Branded>("Branded")({
  id: Schema.String,
  brandIdLine: BrandIdLine,
  brandIdLines: Schema.Array(BrandIdLine),
}) {}

const root = { pk: { field: "pk", composite: ["id"] } } as const
const makers = {
  Root: (Base: any) =>
    Aggregate.make(Root, {
      table: Base,
      schema: AppSchema,
      ...root,
      collection: { name: "root" },
      root: { entityType: "Root" },
      edges: {
        numberLine: Aggregate.one({ entityType: "RootNumberLine", entity: entities.NumberLines }),
        codecLine: Aggregate.one({ entityType: "RootCodecLine", entity: entities.CodecLines }),
        brandLine: Aggregate.one({ entityType: "RootBrandLine", entity: entities.BrandLines }),
        pairLine: Aggregate.one({ entityType: "RootPairLine", entity: entities.PairLines }),
        refLine: Aggregate.ref(entities.NumberLines),
        numberLines: Aggregate.many({
          entityType: "RootNumberLines",
          entity: entities.NumberLines,
          sk: { composite: ["lineId"] },
        }),
        sheets: Aggregate.many({
          entityType: "RootSheet",
          entity: entities.NumberRows,
          sk: { composite: ["qty"] },
        }),
        maybeSheets: Aggregate.many({
          entityType: "RootMaybeSheet",
          entity: entities.NumberRows,
          sk: { composite: ["qty"] },
        }),
        classSheets: Aggregate.many({
          entityType: "RootClassSheet",
          entity: entities.NumberLines,
          sk: { composite: ["qty"] },
        }),
        notes: Aggregate.many({ entityType: "RootNote", sk: { composite: ["id"] } }),
        team: TeamAggregate.with({ discriminator: { teamNumber: 1 } }),
      },
    }),
  Fields: (Base: any) =>
    Aggregate.make(Fields, {
      table: Base,
      schema: AppSchema,
      ...root,
      collection: { name: "fields" },
      root: { entityType: "Fields" },
      edges: { tags: Aggregate.many({ entityType: "FieldsTag", sk: { composite: ["n"] } }) },
    }),
  DeclaresId: (Base: any) =>
    Aggregate.make(
      Schema.Struct({
        id: Schema.String,
        numberLine: NumberLine,
        numberLineId: Schema.optional(Schema.Number),
      }),
      {
        table: Base,
        schema: AppSchema,
        ...root,
        collection: { name: "declares-id" },
        root: { entityType: "DeclaresId" },
        edges: {
          numberLine: Aggregate.one({ entityType: "DeclaresIdLine", entity: entities.NumberLines }),
        },
      },
    ),
  Branded: (Base: any) =>
    Aggregate.make(Branded, {
      table: Base,
      schema: AppSchema,
      ...root,
      collection: { name: "branded" },
      root: { entityType: "Branded" },
      edges: {
        brandIdLine: Aggregate.one({ entityType: "BrandedLine", entity: entities.BrandIdLines }),
        brandIdLines: Aggregate.many({
          entityType: "BrandedLines",
          entity: entities.BrandIdLines,
          sk: { composite: ["lineId"] },
        }),
      },
    }),
}

const seed: ReadonlyArray<readonly [keyof typeof entities, Record<string, unknown>]> = [
  ["NumberLines", { lineId: 1, f: 5 }],
  ["NumberLines", { lineId: 5, f: 1 }],
  ["CodecLines", { lineId: 2, f: 6 }],
  ["BrandLines", { lineId: "b", f: 7 }],
  ["PairLines", { tenant: "t", lineId: "p", f: 8 }],
  ["PairLines", { tenant: "p", lineId: "p", f: 9 }],
  ["NumberRows", { lineId: 1, f: 5 }],
  ["BrandIdLines", { lineId: "b", f: 7 }],
]

const line = { lineId: 1, f: 5 }
const base = {
  id: "a",
  note: "n",
  count: "3",
  numberLine: line,
  codecLine: { lineId: "2", f: 6 },
  brandLine: { lineId: "b", f: 7 },
  pairLine: { tenant: "t", lineId: "p", f: 8 },
  refLine: line,
  numberLines: [line],
  sheets: [{ numberRow: line, qty: 2 }],
  maybeSheets: [{ qty: 2 }],
  classSheets: [{ numberLine: line, qty: 2 }],
  notes: [{ id: "n1", text: "t" }],
  team: { name: "A", captain: line },
}
const without = (key: keyof typeof base) => {
  const { [key]: _, ...rest } = base
  return rest
}
const iso = "2026-01-02T03:04:05.000Z"
const utc = DateTime.makeUnsafe(iso)
const ms = Date.parse(iso)
const fieldsBase = {
  id: "a",
  count: 3,
  at: utc,
  epoch: utc,
  utc,
  when: new Date(iso),
  nested: { at: utc, n: 1 },
  tags: [{ n: 1 }],
}

/** Each case: the aggregate it's created on and its input, as the generator gave them. */
const CASES: Record<string, readonly [keyof typeof makers, Record<string, unknown>]> = {
  "baseline, every edge whole, count in its stored form": ["Root", base],
  "count as its domain value": ["Root", { ...base, count: 3 }],
  "without the aggregate's key composite": ["Root", without("id")],
  "without a required one edge, neither id nor whole": ["Root", without("numberLine")],
  "a number-keyed one edge's id as a string": [
    "Root",
    { ...without("numberLine"), numberLineId: "1" },
  ],
  "a number-keyed one edge's id as a number": [
    "Root",
    { ...without("numberLine"), numberLineId: 1 },
  ],
  "a branded-key one edge's id as a plain string": [
    "Root",
    { ...without("brandLine"), brandLineId: "b" },
  ],
  "a two-attribute-key one edge given one id": [
    "Root",
    { ...without("pairLine"), pairLineId: "p" },
  ],
  "a two-attribute-key one edge given the entity whole and one id": [
    "Root",
    { ...base, pairLineId: "p" },
  ],
  "a two-attribute-key one edge given the entity whole and a number beside it": [
    "Root",
    { ...base, pairLineId: 5 },
  ],
  "a string-keyed one edge given the entity whole and a number beside it": [
    "Root",
    { ...base, brandLineId: 5 },
  ],
  "a field given a value of another type (count a boolean)": ["Root", { ...base, count: true }],
  "a field in the wrong kind of value (count a non-numeric string)": [
    "Root",
    { ...base, count: "x" },
  ],
  "a many element that is the entity given another object": [
    "Root",
    { ...base, numberLines: [{ lineId: "x" }] },
  ],
  "a many element naming the entity's field given a string id of a number key": [
    "Root",
    { ...base, sheets: [{ numberRowId: "1", qty: 2 }] },
  ],
  "a many element naming the entity's field given a number id": [
    "Root",
    { ...base, sheets: [{ numberRowId: 1, qty: 2 }] },
  ],
  "a many element without its entity": ["Root", { ...base, sheets: [{ qty: 2 }] }],
  "a many edge given one element, not an array": [
    "Root",
    { ...base, classSheets: { numberLine: line, qty: 2 } },
  ],
  "a key the aggregate doesn't declare": ["Root", { ...base, typo: 1 }],
  "a many element's key the element doesn't declare": [
    "Root",
    { ...base, sheets: [{ numberRow: line, qty: 2, typo: 1 }] },
  ],
  "fields, every one its domain value": ["Fields", fieldsBase],
  "fields, a NumberFromString given its stored form": ["Fields", { ...fieldsBase, count: "3" }],
  "fields, a NumberFromString given a non-numeric string": [
    "Fields",
    { ...fieldsBase, count: "x" },
  ],
  "fields, a DateTimeUtcFromString given an ISO string": ["Fields", { ...fieldsBase, at: iso }],
  "fields, a DateTimeUtcFromString given a Date": ["Fields", { ...fieldsBase, at: new Date(iso) }],
  "fields, a DateTimeUtcFromString given epoch milliseconds": ["Fields", { ...fieldsBase, at: ms }],
  "fields, a DateEpochMs given epoch milliseconds": ["Fields", { ...fieldsBase, epoch: ms }],
  "fields, a DateEpochMs given a Date": ["Fields", { ...fieldsBase, epoch: new Date(iso) }],
  "fields, a DateEpochMs given an ISO string": ["Fields", { ...fieldsBase, epoch: iso }],
  "fields, a DateTimeUtc given a Date": ["Fields", { ...fieldsBase, utc: new Date(iso) }],
  "fields, a DateTimeUtc given an ISO string": ["Fields", { ...fieldsBase, utc: iso }],
  "fields, a Date given an ISO string": ["Fields", { ...fieldsBase, when: iso }],
  "fields, a Date given a DateTime.Utc": ["Fields", { ...fieldsBase, when: utc }],
  "fields, a Date given epoch milliseconds": ["Fields", { ...fieldsBase, when: ms }],
  "fields, a DateTimeUtc given epoch milliseconds": ["Fields", { ...fieldsBase, utc: ms }],
  "fields, a DateTimeUtcFromString given a non-date string": ["Fields", { ...fieldsBase, at: "x" }],
  "fields, a DateEpochMs given a non-date string": ["Fields", { ...fieldsBase, epoch: "x" }],
  "fields, a nested struct given stored forms": [
    "Fields",
    { ...fieldsBase, nested: { at: iso, n: "1" } },
  ],
  "fields, a nested struct given one stored form and one domain value": [
    "Fields",
    { ...fieldsBase, nested: { at: iso, n: 1 } },
  ],
  "fields, a many element given its stored form": ["Fields", { ...fieldsBase, tags: [{ n: "1" }] }],
  "fields, a key the model doesn't declare": ["Fields", { ...fieldsBase, typo: 1 }],
  "fields, an element's key the element doesn't declare": [
    "Fields",
    { ...fieldsBase, tags: [{ n: 1, typo: 1 }] },
  ],
  "declared id, a number the model declares without the entity whole": [
    "DeclaresId",
    { id: "a", numberLineId: 5 },
  ],
  "declared id, the entity whole and the number the model declares": [
    "DeclaresId",
    { id: "a", numberLine: { lineId: 6, f: 99 }, numberLineId: 5 },
  ],
  "declared id, the entity whole alone": [
    "DeclaresId",
    { id: "a", numberLine: { lineId: 6, f: 99 } },
  ],
  "branded, a one edge's id and a many edge's ids given plain strings, the entity with an identifier":
    ["Branded", { id: "a", brandIdLineId: "b", brandIdLines: ["b"] }],
}

/**
 * The cases whose outcome changed from 1.39.0, each a deliberate fix: an input 1.39.0 died on
 * (an id `create` fetched under the identifier of an entity that has none, or of a type no key
 * holds) is refused with a `ValidationError` before anything is fetched, or created, and a number
 * id 1.39.0 dropped is fetched.
 */
const NOW_REFUSED = [
  "a number-keyed one edge's id as a string",
  "a two-attribute-key one edge given one id",
  "a two-attribute-key one edge given the entity whole and one id",
  "a many element naming the entity's field given a string id of a number key",
]
const NOW_CREATED = [
  "a number-keyed one edge's id as a number",
  "a branded-key one edge's id as a plain string",
  "a many element naming the entity's field given a number id",
]

/** Seeds the entities, then runs `create` and `get` on a recording table. */
const run = (maker: keyof typeof makers, input: Record<string, unknown>) => {
  const table = makeRecordingTable()
  const Base = Table.make({ schema: AppSchema, entities } as never) as any
  const A = makers[maker](Base)
  const Tb = { ...Base, aggregates: { A } }
  return Effect.gen(function* () {
    const edb: any = yield* DynamoClient.make({
      entities,
      tables: { Base },
    } as never) as Effect.Effect<any>
    for (const [member, item] of seed) yield* edb.entities[member].put(item).asEffect()
    table.take()
    const db: any = yield* DynamoClient.make({
      entities: {},
      aggregates: { A },
      tables: { Tb },
    } as never) as Effect.Effect<any>
    const create = yield* Effect.exit(db.aggregates.A.create(input) as Effect.Effect<unknown>)
    const requests = table.take().map((request) => request.command)
    const get = yield* Effect.exit(db.aggregates.A.get({ id: "a" }) as Effect.Effect<unknown>)
    return { create, requests, get }
  }).pipe(
    Effect.provide(Base.layer({ name: "t" })),
    Effect.provide(table.layer),
  ) as unknown as Effect.Effect<{
    create: Exit.Exit<unknown, unknown>
    requests: ReadonlyArray<string>
    get: Exit.Exit<unknown, unknown>
  }>
}

const writes = (requests: ReadonlyArray<string>) =>
  requests.filter((command) => command === "TransactWriteItems" || command === "PutItem").length

describe("create at run time, for each input its type refuses or newly takes, beside 1.39.0", () => {
  it("covers every case the fixture holds, generated from published 1.39.0", () => {
    expect(fixture.generatedFrom).toBe("effect-dynamodb@1.39.0")
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(fixture.cases).sort())
  })

  for (const [label, [maker, input]] of Object.entries(CASES)) {
    const was = fixture.cases[label]!
    if (NOW_REFUSED.includes(label)) {
      it.effect(`${label}: refused, writing nothing (1.39.0: ${was.create.slice(0, 60)})`, () =>
        Effect.gen(function* () {
          expect(was.create).toMatch(/^died: /)
          const { create, requests } = yield* run(maker, input)
          expect(Exit.isFailure(create)).toBe(true)
          const cause = (create as Exit.Failure<unknown, unknown>).cause
          expect(Cause.hasDies(cause)).toBe(false)
          expect(writes(requests)).toBe(0)
        }),
      )
    } else if (NOW_CREATED.includes(label)) {
      it.effect(`${label}: created, where 1.39.0 ${was.create.slice(0, 60)}`, () =>
        Effect.gen(function* () {
          expect(was.written).toBe(0)
          const { create, get } = yield* run(maker, input)
          expect(Exit.isSuccess(create)).toBe(true)
          expect(Exit.isSuccess(get) && json(get.value)).toBe(
            fixture.cases["baseline, every edge whole, count in its stored form"]!.get.replace(
              /^ok /,
              "",
            ),
          )
        }),
      )
    } else if (was.create.startsWith("ok ")) {
      it.effect(`${label}: created, as 1.39.0 created it`, () =>
        Effect.gen(function* () {
          const { create, requests, get } = yield* run(maker, input)
          expect(Exit.isSuccess(create) && json(create.value)).toBe(was.create.replace(/^ok /, ""))
          expect(requests.map((command) => command[0]!.toLowerCase() + command.slice(1))).toEqual(
            was.requests,
          )
          expect(Exit.isSuccess(get) && json(get.value)).toBe(was.get.replace(/^ok /, ""))
        }),
      )
    } else {
      it.effect(`${label}: refused, writing nothing, as 1.39.0 refused it`, () =>
        Effect.gen(function* () {
          expect(was.create).toMatch(/^failed: ValidationError/)
          expect(was.written).toBe(0)
          const { create, requests } = yield* run(maker, input)
          expect(Exit.isFailure(create)).toBe(true)
          expect(Cause.hasDies((create as Exit.Failure<unknown, unknown>).cause)).toBe(false)
          expect(writes(requests)).toBe(0)
        }),
      )
    }
  }
})
