/**
 * `.clearMap()` with another write to the same sparse map (#238), against what the published
 * 1.40.0 did (`fixtures/clear-writes-1.40.0.json`, every request whole).
 *
 * The clear comes first: `.clearMap("counts").set({ counts: { b: 2 } })` leaves `{ b: 2 }`. The
 * expression an update sends removes what the clear's read found of the map and writes the rest,
 * naming no path twice: a `SET` of an entry the read found replaces it (the clear leaves it out),
 * an `ADD` to one starts from nothing (sent as that `SET`), a `.removeEntries()` of one is the
 * clear's own `REMOVE`, and a `.subtract()` from one, which has nothing left to work on, is refused
 * before the write (`EDD-9151`). For a map a `field:` rename stores whole, the clear removes the
 * attribute (`sr`) too, and the entries are written as their own attributes, unguarded, so the row
 * ends holding the map as entries whatever form it held. A retained entity's update, which writes
 * the item whole, clears first too.
 *
 * Through 1.40.0: on a row holding `sr`, every clear reported success and changed nothing a read
 * sees; an entry the read found and the write named was sent twice in one request, which DynamoDB
 * refused; and a retained entity's clear dropped the `.set()` beside it, storing `{}`.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { type OpenTable, onTable, recordingRequests } from "./Kept139.js"
import { overlappingUpdatePaths } from "./MockDynamoClient.js"
import { outcomeOf, rowsOf } from "./RenamedSparseMap.js"
import { wholeOf } from "./RenamedSparseMapWrites.js"

interface Captured {
  readonly outcome: any
  readonly sent: ReadonlyArray<any>
  readonly rows: ReadonlyArray<any>
  readonly read: any
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/clear-writes-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Captured> }

const primaryKey = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }
const definitions = () => {
  const fields = {
    id: Schema.String,
    email: Schema.optional(Schema.String),
    counts: Schema.Record(Schema.String, Schema.Number),
  }
  const renamed = DynamoModel.configure(Schema.Struct(fields), {
    counts: { storedAs: DynamoModel.SparseMap(), field: "sr" },
  } as never)
  const unrenamed = DynamoModel.configure(Schema.Struct(fields), {
    counts: { storedAs: DynamoModel.SparseMap() },
  } as never)
  const make = (entityType: string, model: unknown, extra: object) =>
    Entity.make({ model, entityType, primaryKey, ...extra } as never)
  return {
    Plain: make("Plain", renamed, {}),
    Versioned: make("Versioned", renamed, { versioned: true }),
    Retained: make("Retained", renamed, { versioned: { retain: true } }),
    Unique: make("Unique", renamed, { unique: { byEmail: ["email"] } }),
    Unrenamed: make("Unrenamed", unrenamed, {}),
    RetainedUnrenamed: make("RetainedUnrenamed", unrenamed, { versioned: { retain: true } }),
  } as Record<string, any>
}

const rawSet = (
  tableName: string,
  entity: string,
  expression: string,
  names: Record<string, string>,
  value: number,
) =>
  Effect.gen(function* () {
    const raw = yield* DynamoClient
    yield* raw.updateItem({
      TableName: tableName,
      Key: {
        pk: { S: `$cw#v1#${entity.toLowerCase()}#id_a` },
        sk: { S: `$cw#v1#${entity.toLowerCase()}` },
      },
      ConditionExpression: "attribute_exists(pk)",
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ":v": { N: String(value) } },
    })
  })

const seeds: Record<
  string,
  (db: any, entity: string, tableName: string) => Effect.Effect<unknown, unknown, any>
> = {
  whole: (db, entity) =>
    db.entities[entity].put({ id: "a", email: "e", counts: { a: 1 } }).asEffect(),
  entries: (db, entity, tableName) =>
    Effect.gen(function* () {
      yield* db.entities[entity].put({ id: "a", email: "e", counts: {} }).asEffect()
      yield* rawSet(tableName, entity, "SET #e = :v REMOVE #w", { "#e": "counts#a", "#w": "sr" }, 1)
    }),
  both: (db, entity, tableName) =>
    Effect.gen(function* () {
      yield* db.entities[entity].put({ id: "a", email: "e", counts: { a: 1 } }).asEffect()
      yield* rawSet(tableName, entity, "SET #e = :v", { "#e": "counts#a" }, 7)
    }),
  unrenamed: (db, entity) =>
    db.entities[entity].put({ id: "a", email: "e", counts: { a: 1 } }).asEffect(),
}

/** Each write after the clear, and the map it leaves: the clear first, then the write. */
const writes: ReadonlyArray<
  readonly [label: string, op: (u: any) => any, leaves: Record<string, number> | "subtract"]
> = [
  ["clearMap('counts')", (u) => u.clearMap("counts"), {}],
  [
    "clearMap('counts').set({ counts: { b: 2 } })",
    (u) => u.clearMap("counts").set({ counts: { b: 2 } }),
    { b: 2 },
  ],
  [
    "clearMap('counts').set({ counts: { a: 5 } })",
    (u) => u.clearMap("counts").set({ counts: { a: 5 } }),
    { a: 5 },
  ],
  [
    "clearMap('counts').add({ 'counts#a': 2 })",
    (u) => u.clearMap("counts").add({ "counts#a": 2 }),
    { a: 2 },
  ],
  [
    "clearMap('counts').add({ 'counts#b': 2 })",
    (u) => u.clearMap("counts").add({ "counts#b": 2 }),
    { b: 2 },
  ],
  [
    "clearMap('counts').subtract({ 'counts#a': 1 })",
    (u) => u.clearMap("counts").subtract({ "counts#a": 1 }),
    "subtract",
  ],
  [
    "clearMap('counts').removeEntries('counts', ['a'])",
    (u) => u.clearMap("counts").removeEntries("counts", ["a"]),
    {},
  ],
]

/** The fields of two requests that differ, as dotted paths (an array's elements by position). */
const differing = (head: unknown, was: unknown, at = ""): ReadonlyArray<string> => {
  if (JSON.stringify(head) === JSON.stringify(was)) return []
  if (
    head === null ||
    was === null ||
    typeof head !== "object" ||
    typeof was !== "object" ||
    Array.isArray(head) !== Array.isArray(was)
  ) {
    return [at]
  }
  const keys = new Set([...Object.keys(head as object), ...Object.keys(was as object)])
  return [...keys].flatMap((key) =>
    differing(
      (head as Record<string, unknown>)[key],
      (was as Record<string, unknown>)[key],
      at === "" ? key : `${at}.${key}`,
    ),
  )
}

/** Every `UpdateItem` a request list sent, alone or in a transaction. */
const updatesOf = (sent: ReadonlyArray<any>): ReadonlyArray<any> =>
  sent.flatMap((request) => {
    const [command, input] = Object.entries(request)[0] as [string, any]
    if (command === "updateItem") return [input]
    if (command === "transactWriteItems") {
      return (input.TransactItems as ReadonlyArray<any>).flatMap((item) =>
        item.Update === undefined ? [] : [item.Update],
      )
    }
    return []
  })

export const clearWritesSuite = (open: OpenTable) => {
  for (const entity of [
    "Plain",
    "Versioned",
    "Retained",
    "Unique",
    "Unrenamed",
    "RetainedUnrenamed",
  ]) {
    const rows = entity.includes("Unrenamed") ? ["unrenamed"] : ["whole", "entries", "both"]
    const retained = entity.startsWith("Retained")
    for (const row of rows) {
      for (const [label, op, leaves] of writes) {
        for (const inTransaction of [false, true]) {
          const name = `${entity}, ${row === "unrenamed" ? "a row put created" : `the map ${row}`}: ${label}${inTransaction ? ", in a transaction" : ""}`
          const was = fixture.cases[name]!
          // A subtract from an entry the clear removes has nothing to work on. One the row doesn't
          // hold fails in DynamoDB, as it did; a retained entity's starts from nothing, as it did.
          const refused = leaves === "subtract" && !retained && row !== "whole"
          const expected = leaves === "subtract" ? (retained ? { a: -1 } : undefined) : leaves
          const same = refused
            ? false
            : expected === undefined
              ? was.outcome.fail === "DynamoValidationError"
              : JSON.stringify(was.read.ok?.counts) === JSON.stringify(expected)
          it.effect(
            refused
              ? `${name}: refused (EDD-9151), where 1.40.0 sent the entry twice`
              : expected === undefined
                ? `${name}: DynamoDB refuses a subtract from an entry the row doesn't hold, as 1.40.0`
                : same
                  ? `${name}: as 1.40.0`
                  : `${name}: leaves ${JSON.stringify(expected)}, where 1.40.0 ${was.outcome.fail !== undefined ? "sent the entry twice" : `left ${JSON.stringify(was.read.ok?.counts)}`}`,
            () =>
              Effect.gen(function* () {
                const entities = definitions()
                const MainTable = Table.make({
                  schema: DynamoSchema.make({ name: "cw", version: 1 }),
                  entities,
                } as never)
                const log: Array<unknown> = []
                const got = yield* onTable(
                  recordingRequests(open, log),
                  0,
                  MainTable,
                  { entities },
                  (db, table) =>
                    Effect.gen(function* () {
                      yield* seeds[row]!(db, entity, table.name)
                      const before = rowsOf(yield* table.rows)
                      log.length = 0
                      const exit = yield* Effect.exit(
                        Effect.suspend(() => {
                          const update = op(db.entities[entity].update({ id: "a" }))
                          return inTransaction
                            ? Transaction.transactWrite([update])
                            : update.asEffect()
                        }),
                      )
                      const sent = log.map((request) => wholeOf(request, table.name)) as Array<any>
                      const read = yield* Effect.exit(db.entities[entity].get({ id: "a" }))
                      return {
                        before,
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
                const { captured } = got
                // Never one request naming a path twice.
                for (const update of updatesOf(captured.sent)) {
                  expect(overlappingUpdatePaths(update)).toBeUndefined()
                }
                if (same && (row === "entries" || row === "unrenamed")) {
                  expect(captured).toEqual(was)
                  return
                }
                if (refused) {
                  expect(captured.outcome.fail).toBe("ValidationError")
                  expect(got.says).toContain("[EDD-9151]")
                  expect(captured.rows).toEqual(got.before)
                  // The clear's read, and nothing written.
                  expect(captured.sent.map((request) => Object.keys(request)[0])).toEqual([
                    "getItem",
                  ])
                  expect(captured.sent[0]).toEqual(was.sent[0])
                  return
                }
                if (expected === undefined) {
                  // A subtract from an entry the row doesn't hold: DynamoDB refuses it, as it did.
                  expect(captured.outcome).toEqual(was.outcome)
                  expect(captured.rows).toEqual(got.before)
                } else {
                  expect(captured.read.ok.counts).toEqual(expected)
                }
                const commands = captured.sent.map((request) => Object.keys(request)[0])
                if (!was.sent.some((request) => Object.keys(request)[0] !== "getItem")) {
                  // 1.40.0's clear found nothing it took as the map, and wrote nothing.
                  expect(commands).toEqual([
                    "getItem",
                    inTransaction ? "transactWriteItems" : "updateItem",
                  ])
                  expect(captured.sent[0]).toEqual(was.sent[0])
                  expect(updatesOf(captured.sent)[0]).toEqual(
                    expect.objectContaining({
                      UpdateExpression: "REMOVE #sc0",
                      ExpressionAttributeNames: expect.objectContaining({ "#sc0": "sr" }),
                    }),
                  )
                  return
                }
                // The requests 1.40.0 sent, but for the update's expression (and what it names),
                // and the map a retained entity's version snapshot holds.
                expect(commands).toEqual(was.sent.map((request) => Object.keys(request)[0]))
                const fields = new Set(
                  captured.sent.flatMap((request, i) => differing(request, was.sent[i])),
                )
                for (const field of fields) {
                  expect(field).toMatch(
                    /(UpdateExpression|ExpressionAttributeNames|ExpressionAttributeValues|ConditionExpression|\.Item\.(counts#.|sr))/,
                  )
                }
              }),
          )
        }
      }
    }
  }
}

const removalFixture = JSON.parse(
  readFileSync(new URL("../fixtures/retained-entry-removals-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Captured> }

/**
 * A retained entity's `.removeEntries()` (#238), which writes the item whole and the version it
 * replaces as a snapshot. On a row holding a renamed map whole (`sr`), 1.40.0 removed the entry
 * from the read row's own map, which the snapshot is written from: the snapshot of version 1 lost
 * the entry too, and `versions()` read it without it. The head removes it from a copy; the rest of
 * what it sends and stores is 1.40.0's (`fixtures/retained-entry-removals-1.40.0.json`).
 */
export const retainedEntryRemovalsSuite = (open: OpenTable) => {
  for (const entity of ["Retained", "RetainedUnrenamed"]) {
    const rows = entity === "RetainedUnrenamed" ? ["unrenamed"] : ["whole", "entries", "both"]
    for (const row of rows) {
      for (const [label, op] of [
        ["removeEntries('counts', ['a'])", (u: any) => u.removeEntries("counts", ["a"])],
        [
          "removeEntries('counts', ['a']).set({ counts: { b: 2 } })",
          (u: any) => u.removeEntries("counts", ["a"]).set({ counts: { b: 2 } }),
        ],
      ] as const) {
        for (const inTransaction of [false, true]) {
          const name = `${entity}, ${row === "unrenamed" ? "a row put created" : `the map ${row}`}: ${label}${inTransaction ? ", in a transaction" : ""}`
          const was = removalFixture.cases[name]!
          // Where 1.40.0's snapshot lost the entry: the map whole, the entry removed alone.
          const lost = (row === "whole" || row === "both") && !label.includes(".set(")
          it.effect(
            lost
              ? `${name}: the version snapshot keeps the map as it was, where 1.40.0's lost the entry`
              : `${name}: as 1.40.0`,
            () =>
              Effect.gen(function* () {
                const entities = definitions()
                const MainTable = Table.make({
                  schema: DynamoSchema.make({ name: "cw", version: 1 }),
                  entities,
                } as never)
                const log: Array<unknown> = []
                const got = yield* onTable(
                  recordingRequests(open, log),
                  0,
                  MainTable,
                  { entities },
                  (db, table) =>
                    Effect.gen(function* () {
                      yield* seeds[row]!(db, entity, table.name)
                      const before = rowsOf(yield* table.rows)
                      log.length = 0
                      const exit = yield* Effect.exit(
                        Effect.suspend(() => {
                          const update = op(db.entities[entity].update({ id: "a" }))
                          return inTransaction
                            ? Transaction.transactWrite([update])
                            : update.asEffect()
                        }),
                      )
                      const sent = log.map((request) => wholeOf(request, table.name)) as Array<any>
                      const read = yield* Effect.exit(db.entities[entity].get({ id: "a" }))
                      return {
                        before,
                        captured: {
                          outcome: outcomeOf(exit),
                          sent,
                          rows: rowsOf(yield* table.rows),
                          read: outcomeOf(read),
                        } satisfies Captured,
                      }
                    }),
                )
                const { captured } = got
                if (!lost) {
                  expect(captured).toEqual(was)
                  return
                }
                // The snapshot's map: the row's, before the write. Everything else as 1.40.0's.
                const snapshotOf = (rows: ReadonlyArray<any>) =>
                  rows.findIndex((stored) => String(stored.sk.S).includes("#v#"))
                const at = snapshotOf(captured.rows)
                expect(at).toBeGreaterThanOrEqual(0)
                expect(captured.rows[at].sr).toEqual(got.before[0].sr)
                expect(captured.rows[at].sr).toEqual({ M: { a: { N: "1" } } })
                const fields = new Set(
                  captured.sent.flatMap((request, i) => differing(request, was.sent[i])),
                )
                expect(captured.sent.length).toBe(was.sent.length)
                expect([...fields]).toEqual(["transactWriteItems.TransactItems.1.Put.Item.sr.M.a"])
                expect({ ...captured, rows: [], sent: [] }).toEqual({ ...was, rows: [], sent: [] })
                expect(captured.rows.filter((_: unknown, i: number) => i !== at)).toEqual(
                  was.rows.filter((_: unknown, i: number) => i !== snapshotOf(was.rows)),
                )
              }),
          )
        }
      }
    }
  }
}
