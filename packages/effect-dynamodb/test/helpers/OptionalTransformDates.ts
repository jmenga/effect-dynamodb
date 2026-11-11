/**
 * An entity with `timestamps` declaring `createdAt` (and `updatedAt`) as `Schema.optional` over a date
 * transform schema carrying a `storedAs` encoding of the other wire kind:
 * `DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds))` or
 * `DynamoModel.DateEpochMs.pipe(DynamoModel.storedAs(DynamoModel.DateString))`. Without
 * `Schema.optional`, `Entity.make` refuses such a field as a stamp: the transform stores its own
 * wire form, so no stamp in the annotation's form can be read back. Published 1.39.0 left the field
 * the caller's: every write path stored a value passed for it in the transform's form, and stored
 * nothing without one (`fixtures/entity-optional-transform-1.39.0.json`). It still does. Run on a
 * recording table (`Kept139.test.ts`) and on DynamoDB Local (`connected.kept-1.39.0.test.ts`).
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Duration, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import * as Batch from "../../src/Batch.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { fixtureOf, type OpenTable, onTable, runSteps, type Step, type StepOf } from "./Kept139.js"

const fixture = fixtureOf<Record<string, ReadonlyArray<Step>>>("entity-optional-transform")

const dates = {
  "DateString storedAs DateEpochSeconds": DynamoModel.DateString.pipe(
    DynamoModel.storedAs(DynamoModel.DateEpochSeconds),
  ),
  "DateEpochMs storedAs DateString": DynamoModel.DateEpochMs.pipe(
    DynamoModel.storedAs(DynamoModel.DateString),
  ),
} as const

const declares = {
  "createdAt and updatedAt": ["createdAt", "updatedAt"],
  createdAt: ["createdAt"],
} as const

const ops = [
  "put",
  "create",
  "update",
  "upsert",
  "transactWrite put",
  "Batch.write put",
  "append",
] as const

type Op = (typeof ops)[number]

const value = DateTime.makeUnsafe(0)
const done = () => "done"

const rowsOf = (date: Schema.Top, names: ReadonlyArray<string>, timeSeries: boolean) => {
  const fields = Object.fromEntries(names.map((name) => [name, Schema.optional(date as never)]))
  return Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      ...(timeSeries ? { at: Schema.Number } : {}),
      ...fields,
    }),
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    timestamps: true,
    ...(timeSeries
      ? {
          timeSeries: {
            orderBy: "at",
            appendInput: Schema.Struct({
              id: Schema.String,
              at: Schema.Number,
              name: Schema.String,
              ...fields,
            }),
          },
        }
      : {}),
  } as never) as any
}

const stepsOf = (db: any, names: ReadonlyArray<string>, supplied: boolean, op: Op) => {
  const v = supplied ? Object.fromEntries(names.map((name) => [name, value])) : {}
  const rows = db.entities.Rows
  const later = (effect: Effect.Effect<unknown, unknown>) =>
    Effect.andThen(TestClock.adjust(Duration.seconds(5)), effect)
  const get: StepOf = ["get", () => rows.get({ id: "a" })]
  const steps: Record<Op, ReadonlyArray<StepOf>> = {
    put: [["put", () => rows.put({ id: "a", name: "n", ...v }).asEffect()], get],
    create: [["create", () => rows.create({ id: "a", name: "n", ...v }).asEffect()], get],
    update: [
      ["put", () => rows.put({ id: "a", name: "n" }).asEffect()],
      [
        "update, 5 s later",
        () =>
          later(
            rows
              .update({ id: "a" })
              .set({ name: "o", ...v })
              .asEffect(),
          ),
      ],
      get,
    ],
    upsert: [
      ["upsert", () => rows.upsert({ id: "a", name: "n", ...v }).asEffect()],
      ["upsert, 5 s later", () => later(rows.upsert({ id: "a", name: "o", ...v }).asEffect())],
      get,
    ],
    "transactWrite put": [
      [
        "transactWrite put",
        () => Transaction.transactWrite([rows.put({ id: "a", name: "n", ...v })]),
        done,
      ],
      get,
    ],
    "Batch.write put": [
      ["Batch.write put", () => Batch.write([rows.put({ id: "a", name: "n", ...v })]), done],
      get,
    ],
    append: [
      ["append", () => rows.append({ id: "a", at: 1, name: "n", ...v }).asEffect()],
      [
        "append, 5 s later",
        () => later(rows.append({ id: "a", at: 2, name: "o", ...v }).asEffect()),
      ],
      get,
    ],
  }
  return steps[op]
}

const scenarios = Object.entries(dates).flatMap(([dateName, date]) =>
  Object.entries(declares).flatMap(([declared, names]) =>
    ops.flatMap((op) =>
      ([true, false] as const).map((supplied) => ({
        name: `${dateName} | ${declared} | ${op} | ${supplied ? "a value supplied" : "no value supplied"}`,
        date,
        names,
        op,
        supplied,
      })),
    ),
  ),
)

/** The scenarios, each a test against a table `open` makes. */
export const optionalTransformDatesSuite = (open: OpenTable) => {
  it("1.39.0 left such a date the caller's on every write path", () => {
    expect(Object.keys(fixture.scenarios)).toEqual(scenarios.map((s) => s.name))
    for (const steps of Object.values(fixture.scenarios)) {
      for (const step of steps) expect("ok" in step.outcome, step.step).toBe(true)
    }
  })

  for (const { name, date, names, op, supplied } of scenarios) {
    it.effect(`${name}: every step does what ${fixture.generatedFrom} did`, () =>
      Effect.gen(function* () {
        const Rows = rowsOf(date, names, op === "append")
        const MainTable = Table.make({
          schema: DynamoSchema.make({ name: "kept", version: 1, escapeKeys: false }),
          entities: { Rows },
        })
        const steps = yield* onTable(
          open,
          fixture.clock,
          MainTable,
          { entities: { Rows } },
          (db, table) => runSteps(table, stepsOf(db, names, supplied, op)),
        )
        expect(steps).toEqual(fixture.scenarios[name])
      }),
    )
  }
}
