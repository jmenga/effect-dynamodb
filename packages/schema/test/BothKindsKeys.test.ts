/**
 * `EDD-9128`: no value is composed into key text from a field storing both numeric kinds
 * (`DESIGN.md` §7, "Both numeric kinds"). DynamoDB stores `5` and `5n` alike and reads a safe
 * integer back as a number, while the two compose different key text, so a key composed again from
 * a stored row couldn't be the one written. Refused at load, by the pure `Entity.make` and
 * `Aggregate.make` here, and by the operational ones in `effect-dynamodb`
 * (`test/BothKindsKeys.test.ts`).
 */

import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"

const Numeric = { A: 1, B: 2 } as const

/** Fields storing both numeric kinds, each named for the test. */
const BOTH: ReadonlyArray<readonly [string, Schema.Top]> = [
  ["Union([Number, BigInt])", Schema.Union([Schema.Number, Schema.BigInt])],
  ["Union([BigInt, Number])", Schema.Union([Schema.BigInt, Schema.Number])],
  ["a number literal beside BigInt", Schema.Union([Schema.Literal(1), Schema.BigInt])],
  ["a numeric enum beside BigInt", Schema.Union([Schema.Enum(Numeric), Schema.BigInt])],
  ["Union([String, Number, BigInt])", Schema.Union([Schema.String, Schema.Number, Schema.BigInt])],
  [
    "optional Union([Number, BigInt])",
    Schema.optional(Schema.Union([Schema.Number, Schema.BigInt])),
  ],
  ["a branded union", Schema.Union([Schema.Number, Schema.BigInt]).pipe(Schema.brand("N"))],
]

/**
 * Fields storing one numeric kind, or none, composed as before; and `Schema.Unknown` and
 * `Schema.Any`, which declare no kind: a key over one holding strings works, so its values are judged
 * at write instead (`effect-dynamodb`'s `test/UnknownKeyKinds.test.ts`).
 */
const ONE: ReadonlyArray<readonly [string, Schema.Top]> = [
  ["Unknown", Schema.Unknown],
  ["Any", Schema.Any],
  ["Union([Unknown, BigInt])", Schema.Union([Schema.Unknown, Schema.BigInt])],
  ["Number", Schema.Number],
  ["BigInt", Schema.BigInt],
  ["Union([String, BigInt])", Schema.Union([Schema.String, Schema.BigInt])],
  ["Union([String, Number])", Schema.Union([Schema.String, Schema.Number])],
  ["a numeric enum", Schema.Enum(Numeric)],
  ["BigIntFromString", Schema.BigIntFromString],
  ["OptionFromNullOr(BigInt)", Schema.OptionFromNullOr(Schema.BigInt)],
]

const entity = (n: Schema.Top, config: Record<string, unknown>) => () =>
  Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      n,
      other: Schema.String,
      num: Schema.Number,
      note: Schema.String,
    }),
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...config,
  } as never)

const index = (pk: ReadonlyArray<string>, sk: Record<string, unknown>) => ({
  indexes: {
    byN: { name: "gsi1", pk: { field: "gsi1pk", composite: pk }, sk: { field: "gsi1sk", ...sk } },
  },
})

/** Each place an entity composes a value into key text. */
const ENTITY_PLACES: ReadonlyArray<
  readonly [string, (n: Schema.Top) => Record<string, unknown>, RegExp]
> = [
  [
    "the primary key's partition half",
    () => ({
      primaryKey: { pk: { field: "pk", composite: ["n"] }, sk: { field: "sk", composite: [] } },
    }),
    /the primary key/,
  ],
  [
    "the primary key's sort half",
    () => ({
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["n"] } },
    }),
    /the primary key/,
  ],
  ["an index's partition half", () => index(["n"], { composite: [] }), /index "byN"/],
  ["an index's sort half", () => index(["id"], { composite: ["other", "n"] }), /index "byN"/],
  [
    "a Z-order prefix",
    () => index(["id"], { prefix: ["n"], zorder: [{ field: "num", min: 0, max: 100 }] }),
    /index "byN"/,
  ],
  ["a unique constraint", () => ({ unique: { byN: ["other", "n"] } }), /unique constraint "byN"/],
  [
    "a vector partition",
    () => ({
      vectorIndexes: {
        byNote: {
          name: "vec1",
          dimensions: 2,
          distance: "cosine",
          source: { fields: ["note"] },
          partition: ["n"],
        },
      },
    }),
    /vector index "byNote"'s partition/,
  ],
  [
    "a time-series orderBy",
    (n) => ({
      timeSeries: {
        orderBy: "n",
        appendInput: Schema.Struct({ id: Schema.String, n, note: Schema.String }),
      },
    }),
    /timeSeries\.orderBy/,
  ],
]

describe("EDD-9128 on an entity, a key composed from a field storing both numeric kinds", () => {
  for (const [place, config, where] of ENTITY_PLACES) {
    describe(place, () => {
      for (const [name, n] of BOTH) {
        it(`is refused: ${name}`, () => {
          expect(entity(n, config(n))).toThrow(/\[EDD-9128\] Entity "E": /)
          expect(entity(n, config(n))).toThrow(where)
          expect(entity(n, config(n))).toThrow(/"n", which stores both a number and a bigint/)
        })
      }
      for (const [name, n] of ONE) {
        it(`isn't: ${name}`, () => {
          let thrown: unknown
          try {
            entity(n, config(n))()
          } catch (error) {
            thrown = error
          }
          // A shape another check refuses (a Z-order prefix, a time-series orderBy) may throw,
          // but never this.
          expect(String(thrown ?? "")).not.toMatch(/EDD-9128/)
        })
      }
    })
  }

  it("says what to do", () => {
    expect(entity(BOTH[0]![1], ENTITY_PLACES[0]![1](BOTH[0]![1]))).toThrow(
      /Declare the one kind it holds/,
    )
  })

  it("a field no key reads may store both", () => {
    for (const [, n] of BOTH) {
      expect(
        entity(n, { unique: { byOther: ["other"] }, ...index(["id"], { composite: ["other"] }) }),
      ).not.toThrow()
    }
  })

  it("a ref's identifier, composed into a key as `<ref>Id`", () => {
    const Team = (teamId: Schema.Top) =>
      Schema.Struct({ teamId, name: Schema.String }).annotate({ identifier: "Team" })
    const player = (teamId: Schema.Top) => () => {
      const model = Team(teamId)
      const Teams = Entity.make({
        model: DynamoModel.configure(model, { teamId: { identifier: true } }),
        entityType: "Team",
        primaryKey: {
          pk: { field: "pk", composite: ["name"] },
          sk: { field: "sk", composite: [] },
        },
      } as never)
      return Entity.make({
        model: DynamoModel.configure(Schema.Struct({ playerId: Schema.String, team: model }), {
          playerId: { identifier: true },
          team: { ref: true },
        }),
        entityType: "Player",
        primaryKey: {
          pk: { field: "pk", composite: ["playerId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byTeam: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["teamId"] },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
        refs: { team: { entity: Teams } },
      } as never)
    }
    expect(player(Schema.Union([Schema.Number, Schema.BigInt]))).toThrow(
      /\[EDD-9128\] Entity "Player": index "byTeam" can't be composed from "teamId"/,
    )
    expect(player(Schema.BigInt)).not.toThrow()
  })

  it("a Z-order dimension keeps its own refusal (EDD-9088)", () => {
    const config = index(["id"], { zorder: [{ field: "n", min: 0, max: 100 }] })
    expect(entity(BOTH[0]![1], config)).toThrow(/EDD-9088/)
  })
})

const schema = DynamoSchema.make({ name: "app", version: 1 })

const aggregate = (n: Schema.Top, config: Record<string, unknown>) => () => {
  const Line = Schema.Struct({ sku: Schema.String, n })
  const Sub = Aggregate.make(Schema.Struct({ name: Schema.String, lines: Schema.Array(Line) }), {
    root: { entityType: "Sub" },
    edges: { lines: Aggregate.many({ entityType: "SubLine", sk: { composite: ["n"] } }) },
  } as never) as any
  const Model = Schema.Struct({
    id: Schema.String,
    n,
    cust: Schema.String,
    lines: Schema.Array(Line),
    sub: Schema.Struct({ name: Schema.String, lines: Schema.Array(Line) }),
  })
  const { sub, ...rest } = config as { sub?: boolean }
  return Aggregate.make(Model, {
    table: { Tag: Symbol.for("test/table") },
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { index: "gsi1", name: "c", sk: { field: "gsi1sk", composite: [] } },
    root: { entityType: "Root" },
    edges: {
      lines: Aggregate.many({ entityType: "Line", sk: { composite: ["sku"] } }),
      ...(sub === true ? { sub: Sub.with({ discriminator: { kind: "s" } }) } : {}),
    },
    ...rest,
  } as never)
}

const AGGREGATE_PLACES: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
  ["its partition key", { pk: { field: "pk", composite: ["id", "n"] } }, /its partition key/],
  [
    "its collection sort key",
    { collection: { index: "gsi1", name: "c", sk: { field: "gsi1sk", composite: ["n"] } } },
    /its collection sort key/,
  ],
  [
    "its list partition key",
    {
      list: {
        index: "gsi2",
        name: "l",
        pk: { field: "gsi2pk", composite: ["n"] },
        sk: { field: "gsi2sk", composite: [] },
      },
    },
    /its list partition key/,
  ],
  [
    "its list sort key",
    {
      list: {
        index: "gsi2",
        name: "l",
        pk: { field: "gsi2pk", composite: ["cust"] },
        sk: { field: "gsi2sk", composite: ["n"] },
      },
    },
    /its list sort key/,
  ],
  [
    "a many edge's sort key",
    { edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["sku", "n"] } }) } },
    /edge "lines"'s sort key/,
  ],
  ["a sub-aggregate's many edge's sort key", { sub: true }, /edge "lines"'s sort key/],
]

describe("EDD-9128 on an aggregate, a key composed from a field storing both numeric kinds", () => {
  for (const [place, config, where] of AGGREGATE_PLACES) {
    describe(place, () => {
      for (const [name, n] of BOTH.filter(([label]) => !label.startsWith("optional"))) {
        it(`is refused: ${name}`, () => {
          expect(aggregate(n, config)).toThrow(/\[EDD-9128\] Aggregate "Root": /)
          expect(aggregate(n, config)).toThrow(where)
        })
      }
      for (const [name, n] of ONE) {
        it(`isn't: ${name}`, () => {
          let thrown: unknown
          try {
            aggregate(n, config)()
          } catch (error) {
            thrown = error
          }
          expect(String(thrown ?? "")).not.toMatch(/EDD-9128/)
        })
      }
    })
  }

  it("a field no key reads may store both", () => {
    for (const [, n] of BOTH) expect(aggregate(n, {})).not.toThrow()
  })
})
