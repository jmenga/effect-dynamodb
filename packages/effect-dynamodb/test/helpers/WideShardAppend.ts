/**
 * A time-series `appendInput` that may leave out many of a sharded index's composites. Published
 * 1.39.0 loaded each definition here in milliseconds (`fixtures/wide-shard-append-1.39.0.json`),
 * and so does this release, whether some append can compose the index's key or none can: each
 * step does what 1.39.0 did, an append that can't compose the key failing with `EDD-9100` when it's
 * made. Run on a recording table (`Kept139.test.ts`) and on DynamoDB Local
 * (`connected.kept-1.39.0.test.ts`).
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
    "wide-shard-append",
  )

const optional = Object.fromEntries(
  Array.from({ length: 40 }, (_, i) => [`p${i}`, Schema.optionalKey(Schema.String)]),
)
const all = Object.keys(optional)

const definitions: Record<
  string,
  {
    readonly sk: ReadonlyArray<string>
    readonly appendInput: Record<string, Schema.Top>
    readonly appends: ReadonlyArray<Record<string, unknown>>
  }
> = {
  "an optional `by` after 40 optional sort key composites": {
    sk: [...all, "by"],
    appendInput: { ...optional, by: Schema.optionalKey(Schema.String) },
    appends: [
      { id: "s1", seq: 2 },
      { id: "s1", seq: 3, by: "b" },
    ],
  },
  "a required `by` after a gap, then 40 optional sort key composites": {
    sk: ["gap", "by", ...all],
    appendInput: { tenant: Schema.String, by: Schema.String, ...optional },
    appends: [
      { id: "s1", seq: 2, tenant: "t", by: "b" },
      {
        id: "s1",
        seq: 3,
        tenant: "t",
        by: "b",
        ...Object.fromEntries(all.map((name) => [name, "v"])),
      },
    ],
  },
}

const sensorOf = (name: string) => {
  const { sk, appendInput } = definitions[name]!
  return Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      seq: Schema.Number,
      tenant: Schema.optionalKey(Schema.String),
      gap: Schema.optionalKey(Schema.String),
      by: Schema.optionalKey(Schema.String),
      ...optional,
    }),
    entityType: "Sensor",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    indexes: {
      byTenant: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["tenant"] },
        sk: { field: "gsi1sk", composite: sk },
        shards: { count: 4, by: ["by"] },
      },
    },
    timeSeries: {
      orderBy: "seq",
      appendInput: Schema.Struct({ id: Schema.String, seq: Schema.Number, ...appendInput }),
    },
  } as never) as any
}

/** Loads `name`'s definition, timed. */
const load = (name: string) => {
  const start = performance.now()
  try {
    return { Sensor: sensorOf(name), elapsed: performance.now() - start }
  } catch (error) {
    return { error: String((error as Error).message), elapsed: performance.now() - start }
  }
}

/** The scenarios, each a test against a table `open` makes. */
export const wideShardAppendSuite = (open: OpenTable) => {
  it("1.39.0 loaded every definition here", () => {
    expect(Object.keys(fixture.scenarios)).toEqual(Object.keys(definitions))
    for (const scenario of Object.values(fixture.scenarios)) expect(scenario.loads).toBe(true)
  })

  for (const name of Object.keys(definitions)) {
    const expected = fixture.scenarios[name]!.steps
    const appendSteps = expected.slice(1, -1)
    it.effect(`${name}: loads at once, and every step does what ${fixture.generatedFrom} did`, () =>
      Effect.gen(function* () {
        const loaded = load(name)
        expect(loaded.error).toBeUndefined()
        expect(loaded.elapsed).toBeLessThan(250)
        const Sensor = loaded.Sensor
        const MainTable = Table.make({
          schema: DynamoSchema.make({ name: "kept", version: 1 }),
          entities: { Sensor },
        })
        const steps = yield* onTable(
          open,
          fixture.clock,
          MainTable,
          { entities: { Sensor } },
          (db, table) =>
            runSteps(table, [
              ["put", () => db.entities.Sensor.put({ id: "s1", seq: 1, tenant: "t" }).asEffect()],
              ...definitions[name]!.appends.map(
                (input, i) =>
                  [
                    appendSteps[i]!.step,
                    () => db.entities.Sensor.append(input).asEffect(),
                  ] as const,
              ),
              ["get", () => db.entities.Sensor.get({ id: "s1" })],
            ]),
        )
        expect(steps).toEqual(expected)
      }),
    )
  }
}
