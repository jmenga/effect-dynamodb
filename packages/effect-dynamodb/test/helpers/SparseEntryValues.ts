/**
 * A value a path operation writes into a sparse map's entry, by a path naming the entry's own
 * attribute (`counts#z`), against what the published 1.40.0 did (#238,
 * `fixtures/sparse-entry-values-1.40.0.json`, every request whole, the rows and the read before and
 * after).
 *
 * The value is checked against the map's value schema as one written into a field is, and a value
 * the schema refuses is refused with the `ValidationError` a field's gives, before anything is
 * read or sent. 1.40.0 wrote such a value as given: into an entry the row held, where a read then
 * failed on the row; beside a renamed map the row held whole, where no read took it and the update
 * reported success; or DynamoDB refused it (an append to a list that was inside `sl`). A value a
 * read takes as given is written as given, as 1.40.0 wrote it: a number on a field stored as text,
 * which a read takes as earlier releases left it (`codes#z = 7`, `texts#k = [7]`). Where the map's
 * value schema can't check the value exactly (below an opaque class), the operand check judges it
 * where a row's read decides its position (#236): a value no row holding it reads is refused
 * (`deep#k.o.b = 'str'`). A `pathIfNotExists` value the schema refuses is refused only where the
 * row lacks the path, where it would be stored (#236): the update finds out by a read of the row or
 * by its write sent requiring the path. A union's member is the union rework's (`marks`).
 *
 * And a field holding a declaration (`held`), whose value its schema refuses: refused as the
 * operand it is (`update.pathSet`), naming what the schema refuses. 1.40.0 refused it as a
 * declaration's value no read takes (`EDD-9126`), which it wasn't.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { type OpenTable, onTable, recordingRequests } from "./Kept139.js"
import { outcomeOf, rowsOf } from "./RenamedSparseMap.js"
import { wholeOf } from "./RenamedSparseMapWrites.js"
import { comparedCases } from "./WholeDiff.js"

export interface Captured {
  readonly before: ReadonlyArray<any>
  readonly readBefore: any
  readonly outcome: any
  readonly sent: ReadonlyArray<any>
  readonly rows: ReadonlyArray<any>
  readonly read: any
}

const file = "sparse-entry-values-1.40.0.json"
const fixture = JSON.parse(
  readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8"),
) as { readonly cases: Record<string, Captured> }

class Inner extends Schema.Class<Inner>("Inner")({ b: Schema.Number }) {}
const Opaque = Inner.annotate({ title: "opaque" })
const Positive = Schema.Number.check(Schema.isGreaterThan(0))
const Duck = Schema.declare<{ readonly n: number }>(
  (value): value is { readonly n: number } =>
    typeof value === "object" && value !== null && typeof (value as { n?: unknown }).n === "number",
)

const definitions = () => {
  const model = DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      email: Schema.optional(Schema.String),
      counts: Schema.Record(Schema.String, Schema.Number),
      codes: Schema.Record(Schema.String, Schema.NumberFromString),
      lists: Schema.Record(Schema.String, Schema.Array(Schema.Number)),
      objs: Schema.Record(
        Schema.String,
        Schema.Struct({ n: Schema.Number, s: Schema.optional(Schema.String) }),
      ),
      texts: Schema.Record(Schema.String, Schema.Array(Schema.NumberFromString)),
      marks: Schema.Record(
        Schema.String,
        Schema.Union([
          Schema.Struct({ kind: Schema.Literal("raw"), value: Schema.Number }),
          Schema.Struct({ kind: Schema.Literal("text"), value: Schema.String }),
        ]),
      ),
      deep: Schema.Record(Schema.String, Schema.Struct({ o: Schema.optional(Opaque) })),
      held: Schema.Struct({ n: Positive, blob: Duck }),
    }),
    {
      counts: { storedAs: DynamoModel.SparseMap(), field: "sr" },
      codes: { storedAs: DynamoModel.SparseMap() },
      lists: { storedAs: DynamoModel.SparseMap(), field: "sl" },
      objs: { storedAs: DynamoModel.SparseMap() },
      texts: { storedAs: DynamoModel.SparseMap() },
      marks: { storedAs: DynamoModel.SparseMap() },
      deep: { storedAs: DynamoModel.SparseMap() },
    } as never,
  )
  const primaryKey = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }
  const make = (entityType: string, extra: object) =>
    Entity.make({ model, entityType, primaryKey, ...extra } as never)
  return {
    Plain: make("Plain", {}),
    Retained: make("Retained", { versioned: { retain: true } }),
    Unique: make("Unique", { unique: { byEmail: ["email"] } }),
  } as Record<string, any>
}

const doc = (counts: object, lists: object) => ({
  id: "a",
  email: "e",
  counts,
  codes: { a: 1 },
  lists,
  objs: { k: { n: 1 } },
  texts: { k: [1] },
  marks: { a: { kind: "raw", value: 1 }, b: { kind: "text", value: "x" } },
  deep: { k: { o: new Inner({ b: 1 }) } },
  held: { n: 1, blob: { n: 1 } },
})

const rawSet = (
  tableName: string,
  entity: string,
  expression: string,
  names: Record<string, string>,
  values: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const raw = yield* DynamoClient
    yield* raw.updateItem({
      TableName: tableName,
      Key: {
        pk: { S: `$ev#v1#${entity.toLowerCase()}#id_a` },
        sk: { S: `$ev#v1#${entity.toLowerCase()}` },
      },
      ConditionExpression: "attribute_exists(pk)",
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values as never,
    })
  })

const seeds: Record<
  string,
  (db: any, entity: string, tableName: string) => Effect.Effect<unknown, unknown, any>
> = {
  whole: (db, entity) => db.entities[entity].put(doc({ a: 1 }, { k: [1] })).asEffect(),
  entries: (db, entity, tableName) =>
    Effect.gen(function* () {
      yield* db.entities[entity].put(doc({}, {})).asEffect()
      yield* rawSet(
        tableName,
        entity,
        "SET #c = :c, #l = :l REMOVE #sr, #sl",
        { "#c": "counts#a", "#l": "lists#k", "#sr": "sr", "#sl": "sl" },
        { ":c": { N: "1" }, ":l": { L: [{ N: "1" }] } },
      )
    }),
  both: (db, entity, tableName) =>
    Effect.gen(function* () {
      yield* db.entities[entity].put(doc({ a: 1 }, { k: [1] })).asEffect()
      yield* rawSet(
        tableName,
        entity,
        "SET #c = :c, #l = :l",
        { "#c": "counts#a", "#l": "lists#k" },
        { ":c": { N: "7" }, ":l": { L: [{ N: "7" }] } },
      )
    }),
}

type Segments = ReadonlyArray<string | number>
const set = (segments: Segments, value: unknown) => (u: any) =>
  u.pathSet({ segments, value, isPath: false })
const append = (segments: Segments, value: unknown) => (u: any) => u.pathAppend({ segments, value })
const prepend = (segments: Segments, value: unknown) => (u: any) =>
  u.pathPrepend({ segments, value })
const ifNotExists = (segments: Segments, value: unknown) => (u: any) =>
  u.pathIfNotExists({ segments, value })

/**
 * Each write, and what the head does with it: `"refused"`, a value the map's value schema
 * refuses, refused before anything is read or sent; `"refused where stored"`, such a value written
 * by `pathIfNotExists` where the row lacks the path; `"declared"`, `held`'s refused value, refused
 * as an operand; `"as 1.40.0"`, the same requests, rows and reads as 1.40.0.
 */
type Kind = "refused" | "refused where stored" | "declared" | "as 1.40.0"
const writes: ReadonlyArray<readonly [string, (u: any) => any, Kind]> = [
  ["counts#z = 'str'", set(["counts#z"], "str"), "refused"],
  ["counts#z = ['str']", set(["counts#z"], ["str"]), "refused"],
  ["counts#a = true", set(["counts#a"], true), "refused"],
  ["codes#z = '7'", set(["codes#z"], "7"), "as 1.40.0"],
  ["codes#z = 7", set(["codes#z"], 7), "as 1.40.0"],
  ["codes#z = true", set(["codes#z"], true), "refused"],
  ["lists#k = ['str']", set(["lists#k"], ["str"]), "refused"],
  ["append lists#k ['str']", append(["lists#k"], ["str"]), "refused"],
  ["prepend lists#k ['str']", prepend(["lists#k"], ["str"]), "refused"],
  ["lists#k[0] = 'x'", set(["lists#k", 0], "x"), "refused"],
  ["ifNotExists lists#z ['str']", ifNotExists(["lists#z"], ["str"]), "refused where stored"],
  ["objs#k.n = 3", set(["objs#k", "n"], 3), "as 1.40.0"],
  ["objs#k.n = 'x'", set(["objs#k", "n"], "x"), "refused"],
  ["objs#k = { n: 'x' }", set(["objs#k"], { n: "x" }), "refused"],
  ["objs#k.s = 1", set(["objs#k", "s"], 1), "refused"],
  ["append texts#k ['7']", append(["texts#k"], ["7"]), "as 1.40.0"],
  ["append texts#k [true]", append(["texts#k"], [true]), "refused"],
  ["texts#k = [7]", set(["texts#k"], [7]), "as 1.40.0"],
  ["marks#a.value = 2", set(["marks#a", "value"], 2), "as 1.40.0"],
  ["marks#b.value = 2", set(["marks#b", "value"], 2), "as 1.40.0"],
  ["marks#a.value = true", set(["marks#a", "value"], true), "refused"],
  ["deep#k.o.b = 'str'", set(["deep#k", "o", "b"], "str"), "refused"],
  ["held.n = -1", set(["held", "n"], -1), "declared"],
]

/** The read, but for the version a write moves. */
const withoutVersion = (read: any) =>
  read?.ok === undefined ? read : { ...read, ok: { ...read.ok, version: undefined } }

/**
 * What the head did (`got`) against what 1.40.0 did (`was`), for a write the table says `kind`
 * of. Throws on a difference: the poison test hands it a corrupted record.
 */
export const expectCase = (
  [got, refusal]: readonly [Captured, Refusal | undefined],
  was: Captured,
  kind: Kind,
): void => {
  expect(got.before).toEqual(was.before)
  expect(got.readBefore).toEqual(was.readBefore)
  if (kind === "as 1.40.0") {
    expect(got).toEqual(was)
    return
  }
  expect(got.outcome.fail).toBe("ValidationError")
  if (kind === "refused where stored") {
    // The row lacks the path: a read of the row, or the update sent requiring the path, which
    // DynamoDB refuses. Nothing else is sent, and nothing is written.
    const writes = got.sent.filter((request) => Object.keys(request)[0] !== "getItem")
    expect(writes.length).toBeLessThanOrEqual(1)
    for (const write of writes) {
      expect(write.updateItem?.ConditionExpression).toMatch(/attribute_exists\(#fb\d+\)/)
    }
    expect(got.sent.length).toBeGreaterThan(0)
  } else {
    // Refused before anything is read or sent.
    expect(got.sent).toEqual([])
  }
  // The row and its read as they were.
  expect(got.rows).toEqual(was.before)
  expect(got.read).toEqual(was.readBefore)
  if (kind === "declared") {
    // 1.40.0 refused it too, sending nothing, as a declaration's value no read takes.
    expect(was.sent).toEqual([])
    expect(was.rows).toEqual(was.before)
    expect(was.outcome.fail).toBe("ValidationError")
    // `EDD-9126`'s words: the message is held to its first 200 characters.
    expect(was.outcome.says).toContain("wouldn't read back: a custom declaration's value")
    expect(refusal).toEqual({
      operation: "update.pathSet",
      says: "Cause([Fail(SchemaError(Expected a value greater than 0))])",
    })
    return
  }
  // 1.40.0 sent it, and: DynamoDB refused it, a read then failed on the row, or no read took the
  // value (the row read as before, but for its version).
  expect(was.sent.some((request) => Object.keys(request)[0] !== "getItem")).toBe(true)
  const harmed =
    was.outcome.fail === "DynamoValidationError" ||
    was.read.ok === undefined ||
    JSON.stringify(withoutVersion(was.read)) === JSON.stringify(withoutVersion(was.readBefore))
  expect(harmed).toBe(true)
  expect(refusal?.operation).toMatch(/^update\.path(Set|Append|Prepend|IfNotExists)$/)
}

/** How the head refused a write: the error's operation and its cause in words. */
interface Refusal {
  readonly operation: string
  readonly says: string
}

const capture = (
  open: OpenTable,
  entity: string,
  row: string,
  op: (u: any) => any,
  inTransaction: boolean,
): Effect.Effect<readonly [Captured, Refusal | undefined], unknown> => {
  const entities = definitions()
  const MainTable = Table.make({
    schema: DynamoSchema.make({ name: "ev", version: 1 }),
    entities,
  } as never)
  const log: Array<unknown> = []
  return onTable(recordingRequests(open, log), 0, MainTable, { entities }, (db, table) =>
    Effect.gen(function* () {
      yield* seeds[row]!(db, entity, table.name)
      const before = rowsOf(yield* table.rows)
      const readBefore = outcomeOf(yield* Effect.exit(db.entities[entity].get({ id: "a" })))
      log.length = 0
      const exit = yield* Effect.exit(
        Effect.suspend(() => {
          const update = op(db.entities[entity].update({ id: "a" }))
          return inTransaction ? Transaction.transactWrite([update]) : update.asEffect()
        }),
      )
      const sent = log.map((request) => wholeOf(request, table.name)) as Array<any>
      const read = yield* Effect.exit(db.entities[entity].get({ id: "a" }))
      const failed = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as any) : undefined
      return [
        {
          before,
          readBefore,
          outcome: outcomeOf(exit),
          sent,
          rows: rowsOf(yield* table.rows),
          read: outcomeOf(read),
        } satisfies Captured,
        failed?._tag === "ValidationError"
          ? { operation: String(failed.operation), says: String(failed.cause) }
          : undefined,
      ] as const
    }),
  )
}

export const sparseEntryValuesSuite = (open: OpenTable) => {
  const cases = comparedCases(file, fixture.cases)
  for (const entity of ["Plain", "Retained", "Unique"]) {
    for (const row of ["whole", "entries", "both"]) {
      for (const [label, op, kind] of writes) {
        for (const inTransaction of [false, true]) {
          const name = `${entity}, the maps ${row}: ${label}${inTransaction ? ", in a transaction" : ""}`
          const was = cases.compared(name)
          it.effect(`${name}: ${kind === "declared" ? "refused" : kind}`, () =>
            Effect.gen(function* () {
              expectCase(yield* capture(open, entity, row, op, inTransaction), was, kind)
              cases.asserted(name)
            }),
          )
        }
      }
    }
  }
  cases.everyCaseCompared()
  // A record the comparison doesn't hold the head to fails it: each kind of case, against a
  // record corrupted where that kind's comparison looks.
  it.effect(`${file}: a corrupted record fails the comparison`, () =>
    Effect.gen(function* () {
      const corrupt = (name: string, change: (was: any) => void): Captured => {
        const was = structuredClone(fixture.cases[name]!) as any
        change(was)
        return was
      }
      const asGiven = "Plain, the maps entries: codes#z = 7"
      const refused = "Retained, the maps whole: counts#z = 'str', in a transaction"
      const declared = "Plain, the maps whole: held.n = -1"
      const got = {
        asGiven: yield* capture(open, "Plain", "entries", set(["codes#z"], 7), false),
        refused: yield* capture(open, "Retained", "whole", set(["counts#z"], "str"), true),
        declared: yield* capture(open, "Plain", "whole", set(["held", "n"], -1), false),
      }
      const fails = (
        got: Parameters<typeof expectCase>[0],
        was: Captured,
        kind: Parameters<typeof expectCase>[2],
      ) => expect(() => expectCase(got, was, kind)).toThrow()
      expectCase(got.asGiven, fixture.cases[asGiven]!, "as 1.40.0")
      fails(
        got.asGiven,
        corrupt(asGiven, (was) => {
          was.sent[0].updateItem.UpdateExpression = "SET #x = :x"
        }),
        "as 1.40.0",
      )
      fails(
        got.asGiven,
        corrupt(asGiven, (was) => {
          was.rows[0]["codes#z"] = { S: "7" }
        }),
        "as 1.40.0",
      )
      expectCase(got.refused, fixture.cases[refused]!, "refused")
      fails(
        got.refused,
        corrupt(refused, (was) => {
          was.read = was.readBefore
          was.sent = was.sent.slice(0, 1)
        }),
        "refused",
      )
      fails(
        got.refused,
        corrupt(refused, (was) => {
          was.before[0].email = { S: "x" }
        }),
        "refused",
      )
      expectCase(got.declared, fixture.cases[declared]!, "declared")
      fails(
        got.declared,
        corrupt(declared, (was) => {
          was.outcome.says = "anything else"
        }),
        "declared",
      )
    }),
  )
}
