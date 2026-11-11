/**
 * A `pathRemove` the removal guard judges, beside another clause of the same update writing or
 * removing in the same field (#238, review B3). The guard judges a list position by what reads
 * what's left: the list's length and elements, and a tag beside it. Another clause can change
 * each of those in the same request, so the judgement is made against the update as a whole:
 * where another clause writes or removes what it reads (another position of the list or below
 * one, a property beside the path where a struct holds it, the path or what's above it), the
 * position is judged as 1.40.0 judged it, by length alone, and below a sparse map's entry, which
 * 1.40.0 didn't judge, not at all. The first version judged the removal alone, and refused
 * `f.kind = "b"` beside the removal of `f.p[0]`, which leaves `{ kind: "b", p: ["second"] }`.
 * A property's judgement reads nothing of the row, so no other clause changes it.
 *
 * `fixtures/accompanied-clears-1.40.0.json` holds what the published 1.40.0 did, standalone, in
 * a transaction, on a retained entity (and there in a transaction) and with a unique constraint.
 * The head does the same, except where 1.40.0 stored a row no read decodes, or sent what DynamoDB
 * refused: those it refuses before sending.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { type OpenTable, onTable, type Row, recordingRequests } from "./Kept139.js"

interface Captured {
  readonly outcome: unknown
  readonly sent: ReadonlyArray<unknown>
  readonly rows: ReadonlyArray<Row>
  readonly read: unknown
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/accompanied-clears-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Captured> }

const T2 = Schema.Tuple([Schema.String, Schema.String])
const XY = Schema.Struct({ x: Schema.Number, y: Schema.String })
const sparse = { storedAs: DynamoModel.SparseMap({ prefix: "m" }) }
const tagged = 'Union([{ kind: "b", p: [string] }, { kind: "a", p: [string, string] }])'
const records = "{ [open-*]: [string, string?], [fixed-*]: [string, string] }"

/** Each field by its label, and how it's configured. */
const fields: Record<string, readonly [Schema.Top, { readonly storedAs: unknown }?]> = {
  [tagged]: [
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("b"), p: Schema.Tuple([Schema.String]) }),
      Schema.Struct({ kind: Schema.Literal("a"), p: T2 }),
    ]),
  ],
  "[string, number?]": [Schema.Tuple([Schema.String, Schema.optional(Schema.Number)])],
  "[string, string]": [T2],
  [records]: [
    Schema.StructWithRest(Schema.Struct({}), [
      Schema.Record(
        Schema.TemplateLiteral(["open-", Schema.String]),
        Schema.Tuple([Schema.String, Schema.optional(Schema.String)]),
      ),
      Schema.Record(Schema.TemplateLiteral(["fixed-", Schema.String]), T2),
    ]),
  ],
  "{ x, y }": [XY],
  "sparse Record<string, [string, string]>": [Schema.Record(Schema.String, T2), sparse],
  "sparse Record<string, { x, y }>": [Schema.Record(Schema.String, XY), sparse],
}

type Update = any
const set = (segments: ReadonlyArray<string | number>, value: unknown) => (u: Update) =>
  u.pathSet({ segments, value, isPath: false })

const scenarios: ReadonlyArray<
  readonly [field: string, seed: unknown, label: string, op: (u: Update) => Update]
> = [
  [
    tagged,
    { kind: "a", p: ["first", "second"] },
    "pathSet f.kind = b, pathRemove f.p[0]",
    (u) => set(["f", "kind"], "b")(u).pathRemove(["f", "p", 0]),
  ],
  [
    tagged,
    { kind: "a", p: ["first", "second"] },
    "pathRemove f.p[0], pathSet f.kind = b",
    (u) => set(["f", "kind"], "b")(u.pathRemove(["f", "p", 0])),
  ],
  [
    tagged,
    { kind: "a", p: ["first", "second"] },
    "pathSet f.kind = a, pathRemove f.p[0]",
    (u) => set(["f", "kind"], "a")(u).pathRemove(["f", "p", 0]),
  ],
  [
    tagged,
    { kind: "a", p: ["first", "second"] },
    "pathSet f.p[2] = third, pathRemove f.p[0]",
    (u) => set(["f", "p", 2], "third")(u).pathRemove(["f", "p", 0]),
  ],
  [
    "[string, number?]",
    ["first", 1],
    "pathSet f[1] = 2, pathRemove f[0]",
    (u) => set(["f", 1], 2)(u).pathRemove(["f", 0]),
  ],
  [
    "[string, number?]",
    ["first", 1],
    "pathRemove f[0], pathRemove f[1]",
    (u) => u.pathRemove(["f", 0]).pathRemove(["f", 1]),
  ],
  [
    "[string, string]",
    ["first", "second"],
    "pathSet f[2] = third, pathRemove f[0]",
    (u) => set(["f", 2], "third")(u).pathRemove(["f", 0]),
  ],
  [
    "[string, string]",
    ["first", "second"],
    "pathAppend f [third], pathRemove f[0]",
    (u) => u.pathAppend({ segments: ["f"], value: ["third"] }).pathRemove(["f", 0]),
  ],
  [
    records,
    { "fixed-k": ["first", "second"] },
    "pathSet f.fixed-k[2] = third, pathRemove f.fixed-k[0]",
    (u) => set(["f", "fixed-k", 2], "third")(u).pathRemove(["f", "fixed-k", 0]),
  ],
  [
    records,
    { "fixed-k": ["first", "second"] },
    "pathSet f.open-j = [x], pathRemove f.fixed-k[0]",
    (u) => set(["f", "open-j"], ["x"])(u).pathRemove(["f", "fixed-k", 0]),
  ],
  [
    "{ x, y }",
    { x: 1, y: "kept" },
    "pathSet f.y = new, pathRemove f.x",
    (u) => set(["f", "y"], "new")(u).pathRemove(["f", "x"]),
  ],
  [
    "{ x, y }",
    { x: 1, y: "kept" },
    "set f, pathRemove f.x",
    (u) => u.set({ f: { x: 2, y: "new" } }).pathRemove(["f", "x"]),
  ],
  [
    "sparse Record<string, [string, string]>",
    { k: ["first", "second"] },
    "pathSet m#k[2] = third, pathRemove m#k[0]",
    (u) => set(["m#k", 2], "third")(u).pathRemove(["m#k", 0]),
  ],
  [
    "sparse Record<string, { x, y }>",
    { k: { x: 1, y: "kept" } },
    "pathSet m#k.y = new, pathRemove m#k.x",
    (u) => set(["m#k", "y"], "new")(u).pathRemove(["m#k", "x"]),
  ],
  [
    "sparse Record<string, { x, y }>",
    { k: { x: 1, y: "kept" } },
    "set f, pathRemove m#k.x",
    (u) => u.set({ f: { k: { x: 2, y: "new" } } }).pathRemove(["m#k", "x"]),
  ],
]

interface Mode {
  readonly transaction?: true
  readonly retain?: true
  readonly unique?: true
}

const modes: ReadonlyArray<Mode> = [
  {},
  { transaction: true },
  { retain: true },
  { retain: true, transaction: true },
  { unique: true },
]

const modeName = (mode: Mode) =>
  `${mode.transaction ? ", in a transaction" : ""}${mode.retain ? ", retained" : ""}` +
  `${mode.unique ? ", with a unique constraint" : ""}`

/**
 * Refused before sending where 1.40.0 sent: a removal no value survives whatever the other clause
 * writes beside it (a sibling a record's key doesn't read, a property's sibling), which 1.40.0
 * left as a row no read decodes; and a removal below an entry the other clause writes whole, which
 * DynamoDB refused (`DynamoValidationError`: two paths overlap).
 */
const refused: Record<string, "unreadable" | "overlap"> = {
  "pathSet f.open-j = [x], pathRemove f.fixed-k[0]": "unreadable",
  "pathSet m#k.y = new, pathRemove m#k.x": "unreadable",
  "set f, pathRemove m#k.x": "overlap",
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const normal = (value: unknown): any =>
  JSON.parse(JSON.stringify(value ?? null), (_key, held) =>
    typeof held === "string" && (UUID.test(held) || held === "<uuid>")
      ? "<token>"
      : typeof held === "string" && ISO.test(held)
        ? "<time>"
        : held,
  )

const PARTS = [
  "UpdateExpression",
  "ConditionExpression",
  "ExpressionAttributeNames",
  "ExpressionAttributeValues",
  "Item",
] as const
const partsOf = (input: Record<string, unknown>) =>
  Object.fromEntries(PARTS.filter((part) => input[part] !== undefined).map((p) => [p, input[p]]))

/** The expression parts of a write, a transaction's per item. */
const sentOf = (request: unknown): unknown => {
  const [command, input] = Object.entries(request as Record<string, Record<string, any>>)[0]!
  if (command === "getItem" || command === "query") return undefined
  return normal(
    input.TransactItems !== undefined
      ? {
          [command]: (input.TransactItems as ReadonlyArray<Record<string, any>>).map((item) =>
            Object.fromEntries(Object.entries(item).map(([kind, body]) => [kind, partsOf(body)])),
          ),
        }
      : { [command]: partsOf(input) },
  )
}

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return { ok: normal(exit.value) }
  const squashed = Cause.squash(exit.cause) as any
  return {
    [Cause.hasFails(exit.cause) ? "fail" : "die"]: String(squashed?._tag ?? squashed?.name),
    says: String(squashed?.message ?? "")
      .split("\n")[0]!
      .slice(0, 160),
  }
}

const keyOf = (row: Row) => `${row.pk?.S}|${row.sk?.S}`
const rowsOf = (rows: ReadonlyArray<Row>) =>
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

/** Each scenario in each mode, on a table of its own. */
export const accompaniedClearsSuite = (open: OpenTable) => {
  for (const [field, seed, label, op] of scenarios) {
    for (const mode of modes) {
      const name = `f: ${field}, holding ${JSON.stringify(seed)}: ${label}${modeName(mode)}`
      const was = fixture.cases[name]!
      const refusal = refused[label]
      it.effect(
        refusal === "unreadable"
          ? `${name}: refused, where 1.40.0 left a row no read decodes`
          : refusal === "overlap"
            ? `${name}: refused, where DynamoDB refused 1.40.0's request`
            : `${name}: does what 1.40.0 did`,
        () =>
          Effect.gen(function* () {
            const [schema, config] = fields[field]!
            const model = Schema.Struct({
              id: Schema.String,
              ...(mode.unique ? { email: Schema.String } : {}),
              f: schema,
            })
            const Doc = Entity.make({
              model:
                config === undefined ? model : DynamoModel.configure(model, { f: config } as never),
              entityType: "Doc",
              primaryKey: {
                pk: { field: "pk", composite: ["id"] },
                sk: { field: "sk", composite: [] },
              },
              ...(mode.retain ? { versioned: { retain: true } } : {}),
              ...(mode.unique ? { unique: { email: ["email"] } } : {}),
            } as never) as any
            const MainTable = Table.make({
              schema: DynamoSchema.make({ name: "kept", version: 1 }),
              entities: { Doc },
            })
            const log: Array<unknown> = []
            const got = yield* onTable(
              recordingRequests(open, log),
              0,
              MainTable,
              { entities: { Doc } },
              (db, table) =>
                Effect.gen(function* () {
                  const seeded = yield* db.entities.Doc.put({
                    id: "one",
                    ...(mode.unique ? { email: "one@example.com" } : {}),
                    f: seed,
                  }).asEffect()
                  const before = rowsOf(yield* table.rows)
                  log.length = 0
                  const exit = yield* Effect.exit(
                    Effect.suspend(() => {
                      const update = op(db.entities.Doc.update({ id: "one" }))
                      return mode.transaction
                        ? Transaction.transactWrite([update])
                        : update.asEffect()
                    }),
                  )
                  const sent = log.flatMap((request) => {
                    const parts = sentOf(request)
                    return parts === undefined ? [] : [parts]
                  })
                  const read = yield* Effect.exit(db.entities.Doc.get({ id: "one" }))
                  return {
                    seeded: normal(seeded),
                    before,
                    captured: {
                      outcome: outcomeOf(exit),
                      sent,
                      rows: rowsOf(yield* table.rows),
                      read: Exit.isSuccess(read)
                        ? { ok: normal(read.value) }
                        : { fail: String((Cause.squash(read.cause) as any)?._tag) },
                    } satisfies Captured,
                  }
                }),
            )
            if (refusal === undefined) {
              expect(got.captured.sent).toEqual(was.sent)
              expect(got.captured.rows).toEqual(was.rows)
              expect(got.captured.read).toEqual(was.read)
              expect(got.captured.outcome).toEqual(was.outcome)
              return
            }
            // 1.40.0 sent it; the head sends nothing, and the row reads as it was put.
            expect(was.sent).not.toEqual([])
            expect(
              refusal === "unreadable" ? was.read : (was.outcome as { fail: string }).fail,
            ).toEqual(
              refusal === "unreadable" ? { fail: "ValidationError" } : "DynamoValidationError",
            )
            expect(got.captured.outcome).toMatchObject({ fail: "ValidationError" })
            expect(got.captured.sent).toEqual([])
            expect(got.captured.rows).toEqual(got.before)
            expect(got.captured.read).toEqual({ ok: got.seeded })
          }),
      )
    }
  }
}
