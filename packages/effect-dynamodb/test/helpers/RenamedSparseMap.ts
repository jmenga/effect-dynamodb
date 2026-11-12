/**
 * A sparse map a `field:` rename stores whole (`counts: Record<string, number>`, configured
 * `{ storedAs: SparseMap(), field: "sr" }`), through every operation that names the map or an
 * entry, on rows `put` created (the map whole, as `sr`) and rows `upsert` created (one attribute per
 * entry, `counts#<key>`, on a plain entity; `sr` on a retained or unique one), standalone and in a
 * transaction (#238, decision 1).
 *
 * A read takes `sr` whenever the row holds it. 1.40.0 wrote an update's entries as their own
 * attributes whatever the row held, so on a row holding `sr` every entry write reported success and
 * changed nothing a read sees (a `.subtract()` failed naming no attribute), a condition on an entry
 * `.entry()` built failed where it held, and on a row holding entries a condition or a filter on
 * `t.counts.a` failed where it held. The head:
 *
 * - writes an entry where the row it holds holds the map (a retained read, `clearMap`'s read, a
 *   transaction's plan): inside `sr` (`SET sr.b`, `ADD sr.a`, `REMOVE sr.a`) or as `counts#<key>`;
 * - sends a write made without reading the row as before, guarded `attribute_not_exists(sr)`, and
 *   answers its refusal on a row holding `sr` with a `ValidationError` (`EDD-9150`);
 * - asks a condition or a filter on an entry both ways, each beside the test of which the row holds.
 *
 * `put`, `Batch.write`, a transaction's put and a retained or unique `upsert` are sent as 1.40.0 sent
 * them, and so is every write naming no entry. A plain `upsert` carries the same guard as an unread
 * update (`RenamedSparseMapWrites.ts`). `fixtures/renamed-sparse-map-1.40.0.json` holds what the published
 * 1.40.0 did in each case, every request whole (identical under `escapeKeys`); every case where
 * 1.40.0 left the map as the operation meant to leave it leaves the same rows here. Each case names
 * the exact paths at which its requests differ from 1.40.0's (`expectedDifference`): a request's
 * expressions and the placeholders they map (and a retained snapshot's map, which 1.40.0 emptied),
 * or a request as a whole; never a key, a table or what a write returns. A case naming none sends
 * what 1.40.0 sent.
 *
 * A read (`get`, a scan's filter or select) takes the map from whichever form the row holds:
 * 1.40.0's filter or select of `t.counts.a` named `counts.a` (no row holds it) and its `.entry()`
 * threw.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as Batch from "../../src/Batch.js"
import * as Entity from "../../src/Entity.js"
import { createPathBuilder } from "../../src/internal/PathBuilder.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { type OpenTable, onTable, type Row, recordingRequests } from "./Kept139.js"
import { wholeOf } from "./RenamedSparseMapWrites.js"
import { comparedCases, expectDiffersOnly } from "./WholeDiff.js"

interface Captured {
  readonly outcome: any
  readonly sent: ReadonlyArray<any>
  readonly rows: ReadonlyArray<Row>
  readonly read: any
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/renamed-sparse-map-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Captured> }
const fixtureCases = comparedCases("renamed-sparse-map-1.40.0.json", fixture.cases)

const model = (unique: boolean) =>
  DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      note: Schema.optional(Schema.String),
      ...(unique ? { email: Schema.String } : {}),
      counts: Schema.Record(Schema.String, Schema.Number),
    }),
    { counts: { storedAs: DynamoModel.SparseMap(), field: "sr" } } as never,
  )
const primaryKey = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }
const definitions = () => {
  const Plain = Entity.make({ model: model(false), entityType: "Plain", primaryKey } as never)
  const Retained = Entity.make({
    model: model(false),
    entityType: "Retained",
    primaryKey,
    versioned: { retain: true },
  } as never)
  const Unique = Entity.make({
    model: model(true),
    entityType: "Unique",
    primaryKey,
    unique: { byEmail: ["email"] },
  } as never)
  return { Plain, Retained, Unique } as Record<string, any>
}

const entry = (key: string) =>
  (createPathBuilder([], undefined, { counts: { prefix: "counts" } }) as any).counts.entry(key)
    .segments as ReadonlyArray<string>

type Update = any
/** The placeholders a condition on `t.counts.a` maps other than 1.40.0 did: it asks both forms. */
const BY_PATH = ["#e1", "#e2", "#e4", "#e5", ":e2", ":e3", ":e6"]
/** The placeholders a comparison of `t.counts.entry("a")` maps other than 1.40.0 did. */
const BY_ENTRY = ["#e0", "#e1", "#e2", "#e4", "#e5", ":e1", ":e3", ":e6"]
/** The placeholders an `exists` or `notExists` of an entry maps other than 1.40.0 did. */
const EXISTS = ["#e0", "#e1", "#e2", "#e3", "#e4"]

/**
 * Each update, with the map it leaves on a row holding `{ a: 1 }` (`undefined`: the row as it was;
 * `"refused"`: refused before sending, as 1.40.0 refused it), whether it names an entry, and the
 * placeholders (`#name`, `:value`) it maps other than 1.40.0 did where it writes into `sr` (a
 * condition: wherever it's sent).
 */
const writes: ReadonlyArray<
  readonly [
    label: string,
    op: (u: Update) => Update,
    leaves: Record<string, number> | undefined | "refused" | "fails",
    namesEntry: boolean,
    mapped: ReadonlyArray<string>,
  ]
> = [
  [
    ".set({ counts: { b: 2 } })",
    (u) => u.set({ counts: { b: 2 } }),
    { a: 1, b: 2 },
    true,
    ["#m0", "#m1", "#u0"],
  ],
  [
    ".set({ counts: { a: 5 } })",
    (u) => u.set({ counts: { a: 5 } }),
    { a: 5 },
    true,
    ["#m0", "#m1", "#u0"],
  ],
  [
    ".add({ 'counts#a': 1 })",
    (u) => u.add({ "counts#a": 1 }),
    { a: 2 },
    true,
    ["#a0", "#m0", "#m1"],
  ],
  [
    ".subtract({ 'counts#a': 1 })",
    (u) => u.subtract({ "counts#a": 1 }),
    { a: 0 },
    true,
    ["#m0", "#m1", "#u0"],
  ],
  [
    ".removeEntries('counts', ['a'])",
    (u) => u.removeEntries("counts", ["a"]),
    {},
    true,
    ["#m0", "#m1", "#sr0"],
  ],
  [".clearMap('counts')", (u) => u.clearMap("counts"), {}, true, []],
  [
    "pathSet(['counts#b'], 2)",
    (u) => u.pathSet({ segments: ["counts#b"], value: 2, isPath: false }),
    { a: 1, b: 2 },
    true,
    ["#ps0", "#ps1", ":ps1", ":ps2"],
  ],
  [
    "pathAdd(['counts#a'], 1)",
    (u) => u.pathAdd({ segments: ["counts#a"], value: 1 }),
    { a: 2 },
    true,
    ["#pad0", "#pad1", ":pad1", ":pad2"],
  ],
  [
    "pathSubtract(['counts#a'], 1)",
    (u) => u.pathSubtract({ segments: ["counts#a"], value: 1, isPath: false }),
    { a: 0 },
    true,
    ["#psb0", "#psb1", ":psb1", ":psb2"],
  ],
  [
    "pathIfNotExists(['counts#b'], 2)",
    (u) => u.pathIfNotExists({ segments: ["counts#b"], value: 2 }),
    { a: 1, b: 2 },
    true,
    ["#pi0", "#pi1", ":pi1", ":pi2"],
  ],
  [
    "pathSet of counts.entry('b'), 2",
    (u) => u.pathSet({ segments: entry("b"), value: 2, isPath: false }),
    { a: 1, b: 2 },
    true,
    ["#ps0", "#ps1", ":ps1", ":ps2"],
  ],
  [
    "pathAdd of counts.entry('a'), 1",
    (u) => u.pathAdd({ segments: entry("a"), value: 1 }),
    { a: 2 },
    true,
    ["#pad0", "#pad1", ":pad1", ":pad2"],
  ],
  [
    "pathSet(['counts', 'a'], 5)",
    (u) => u.pathSet({ segments: ["counts", "a"], value: 5, isPath: false }),
    "refused",
    false,
    [],
  ],
  ["pathRemove(['counts#a'])", (u) => u.pathRemove(["counts#a"]), "refused", false, []],
  ["pathRemove of counts.entry('a')", (u) => u.pathRemove(entry("a")), "refused", false, []],
  [".set({ 'counts#b': 2 })", (u) => u.set({ "counts#b": 2 }), undefined, false, []],
  [".set({ note: 'n' })", (u) => u.set({ note: "n" }), { a: 1 }, false, []],
  [
    "condition eq(t.counts.a, 1), which holds",
    (u) => u.set({ note: "n" }).condition((t: any, { eq }: any) => eq(t.counts.a, 1)),
    { a: 1 },
    true,
    BY_PATH,
  ],
  [
    "condition eq(t.counts.a, 9), which doesn't hold",
    (u) => u.set({ note: "n" }).condition((t: any, { eq }: any) => eq(t.counts.a, 9)),
    "fails",
    true,
    BY_PATH,
  ],
  [
    "condition eq(t.counts.entry('a'), 1), which holds",
    (u) => u.set({ note: "n" }).condition((t: any, { eq }: any) => eq(t.counts.entry("a"), 1)),
    { a: 1 },
    true,
    BY_ENTRY,
  ],
  [
    "condition exists(t.counts.entry('a'))",
    (u) => u.set({ note: "n" }).condition((t: any, { exists }: any) => exists(t.counts.entry("a"))),
    { a: 1 },
    true,
    EXISTS,
  ],
  [
    "condition eq(t.counts.entry('a'), 9), which doesn't hold",
    (u) => u.set({ note: "n" }).condition((t: any, { eq }: any) => eq(t.counts.entry("a"), 9)),
    "fails",
    true,
    BY_ENTRY,
  ],
  [
    "condition notExists(t.counts.entry('b'))",
    (u) =>
      u
        .set({ note: "n" })
        .condition((t: any, { notExists }: any) => notExists(t.counts.entry("b"))),
    { a: 1 },
    true,
    EXISTS,
  ],
]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
export const normal = (value: unknown): any =>
  JSON.parse(JSON.stringify(value ?? null), (_key, held) =>
    typeof held === "string" && (UUID.test(held) || held === "<uuid>")
      ? "<token>"
      : typeof held === "string" && ISO.test(held)
        ? "<time>"
        : held,
  )

/** An outcome as the capture recorded it: a result, or a failure's tag and its message's first line. */
export const outcomeOf = (exit: Exit.Exit<unknown, unknown>, length = 200): any => {
  if (Exit.isSuccess(exit)) return { ok: normal(exit.value) }
  const squashed = Cause.squash(exit.cause) as any
  const message = String(
    typeof squashed?.cause === "string"
      ? squashed.cause
      : (squashed?.cause?.message ?? squashed?.message ?? ""),
  )
  return {
    [Cause.hasFails(exit.cause) ? "fail" : "die"]: String(squashed?._tag ?? squashed?.name),
    says: message.split("\n")[0]!.slice(0, length),
  }
}

const keyOf = (row: Row) => `${row.pk?.S}|${row.sk?.S}`
export const rowsOf = (rows: ReadonlyArray<Row>) =>
  normal(
    [...rows]
      .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1))
      .map((row) =>
        Object.fromEntries(
          Object.keys(row)
            .sort()
            .map((name) => [name, row[name]]),
        ),
      ),
  )

/**
 * 1.40.0's rows after an update, but for a version snapshot it emptied: a retained entity's removal
 * of an entry of a map stored whole emptied the map (`sr`) of the snapshot it read the row from,
 * which the head keeps as it was written. Only that field of such a row differs.
 */
const snapshotsKept = (after: ReadonlyArray<Row>, before: ReadonlyArray<Row>) =>
  after.map((row) => {
    const was = before.find((other) => keyOf(other) === keyOf(row))
    const emptied = JSON.stringify(row.sr) === JSON.stringify({ M: {} })
    return was !== undefined && row.sk?.S?.includes("#v#") && emptied ? { ...row, sr: was.sr } : row
  })

/** Run one case on a table of its own: seed `{ id: "a", counts: { a: 1 } }`, then `body`. */
const runCase = (
  open: OpenTable,
  entity: string,
  form: "put" | "upsert",
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
        yield* db.entities[entity]
          [form]({
            id: "a",
            counts: { a: 1 },
            ...(entity === "Unique" ? { email: "a@x" } : {}),
          })
          .asEffect()
        const before = rowsOf(yield* table.rows)
        log.length = 0
        const exit = yield* Effect.exit(Effect.suspend(() => body(db)))
        const sent = log.map((request) => wholeOf(request, table.name))
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
  })

/** The update an unread write sends, first. */
const UNREAD = "[0].updateItem"
/** The update a write that read the row sends, after the read: in a transaction, as a retained one. */
const HELD = "[1].transactWriteItems.TransactItems[0].Update"

/** The fields of `request` an expression and its placeholders (`#name`, `:value`) take. */
const fieldsOf = (request: string, expression: string, placeholders: ReadonlyArray<string>) => [
  `${request}.${expression}`,
  ...placeholders.map(
    (held) =>
      `${request}.${held.startsWith("#") ? "ExpressionAttributeNames" : "ExpressionAttributeValues"}.${held}`,
  ),
]

/**
 * The paths at which a case's requests differ from 1.40.0's, exactly; none where the head sends
 * what 1.40.0 sent.
 *
 * - A write naming no entry, or one refused before sending as 1.40.0 refused it: none.
 * - A condition on an entry: its expression and the placeholders it maps (it asks both forms).
 * - An unread write of an entry: its condition and `#fm0` (the guard `attribute_not_exists(sr)`).
 * - A write that read the row, of an entry on a row holding entries: the same guard.
 * - Of an entry on a row holding `sr`: the guard, the update expression and the placeholders the
 *   write into `sr` maps. A retained entity's record operations (`.set`, `.add`, `.subtract`)
 *   write the map whole, as 1.40.0 did, so they send what it sent, but for the version snapshot
 *   `.removeEntries()` no longer empties. Where 1.40.0's write failed and the head's succeeds, a
 *   retained update goes on to read the item back (`[2]`).
 * - A `clearMap` on a row holding `sr` (not retained): its write (`[1]`), where 1.40.0 found no
 *   entry to remove and read the item back.
 */
const expectedDifference = (
  entity: string,
  holdsWhole: boolean,
  inTransaction: boolean,
  [label, , leaves, namesEntry, mapped]: (typeof writes)[number],
  was: Captured,
): ReadonlyArray<string> => {
  if (leaves === "refused" || leaves === undefined || !namesEntry) return []
  const unread = !inTransaction && entity !== "Retained" && label !== ".clearMap('counts')"
  if (label.startsWith("condition")) {
    return fieldsOf(unread ? UNREAD : HELD, "ConditionExpression", mapped)
  }
  if (label === ".clearMap('counts')") {
    return holdsWhole && entity !== "Retained"
      ? ["[1].getItem", inTransaction ? "[1].transactWriteItems" : "[1].updateItem"]
      : []
  }
  if (unread || !holdsWhole) {
    return fieldsOf(unread ? UNREAD : HELD, "ConditionExpression", ["#fm0"])
  }
  if (entity === "Retained" && label.startsWith(".")) {
    return label.startsWith(".removeEntries")
      ? ["[1].transactWriteItems.TransactItems[1].Put.Item.sr.M.a"]
      : []
  }
  return [
    ...fieldsOf(HELD, "ConditionExpression", ["#fm0", ...mapped]),
    `${HELD}.UpdateExpression`,
    ...(entity === "Retained" && !inTransaction && was.outcome.fail !== undefined ? ["[2]"] : []),
  ]
}

/**
 * `got`'s requests differ from `was`'s at exactly the paths `named`, and equal them where it names
 * none.
 */
const expectRequestsDifferAt = (
  was: ReadonlyArray<unknown>,
  got: ReadonlyArray<unknown>,
  named: ReadonlyArray<string>,
) => {
  if (named.length === 0) expect(got).toEqual(was)
  else expectDiffersOnly(was, got, named)
}

/** The commands a case sent, in order. */
export const commands = (sent: ReadonlyArray<unknown>) =>
  sent.map((request) => Object.keys(request as object)[0])

/**
 * What a plain upsert writing an entry of the map does where 1.40.0 did `was`: the same request with
 * `attribute_not_exists(sr)` beside its own condition, refused (`EDD-9150`, nothing written) on a
 * row holding the map whole, and otherwise what 1.40.0 did.
 */
export const guardedUpsert = (
  was: Captured,
  before: ReadonlyArray<Row>,
  says: string | undefined,
  holdsWhole: boolean,
): Captured => {
  const [request] = was.sent as ReadonlyArray<any>
  const update = request.updateItem
  const sent = [
    {
      updateItem: {
        ...update,
        ConditionExpression:
          update.ConditionExpression === undefined
            ? "attribute_not_exists(#fm0)"
            : `${update.ConditionExpression} AND attribute_not_exists(#fm0)`,
        ExpressionAttributeNames: { ...update.ExpressionAttributeNames, "#fm0": "sr" },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      },
    },
  ]
  if (!holdsWhole) return { ...was, sent }
  expect(says).toContain("[EDD-9150]")
  expect(says).toContain("this upsert writes its entries")
  return {
    outcome: { fail: "ValidationError", says: says!.split("\n")[0]!.slice(0, 200) },
    sent,
    rows: before,
    // What the row read before: 1.40.0's write changed nothing a read sees either.
    read: was.read,
  }
}

export const renamedSparseMapSuite = (open: OpenTable) => {
  for (const entity of ["Plain", "Retained", "Unique"]) {
    for (const form of ["put", "upsert"] as const) {
      const on = `${entity}, a row ${form} created`
      // Retained and unique upserts store the map whole too.
      const holdsWhole = form === "put" || entity !== "Plain"
      for (const write of writes) {
        const [label, op, leaves, namesEntry] = write
        for (const inTransaction of [false, true]) {
          const name = `${on}: ${label}${inTransaction ? ", in a transaction" : ""}`
          const was = fixtureCases.compared(name)
          // Without reading the row (a plain or unique update, standalone): refused on a row
          // holding the map whole, once its guard is. `clearMap` reads the row.
          const unread = !inTransaction && entity !== "Retained" && label !== ".clearMap('counts')"
          const refusedWhole =
            holdsWhole &&
            unread &&
            namesEntry &&
            typeof leaves === "object" &&
            !label.startsWith("condition")
          it.effect(
            refusedWhole
              ? `${name}: refused (EDD-9150), where 1.40.0 ${(was.outcome as any).fail === undefined ? "reported success and changed nothing a read sees" : "failed naming no attribute"}`
              : `${name}: leaves ${leaves === undefined ? "the row as it was" : typeof leaves === "string" ? leaves : JSON.stringify(leaves)}`,
            () =>
              Effect.gen(function* () {
                const got = yield* runCase(open, entity, form, (db) => {
                  const update = op(db.entities[entity].update({ id: "a" }))
                  return inTransaction ? Transaction.transactWrite([update]) : update.asEffect()
                })
                const { captured } = got
                const difference = expectedDifference(entity, holdsWhole, inTransaction, write, was)
                expectRequestsDifferAt(was.sent, captured.sent, difference)
                if (difference.includes("[2]")) {
                  // The read back of a retained update whose write 1.40.0 failed.
                  expect(commands(captured.sent)).toEqual([...commands(was.sent), "getItem"])
                }
                if (leaves === "refused") {
                  // Refused before sending, as 1.40.0 refused it.
                  expect(captured.outcome).toEqual(was.outcome)
                  expect(captured.sent).toEqual([])
                  expect(captured.rows).toEqual(got.before)
                  return
                }
                if (leaves === undefined) {
                  // Nothing to write: as 1.40.0.
                  expect(captured).toEqual(was)
                  return
                }
                if (refusedWhole) {
                  expect(captured.outcome.fail).toEqual("ValidationError")
                  expect(got.says).toContain("[EDD-9150]")
                  expect(got.says).toContain('stored whole under "sr"')
                  expect(captured.rows).toEqual(got.before)
                  expect(captured.read).toEqual(was.read)
                  // Sent as 1.40.0 sent it, with the guard beside its own.
                  expect(commands(captured.sent)).toEqual(commands(was.sent))
                  const [sent] = captured.sent as ReadonlyArray<any>
                  expect(sent.updateItem.ConditionExpression).toMatch(
                    /attribute_not_exists\(#fm0\)$/,
                  )
                  expect(sent.updateItem.ExpressionAttributeNames["#fm0"]).toEqual("sr")
                  expect(sent.updateItem.UpdateExpression).toEqual(
                    was.sent[0].updateItem.UpdateExpression,
                  )
                  return
                }
                if (leaves === "fails") {
                  // DynamoDB's own message isn't the recording table's.
                  expect(captured.outcome.fail).toEqual(was.outcome.fail)
                  expect(captured.rows).toEqual(got.before)
                  return
                }
                // The map the operation means, read back.
                expect(captured.read.ok?.counts).toEqual(leaves)
                if (inTransaction) expect(captured.outcome).toEqual({ ok: null })
                else expect(captured.outcome.ok?.counts).toEqual(leaves)
                if (!namesEntry) {
                  // Names no entry: sent as 1.40.0 sent it.
                  expect(captured).toEqual(was)
                } else if ((was.read as any).ok?.counts !== undefined) {
                  const keptRight = JSON.stringify(was.read.ok.counts) === JSON.stringify(leaves)
                  // Where 1.40.0 left the map as meant, the same rows (the request now carries the
                  // form's guard, or asks a condition both ways).
                  if (keptRight && was.outcome.ok !== undefined) {
                    expect(captured.rows).toEqual(snapshotsKept(was.rows, got.before))
                  }
                }
                // Written where the row holds the map: inside `sr`, or as entries, never beside.
                const row = captured.rows.find(
                  (r: Row) => r.sk?.S === `$sr#v1#${entity.toLowerCase()}`,
                )!
                const entries = Object.keys(row).filter((name) => name.startsWith("counts#"))
                if (holdsWhole) expect(entries).toEqual([])
                else expect(row.sr).toBeUndefined()
              }),
          )
        }
      }
      const replace = {
        id: "a",
        counts: { b: 2 },
        ...(entity === "Unique" ? { email: "a@x" } : {}),
      }
      const puts: ReadonlyArray<readonly [string, (db: any) => Effect.Effect<unknown, unknown>]> = [
        ["upsert({ counts: { b: 2 } })", (db) => db.entities[entity].upsert(replace).asEffect()],
        ["put({ counts: { b: 2 } })", (db) => db.entities[entity].put(replace).asEffect()],
        [
          "Batch.write put({ counts: { b: 2 } })",
          (db) => Batch.write([db.entities[entity].put(replace)]),
        ],
        [
          "put({ counts: { b: 2 } }), in a transaction",
          (db) => Transaction.transactWrite([db.entities[entity].put(replace)]),
        ],
      ]
      for (const [label, body] of puts) {
        const name = `${on}: ${label}`
        // A plain upsert is guarded on the row not holding the map whole (`RenamedSparseMapWrites.ts`).
        const guarded = entity === "Plain" && label.startsWith("upsert")
        const was = fixtureCases.compared(name)
        it.effect(`${name}: ${guarded ? "guarded" : "sent as 1.40.0 sent it"}`, () =>
          Effect.gen(function* () {
            const { captured, before, says } = yield* runCase(open, entity, form, body)
            if (!guarded) {
              expect(captured).toEqual(was)
              return
            }
            expect(captured).toEqual(guardedUpsert(was, before, says, holdsWhole))
            expectRequestsDifferAt(
              was.sent,
              captured.sent,
              fieldsOf(UNREAD, "ConditionExpression", ["#fm0"]).concat(
                `${UNREAD}.ReturnValuesOnConditionCheckFailure`,
              ),
            )
          }),
        )
      }
      if (entity !== "Plain") continue
      for (const [label, body, outcome, differs] of reads) {
        const name = `${on}: ${label}`
        const was = fixtureCases.compared(name)
        const same = JSON.stringify(was.outcome) === JSON.stringify(outcome)
        it.effect(
          same
            ? `${name}: as 1.40.0`
            : `${name}: reads the row's map, where 1.40.0 ${was.outcome.die !== undefined ? "threw" : `returned ${JSON.stringify(was.outcome.ok)}`}`,
          () =>
            Effect.gen(function* () {
              const { captured, before } = yield* runCase(open, entity, form, body)
              expect(captured.outcome).toEqual(outcome)
              expect(captured.rows).toEqual(before)
              expect(captured.read).toEqual(was.read)
              expect(captured.rows).toEqual(was.rows)
              if (label === "get") expect(captured).toEqual(was)
              expectRequestsDifferAt(was.sent, captured.sent, differs)
            }),
        )
      }
    }
  }
  fixtureCases.everyCaseCompared()
}

const SCAN = "[0].scan"
/** A scan whose filter on `t.counts.a` asks both forms: the filter and the placeholders it maps. */
const FILTER_BY_PATH = fieldsOf(SCAN, "FilterExpression", BY_PATH)
/** 1.40.0 threw before sending (`.entry()` outside a write), so the head's scan is all new. */
const SENT_NEW = ["[0]"]

/**
 * Reads of the map on `Plain`, each with what it returns from a row holding `{ a: 1 }` and the paths
 * at which its requests differ from 1.40.0's.
 */
const reads: ReadonlyArray<
  readonly [
    label: string,
    body: (db: any) => Effect.Effect<unknown, unknown, any>,
    outcome: unknown,
    differs: ReadonlyArray<string>,
  ]
> = [
  ["get", (db) => db.entities.Plain.get({ id: "a" }), { ok: { id: "a", counts: { a: 1 } } }, []],
  [
    "scan filter eq(t.counts.a, 1)",
    (db) =>
      db.entities.Plain.scan()
        .filter((t: any, { eq }: any) => eq(t.counts.a, 1))
        .collect(),
    { ok: [{ id: "a", counts: { a: 1 } }] },
    FILTER_BY_PATH,
  ],
  [
    "scan filter eq(t.counts.entry('a'), 1)",
    (db) =>
      db.entities.Plain.scan()
        .filter((t: any, { eq }: any) => eq(t.counts.entry("a"), 1))
        .collect(),
    { ok: [{ id: "a", counts: { a: 1 } }] },
    SENT_NEW,
  ],
  [
    "scan filter eq(t.counts.a, 9)",
    (db) =>
      db.entities.Plain.scan()
        .filter((t: any, { eq }: any) => eq(t.counts.a, 9))
        .collect(),
    { ok: [] },
    FILTER_BY_PATH,
  ],
  [
    "scan filter notExists(t.counts.entry('b'))",
    (db) =>
      db.entities.Plain.scan()
        .filter((t: any, { notExists }: any) => notExists(t.counts.entry("b")))
        .collect(),
    { ok: [{ id: "a", counts: { a: 1 } }] },
    SENT_NEW,
  ],
  [
    "scan select((t) => [t.counts.entry('a'), t.note])",
    (db) =>
      db.entities.Plain.scan()
        .select((t: any) => [t.counts.entry("a"), t.note])
        .collect(),
    { ok: [{ counts: { a: 1 } }] },
    SENT_NEW,
  ],
  [
    "scan select(['counts'])",
    (db) => db.entities.Plain.scan().select(["counts"]).collect(),
    { ok: [{ counts: { a: 1 } }] },
    fieldsOf(SCAN, "ProjectionExpression", ["#proj0"]),
  ],
  [
    "scan select((t) => [t.counts.a])",
    (db) =>
      db.entities.Plain.scan()
        .select((t: any) => [t.counts.a])
        .collect(),
    { ok: [{ counts: { a: 1 } }] },
    fieldsOf(SCAN, "ProjectionExpression", ["#proj0", "#proj1"]),
  ],
  [
    "scan select((t) => [t.counts.entry('a')])",
    (db) =>
      db.entities.Plain.scan()
        .select((t: any) => [t.counts.entry("a")])
        .collect(),
    { ok: [{ counts: { a: 1 } }] },
    SENT_NEW,
  ],
]
