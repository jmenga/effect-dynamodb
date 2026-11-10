/**
 * A time-series `appendInput` that may leave a sharded index's composite out (`EDD-9113`). The
 * definition is refused at load only when no append the input allows can compose the index's key.
 * One that some append can is loaded, as published 1.39.0 loaded it, and every step does what
 * 1.39.0 did (`fixtures/optional-shard-append-1.39.0.json`): the append that composes is written,
 * and the one that can't fails with `EDD-9100` when it's made. Run on a recording table
 * (`Kept139.test.ts`) and on DynamoDB Local (`connected.kept-1.39.0.test.ts`).
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import { fixtureOf, type OpenTable, onTable, runSteps, type Step } from "./Kept139.js"

const fixture =
  fixtureOf<Record<string, { readonly loads: boolean; readonly steps: ReadonlyArray<Step> }>>(
    "optional-shard-append",
  )

const definitions: Record<
  string,
  {
    readonly sk: ReadonlyArray<string>
    readonly appendInput: Record<string, Schema.Top>
    readonly seed: Record<string, unknown>
    readonly appends: ReadonlyArray<Record<string, unknown>>
  }
> = {
  "`by` optional, the index's partition composite never carried": {
    sk: ["region", "group"],
    appendInput: { group: Schema.optional(Schema.String) },
    seed: { id: "1", tenant: "t", at: 1, region: "r", group: "a" },
    appends: [
      { id: "1", at: 2 },
      { id: "1", at: 3, group: "b" },
    ],
  },
  "`by` required, an optional composite after a gap": {
    sk: ["group", "mid", "tail"],
    appendInput: {
      tenant: Schema.String,
      group: Schema.String,
      tail: Schema.optional(Schema.String),
    },
    seed: { id: "1", tenant: "t", at: 1, group: "a", mid: "m", tail: "x" },
    appends: [
      { id: "1", tenant: "t", at: 2, group: "b" },
      { id: "1", tenant: "t", at: 3, group: "c", tail: "y" },
    ],
  },
  "`by` optional, the index's partition composite always carried": {
    sk: ["region", "group"],
    appendInput: { tenant: Schema.String, group: Schema.optional(Schema.String) },
    seed: { id: "1", tenant: "t", at: 1, region: "r", group: "a" },
    appends: [
      { id: "1", tenant: "t", at: 2 },
      { id: "1", tenant: "t", at: 3, group: "b" },
    ],
  },
}

const seriesOf = (name: string) => {
  const definition = definitions[name]!
  return Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      tenant: Schema.String,
      at: Schema.Number,
      region: Schema.optional(Schema.String),
      group: Schema.optional(Schema.String),
      mid: Schema.optional(Schema.String),
      tail: Schema.optional(Schema.String),
    }),
    entityType: "Series",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    indexes: {
      byTenant: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["tenant"] },
        sk: { field: "gsi1sk", composite: definition.sk },
        shards: { count: 8, by: ["group"] },
      },
    },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({
        id: Schema.String,
        at: Schema.Number,
        ...definition.appendInput,
      }),
    },
  } as never) as any
}

/** Whether 1.39.0 wrote any append of the scenario. */
const someAppendWritten = (name: string) =>
  fixture.scenarios[name]!.steps.slice(1).some((step) => "ok" in step.outcome)

/** The scenarios, each a test against a table `open` makes. */
export const optionalShardAppendSuite = (open: OpenTable) => {
  it("1.39.0 loaded every definition here", () => {
    expect(Object.keys(fixture.scenarios)).toEqual(Object.keys(definitions))
    for (const scenario of Object.values(fixture.scenarios)) expect(scenario.loads).toBe(true)
  })

  for (const name of Object.keys(definitions)) {
    const expected = fixture.scenarios[name]!.steps
    if (!someAppendWritten(name)) {
      it(`${name}: no append was ever written, so it's refused at load`, () => {
        // Every append 1.39.0 was given failed, the one leaving `by` out included.
        expect(expected.slice(1).map((step) => step.outcome)).toEqual([
          { fail: "ValidationError", code: "EDD-9100" },
          { fail: "ValidationError", code: "EDD-9100" },
        ])
        expect(() => seriesOf(name)).toThrow("[EDD-9113]")
      })
      continue
    }
    it.effect(`${name}: loads, and every step does what ${fixture.generatedFrom} did`, () =>
      Effect.gen(function* () {
        const Series = seriesOf(name)
        const MainTable = Table.make({
          schema: DynamoSchema.make({ name: "kept", version: 1 }),
          entities: { Series },
        })
        const { seed, appends } = definitions[name]!
        const steps = yield* onTable(
          open,
          fixture.clock,
          MainTable,
          { entities: { Series } },
          (db, table) =>
            runSteps(table, [
              ["put", () => db.entities.Series.put(seed).asEffect()],
              ...appends.map(
                (input, i) =>
                  [
                    expected[i + 1]!.step,
                    () => db.entities.Series.append(input).asEffect(),
                  ] as const,
              ),
            ]),
        )
        // The append that composes is written; the one that can't fails with EDD-9100, when made.
        expect(steps.map((step) => step.outcome)).toEqual(expected.map((step) => step.outcome))
        expect(steps.at(-1)!.outcome).toEqual({ fail: "ValidationError", code: "EDD-9100" })
        expect(steps).toEqual(expected)
      }),
    )
  }
}
