/**
 * A time-series `appendInput` carrying a sharded index's `by` attribute, which may leave a
 * composite the key needs out. Published 1.39.0 loaded every definition here, whatever the input
 * carries, and so does this release: each step does what 1.39.0 did
 * (`fixtures/optional-shard-append-1.39.0.json`). An append that composes the index's key is
 * written, and one that can't fails with `EDD-9100` when it's made, nothing written. An optional
 * key left out and one given as `undefined` compose differently: on a sparse partition key, only
 * the second leaves the index alone. Run on a recording table (`Kept139.test.ts`) and on DynamoDB
 * Local (`connected.kept-1.39.0.test.ts`).
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
    readonly indexPolicy?: {
      readonly pk: "sparse" | "preserve"
      readonly sk: "sparse" | "preserve"
    }
    readonly appendInput: Record<string, Schema.Top>
    /** Put before the appends. */
    readonly seed?: Record<string, unknown>
    readonly appends: ReadonlyArray<Record<string, unknown>>
    /** Read back after them. */
    readonly read?: true
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
  "`by` optional, the index's partition composite always carried, and sparse": {
    sk: ["region", "group"],
    indexPolicy: { pk: "sparse", sk: "preserve" },
    appendInput: { tenant: Schema.String, group: Schema.optional(Schema.String) },
    appends: [
      { id: "1", tenant: "t", at: 1 },
      { id: "1", tenant: "t", at: 2, group: undefined },
      { id: "1", tenant: "t", at: 3, group: "b" },
    ],
    read: true,
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
        ...(definition.indexPolicy === undefined ? {} : { indexPolicy: definition.indexPolicy }),
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

/** The scenarios, each a test against a table `open` makes. */
export const optionalShardAppendSuite = (open: OpenTable) => {
  it("1.39.0 loaded every definition here", () => {
    expect(Object.keys(fixture.scenarios)).toEqual(Object.keys(definitions))
    for (const scenario of Object.values(fixture.scenarios)) expect(scenario.loads).toBe(true)
  })

  for (const name of Object.keys(definitions)) {
    const expected = fixture.scenarios[name]!.steps
    it.effect(`${name}: loads, and every step does what ${fixture.generatedFrom} did`, () =>
      Effect.gen(function* () {
        const Series = seriesOf(name)
        const MainTable = Table.make({
          schema: DynamoSchema.make({ name: "kept", version: 1 }),
          entities: { Series },
        })
        const { seed, appends, read } = definitions[name]!
        const first = seed === undefined ? 0 : 1
        const steps = yield* onTable(
          open,
          fixture.clock,
          MainTable,
          { entities: { Series } },
          (db, table) =>
            runSteps(table, [
              ...(seed === undefined
                ? []
                : [["put", () => db.entities.Series.put(seed).asEffect()] as const]),
              ...appends.map(
                (input, i) =>
                  [
                    expected[first + i]!.step,
                    () => db.entities.Series.append(input).asEffect(),
                  ] as const,
              ),
              ...(read ? [["get", () => db.entities.Series.get({ id: "1" })] as const] : []),
            ]),
        )
        // The appends that compose are written; one that can't fails with EDD-9100, when made.
        expect(steps.map((step) => step.outcome)).toContainEqual({
          fail: "ValidationError",
          code: "EDD-9100",
        })
        expect(steps).toEqual(expected)
      }),
    )
  }
}
