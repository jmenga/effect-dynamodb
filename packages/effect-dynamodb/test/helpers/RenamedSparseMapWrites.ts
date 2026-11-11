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
 *
 * A copy's source (`pathSet` / `pathSubtract` with `isPath`) writes nothing, so it carries no guard.
 * Spelled as the entry's attribute (`["counts#a"]`) it names that attribute, as 1.40.0 did. Spelled
 * through the map (`counts.entry("a")`, `["counts", "a"]`) it reads where a read takes the entry
 * when the update holds the row (a retained entity's, a transaction's plan): inside `sr` on a row
 * holding it, as `counts#a` otherwise. Without the row it's named as 1.40.0 named it.
 * `fixtures/renamed-sparse-map-copies-1.40.0.json` holds what 1.40.0 did with each, whole requests.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import { createPathBuilder } from "../../src/internal/PathBuilder.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { type OpenTable, onTable, recordingRequests } from "./Kept139.js"
import { normal, outcomeOf, rowsOf, sentOf } from "./RenamedSparseMap.js"

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

/** A request whole, as the captures hold it: the table's name, UUIDs and timestamps set aside. */
export const wholeOf = (request: unknown, tableName: string): unknown => {
  const named = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(named)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([name, held]) => [
              name === tableName ? "<table>" : name,
              named(held),
            ]),
          )
        : value === tableName
          ? "<table>"
          : value
  return normal(named(JSON.parse(JSON.stringify(request))))
}

const copyFixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/renamed-sparse-map-copies-1.40.0.json", import.meta.url),
    "utf8",
  ),
) as { readonly cases: Record<string, Captured> }

const copyDefinitions = () => {
  const model = DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      n: Schema.optional(Schema.Number),
      counts: Schema.Record(Schema.String, Schema.Number),
    }),
    { counts: { storedAs: DynamoModel.SparseMap(), field: "sr" } } as never,
  )
  return {
    Plain: Entity.make({ model, entityType: "Plain", primaryKey } as never),
    Retained: Entity.make({
      model,
      entityType: "Retained",
      primaryKey,
      versioned: { retain: true },
    } as never),
  } as Record<string, any>
}

/** The row each case starts from: the map whole, as entries, or both (an entry beside `sr`). */
const copySeeds: Record<
  string,
  (db: any, entity: string, tableName: string) => Effect.Effect<unknown, unknown, any>
> = {
  whole: (db, entity) => db.entities[entity].put({ id: "a", n: 10, counts: { a: 1 } }).asEffect(),
  entries: (db, entity, tableName) =>
    Effect.gen(function* () {
      yield* db.entities[entity].put({ id: "a", n: 10, counts: {} }).asEffect()
      yield* rawSet(entity, tableName, "SET #e = :v REMOVE #w", 1)
    }),
  both: (db, entity, tableName) =>
    Effect.gen(function* () {
      yield* db.entities[entity].put({ id: "a", n: 10, counts: { a: 1 } }).asEffect()
      yield* rawSet(entity, tableName, "SET #e = :v", 7)
    }),
}
const rawSet = (entity: string, tableName: string, expression: string, value: number) =>
  Effect.gen(function* () {
    const raw = yield* DynamoClient
    yield* raw.updateItem({
      TableName: tableName,
      Key: {
        pk: { S: `$sr#v1#${entity.toLowerCase()}#id_a` },
        sk: { S: `$sr#v1#${entity.toLowerCase()}` },
      },
      UpdateExpression: expression,
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: {
        "#e": "counts#a",
        ...(expression.includes("#w") ? { "#w": "sr" } : {}),
      },
      ExpressionAttributeValues: { ":v": { N: String(value) } },
    })
  })

const entryOf = (key: string) =>
  (createPathBuilder([], undefined, { counts: { prefix: "counts" } }) as any).counts.entry(key)
    .segments as ReadonlyArray<string>
const copies: ReadonlyArray<
  readonly [label: string, op: (u: any) => any, through: "attribute" | "entry" | "map"]
> = [
  [
    "pathSet(['n'] from ['counts#a'])",
    (u) => u.pathSet({ segments: ["n"], valueSegments: ["counts#a"], isPath: true }),
    "attribute",
  ],
  [
    "pathSet(['n'] from counts.entry('a'))",
    (u) => u.pathSet({ segments: ["n"], valueSegments: entryOf("a"), isPath: true }),
    "entry",
  ],
  [
    "pathSet(['n'] from ['counts', 'a'])",
    (u) => u.pathSet({ segments: ["n"], valueSegments: ["counts", "a"], isPath: true }),
    "map",
  ],
  [
    "pathSubtract(['n'] by ['counts#a'])",
    (u) => u.pathSubtract({ segments: ["n"], valueSegments: ["counts#a"], isPath: true }),
    "attribute",
  ],
  [
    "pathSubtract(['n'] by counts.entry('a'))",
    (u) => u.pathSubtract({ segments: ["n"], valueSegments: entryOf("a"), isPath: true }),
    "entry",
  ],
  [
    "pathSubtract(['n'] by ['counts', 'a'])",
    (u) => u.pathSubtract({ segments: ["n"], valueSegments: ["counts", "a"], isPath: true }),
    "map",
  ],
]

/** One copy case on a table of its own, every request it sent kept whole. */
const runCopy = (open: OpenTable, entity: string, row: string, body: (db: any) => any) =>
  Effect.gen(function* () {
    const entities = copyDefinitions()
    const MainTable = Table.make({
      schema: DynamoSchema.make({ name: "sr", version: 1 }),
      entities,
    } as never)
    const log: Array<unknown> = []
    return yield* onTable(recordingRequests(open, log), 0, MainTable, { entities }, (db, table) =>
      Effect.gen(function* () {
        yield* copySeeds[row]!(db, entity, table.name)
        log.length = 0
        const exit = yield* Effect.exit(Effect.suspend(() => body(db)))
        const sent = log.map((request) => wholeOf(request, table.name))
        const read = yield* Effect.exit(db.entities[entity].get({ id: "a" }))
        return {
          outcome: outcomeOf(exit),
          sent,
          rows: rowsOf(yield* table.rows),
          read: outcomeOf(read),
        } satisfies Captured
      }),
    )
  })

export const renamedSparseMapCopiesSuite = (open: OpenTable) => {
  for (const entity of ["Plain", "Retained"]) {
    for (const row of ["whole", "entries", "both"]) {
      for (const [label, op, through] of copies) {
        for (const inTransaction of [false, true]) {
          const name = `${entity}, the map ${row}: ${label}${inTransaction ? ", in a transaction" : ""}`
          // A retained update reads the row, and so does a transaction's plan.
          const holds = entity === "Retained" || inTransaction
          // Read where a read takes the entry: as 1.40.0 sent the spelling that named it there.
          const sibling =
            through === "attribute" || !holds
              ? name
              : name.replace(
                  label,
                  label.replace(
                    through === "entry" ? "counts.entry('a')" : "['counts', 'a']",
                    row === "entries" ? "counts.entry('a')" : "['counts', 'a']",
                  ),
                )
          it.effect(
            sibling === name
              ? `${name}: as 1.40.0`
              : `${name}: reads where a read takes the entry, as 1.40.0's ${row === "entries" ? "counts.entry('a')" : "['counts', 'a']"} did`,
            () =>
              Effect.gen(function* () {
                const captured = yield* runCopy(open, entity, row, (db) => {
                  const update = op(db.entities[entity].update({ id: "a" }))
                  return inTransaction ? Transaction.transactWrite([update]) : update.asEffect()
                })
                expect(captured).toEqual(copyFixture.cases[sibling])
              }),
          )
        }
      }
    }
  }
}
