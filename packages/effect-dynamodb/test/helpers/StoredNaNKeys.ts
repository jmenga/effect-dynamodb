/**
 * A key over a number its field stores as a string, holding a value the numeric key text treats
 * specially. With `escapeKeys` off, published 1.39.0 composed 1.36's text for each, stored the row
 * and read, queried, updated and deleted it by that key on every path
 * (`fixtures/stored-nan-keys-1.39.0.json`): a `Schema.NumberFromString` holding `NaN` (under
 * `0000000000000NaN`), `Infinity`, `-Infinity`, `-0`, a negative fraction or `1e21`, and a
 * `Schema.BigIntFromString` holding `0n`, a negative, `10^38` or a value of more than 1,000 digits.
 * An aggregate keyed by a `NumberFromString` holding `NaN`, in its partition key or a `many` edge's
 * sort key, was created, read, updated and deleted the same way.
 * Every path here does what it did. A `Schema.Number`'s `NaN`, which no row can hold (1.39.0's `put`
 * died in the marshaller), is refused, and with `escapeKeys` on a `NaN` has no key text and every
 * path refuses it, as 1.39.0 did. Run on a recording table (`Kept139.test.ts`) and on DynamoDB
 * Local (`connected.kept-1.39.0.test.ts`).
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import * as Batch from "../../src/Batch.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import {
  fixtureOf,
  type OpenTable,
  onTable,
  runSteps,
  type ScenarioTable,
  type Step,
  type StepOf,
} from "./Kept139.js"

const fixture = fixtureOf<Record<string, ReadonlyArray<Step>>>("stored-nan-keys")

const kinds = {
  NumberFromString: Schema.NumberFromString,
  BigIntFromString: Schema.BigIntFromString,
  Number: Schema.Number,
} as const

type Kind = keyof typeof kinds

/** The values the fixture was captured for, in its order. */
const values: ReadonlyArray<readonly [Kind, string, number | bigint]> = [
  ["NumberFromString", "NaN", Number.NaN],
  ["NumberFromString", "Infinity", Number.POSITIVE_INFINITY],
  ["NumberFromString", "-Infinity", Number.NEGATIVE_INFINITY],
  ["NumberFromString", "-0", -0],
  ["NumberFromString", "-3.5", -3.5],
  ["NumberFromString", "1e21", 1e21],
  ["BigIntFromString", "0n", 0n],
  ["BigIntFromString", "-5n", -5n],
  ["BigIntFromString", "10^38", 10n ** 38n],
  ["BigIntFromString", "1001 nines", BigInt("9".repeat(1001))],
  ["Number", "NaN", Number.NaN],
]

const positions = {
  "sort key": { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["level"] } },
  "partition key": {
    pk: { field: "pk", composite: ["level"] },
    sk: { field: "sk", composite: ["id"] },
  },
} as const

const world = (position: keyof typeof positions, escapeKeys: boolean, kind: Kind) => {
  const Rows = Entity.make({
    model: Schema.Struct({ id: Schema.String, level: kinds[kind], note: Schema.String }),
    entityType: "Row",
    primaryKey: positions[position],
    indexes: {
      byNote: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["note"] },
        sk: { field: "gsi1sk", composite: ["level"] },
      },
    },
  } as never) as any
  const MainTable = Table.make({
    schema: DynamoSchema.make({ name: "kept", version: 1, escapeKeys }),
    entities: { Rows },
  })
  return { Rows, MainTable }
}

/** Every key-taking path, in the order the fixture was captured in. */
const stepsOf = (db: any, value: unknown): ReadonlyArray<StepOf> => {
  const rows = db.entities.Rows
  const key = { id: "a", level: value }
  const done = () => "done"
  return [
    ["put", () => rows.put({ ...key, note: "n" }).asEffect()],
    ["get", () => rows.get(key)],
    ["query by the whole key", () => rows.primary(key).collect()],
    ["query an index", () => rows.byNote({ note: "n", level: value }).collect()],
    [
      "where",
      () =>
        rows
          .byNote({ note: "n" })
          .where((t: any, { eq }: any) => eq(t.level, value))
          .collect(),
    ],
    [
      "within eq",
      () =>
        rows
          .byNote({ note: "n" })
          .within({ level: { eq: value } })
          .collect(),
    ],
    [
      "where gte",
      () =>
        rows
          .byNote({ note: "n" })
          .where((t: any, { gte }: any) => gte(t.level, value))
          .collect(),
    ],
    ["update", () => rows.update(key).set({ note: "m" }).asEffect()],
    ["Batch.get", () => Batch.get([rows.get(key)])],
    ["transactGet", () => Transaction.transactGet([rows.get(key)])],
    [
      "rekey",
      () => db.tables.MainTable.rekey(),
      (report: any) => ({
        conflicts: report.conflicts.length,
        moved: Object.values(report.moved as Record<string, number>).reduce((a, b) => a + b, 0),
        indexKeysRewritten: report.indexKeysRewritten,
      }),
    ],
    ["delete", () => rows.delete(key).asEffect(), done],
    ["transactWrite put", () => Transaction.transactWrite([rows.put({ ...key, note: "t" })]), done],
    ["transactWrite delete", () => Transaction.transactWrite([rows.delete(key)]), done],
    ["Batch.write put", () => Batch.write([rows.put({ ...key, note: "b" })]), done],
    ["Batch.write delete", () => Batch.write([rows.delete(key)]), done],
  ]
}

const replay = (
  open: OpenTable,
  position: keyof typeof positions,
  escapeKeys: boolean,
  kind: Kind,
  value: unknown,
) => {
  const { Rows, MainTable } = world(position, escapeKeys, kind)
  return onTable(
    open,
    fixture.clock,
    MainTable,
    { entities: { Rows } },
    (db, table: ScenarioTable) => runSteps(table, stepsOf(db, value)),
  )
}

const REFUSED = { fail: "ValidationError", code: "EDD-9096" }

const aggregateKeys = ["root key", "edge key"] as const

/** An aggregate whose partition key and `many` edge sort key are numbers stored as strings. */
const replayAggregate = (open: OpenTable, where: (typeof aggregateKeys)[number]) => {
  // The table's key definition comes from an entity.
  const Other = Entity.make({
    model: Schema.Struct({ id: Schema.String }),
    entityType: "Other",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const Base = Table.make({
    schema: DynamoSchema.make({ name: "kept", version: 1, escapeKeys: false }),
    entities: { Other },
  })
  const Agg = Aggregate.make(
    Schema.Struct({
      id: Schema.NumberFromString,
      name: Schema.String,
      lines: Schema.Array(Schema.Struct({ n: Schema.NumberFromString })),
    }),
    {
      table: Base,
      schema: Base.schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "agg" },
      root: { entityType: "Agg" },
      edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["n"] } }) },
    } as never,
  ) as any
  const MainTable = { ...Base, aggregates: { Agg } } as any
  const id = where === "root key" ? Number.NaN : 1
  const n = where === "edge key" ? Number.NaN : 2
  return onTable(
    open,
    fixture.clock,
    MainTable,
    { entities: {}, aggregates: { Agg } },
    (db, table: ScenarioTable) =>
      runSteps(table, [
        ["create", () => db.aggregates.Agg.create({ id, name: "n", lines: [{ n }] })],
        ["get", () => db.aggregates.Agg.get({ id })],
        [
          "update",
          () => db.aggregates.Agg.update({ id }, ({ state }: any) => ({ ...state, name: "m" })),
        ],
        ["delete", () => db.aggregates.Agg.delete({ id }), () => "done"],
      ]),
  )
}

/** The scenarios, each a test against a table `open` makes. */
export const storedNaNKeySuite = (open: OpenTable) => {
  it("the fixture holds every value here, in both positions, and the aggregate's keys", () => {
    expect(Object.keys(fixture.scenarios)).toEqual([
      ...Object.keys(positions).flatMap((position) =>
        values.map(([kind, name]) => `${kind} ${name} in the ${position}`),
      ),
      ...aggregateKeys.map((where) => `aggregate, NumberFromString NaN in the ${where}`),
    ])
  })

  for (const where of aggregateKeys) {
    const scenario = `aggregate, NumberFromString NaN in the ${where}`
    it.effect(
      `escapeKeys off, ${scenario}: every step does what ${fixture.generatedFrom} did`,
      () =>
        Effect.gen(function* () {
          const expected = fixture.scenarios[scenario]!
          expect(expected.every((step) => "ok" in step.outcome)).toBe(true)
          const steps = yield* replayAggregate(open, where)
          for (const [i, step] of steps.entries()) expect(step, step.step).toEqual(expected[i])
          expect(steps).toEqual(expected)
        }),
    )
  }

  for (const position of Object.keys(positions) as ReadonlyArray<keyof typeof positions>) {
    for (const [kind, name, value] of values) {
      const scenario = `${kind} ${name} in the ${position}`
      const expected = fixture.scenarios[scenario]!
      if (kind === "Number") {
        it.effect(`escapeKeys off, ${scenario}: no row can hold it, refused on every path`, () =>
          Effect.gen(function* () {
            // 1.39.0 composed a key for it, and every write died in the marshaller.
            const died = expected.filter((step) => "die" in step.outcome).map((step) => step.step)
            expect(died).toEqual(["put", "transactWrite put", "Batch.write put"])
            expect(expected.every((step) => step.rows.length === 0)).toBe(true)
            const steps = yield* replay(open, position, false, kind, value)
            for (const step of steps) {
              expect(step.rows, step.step).toEqual([])
              if (step.step === "rekey") continue
              expect(step.outcome, step.step).toEqual(REFUSED)
            }
          }),
        )
        continue
      }
      it.effect(
        `escapeKeys off, ${scenario}: every path does what ${fixture.generatedFrom} did`,
        () =>
          Effect.gen(function* () {
            // 1.39.0 wrote the row, found it by its key on every path, and took it away again.
            expect(expected.every((step) => "ok" in step.outcome)).toBe(true)
            expect(expected.find((step) => step.step === "put")!.rows).toHaveLength(1)
            const steps = yield* replay(open, position, false, kind, value)
            for (const [i, step] of steps.entries()) expect(step, step.step).toEqual(expected[i])
            expect(steps).toEqual(expected)
          }),
      )
    }

    it.effect(`escapeKeys on, NaN in the ${position}: no key text, refused on every path`, () =>
      Effect.gen(function* () {
        const steps = yield* replay(open, position, true, "NumberFromString", Number.NaN)
        for (const step of steps) {
          expect(step.rows, step.step).toEqual([])
          if (step.step === "rekey") continue
          expect(step.outcome, step.step).toEqual(REFUSED)
        }
      }),
    )
  }

  it("the NaN row's key holds the text 1.36 gave it", () => {
    const [row] = fixture.scenarios["NumberFromString NaN in the sort key"]![0]!.rows
    expect(row!.sk).toEqual({ S: "$kept#v1#row#level_0000000000000nan" })
    expect(row!.gsi1sk).toEqual({ S: "$kept#v1#row#level_0000000000000nan" })
    expect(row!.level).toEqual({ S: "NaN" })
  })
}
