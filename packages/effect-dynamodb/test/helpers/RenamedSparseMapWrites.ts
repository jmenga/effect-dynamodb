/**
 * Writes over a sparse map a `field:` rename stores whole (`counts`, configured
 * `{ storedAs: SparseMap(), field: "sr" }`) that `RenamedSparseMap.ts` doesn't cover (#238).
 *
 * A plain `upsert` writes the map's entries as attributes of their own (`counts#<key>`) without
 * reading the row. 1.40.0 sent it so whatever the row held: on a row `put` created, holding the map
 * whole as `sr`, it reported success and wrote entries a read never sees, because a read takes `sr`
 * in their place (and a condition the caller gave, where it held, let the rest of the write
 * through). The head sends the same request with `attribute_not_exists(sr)` beside its own
 * condition, and answers its refusal on such a row with a `ValidationError` (`EDD-9150`), nothing
 * written, where the rest of the condition holds on the row; where it doesn't, the upsert fails on
 * the caller's condition, as 1.40.0 did. On a row holding entries, or no row, the guard holds and the upsert does what 1.40.0
 * did. An upsert writing no entry (`counts: {}`, or no `counts` at all where the model's map is an
 * `optionalKey`), and every upsert of an entity whose sparse map isn't renamed, is sent as 1.40.0
 * sent it. `fixtures/renamed-sparse-map-upserts-1.40.0.json` holds what the published 1.40.0 did in
 * each case, every request whole: a guarded upsert's differs only in the guard (`GUARD`).
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
import { normal, outcomeOf, rowsOf } from "./RenamedSparseMap.js"
import { comparedCases, expectDiffersOnly } from "./WholeDiff.js"

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
const upsertCases = comparedCases("renamed-sparse-map-upserts-1.40.0.json", upsertFixture.cases)

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
  const optional = DynamoModel.configure(
    Schema.Struct({ ...fields, counts: Schema.optionalKey(fields.counts) }),
    { counts: { storedAs: DynamoModel.SparseMap(), field: "sr" } } as never,
  )
  return {
    Plain: Entity.make({ model: renamed, entityType: "Plain", primaryKey } as never),
    Stamped: Entity.make({
      model: renamed,
      entityType: "Stamped",
      primaryKey,
      timestamps: true,
    } as never),
    Unrenamed: Entity.make({ model: unrenamed, entityType: "Unrenamed", primaryKey } as never),
    Optional: Entity.make({ model: optional, entityType: "Optional", primaryKey } as never),
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
        const sent = log.map((request) => wholeOf(request, table.name))
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

/** Upserts that leave the map out, on `Optional`, whose map is an `optionalKey`. */
const omitted: ReadonlyArray<
  readonly [label: string, body: (db: any, entity: string) => any, entries: boolean]
> = [
  ["upsert({}), counts omitted", (db, e) => db.entities[e].upsert({ id: "a" }), false],
  [
    "upsert({ note: 'n' }), counts omitted",
    (db, e) => db.entities[e].upsert({ id: "a", note: "n" }),
    false,
  ],
]

/**
 * 1.40.0's request with the form guard beside its own condition, and the row a refusal returns
 * (`ReturnValuesOnConditionCheckFailure`), which the caller's own verdict is judged on first.
 */
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
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    },
  }
}

/** The fields the guard changes in a guarded upsert's one request. */
const GUARD = [
  "[0].updateItem.ConditionExpression",
  "[0].updateItem.ExpressionAttributeNames.#fm0",
  "[0].updateItem.ReturnValuesOnConditionCheckFailure",
]

export const renamedSparseMapUpsertsSuite = (open: OpenTable) => {
  for (const entity of ["Plain", "Stamped", "Unrenamed", "Optional"]) {
    for (const seed of ["put", "upsert", "none"] as const) {
      const on = seed === "none" ? `${entity}, no row` : `${entity}, a row ${seed} created`
      for (const [label, body, entries] of entity === "Optional"
        ? [...upserts, ...omitted]
        : upserts) {
        const name = `${on}: ${label}`
        const was = upsertCases.compared(name)
        const renamed = entity !== "Unrenamed"
        // Refused where the caller's condition holds: where it doesn't, the caller's verdict wins.
        const refused = renamed && entries && seed === "put" && was.outcome.ok !== undefined
        it.effect(
          !renamed || !entries
            ? `${name}: as 1.40.0`
            : refused
              ? `${name}: refused (EDD-9150), where 1.40.0 reported success and lost the entries`
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
              expectDiffersOnly(was.sent, captured.sent, GUARD)
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
  upsertCases.everyCaseCompared()
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
const copyCases = comparedCases("renamed-sparse-map-copies-1.40.0.json", copyFixture.cases)

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

/**
 * Where a copy that reads where a read takes the entry differs from 1.40.0's record of its own
 * spelling (`was`): the update's expression and the two names its source maps; the copied value
 * (`n`), in the row, the read and a retained update's result. Where 1.40.0's spelling failed
 * (naming an attribute the row lacks), also the outcome whole, and on a retained entity the version
 * it now writes, the snapshot of the row it replaces (where the row held entries: 1.40.0's seed
 * snapshot held `sr`) and, standalone, the read back of the item it now writes.
 */
const copyDifference = (
  entity: string,
  row: string,
  label: string,
  inTransaction: boolean,
  was: Captured,
): ReadonlyArray<string> => {
  const update = "sent[1].transactWriteItems.TransactItems[0].Update"
  const source = label.startsWith("pathSet") ? "#ps" : "#psb"
  const failed = was.outcome.fail !== undefined
  const retained = entity === "Retained"
  return [
    `${update}.UpdateExpression`,
    `${update}.ExpressionAttributeNames.${source}1`,
    `${update}.ExpressionAttributeNames.${source}2`,
    ...(failed
      ? ["outcome.fail", "outcome.says", "outcome.ok"]
      : retained && !inTransaction
        ? ["outcome.ok.n"]
        : []),
    ...(failed && retained && !inTransaction ? ["sent[2]"] : []),
    "rows[0].n.N",
    ...(failed && retained ? ["rows[0].version.N"] : []),
    ...(failed && retained && row === "entries" ? ["rows[1].sr", "rows[1].counts#a"] : []),
    "read.ok.n",
    ...(failed && retained ? ["read.ok.version"] : []),
  ]
}

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
          const was = copyCases.compared(name)
          const like = copyCases.compared(sibling)
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
                expect(captured).toEqual(like)
                // Against its own spelling on 1.40.0: the source the copy reads, and what follows.
                if (sibling !== name) {
                  expectDiffersOnly(
                    was,
                    captured,
                    copyDifference(entity, row, label, inTransaction, was),
                  )
                }
              }),
          )
        }
      }
    }
  }
  copyCases.everyCaseCompared()
}

const verdictFixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/renamed-sparse-map-verdicts-1.40.0.json", import.meta.url),
    "utf8",
  ),
) as { readonly cases: Record<string, Captured> }
const verdictCases = comparedCases("renamed-sparse-map-verdicts-1.40.0.json", verdictFixture.cases)

const verdictDefinitions = () => {
  const model = DynamoModel.configure(Schema.Struct(fields), {
    counts: { storedAs: DynamoModel.SparseMap(), field: "sr" },
  } as never)
  return {
    Plain: Entity.make({ model, entityType: "Plain", primaryKey } as never),
    Versioned: Entity.make({
      model,
      entityType: "Versioned",
      primaryKey,
      versioned: true,
    } as never),
  } as Record<string, any>
}

/**
 * Updates writing an entry (`set({ counts: { b: 2 } })`) without reading a row `put` created, which
 * holds the map whole: the form guard refuses each, and its refusal is answered only where the rest
 * of the condition holds on the row the refusal returned. `refused`: the caller's condition and
 * version hold, and 1.40.0 reported success and lost the entry (or, for a condition on the entry,
 * judged it as `counts#a`, which the row doesn't hold) — `EDD-9150`. `caller's`: they don't, and
 * the update fails as 1.40.0 failed.
 */
const verdicts: ReadonlyArray<
  readonly [
    label: string,
    entities: ReadonlyArray<string>,
    op: (u: any) => any,
    head: "refused" | "caller's",
    condition?: string,
  ]
> = [
  [
    "set({ counts: { b: 2 } })",
    ["Plain", "Versioned"],
    (u) => u.set({ counts: { b: 2 } }),
    "refused",
  ],
  [
    "set({ counts: { b: 2 } }) condition notExists(t.note), which holds",
    ["Plain", "Versioned"],
    (u) => u.set({ counts: { b: 2 } }).condition((t: any, { notExists }: any) => notExists(t.note)),
    "refused",
  ],
  [
    "set({ counts: { b: 2 } }) condition exists(t.note), which doesn't hold",
    ["Plain", "Versioned"],
    (u) => u.set({ counts: { b: 2 } }).condition((t: any, { exists }: any) => exists(t.note)),
    "caller's",
  ],
  [
    "set({ counts: { b: 2 } }) condition counts.entry('a') = 1, which holds",
    ["Plain", "Versioned"],
    (u) =>
      u.set({ counts: { b: 2 } }).condition((t: any, { eq }: any) => eq(t.counts.entry("a"), 1)),
    "refused",
    "(((attribute_exists(#e0)) AND (#e1.#e2 = :e3)) OR ((attribute_not_exists(#e4)) AND (#e5 = :e6)))",
  ],
  [
    "set({ counts: { b: 2 } }) condition counts.entry('a') = 9, which doesn't hold",
    ["Plain", "Versioned"],
    (u) =>
      u.set({ counts: { b: 2 } }).condition((t: any, { eq }: any) => eq(t.counts.entry("a"), 9)),
    "caller's",
    "(((attribute_exists(#e0)) AND (#e1.#e2 = :e3)) OR ((attribute_not_exists(#e4)) AND (#e5 = :e6)))",
  ],
  [
    "set({ counts: { b: 2 } }) condition between(counts.entry('a'), 0, 2) or exists(t.note), which holds",
    ["Plain", "Versioned"],
    (u) =>
      u
        .set({ counts: { b: 2 } })
        .condition((t: any, { between, exists, or }: any) =>
          or(between(t.counts.entry("a"), 0, 2), exists(t.note)),
        ),
    "refused",
    "((((attribute_exists(#e0)) AND (#e1.#e2 BETWEEN :e3 AND :e4)) OR ((attribute_not_exists(#e5)) AND (#e6 BETWEEN :e7 AND :e8))) OR (attribute_exists(#e9)))",
  ],
  [
    "set({ counts: { b: 2 } }) expectedVersion(1), the stored version",
    ["Versioned"],
    (u) => u.set({ counts: { b: 2 } }).expectedVersion(1),
    "refused",
  ],
  [
    "set({ counts: { b: 2 } }) expectedVersion(5), a stale version",
    ["Versioned"],
    (u) => u.set({ counts: { b: 2 } }).expectedVersion(5),
    "caller's",
  ],
  [
    "set({ counts: { b: 2 } }) expectedVersion(5) condition notExists(t.note)",
    ["Versioned"],
    (u) =>
      u
        .set({ counts: { b: 2 } })
        .expectedVersion(5)
        .condition((t: any, { notExists }: any) => notExists(t.note)),
    "caller's",
  ],
]

export const renamedSparseMapVerdictsSuite = (open: OpenTable) => {
  for (const [label, entities, op, head, condition] of verdicts) {
    for (const entity of entities) {
      const name = `${entity}, a row put created: ${label}`
      const was = verdictCases.compared(name)
      it.effect(
        head === "refused"
          ? `${name}: refused (EDD-9150), where 1.40.0 ${was.outcome.ok !== undefined ? "reported success and lost the entry" : "judged the entry as counts#a and failed on the condition"}`
          : `${name}: fails on the caller's ${was.outcome.fail === "OptimisticLockError" ? "version" : "condition"}, as 1.40.0`,
        () =>
          Effect.gen(function* () {
            const definitions = verdictDefinitions()
            const MainTable = Table.make({
              schema: DynamoSchema.make({ name: "sr", version: 1 }),
              entities: definitions,
            } as never)
            const log: Array<unknown> = []
            yield* onTable(
              recordingRequests(open, log),
              0,
              MainTable,
              { entities: definitions },
              (db, table) =>
                Effect.gen(function* () {
                  yield* db.entities[entity].put({ id: "a", counts: { a: 1 } }).asEffect()
                  const rowsBefore = rowsOf(yield* table.rows)
                  const readBefore = outcomeOf(
                    yield* Effect.exit(db.entities[entity].get({ id: "a" })),
                  )
                  log.length = 0
                  const exit = yield* Effect.exit(
                    Effect.suspend(() => op(db.entities[entity].update({ id: "a" })).asEffect()),
                  )
                  const sent = log.map((request) => wholeOf(request, table.name)) as Array<any>
                  const read = outcomeOf(yield* Effect.exit(db.entities[entity].get({ id: "a" })))
                  const rows = rowsOf(yield* table.rows)
                  // One request, as 1.40.0's, but for the form guard beside its condition (and a
                  // condition on the entry, which follows the read's precedence).
                  expect(sent.length).toBe(1)
                  const { ConditionExpression, ExpressionAttributeNames, ...rest } =
                    sent[0].updateItem
                  const wasUpdate = (was.sent[0] as any).updateItem
                  const {
                    ConditionExpression: wasCondition,
                    ExpressionAttributeNames: wasNames,
                    ...wasRest
                  } = wasUpdate
                  if (condition === undefined) {
                    expect(rest).toEqual(wasRest)
                    expect(ConditionExpression).toBe(
                      wasCondition.replace(
                        "attribute_exists(#exists)",
                        "attribute_exists(#exists) AND attribute_not_exists(#fm0)",
                      ),
                    )
                    expect(ExpressionAttributeNames).toEqual({ ...wasNames, "#fm0": "sr" })
                  } else {
                    const { ExpressionAttributeValues, ...others } = rest
                    const { ExpressionAttributeValues: wasValues, ...wasOthers } = wasRest
                    expect(others).toEqual(wasOthers)
                    expect(ConditionExpression).toContain(
                      `${condition} AND attribute_exists(#exists) AND attribute_not_exists(#fm0)`,
                    )
                    expect(ExpressionAttributeNames["#fm0"]).toBe("sr")
                    expect(Object.values(ExpressionAttributeValues)).toEqual(
                      expect.arrayContaining(Object.values(wasValues)),
                    )
                  }
                  if (head === "caller's") {
                    expect(outcomeOf(exit)).toEqual(was.outcome)
                    expect(rows).toEqual(was.rows)
                    expect(read).toEqual(was.read)
                    return
                  }
                  // Nothing written: the row reads as it did.
                  const says = outcomeOf(exit, Number.POSITIVE_INFINITY).says as string
                  expect(outcomeOf(exit).fail).toBe("ValidationError")
                  expect(says).toContain("[EDD-9150]")
                  expect(rows).toEqual(rowsBefore)
                  expect(read).toEqual(readBefore)
                  expect(readBefore).toEqual({
                    ok: {
                      id: "a",
                      counts: { a: 1 },
                      ...(entity === "Versioned" && { version: 1 }),
                    },
                  })
                }),
            )
          }),
      )
    }
  }
  verdictCases.everyCaseCompared()
}
