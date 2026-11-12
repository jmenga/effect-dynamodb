/**
 * Path writes into a union's member (#238), against what the published 1.40.0 did
 * (`fixtures/union-path-writes-1.40.0.json`, every request whole).
 *
 * 1.40.0 checked a `pathSet` value against the first member of each union on the way that holds
 * the path's next segment, and refused anything that member refused: `pathSet(["tag", "kind"], "b")`
 * on `Union([{ kind: "a", x }, { kind: "b", y }])` was refused with `Expected "a"`, whatever the row
 * held, as was `vary.v = "tt"` on `Union([{ v: number }, { v: string }])`. A value one of the other
 * members takes is now written as that member stores it, and the update's clauses in the field are
 * judged together. A path write reads nothing of the row, so such a value is written only where the
 * update writes every property of the member it writes into (`tag.kind = "b"` beside
 * `tag.y = 2`): what it leaves there then reads whatever the row held. Anywhere else it stays
 * refused as 1.40.0 refused it: a tag written alone (on a row holding the other member it would
 * leave that member's properties under the new tag, a row no read takes; 1.40.0's refusal kept it
 * readable), or beside a clause the schema can't judge (an increment). The request each sends is
 * the one 1.40.0 sent for the same paths with the first member's value (`twin`), but for that
 * value.
 *
 * `tag.kind = "a"` beside `pathRemove(["tag", "x"])` leaves a value no member reads (`a` requires
 * `x`), on any row: refused, nothing sent. 1.40.0 applied it, and the read-back failed (in a
 * transaction, which reads nothing back, it succeeded and left the row unreadable).
 *
 * Every other case sends what 1.40.0 sent.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Lib from "../../src/index.js"
import { type OpenTable, onTable, recordingRequests } from "./Kept139.js"
import { outcomeOf, rowsOf } from "./RenamedSparseMap.js"
import { wholeOf } from "./RenamedSparseMapWrites.js"

interface Captured {
  readonly outcome: any
  readonly sent: ReadonlyArray<unknown>
  readonly rows: unknown
  readonly read: any
  readonly refusal?: { readonly operation: string; readonly cause: string }
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/union-path-writes-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Captured> }

const S = Schema
const A = S.Struct({ kind: S.Literal("a"), x: S.String })
const B = S.Struct({ kind: S.Literal("b"), y: S.Number })
const Docs = Lib.Entity.make({
  model: S.Struct({
    id: S.String,
    tag: S.Union([A, B]),
    vary: S.Union([S.Struct({ v: S.Number }), S.Struct({ v: S.String })]),
    mixed: S.Union([S.Struct({ a: S.Number }), S.String]),
    deep: S.Struct({ inner: S.Union([A, B]) }),
    maybe: S.optional(S.NullOr(S.Union([A, B]))),
    nested: S.Union([S.Struct({ g: S.Union([A, B]) }), S.Struct({ h: S.String })]),
    coded: S.Union([
      S.Struct({ kind: S.Literal("a"), n: S.NumberFromString }),
      S.Struct({ kind: S.Literal("b"), n: S.Number }),
    ]),
  }),
  entityType: "Doc",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const entities = { Docs }
const MainTable = Lib.Table.make({
  schema: Lib.DynamoSchema.make({ name: "uw", version: 1 }),
  entities,
})

const ROWS = {
  a: {
    id: "a",
    tag: { kind: "a", x: "s" },
    vary: { v: 1 },
    mixed: { a: 1 },
    deep: { inner: { kind: "a", x: "s" } },
    maybe: { kind: "a", x: "s" },
    nested: { g: { kind: "a", x: "s" } },
    coded: { kind: "a", n: 5 },
  },
  b: {
    id: "b",
    tag: { kind: "b", y: 1 },
    vary: { v: "s" },
    mixed: "str",
    deep: { inner: { kind: "b", y: 1 } },
    maybe: { kind: "b", y: 1 },
    nested: { g: { kind: "b", y: 1 } },
    coded: { kind: "b", n: 5 },
  },
} as const

type Op = (update: any) => any
const set =
  (segments: ReadonlyArray<string | number>, value: unknown): Op =>
  (u) =>
    u.pathSet({ segments, value, isPath: false })
const remove =
  (segments: ReadonlyArray<string | number>): Op =>
  (u) =>
    u.pathRemove(segments)
const add =
  (segments: ReadonlyArray<string | number>, value: unknown): Op =>
  (u) =>
    u.pathAdd({ segments, value })
const all =
  (...ops: ReadonlyArray<Op>): Op =>
  (u) =>
    ops.reduce((acc, op) => op(acc), u)

const ops: ReadonlyArray<readonly [string, Op]> = [
  ["tag.kind = a", set(["tag", "kind"], "a")],
  ["tag.kind = b", set(["tag", "kind"], "b")],
  ["tag.kind = c", set(["tag", "kind"], "c")],
  ["tag.kind = b, tag.y = 2", all(set(["tag", "kind"], "b"), set(["tag", "y"], 2))],
  ["tag.y = 2, tag.kind = b", all(set(["tag", "y"], 2), set(["tag", "kind"], "b"))],
  ["tag.kind = b, remove tag.y", all(set(["tag", "kind"], "b"), remove(["tag", "y"]))],
  ["tag.kind = a, remove tag.x", all(set(["tag", "kind"], "a"), remove(["tag", "x"]))],
  ["tag.kind = b, tag.x = tt", all(set(["tag", "kind"], "b"), set(["tag", "x"], "tt"))],
  ["tag.kind = b, tag.y = s", all(set(["tag", "kind"], "b"), set(["tag", "y"], "s"))],
  ["tag.kind = b, add tag.y 1", all(set(["tag", "kind"], "b"), add(["tag", "y"], 1))],
  ["tag.y = s", set(["tag", "y"], "s")],
  ["tag.x = tt", set(["tag", "x"], "tt")],
  ["tag.y = 5", set(["tag", "y"], 5)],
  ["vary.v = tt", set(["vary", "v"], "tt")],
  ["vary.v = 5", set(["vary", "v"], 5)],
  ["mixed.a = 5", set(["mixed", "a"], 5)],
  ["mixed.a = s", set(["mixed", "a"], "s")],
  ["deep.inner.kind = b", set(["deep", "inner", "kind"], "b")],
  [
    "deep.inner.kind = b, deep.inner.y = 3",
    all(set(["deep", "inner", "kind"], "b"), set(["deep", "inner", "y"], 3)),
  ],
  ["maybe.kind = b", set(["maybe", "kind"], "b")],
  ["maybe.kind = b, maybe.y = 3", all(set(["maybe", "kind"], "b"), set(["maybe", "y"], 3))],
  ["nested.g.kind = b", set(["nested", "g", "kind"], "b")],
  [
    "nested.g.kind = b, nested.g.y = 2",
    all(set(["nested", "g", "kind"], "b"), set(["nested", "g", "y"], 2)),
  ],
  ["nested.h = tt", set(["nested", "h"], "tt")],
  ["coded.n = 7", set(["coded", "n"], 7)],
  ["coded.kind = b, coded.n = 7", all(set(["coded", "kind"], "b"), set(["coded", "n"], 7))],
  ["coded.kind = a, coded.n = 7", all(set(["coded", "kind"], "a"), set(["coded", "n"], 7))],
  ["tag.kind = a, tag.y = 2", all(set(["tag", "kind"], "a"), set(["tag", "y"], 2))],
  ["tag.y = 2, tag.kind = a", all(set(["tag", "y"], 2), set(["tag", "kind"], "a"))],
  ["tag.kind = a, tag.x = tt", all(set(["tag", "kind"], "a"), set(["tag", "x"], "tt"))],
  ["deep.inner.kind = a", set(["deep", "inner", "kind"], "a")],
  [
    "deep.inner.kind = a, deep.inner.y = 3",
    all(set(["deep", "inner", "kind"], "a"), set(["deep", "inner", "y"], 3)),
  ],
  ["maybe.kind = a", set(["maybe", "kind"], "a")],
  ["maybe.kind = a, maybe.y = 3", all(set(["maybe", "kind"], "a"), set(["maybe", "y"], 3))],
  ["nested.g.kind = a", set(["nested", "g", "kind"], "a")],
  [
    "nested.g.kind = a, nested.g.y = 2",
    all(set(["nested", "g", "kind"], "a"), set(["nested", "g", "y"], 2)),
  ],
]
const inTransaction = new Set([
  "tag.kind = a",
  "tag.kind = b",
  "tag.kind = b, tag.y = 2",
  "tag.kind = a, tag.y = 2",
  "tag.kind = a, remove tag.x",
  "tag.kind = b, remove tag.y",
])

/**
 * A write 1.40.0 refused that is now sent: the case 1.40.0 sent for the same paths (`twin`), the
 * values the request holds in place of the twin's, and what the row reads back as (`reads`, the
 * field written), on a row of either member.
 */
type Sent = {
  readonly twin: string
  readonly values: Record<string, unknown>
  readonly reads: readonly [field: string, value: unknown]
}
const b = { S: "b" }
const sent: Record<string, Sent> = {}
const sends = (
  label: string,
  twin: string,
  values: Record<string, unknown>,
  reads: Record<"a" | "b", Sent["reads"]>,
  how: ReadonlyArray<string> = [""],
) => {
  for (const row of ["a", "b"] as const) {
    for (const suffix of how) {
      sent[`${label} / row ${row}${suffix}`] = {
        twin: `${twin} / row ${row}${suffix}`,
        values,
        reads: reads[row],
      }
    }
  }
}
const tx = ["", " / in a transaction"]
const tagB2 = ["tag", { kind: "b", y: 2 }] as const
sends(
  "tag.kind = b, tag.y = 2",
  "tag.kind = a, tag.y = 2",
  { ":ps2": b },
  { a: tagB2, b: tagB2 },
  tx,
)
sends("tag.y = 2, tag.kind = b", "tag.y = 2, tag.kind = a", { ":ps5": b }, { a: tagB2, b: tagB2 })
sends(
  "vary.v = tt",
  "vary.v = 5",
  { ":ps2": { S: "tt" } },
  { a: ["vary", { v: "tt" }], b: ["vary", { v: "tt" }] },
)
const deepB3 = ["deep", { inner: { kind: "b", y: 3 } }] as const
sends(
  "deep.inner.kind = b, deep.inner.y = 3",
  "deep.inner.kind = a, deep.inner.y = 3",
  { ":ps3": b },
  { a: deepB3, b: deepB3 },
)
const maybeB3 = ["maybe", { kind: "b", y: 3 }] as const
sends(
  "maybe.kind = b, maybe.y = 3",
  "maybe.kind = a, maybe.y = 3",
  { ":ps2": b },
  { a: maybeB3, b: maybeB3 },
)
const nestedB2 = ["nested", { g: { kind: "b", y: 2 } }] as const
sends(
  "nested.g.kind = b, nested.g.y = 2",
  "nested.g.kind = a, nested.g.y = 2",
  { ":ps3": b },
  { a: nestedB2, b: nestedB2 },
)

/** Refused before anything is sent, where 1.40.0 applied the update and left a row no read takes. */
const refused = new Set(
  ["a", "b"].flatMap((row) =>
    tx.map((suffix) => `tag.kind = a, remove tag.x / row ${row}${suffix}`),
  ),
)

/** `value` with each `ExpressionAttributeValues` entry `values` names replaced. */
const withValues = (value: unknown, values: Record<string, unknown>): unknown => {
  if (Array.isArray(value)) return value.map((entry) => withValues(entry, values))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([name, held]) => [
      name,
      name === "ExpressionAttributeValues"
        ? { ...(held as object), ...values }
        : withValues(held, values),
    ]),
  )
}

export const unionPathWritesSuite = (open: OpenTable) => {
  it("captures every case 1.40.0 was asked", () => {
    const names = ops.flatMap(([label]) =>
      ["a", "b"].flatMap((row) => [
        `${label} / row ${row}`,
        ...(inTransaction.has(label) ? [`${label} / row ${row} / in a transaction`] : []),
      ]),
    )
    expect(names.sort()).toEqual(Object.keys(fixture.cases).sort())
  })
  for (const [label, op] of ops) {
    for (const row of ["a", "b"] as const) {
      for (const how of ["alone", ...(inTransaction.has(label) ? ["in a transaction"] : [])]) {
        const name = how === "alone" ? `${label} / row ${row}` : `${label} / row ${row} / ${how}`
        const was = fixture.cases[name]!
        const now = sent[name]
        it.effect(
          now !== undefined
            ? `${name}: sent as 1.40.0 sent ${now.twin}, where it refused it`
            : refused.has(name)
              ? `${name}: refused, nothing sent, where 1.40.0 left a row no read takes`
              : `${name}: as 1.40.0`,
          () =>
            Effect.gen(function* () {
              const log: Array<unknown> = []
              let refusal: { operation: string; cause: string } | undefined
              const head = yield* onTable(
                recordingRequests(open, log),
                0,
                MainTable,
                { entities },
                (db, table) =>
                  Effect.gen(function* () {
                    yield* db.entities.Docs.put(ROWS.a).asEffect()
                    yield* db.entities.Docs.put(ROWS.b).asEffect()
                    log.length = 0
                    const update = op(db.entities.Docs.update({ id: row }))
                    const exit = yield* Effect.exit(
                      Effect.tapError(
                        how === "alone"
                          ? update.asEffect()
                          : Lib.Transaction.transactWrite([update]),
                        (error: any) =>
                          Effect.sync(() => {
                            refusal = {
                              operation: error.operation,
                              cause: String(error.cause).slice(0, 300),
                            }
                          }),
                      ),
                    )
                    const sentNow = log.map((request) => wholeOf(request, table.name))
                    const rows = rowsOf(yield* table.rows)
                    const read = outcomeOf(
                      yield* Effect.exit(
                        db.entities.Docs.get({ id: row }) as Effect.Effect<unknown>,
                      ),
                    )
                    return { outcome: outcomeOf(exit), sent: sentNow, rows, read }
                  }),
              )
              if (now === undefined && !refused.has(name)) {
                expect({ ...head, ...(refusal === undefined ? {} : { refusal }) }).toEqual(was)
                return
              }
              if (refused.has(name)) {
                // Nothing sent: the rows and the read are those of a write 1.40.0 refused.
                const untouched = fixture.cases[`tag.kind = c / row ${row}`]!
                const says =
                  'the path operations on "tag" leave a value no member of its union reads: ' +
                  "what one of them needs a member to hold, another removes or refuses. " +
                  "Nothing was sent."
                expect(head.sent).toEqual([])
                expect(head.outcome).toEqual({ fail: "ValidationError", says: says.slice(0, 200) })
                expect(refusal).toEqual({ operation: "update.pathSet", cause: says })
                expect({ rows: head.rows, read: head.read }).toEqual({
                  rows: untouched.rows,
                  read: untouched.read,
                })
                return
              }
              // The twin's requests, but for the value 1.40.0 refused.
              const twin = fixture.cases[now!.twin]!
              expect(head.sent).toEqual(withValues(twin.sent, now!.values))
              const [field, value] = now!.reads
              expect(head.outcome).toEqual(
                how === "alone" ? { ok: { ...was.read.ok, [field]: value } } : { ok: null },
              )
              expect(head.read).toEqual({ ok: { ...was.read.ok, [field]: value } })
            }),
        )
      }
    }
  }
}
