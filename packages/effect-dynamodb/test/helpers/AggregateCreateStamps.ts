/**
 * An aggregate whose rows declare the field a timestamp is stored under (`updated`, `created`,
 * `createdAt`, `updatedAt`). Published 1.39.0's `create` failed with `Missing key` unless the caller
 * passed a value for each, then stored the stamp in its place
 * (`fixtures/aggregate-create-stamps-1.39.0.json`), and an `update` re-stamped `updated`. `create`
 * still stores the stamp whether or not a value is passed, so a placeholder a 1.39.0 caller passed is
 * never stored; a missing value is accepted, and stores what 1.39.0 stored when one was passed.
 * What `create` returns is what it stored (1.39.0 returned the value passed, which it never stored).
 * Run on a recording table (`Kept139.test.ts`) and on DynamoDB Local
 * (`connected.kept-1.39.0.test.ts`).
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Duration, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import {
  fixtureOf,
  type OpenTable,
  onTable,
  type Row,
  runSteps,
  type ScenarioTable,
  type Step,
} from "./Kept139.js"

type Supplied = "a value supplied" | "no value supplied"

const fixture =
  fixtureOf<Record<string, Record<Supplied, ReadonlyArray<Step>>>>("aggregate-create-stamps")

const epoch = new Date(0)

const definitions: Record<
  string,
  {
    readonly model: Schema.Top
    readonly timestamps: unknown
    readonly edges: Record<string, unknown>
    readonly inputs: Record<Supplied, Record<string, unknown>>
    /** The root field the update stamp is stored under. */
    readonly updated: string
    /** Dates the root declares optional: 1.39.0 stored a value passed for one. */
    readonly keeps: ReadonlyArray<string>
    /** 1.39.0's `create` failed with `Missing key` without a value. */
    readonly missingKey: boolean
  }
> = {
  "the root declares an optional `updated`": {
    model: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      updated: Schema.optional(DynamoModel.DateEpochMs),
    }),
    timestamps: { updated: { field: "updated" } },
    edges: {},
    inputs: {
      "a value supplied": { id: "m", name: "n", updated: epoch },
      "no value supplied": { id: "m", name: "n" },
    },
    updated: "updated",
    keeps: ["updated"],
    missingKey: false,
  },
  "the root declares optional `createdAt` and `updatedAt`": {
    model: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      createdAt: Schema.optional(Schema.Date),
      updatedAt: Schema.optional(Schema.Date),
    }),
    timestamps: true,
    edges: {},
    inputs: {
      "a value supplied": { id: "m", name: "n", createdAt: epoch, updatedAt: epoch },
      "no value supplied": { id: "m", name: "n" },
    },
    updated: "updatedAt",
    keeps: ["createdAt", "updatedAt"],
    missingKey: false,
  },
  "a many element declares an optional `updated`": {
    model: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      players: Schema.Array(
        Schema.Struct({ playerId: Schema.String, updated: Schema.optional(Schema.Date) }),
      ),
    }),
    timestamps: { updated: { field: "updated" } },
    edges: { players: Aggregate.many({ entityType: "Player", sk: { composite: ["playerId"] } }) },
    inputs: {
      "a value supplied": { id: "m", name: "n", players: [{ playerId: "p", updated: epoch }] },
      "no value supplied": { id: "m", name: "n", players: [{ playerId: "p" }] },
    },
    updated: "updated",
    keeps: [],
    missingKey: false,
  },
  "a one edge declares an optional `updated`": {
    model: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      venue: Schema.Struct({ venueId: Schema.String, updated: Schema.optional(Schema.Date) }),
    }),
    timestamps: { updated: { field: "updated" } },
    edges: { venue: Aggregate.one({ entityType: "Venue" }) },
    inputs: {
      "a value supplied": { id: "m", name: "n", venue: { venueId: "v", updated: epoch } },
      "no value supplied": { id: "m", name: "n", venue: { venueId: "v" } },
    },
    updated: "updated",
    keeps: [],
    missingKey: false,
  },
  "the root declares a required and an optional date": {
    model: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      createdAt: Schema.Date,
      updatedAt: Schema.optional(Schema.Date),
    }),
    timestamps: true,
    edges: {},
    inputs: {
      "a value supplied": { id: "m", name: "n", createdAt: epoch, updatedAt: epoch },
      "no value supplied": { id: "m", name: "n", createdAt: epoch },
    },
    updated: "updatedAt",
    keeps: ["updatedAt"],
    missingKey: false,
  },
  "the root declares `updated`": {
    model: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      updated: DynamoModel.DateEpochMs,
    }),
    timestamps: { updated: { field: "updated" } },
    edges: {},
    inputs: {
      "a value supplied": { id: "m", name: "n", updated: epoch },
      "no value supplied": { id: "m", name: "n" },
    },
    updated: "updated",
    keeps: [],
    missingKey: true,
  },
  "the root declares `created` and `updated`": {
    model: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      created: DynamoModel.DateEpochMs,
      updated: DynamoModel.DateEpochMs,
    }),
    timestamps: { created: { field: "created" }, updated: { field: "updated" } },
    edges: {},
    inputs: {
      "a value supplied": { id: "m", name: "n", created: epoch, updated: epoch },
      "no value supplied": { id: "m", name: "n" },
    },
    updated: "updated",
    keeps: [],
    missingKey: true,
  },
  "the root declares `createdAt` and `updatedAt`": {
    model: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      createdAt: Schema.Date,
      updatedAt: Schema.Date,
    }),
    timestamps: true,
    edges: {},
    inputs: {
      "a value supplied": { id: "m", name: "n", createdAt: epoch, updatedAt: epoch },
      "no value supplied": { id: "m", name: "n" },
    },
    updated: "updatedAt",
    keeps: [],
    missingKey: true,
  },
  "a one edge and a many element declare `updated`": {
    model: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      venue: Schema.Struct({ venueId: Schema.String, updated: Schema.Date }),
      players: Schema.Array(Schema.Struct({ playerId: Schema.String, updated: Schema.Date })),
    }),
    timestamps: { updated: { field: "updated" } },
    edges: {
      venue: Aggregate.one({ entityType: "Venue" }),
      players: Aggregate.many({ entityType: "Player", sk: { composite: ["playerId"] } }),
    },
    inputs: {
      "a value supplied": {
        id: "m",
        name: "n",
        venue: { venueId: "v", updated: epoch },
        players: [{ playerId: "p", updated: epoch }],
      },
      "no value supplied": {
        id: "m",
        name: "n",
        venue: { venueId: "v" },
        players: [{ playerId: "p" }],
      },
    },
    updated: "updated",
    keeps: [],
    missingKey: true,
  },
}

const replay = (open: OpenTable, name: string, supplied: Supplied) => {
  const definition = definitions[name]!
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
    definition.model as never,
    {
      table: Base,
      schema: Base.schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "match" },
      root: { entityType: "Match" },
      edges: definition.edges,
      timestamps: definition.timestamps,
    } as never,
  ) as any
  const MainTable = { ...Base, aggregates: { Agg } } as any
  return onTable(
    open,
    fixture.clock,
    MainTable,
    { entities: {}, aggregates: { Agg } },
    (db, table: ScenarioTable) =>
      runSteps(table, [
        ["create", () => db.aggregates.Agg.create(definition.inputs[supplied])],
        [
          "update, 5 s later",
          () =>
            Effect.andThen(
              TestClock.adjust(Duration.seconds(5)),
              db.aggregates.Agg.update({ id: "m" }, ({ state }: any) => ({ ...state, name: "o" })),
            ),
        ],
      ]),
  )
}

/** `value` with each date the epoch (the one a caller passed) as the stamp at `at`, but `keeps`. */
const stampedOver = (value: unknown, at: number, keeps: ReadonlyArray<string> = []): unknown =>
  JSON.parse(
    JSON.stringify(value, function (this: unknown, key, held) {
      if (this === (value as { readonly ok?: unknown }).ok && keeps.includes(key)) return held
      return held !== null && typeof held === "object" && held.date === 0 ? { date: at } : held
    }),
  )

/** An instant in the form `held` stores one in. */
const storedAs = (held: Row[string], at: number): Row[string] =>
  "N" in held ? { N: String(at) } : { S: new Date(at).toISOString() }

/** `rows` with `names`, where a row `which` picks holds one, as the instant `at`. */
const stampedRows = (
  rows: ReadonlyArray<Row>,
  names: ReadonlyArray<string>,
  at: number,
  which: (row: Row) => boolean,
): ReadonlyArray<Row> =>
  rows.map((row) =>
    which(row)
      ? {
          ...row,
          ...Object.fromEntries(
            names.filter((name) => row[name] !== undefined).map((n) => [n, storedAs(row[n]!, at)]),
          ),
        }
      : row,
  )

const isRoot = (row: Row) => row.__edd_e__?.S === "Match"

/** The scenarios, each a test against a table `open` makes. */
export const aggregateCreateStampsSuite = (open: OpenTable) => {
  it("1.39.0 stored the stamp over a value passed, but under a date the root declares optional", () => {
    expect(Object.keys(fixture.scenarios)).toEqual(Object.keys(definitions))
    for (const [name, scenario] of Object.entries(fixture.scenarios)) {
      const { keeps, missingKey } = definitions[name]!
      const [created] = scenario["a value supplied"]
      // The value passed came back, and was stored only under a date the root declares optional.
      expect(JSON.stringify(created!.outcome)).toContain('{"date":0}')
      const root = created!.rows.find(isRoot)!
      for (const field of keeps) expect(storedAs(root[field]!, 0), field).toEqual(root[field])
      const rest = JSON.stringify(
        created!.rows.map((row) =>
          row === root
            ? Object.fromEntries(Object.entries(row).filter(([n]) => !keeps.includes(n)))
            : row,
        ),
      )
      expect(rest).not.toContain("1970-01-01")
      expect(rest).not.toContain('{"N":"0"}')
      // Without a value, a date a row requires was refused.
      const [bare] = scenario["no value supplied"]
      if (missingKey)
        expect(bare!.outcome).toEqual({ fail: "ValidationError", message: "Missing key" })
      else expect("ok" in bare!.outcome).toBe(true)
    }
  })

  for (const name of Object.keys(definitions)) {
    const definition = definitions[name]!
    const { keeps } = definition
    const [created, updated] = fixture.scenarios[name]!["a value supplied"] as readonly [Step, Step]
    const stamp = fixture.clock
    for (const supplied of ["a value supplied", "no value supplied"] as const) {
      it.effect(`${name}, ${supplied}: create stores what ${fixture.generatedFrom} stored`, () =>
        Effect.gen(function* () {
          const steps: ReadonlyArray<Step> = yield* replay(open, name, supplied)
          const [create, update] = [steps[0]!, steps[1]!]
          if (supplied === "a value supplied") {
            // What 1.39.0 stored: the stamp, but the value passed for a date the root declares
            // optional. What's returned is what's stored.
            expect(create.rows).toEqual(created.rows)
            expect(create.outcome).toEqual(stampedOver(created.outcome, stamp, keeps))
          } else {
            // Without a value, what 1.39.0 stored when one was passed; the stamp under a date the
            // root declares optional, where 1.39.0 stored nothing.
            expect(create.rows).toEqual(stampedRows(created.rows, keeps, stamp, isRoot))
            expect(create.outcome).toEqual(stampedOver(created.outcome, stamp))
          }
          // An update re-stamps `updated` on each row holding it and keeps `created`. 1.39.0 did on
          // each row it re-stamped (it left a date the root declares optional as it was), and
          // couldn't read an edge declaring a stamped date back (`Missing key`).
          const later = stamp + 5_000
          const rewritten = stampedRows(create.rows, [definition.updated], later, () => true)
          // The update's stamp takes the form `create` stored the field in (`AggregateStampForms.ts`).
          expect(update.rows).toEqual(
            rewritten.map((row) => (isRoot(row) ? { ...row, name: { S: "o" } } : row)),
          )
          if ("ok" in updated.outcome && keeps.length === 0) {
            expect(update.rows).toEqual(updated.rows)
          }
          expect(update.outcome).toEqual(
            JSON.parse(
              JSON.stringify(create.outcome, (key, held) =>
                key === definition.updated ? { date: later } : key === "name" ? "o" : held,
              ),
            ),
          )
        }),
      )
    }
  }
}
