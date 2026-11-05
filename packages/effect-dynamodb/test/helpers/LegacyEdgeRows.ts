/**
 * Rows an upgrade from 1.36 meets at the edges of the key fallback and `rekey` (#171):
 * a sort key an index policy left behind its values. The scenarios run on a
 * recording table (`LegacyEdgeRows.test.ts`) and on DynamoDB Local
 * (`connected.legacy-edge-rows.test.ts`) through a {@link Harness}, and assert on which
 * reads find a row and what `rekey` leaves stored, rather than on what was sent.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import { toAttributeMap } from "../../src/Marshaller.js"
import * as Table from "../../src/Table.js"

export const TENANT = "t"
/** A value whose sort key text changed in 1.37: the space is escaped. */
export const REGION = "new york"

class Row extends Schema.Class<Row>("Row")({
  id: Schema.String,
  name: Schema.String,
  tenant: Schema.String,
  region: Schema.optional(Schema.String),
  zone: Schema.optional(Schema.String),
  group: Schema.optional(Schema.String),
}) {}

const worldOf = (schema: DynamoSchema.DynamoSchema) => {
  const Rows = Entity.make({
    model: Row,
    entityType: "Row",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: ["name"] },
    },
    indexes: {
      byTenant: {
        name: "gsi",
        pk: { field: "gpk", composite: ["tenant"] },
        sk: { field: "gsk", composite: ["region", "zone", "group"] },
      },
    },
  })
  const MainTable = Table.make({ schema, entities: { Rows } })
  return { schema, Rows, MainTable }
}

/** The 1.37 default: rows still under their 1.36 keys are read and moved. */
export const On = worldOf(DynamoSchema.make({ name: "edge", version: 1 }))
/** After `rekey`: the fallback off. */
export const Off = worldOf(DynamoSchema.make({ name: "edge", version: 1, legacyKeys: false }))
export type World = typeof On

export const clientOf = (world: World) =>
  DynamoClient.make({
    entities: { Rows: world.Rows },
    tables: { MainTable: world.MainTable },
  })
export type Db = Effect.Success<ReturnType<typeof clientOf>>

export type StoredRow = Record<string, AttributeValue>

/** What a scenario needs of a table. */
export interface Harness {
  /** Store a row as it is. */
  readonly seed: (row: StoredRow) => Effect.Effect<void, unknown>
  /** Every stored row. */
  readonly rows: () => Effect.Effect<ReadonlyArray<StoredRow>, unknown>
  /** Run `body` with a client over `world`'s definitions of this table. */
  readonly inWorld: <A, E>(
    world: World,
    body: (db: Db) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
}

export interface Values {
  readonly id: string
  readonly name?: string | undefined
  readonly region?: string | undefined
  readonly zone?: string | undefined
  readonly group?: string | undefined
}

const recordOf = (values: Values) => ({ tenant: TENANT, ...values, name: values.name ?? "n" })
const primary = On.Rows.indexes.primary
const byTenant = On.Rows.indexes.byTenant

/**
 * A row as 1.36 wrote it, its key text not escaped and its sort key truncated where the
 * values stop. `tableKey: "current"`: stored under its current table key, as after a
 * write that moved it.
 */
export const row136 = (values: Values, tableKey?: "current"): StoredRow => {
  const record = recordOf(values)
  return toAttributeMap({
    ...record,
    ...(tableKey === "current"
      ? KeyComposer.composeIndexKeys(On.schema, "Row", 1, primary, record)
      : {
          pk: KeyText136.composePk(On.schema, "Row", primary, record),
          sk: KeyText136.composeSk(On.schema, "Row", 1, primary, record),
        }),
    gpk: KeyText136.composePk(On.schema, "Row", byTenant, record),
    gsk: KeyText136.composeSortKeyPrefix(On.schema, "Row", 1, byTenant, record),
    __edd_e__: "Row",
  }) as StoredRow
}

/** The sort key the current code composes for `values`, truncated where they stop. */
export const gskNow = (values: Values): string =>
  KeyComposer.composeSortKeyPrefix(On.schema, "Row", 1, byTenant, recordOf(values))

export const idsOf = (rows: ReadonlyArray<{ readonly id: string }>) =>
  rows.map((row) => row.id).sort()

/** `preserve` keeps a sort key an update can't compose: a write of `group` alone. */
const leaveSortKey = (db: Db, values: Values & { readonly group: string }) =>
  Effect.gen(function* () {
    const { group, ...rest } = values
    yield* db.entities.Rows.put({ ...recordOf(rest), group: "a" }).asEffect()
    yield* db.entities.Rows.update({ id: values.id, name: values.name ?? "n" })
      .set({ group })
      .asEffect()
  })

/**
 * A sort key an index policy left, in current text, under a pin whose text changed:
 * the fallback's current read keeps it, as a read with the fallback off does. It isn't
 * the text 1.36 composed for the row's values, so it isn't another value's 1.36 row.
 */
export const leftSortKeyReachableScenario = (h: Harness) =>
  Effect.gen(function* () {
    yield* h.inWorld(On, (db) =>
      leaveSortKey(db, { id: "1", region: REGION, zone: "z", group: "b" }),
    )
    const [stored] = yield* h.rows()
    expect(stored!.gsk?.S).toBe(gskNow({ id: "1", region: REGION, zone: "z", group: "a" }))
    for (const world of [On, Off]) {
      yield* h.inWorld(world, (db) =>
        Effect.gen(function* () {
          const query = db.entities.Rows.byTenant({ tenant: TENANT, region: REGION })
          expect(idsOf(yield* query.collect())).toEqual(["1"])
          expect(yield* query.count()).toBe(1)
        }),
      )
    }
  })

/**
 * The same row in a range both texts hold: `begins_with` on `50%` holds `50%25`, its
 * escaped text, under both texts in one partition. The current read returns it, and the
 * 1.36 read leaves it.
 */
export const leftSortKeyOnceScenario = (h: Harness) =>
  Effect.gen(function* () {
    yield* h.inWorld(On, (db) =>
      Effect.gen(function* () {
        yield* leaveSortKey(db, { id: "left", region: "50%", zone: "z", group: "b" })
        const found = yield* db.entities.Rows.byTenant({ tenant: TENANT })
          .where((t, { beginsWith }) => beginsWith(t.region, "50%"))
          .collect()
        expect(idsOf(found)).toEqual(["left"])
      }),
    )
  })

/** Every scenario, for both harnesses. */
export const scenarios: ReadonlyArray<{
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown, any>
}> = [
  {
    name: "a sort key an index policy left, in current text, stays reachable with the fallback on",
    run: leftSortKeyReachableScenario,
  },
  {
    name: "a sort key an index policy left, in a range both texts hold, is read once",
    run: leftSortKeyOnceScenario,
  },
]
