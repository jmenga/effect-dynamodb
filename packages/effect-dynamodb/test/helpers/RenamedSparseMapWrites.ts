/**
 * Writes over a sparse map a `field:` rename stores whole (`counts`, configured
 * `{ storedAs: SparseMap(), field: "sr" }`) that `RenamedSparseMap.ts` doesn't cover (#238).
 *
 * A plain `upsert` writes the map's entries as attributes of their own (`counts#<key>`) without
 * reading the row. 1.40.0 sent it so whatever the row held: on a row `put` created, holding the map
 * whole as `sr`, it reported success and wrote entries a read never sees, because a read takes `sr`
 * in their place (and a condition the caller gave, where it held, let the rest of the write
 * through). The head sends the same request with `attribute_not_exists(sr)` beside its own
 * condition, and answers its refusal on such a row with a `ValidationError` (`EDD-9150`): nothing
 * is written. On a row holding entries, or no row, the guard holds and the upsert does what 1.40.0
 * did. An upsert writing no entry (`counts: {}`), and every upsert of an entity whose sparse map
 * isn't renamed, is sent as 1.40.0 sent it. `fixtures/renamed-sparse-map-upserts-1.40.0.json`
 * holds what the published 1.40.0 did in each case.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import { type OpenTable, onTable, recordingRequests } from "./Kept139.js"
import { outcomeOf, rowsOf, sentOf } from "./RenamedSparseMap.js"

interface Captured {
  readonly outcome: any
  readonly sent: ReadonlyArray<any>
  readonly rows: ReadonlyArray<any>
  readonly read: any
}

const upsertFixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/renamed-sparse-map-upserts-1.40.0.json", import.meta.url),
    "utf8",
  ),
) as { readonly cases: Record<string, Captured> }

const primaryKey = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }
const fields = {
  id: Schema.String,
  note: Schema.optional(Schema.String),
  counts: Schema.Record(Schema.String, Schema.Number),
}
const definitions = () => {
  const renamed = DynamoModel.configure(Schema.Struct(fields), {
    counts: { storedAs: DynamoModel.SparseMap(), field: "sr" },
  } as never)
  const unrenamed = DynamoModel.configure(Schema.Struct(fields), {
    counts: { storedAs: DynamoModel.SparseMap() },
  } as never)
  return {
    Plain: Entity.make({ model: renamed, entityType: "Plain", primaryKey } as never),
    Stamped: Entity.make({
      model: renamed,
      entityType: "Stamped",
      primaryKey,
      timestamps: true,
    } as never),
    Unrenamed: Entity.make({ model: unrenamed, entityType: "Unrenamed", primaryKey } as never),
  } as Record<string, any>
}

/** Run one case on a table of its own: seed `{ id: "a", counts: { a: 1 } }` with `seed`, then `body`. */
const runCase = (
  open: OpenTable,
  entity: string,
  seed: "put" | "upsert" | "none",
  body: (db: any) => Effect.Effect<unknown, unknown, any>,
) =>
  Effect.gen(function* () {
    const entities = definitions()
    const MainTable = Table.make({
      schema: DynamoSchema.make({ name: "sr", version: 1 }),
      entities,
    } as never)
    const log: Array<unknown> = []
    return yield* onTable(recordingRequests(open, log), 0, MainTable, { entities }, (db, table) =>
      Effect.gen(function* () {
        if (seed !== "none") {
          yield* db.entities[entity][seed]({ id: "a", counts: { a: 1 } }).asEffect()
        }
        const before = rowsOf(yield* table.rows)
        const readBefore = outcomeOf(yield* Effect.exit(db.entities[entity].get({ id: "a" })))
        log.length = 0
        const exit = yield* Effect.exit(Effect.suspend(() => body(db)))
        const sent = log.map(sentOf)
        const read = yield* Effect.exit(db.entities[entity].get({ id: "a" }))
        return {
          before,
          readBefore,
          says: outcomeOf(exit, Number.POSITIVE_INFINITY).says as string | undefined,
          captured: {
            outcome: outcomeOf(exit),
            sent,
            rows: rowsOf(yield* table.rows),
            read: outcomeOf(read),
          } satisfies Captured,
        }
      }),
    )
  })

const upserts: ReadonlyArray<
  readonly [label: string, body: (db: any, entity: string) => any, entries: boolean]
> = [
  [
    "upsert({ counts: { b: 2 } })",
    (db, e) => db.entities[e].upsert({ id: "a", counts: { b: 2 } }),
    true,
  ],
  [
    "upsert({ counts: { a: 5 } })",
    (db, e) => db.entities[e].upsert({ id: "a", counts: { a: 5 } }),
    true,
  ],
  ["upsert({ counts: {} })", (db, e) => db.entities[e].upsert({ id: "a", counts: {} }), false],
  [
    "upsert({ note: 'n', counts: { b: 2 } }) condition notExists(t.note), which holds",
    (db, e) =>
      db.entities[e]
        .upsert({ id: "a", note: "n", counts: { b: 2 } })
        .condition((t: any, { notExists }: any) => notExists(t.note)),
    true,
  ],
  [
    "upsert({ counts: { b: 2 } }) condition exists(t.note), which doesn't hold",
    (db, e) =>
      db.entities[e]
        .upsert({ id: "a", counts: { b: 2 } })
        .condition((t: any, { exists }: any) => exists(t.note)),
    true,
  ],
]

/** 1.40.0's request with the form guard beside its own condition. */
const guarded = (was: any) => {
  const update = was.updateItem
  return {
    updateItem: {
      ...update,
      ConditionExpression:
        update.ConditionExpression === undefined
          ? "attribute_not_exists(#fm0)"
          : `${update.ConditionExpression} AND attribute_not_exists(#fm0)`,
      ExpressionAttributeNames: { ...update.ExpressionAttributeNames, "#fm0": "sr" },
    },
  }
}

export const renamedSparseMapUpsertsSuite = (open: OpenTable) => {
  for (const entity of ["Plain", "Stamped", "Unrenamed"]) {
    for (const seed of ["put", "upsert", "none"] as const) {
      const on = seed === "none" ? `${entity}, no row` : `${entity}, a row ${seed} created`
      for (const [label, body, entries] of upserts) {
        const name = `${on}: ${label}`
        const was = upsertFixture.cases[name]!
        const renamed = entity !== "Unrenamed"
        const refused = renamed && entries && seed === "put"
        it.effect(
          !renamed || !entries
            ? `${name}: as 1.40.0`
            : refused
              ? `${name}: refused (EDD-9150), where 1.40.0 ${was.outcome.ok !== undefined ? "reported success and lost the entries" : "failed on the caller's condition"}`
              : `${name}: guarded, and otherwise as 1.40.0`,
          () =>
            Effect.gen(function* () {
              const got = yield* runCase(open, entity, seed, (db) => body(db, entity).asEffect())
              const { captured } = got
              if (!renamed || !entries) {
                expect(captured).toEqual(was)
                return
              }
              expect(captured.sent).toEqual(was.sent.map(guarded))
              if (!refused) {
                expect(captured.outcome).toEqual(was.outcome)
                expect(captured.rows).toEqual(was.rows)
                expect(captured.read).toEqual(was.read)
                return
              }
              // Nothing written: the row reads as it did, where 1.40.0 wrote entries no read sees.
              expect(captured.outcome.fail).toEqual("ValidationError")
              expect(got.says).toContain("[EDD-9150]")
              expect(got.says).toContain('stored whole under "sr"')
              expect(got.says).toContain("this upsert writes its entries")
              expect(captured.rows).toEqual(got.before)
              expect(captured.read).toEqual(got.readBefore)
              expect(was.read.ok?.counts ?? { a: 1 }).toEqual({ a: 1 })
            }),
        )
      }
    }
  }
}
