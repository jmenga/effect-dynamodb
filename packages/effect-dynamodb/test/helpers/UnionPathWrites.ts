/**
 * Path writes into a union's member (#238), against what the published 1.40.0 did
 * (`fixtures/union-path-writes-1.40.0.json`, every request whole).
 *
 * 1.40.0 checked a `pathSet` value against the first member of each union on the way that holds
 * the path's next segment, and refused anything that member refused: `pathSet(["tag", "kind"], "b")`
 * on `Union([{ kind: "a", x }, { kind: "b", y }])` was refused with `Expected "a"`, whatever the row
 * held, as was `vary.v = "tt"` on `Union([{ v: number }, { v: string }])`. A value one of the other
 * members takes is now written as that member stores it, and the update's clauses in the field are
 * judged together. A path write reads nothing of the row, so such a value is written only where
 * what the update leaves reads whatever the row held, at every union its paths pass: every member
 * there reads it, or the update writes every property of one member that does (`tag.kind = "b"`
 * beside `tag.y = 2`). The unions a path passes through are the second suite's. Anywhere else it stays
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
import { Effect, Option, Schema } from "effect"
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

// ---------------------------------------------------------------------------
// Unions a path passes through (round three, `fixtures/union-path-writes-passed-1.40.0.json`)
// ---------------------------------------------------------------------------

/**
 * A value only another member takes is judged at EVERY union the update's paths pass, passed
 * through or ended at, at any depth: it's sent only where every member there reads what the update
 * leaves, or the update writes every property of one member that does (a struct property set
 * whole, or every property of it written, in turn). Anywhere else it's refused as 1.40.0 refused
 * it: `pass.inner.v = "str"` on `Union([{ kind: "a", inner: { v: number } }, { kind: "b", inner:
 * { v: string } }])`, where every member holds `inner`, leaves `kind: "a"` beside a string on a row
 * of the first member, which no read takes.
 *
 * Each union field has its own entity pair, plain (`Docs_<field>`) and retained (`Kept_<field>`),
 * every case runs on both, on a row of either member, alone and in a transaction, and every case
 * of the fixture is asserted: equal to 1.40.0 whole, or one of the named changes below.
 */
const passedFixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/union-path-writes-passed-1.40.0.json", import.meta.url),
    "utf8",
  ),
) as { readonly cases: Record<string, Captured> }

class ClsA extends S.Class<ClsA>("ClsA")({ kind: S.Literal("a"), x: S.String }) {}
class ClsB extends S.Class<ClsB>("ClsB")({ kind: S.Literal("b"), y: S.Number }) {}
const passedFields = {
  pass: S.Union([
    S.Struct({ kind: S.Literal("a"), inner: S.Struct({ v: S.Number }) }),
    S.Struct({ kind: S.Literal("b"), inner: S.Struct({ v: S.String }) }),
  ]),
  pass2: S.Union([
    S.Struct({ inner: S.Struct({ v: S.Number }), n: S.Number }),
    S.Struct({ inner: S.Struct({ v: S.String }), s: S.String }),
  ]),
  outer: S.Union([
    S.Struct({ mode: S.Literal("a"), g: A }),
    S.Struct({ mode: S.Literal("b"), g: B }),
  ]),
  outer2: S.Union([
    S.Struct({ mode: S.Literal("a"), g: A }),
    S.Struct({ mode: S.Literal("b"), g: S.Union([A, B]) }),
  ]),
  passList: S.Union([
    S.Struct({ kind: S.Literal("a"), items: S.Array(S.Struct({ v: S.Number })) }),
    S.Struct({ kind: S.Literal("b"), items: S.Array(S.Struct({ v: S.String })) }),
  ]),
  passRec: S.Union([
    S.Struct({ kind: S.Literal("a"), rec: S.Record(S.String, S.Number) }),
    S.Struct({ kind: S.Literal("b"), rec: S.Record(S.String, S.String) }),
  ]),
  two: S.Union([
    S.Struct({ kind: S.Literal("a"), g: S.Union([A, B]) }),
    S.Struct({
      kind: S.Literal("b"),
      g: S.Union([S.Struct({ kind: S.Literal("b"), y: S.String })]),
    }),
  ]),
  opt: S.Union([
    S.Struct({ kind: S.Literal("a"), z: S.String }),
    S.Struct({ kind: S.Literal("b"), y: S.Number, z: S.optional(S.Number) }),
  ]),
  over: S.Union([
    S.Struct({ kind: S.Literal("a"), y: S.String }),
    S.Struct({ kind: S.Literal("b"), y: S.Number }),
  ]),
  list: S.Array(S.Union([A, B])),
  rec: S.Record(S.String, S.Union([A, B])),
  wide: S.Union([S.Struct({ v: S.Number, w: S.Number }), S.Struct({ v: S.String })]),
  bag: S.Union([
    S.Struct({ kind: S.Literal("a"), s: S.ReadonlySet(S.String) }),
    S.Struct({ kind: S.Literal("b"), s: S.ReadonlySet(S.Number) }),
  ]),
  cls: S.Union([ClsA, ClsB]),
  renamed: S.Union([
    A.pipe(S.encodeKeys({ kind: "k", x: "xx" })),
    B.pipe(S.encodeKeys({ kind: "k", y: "yy" })),
  ]),
  optn: S.Union([
    S.Struct({ kind: S.Literal("a"), o: S.OptionFromNullOr(S.String) }),
    S.Struct({ kind: S.Literal("b"), o: S.Number }),
  ]),
} as const
type PassedField = keyof typeof passedFields
const passedKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const
const passedEntities: Record<string, any> = {}
for (const [field, schema] of Object.entries(passedFields)) {
  const model = S.Struct({ id: S.String, [field]: schema })
  passedEntities[`Docs_${field}`] = Lib.Entity.make({
    model,
    entityType: `Doc_${field}`,
    primaryKey: passedKey,
  } as any)
  passedEntities[`Kept_${field}`] = Lib.Entity.make({
    model,
    entityType: `Kept_${field}`,
    versioned: { retain: true },
    primaryKey: passedKey,
  } as any)
}
const PassedTable = Lib.Table.make({
  schema: Lib.DynamoSchema.make({ name: "up", version: 1 }),
  entities: passedEntities,
})
const passedRows = (row: "a" | "b"): Record<PassedField, unknown> =>
  row === "a"
    ? {
        pass: { kind: "a", inner: { v: 1 } },
        pass2: { inner: { v: 1 }, n: 1 },
        outer: { mode: "a", g: { kind: "a", x: "s" } },
        outer2: { mode: "a", g: { kind: "a", x: "s" } },
        passList: { kind: "a", items: [{ v: 1 }] },
        passRec: { kind: "a", rec: { k: 1, j: 2 } },
        two: { kind: "a", g: { kind: "a", x: "s" } },
        opt: { kind: "a", z: "zz" },
        over: { kind: "a", y: "s" },
        list: [{ kind: "a", x: "s" }],
        rec: { k: { kind: "a", x: "s" }, j: { kind: "a", x: "u" } },
        wide: { v: 1, w: 2 },
        bag: { kind: "a", s: new Set(["p"]) },
        cls: new ClsA({ kind: "a", x: "s" }),
        renamed: { kind: "a", x: "s" },
        optn: { kind: "a", o: Option.some("s") },
      }
    : {
        pass: { kind: "b", inner: { v: "s" } },
        pass2: { inner: { v: "s" }, s: "sv" },
        outer: { mode: "b", g: { kind: "b", y: 1 } },
        outer2: { mode: "b", g: { kind: "b", y: 1 } },
        passList: { kind: "b", items: [{ v: "s" }] },
        passRec: { kind: "b", rec: { k: "s", j: "u" } },
        two: { kind: "b", g: { kind: "b", y: "s" } },
        opt: { kind: "b", y: 1, z: 1 },
        over: { kind: "b", y: 1 },
        list: [{ kind: "b", y: 1 }],
        rec: { k: { kind: "b", y: 1 }, j: { kind: "b", y: 2 } },
        wide: { v: "s" },
        bag: { kind: "b", s: new Set([1]) },
        cls: new ClsB({ kind: "b", y: 1 }),
        renamed: { kind: "b", y: 1 },
        optn: { kind: "b", o: 1 },
      }

const sub =
  (segments: ReadonlyArray<string | number>, value: unknown): Op =>
  (u) =>
    u.pathSubtract({ segments, value, isPath: false })
const append =
  (segments: ReadonlyArray<string | number>, value: unknown): Op =>
  (u) =>
    u.pathAppend({ segments, value })
const prepend =
  (segments: ReadonlyArray<string | number>, value: unknown): Op =>
  (u) =>
    u.pathPrepend({ segments, value })
const ifne =
  (segments: ReadonlyArray<string | number>, value: unknown): Op =>
  (u) =>
    u.pathIfNotExists({ segments, value })
const del =
  (segments: ReadonlyArray<string | number>, value: unknown): Op =>
  (u) =>
    u.pathDelete({ segments, value })

/** Each update the fixture holds, with the field it writes. */
const passedOps: ReadonlyArray<readonly [label: string, field: PassedField, op: Op]> = [
  ["pass.inner.v = str", "pass", set(["pass", "inner", "v"], "str")],
  ["pass2.inner.v = str", "pass2", set(["pass2", "inner", "v"], "str")],
  ["passList.items[0].v = str", "passList", set(["passList", "items", 0, "v"], "str")],
  ["passRec.rec.k = str", "passRec", set(["passRec", "rec", "k"], "str")],
  [
    "two.g.kind = b, two.g.y = str",
    "two",
    all(set(["two", "g", "kind"], "b"), set(["two", "g", "y"], "str")),
  ],
  ["two.g.y = str", "two", set(["two", "g", "y"], "str")],
  [
    "two.g.kind = b, two.g.y = 2",
    "two",
    all(set(["two", "g", "kind"], "b"), set(["two", "g", "y"], 2)),
  ],
  [
    "outer.g.kind = b, outer.g.y = 2",
    "outer",
    all(set(["outer", "g", "kind"], "b"), set(["outer", "g", "y"], 2)),
  ],
  [
    "outer2.g.kind = b, outer2.g.y = 2",
    "outer2",
    all(set(["outer2", "g", "kind"], "b"), set(["outer2", "g", "y"], 2)),
  ],
  ["pass.inner = {v: str}", "pass", set(["pass", "inner"], { v: "str" })],
  ["pass.kind = b", "pass", set(["pass", "kind"], "b")],
  ["opt.kind = b, opt.y = 2", "opt", all(set(["opt", "kind"], "b"), set(["opt", "y"], 2))],
  ["over.y = 2", "over", set(["over", "y"], 2)],
  ["over.kind = b", "over", set(["over", "kind"], "b")],
  [
    "list[0].kind = b, list[1].y = 2",
    "list",
    all(set(["list", 0, "kind"], "b"), set(["list", 1, "y"], 2)),
  ],
  [
    "rec.k.kind = b, rec.j.y = 2",
    "rec",
    all(set(["rec", "k", "kind"], "b"), set(["rec", "j", "y"], 2)),
  ],
  [
    "over.kind = b, over.y = 2, add over.y 1",
    "over",
    all(set(["over", "kind"], "b"), set(["over", "y"], 2), add(["over", "y"], 1)),
  ],
  ["cls.kind = b, cls.y = 2", "cls", all(set(["cls", "kind"], "b"), set(["cls", "y"], 2))],
  [
    "renamed.kind = b, renamed.y = 2",
    "renamed",
    all(set(["renamed", "kind"], "b"), set(["renamed", "y"], 2)),
  ],
  ["optn.kind = b, optn.o = 2", "optn", all(set(["optn", "kind"], "b"), set(["optn", "o"], 2))],
  ["renamed.kind = b", "renamed", set(["renamed", "kind"], "b")],
  ["renamed.kind = a", "renamed", set(["renamed", "kind"], "a")],
  ["renamed.y = 2", "renamed", set(["renamed", "y"], 2)],
  ["renamed.x = n", "renamed", set(["renamed", "x"], "n")],
  ["remove renamed.x", "renamed", remove(["renamed", "x"])],
  ["add renamed.y 1", "renamed", add(["renamed", "y"], 1)],
  [
    "renamed.kind = a, renamed.x = n",
    "renamed",
    all(set(["renamed", "kind"], "a"), set(["renamed", "x"], "n")),
  ],
  [
    "pass.kind = b, pass.inner.v = str, ifNotExists pass.inner.w",
    "pass",
    all(
      set(["pass", "kind"], "b"),
      set(["pass", "inner", "v"], "str"),
      ifne(["pass", "inner", "w"], 1),
    ),
  ],
  [
    "pass.kind = b, pass.inner.v = str",
    "pass",
    all(set(["pass", "kind"], "b"), set(["pass", "inner", "v"], "str")),
  ],
  [
    "pass.kind = b, pass.inner = {v: str}",
    "pass",
    all(set(["pass", "kind"], "b"), set(["pass", "inner"], { v: "str" })),
  ],
  [
    "pass2.inner.v = str, pass2.s = x",
    "pass2",
    all(set(["pass2", "inner", "v"], "str"), set(["pass2", "s"], "x")),
  ],
  [
    "passList.kind = b, passList.items = [{v: s}]",
    "passList",
    all(set(["passList", "kind"], "b"), set(["passList", "items"], [{ v: "s" }])),
  ],
  [
    "two.kind = b, two.g = {kind: b, y: str}",
    "two",
    all(set(["two", "kind"], "b"), set(["two", "g"], { kind: "b", y: "str" })),
  ],
  [
    "outer.mode = b, outer.g.kind = b, outer.g.y = 2",
    "outer",
    all(set(["outer", "mode"], "b"), set(["outer", "g", "kind"], "b"), set(["outer", "g", "y"], 2)),
  ],
  [
    "outer2.mode = b, outer2.g.kind = b, outer2.g.y = 2",
    "outer2",
    all(
      set(["outer2", "mode"], "b"),
      set(["outer2", "g", "kind"], "b"),
      set(["outer2", "g", "y"], 2),
    ),
  ],
  [
    "opt.kind = b, opt.y = 2, remove opt.z",
    "opt",
    all(set(["opt", "kind"], "b"), set(["opt", "y"], 2), remove(["opt", "z"])),
  ],
  [
    "opt.kind = b, opt.y = 2, opt.z = 3",
    "opt",
    all(set(["opt", "kind"], "b"), set(["opt", "y"], 2), set(["opt", "z"], 3)),
  ],
  ["over.kind = b, over.y = 2", "over", all(set(["over", "kind"], "b"), set(["over", "y"], 2))],
  [
    "list[0].kind = b, list[0].y = 2",
    "list",
    all(set(["list", 0, "kind"], "b"), set(["list", 0, "y"], 2)),
  ],
  [
    "rec.k.kind = b, rec.k.y = 2",
    "rec",
    all(set(["rec", "k", "kind"], "b"), set(["rec", "k", "y"], 2)),
  ],
  ["wide.v = tt", "wide", set(["wide", "v"], "tt")],
  [
    "two.g.kind = b, two.g.y = 2, two.kind = a",
    "two",
    all(set(["two", "g", "kind"], "b"), set(["two", "g", "y"], 2), set(["two", "kind"], "a")),
  ],
  ["pass.inner.v = 7", "pass", set(["pass", "inner", "v"], 7)],
  ["pass.inner = {v: 7}", "pass", set(["pass", "inner"], { v: 7 })],
  [
    "passRec.rec.k = 7, remove passRec.rec.j",
    "passRec",
    all(set(["passRec", "rec", "k"], 7), remove(["passRec", "rec", "j"])),
  ],
  ["two.g.x = n", "two", set(["two", "g", "x"], "n")],
  ["list[0].x = n", "list", set(["list", 0, "x"], "n")],
  [
    "rec.k.x = n, rec.k.kind = a",
    "rec",
    all(set(["rec", "k", "x"], "n"), set(["rec", "k", "kind"], "a")),
  ],
  ["wide.v = 5, wide.w = 6", "wide", all(set(["wide", "v"], 5), set(["wide", "w"], 6))],
  ["wide.v = 5, add wide.w 1", "wide", all(set(["wide", "v"], 5), add(["wide", "w"], 1))],
  [
    "passList.items[0].v = 7, append passList.items",
    "passList",
    all(set(["passList", "items", 0, "v"], 7), append(["passList", "items"], [{ v: 8 }])),
  ],
  ["ifNotExists pass.inner.v = str", "pass", ifne(["pass", "inner", "v"], "str")],
  ["ifNotExists pass.inner.v = 7", "pass", ifne(["pass", "inner", "v"], 7)],
  ["append passList.items [{v: s}]", "passList", append(["passList", "items"], [{ v: "s" }])],
  ["append passList.items [{v: 9}]", "passList", append(["passList", "items"], [{ v: 9 }])],
  ["prepend passList.items [{v: s}]", "passList", prepend(["passList", "items"], [{ v: "s" }])],
  ["prepend passList.items [{v: 9}]", "passList", prepend(["passList", "items"], [{ v: 9 }])],
  ["add pass.inner.v 1", "pass", add(["pass", "inner", "v"], 1)],
  ["subtract pass.inner.v 1", "pass", sub(["pass", "inner", "v"], 1)],
  ["add bag.s {q}", "bag", add(["bag", "s"], new Set(["q"]))],
  ["delete bag.s {p}", "bag", del(["bag", "s"], new Set(["p"]))],
  ["remove pass.inner.v", "pass", remove(["pass", "inner", "v"])],
  ["remove opt.z", "opt", remove(["opt", "z"])],
  ["remove over.y", "over", remove(["over", "y"])],
  ["cls.x = n", "cls", set(["cls", "x"], "n")],
  ["optn.o = n", "optn", set(["optn", "o"], "n")],
  [
    "pass.kind = a, pass.inner.v = 7",
    "pass",
    all(set(["pass", "kind"], "a"), set(["pass", "inner", "v"], 7)),
  ],
  [
    "pass.kind = a, pass.inner = {v: 7}",
    "pass",
    all(set(["pass", "kind"], "a"), set(["pass", "inner"], { v: 7 })),
  ],
  [
    "pass2.inner.v = 7, pass2.s = x",
    "pass2",
    all(set(["pass2", "inner", "v"], 7), set(["pass2", "s"], "x")),
  ],
  [
    "passList.kind = a, passList.items = [{v: 1}]",
    "passList",
    all(set(["passList", "kind"], "a"), set(["passList", "items"], [{ v: 1 }])),
  ],
  [
    "two.kind = a, two.g = {kind: a, x: s}",
    "two",
    all(set(["two", "kind"], "a"), set(["two", "g"], { kind: "a", x: "s" })),
  ],
  [
    "outer.mode = a, outer.g.kind = a, outer.g.y = 2",
    "outer",
    all(set(["outer", "mode"], "a"), set(["outer", "g", "kind"], "a"), set(["outer", "g", "y"], 2)),
  ],
  [
    "outer2.mode = a, outer2.g.kind = a, outer2.g.y = 2",
    "outer2",
    all(
      set(["outer2", "mode"], "a"),
      set(["outer2", "g", "kind"], "a"),
      set(["outer2", "g", "y"], 2),
    ),
  ],
  [
    "opt.kind = a, opt.y = 2, remove opt.z",
    "opt",
    all(set(["opt", "kind"], "a"), set(["opt", "y"], 2), remove(["opt", "z"])),
  ],
  [
    "opt.kind = a, opt.y = 2, opt.z = zz",
    "opt",
    all(set(["opt", "kind"], "a"), set(["opt", "y"], 2), set(["opt", "z"], "zz")),
  ],
  ["over.kind = a, over.y = s", "over", all(set(["over", "kind"], "a"), set(["over", "y"], "s"))],
  [
    "list[0].kind = a, list[0].y = 2",
    "list",
    all(set(["list", 0, "kind"], "a"), set(["list", 0, "y"], 2)),
  ],
  [
    "rec.k.kind = a, rec.k.y = 2",
    "rec",
    all(set(["rec", "k", "kind"], "a"), set(["rec", "k", "y"], 2)),
  ],
  ["wide.v = 5", "wide", set(["wide", "v"], 5)],
  [
    "two.g.kind = a, two.g.y = 2, two.kind = a",
    "two",
    all(set(["two", "g", "kind"], "a"), set(["two", "g", "y"], 2), set(["two", "kind"], "a")),
  ],
  ["optn.kind = a, optn.o = n", "optn", all(set(["optn", "kind"], "a"), set(["optn", "o"], "n"))],
  [
    "pass.kind = a, pass.inner.v = 7, ifNotExists pass.inner.w",
    "pass",
    all(
      set(["pass", "kind"], "a"),
      set(["pass", "inner", "v"], 7),
      ifne(["pass", "inner", "w"], 1),
    ),
  ],
]

/**
 * A write 1.40.0 refused that is now sent, as the update writes every property of the member it
 * writes into, at every union its paths pass: the case 1.40.0 sent for the same paths with the
 * first member's values (`twin`), the values the requests hold in place of the twin's, and what
 * the field reads back as on each row.
 */
type PassedSent = {
  readonly twin: string
  readonly values: Record<string, unknown>
  readonly reads: Record<"a" | "b", unknown>
}
const same = (value: unknown): Record<"a" | "b", unknown> => ({ a: value, b: value })
const passedSent: Record<string, PassedSent> = {
  "optn.kind = b, optn.o = 2": {
    twin: "optn.kind = a, optn.o = n",
    values: { ":ps2": b, ":ps5": { N: "2" } },
    reads: same({ kind: "b", o: 2 }),
  },
  "pass.kind = b, pass.inner.v = str, ifNotExists pass.inner.w": {
    twin: "pass.kind = a, pass.inner.v = 7, ifNotExists pass.inner.w",
    values: { ":ps2": b, ":ps6": { S: "str" } },
    reads: same({ kind: "b", inner: { v: "str" } }),
  },
  "pass.kind = b, pass.inner.v = str": {
    twin: "pass.kind = a, pass.inner.v = 7",
    values: { ":ps2": b, ":ps6": { S: "str" } },
    reads: same({ kind: "b", inner: { v: "str" } }),
  },
  "pass.kind = b, pass.inner = {v: str}": {
    twin: "pass.kind = a, pass.inner = {v: 7}",
    values: { ":ps2": b, ":ps5": { M: { v: { S: "str" } } } },
    reads: same({ kind: "b", inner: { v: "str" } }),
  },
  "pass2.inner.v = str, pass2.s = x": {
    twin: "pass2.inner.v = 7, pass2.s = x",
    values: { ":ps3": { S: "str" } },
    reads: same({ inner: { v: "str" }, s: "x" }),
  },
  "passList.kind = b, passList.items = [{v: s}]": {
    twin: "passList.kind = a, passList.items = [{v: 1}]",
    values: { ":ps2": b, ":ps5": { L: [{ M: { v: { S: "s" } } }] } },
    reads: same({ kind: "b", items: [{ v: "s" }] }),
  },
  "two.kind = b, two.g = {kind: b, y: str}": {
    twin: "two.kind = a, two.g = {kind: a, x: s}",
    values: { ":ps2": b, ":ps5": { M: { kind: b, y: { S: "str" } } } },
    reads: same({ kind: "b", g: { kind: "b", y: "str" } }),
  },
  "outer.mode = b, outer.g.kind = b, outer.g.y = 2": {
    twin: "outer.mode = a, outer.g.kind = a, outer.g.y = 2",
    values: { ":ps2": b, ":ps6": b },
    reads: same({ mode: "b", g: { kind: "b", y: 2 } }),
  },
  "outer2.mode = b, outer2.g.kind = b, outer2.g.y = 2": {
    twin: "outer2.mode = a, outer2.g.kind = a, outer2.g.y = 2",
    values: { ":ps2": b, ":ps6": b },
    reads: same({ mode: "b", g: { kind: "b", y: 2 } }),
  },
  "opt.kind = b, opt.y = 2, remove opt.z": {
    twin: "opt.kind = a, opt.y = 2, remove opt.z",
    values: { ":ps2": b },
    reads: same({ kind: "b", y: 2 }),
  },
  "opt.kind = b, opt.y = 2, opt.z = 3": {
    twin: "opt.kind = a, opt.y = 2, opt.z = zz",
    values: { ":ps2": b, ":ps8": { N: "3" } },
    reads: same({ kind: "b", y: 2, z: 3 }),
  },
  "over.kind = b, over.y = 2": {
    twin: "over.kind = a, over.y = s",
    values: { ":ps2": b, ":ps5": { N: "2" } },
    reads: same({ kind: "b", y: 2 }),
  },
  "list[0].kind = b, list[0].y = 2": {
    twin: "list[0].kind = a, list[0].y = 2",
    values: { ":ps2": b },
    reads: same([{ kind: "b", y: 2 }]),
  },
  "rec.k.kind = b, rec.k.y = 2": {
    twin: "rec.k.kind = a, rec.k.y = 2",
    values: { ":ps3": b },
    reads: {
      a: { k: { kind: "b", y: 2 }, j: { kind: "a", x: "u" } },
      b: { k: { kind: "b", y: 2 }, j: { kind: "b", y: 2 } },
    },
  },
  "wide.v = tt": { twin: "wide.v = 5", values: { ":ps2": { S: "tt" } }, reads: same({ v: "tt" }) },
  "two.g.kind = b, two.g.y = 2, two.kind = a": {
    twin: "two.g.kind = a, two.g.y = 2, two.kind = a",
    values: { ":ps3": b },
    reads: same({ kind: "a", g: { kind: "b", y: 2 } }),
  },
}

/**
 * A path below a member that renames its keys, which 1.40.0 wrote by the names given — beside
 * what the row held, where no read took them — now written by the names the member stores them
 * under, where every member reads what the update leaves: the requests 1.40.0 sent but for those
 * names (`names`), and what the field reads back as on each row.
 */
type PassedRenamed = {
  readonly names: Record<string, string>
  readonly reads: Record<"a" | "b", unknown>
}
const passedRenamed: Record<string, PassedRenamed> = {
  "renamed.kind = b, renamed.y = 2": {
    names: { "#ps1": "k", "#ps4": "yy" },
    reads: same({ kind: "b", y: 2 }),
  },
  "renamed.y = 2": {
    names: { "#ps1": "yy" },
    reads: { a: { kind: "a", x: "s" }, b: { kind: "b", y: 2 } },
  },
  "renamed.x = n": {
    names: { "#ps1": "xx" },
    reads: { a: { kind: "a", x: "n" }, b: { kind: "b", y: 1 } },
  },
  "renamed.kind = a, renamed.x = n": {
    names: { "#ps1": "k", "#ps4": "xx" },
    reads: same({ kind: "a", x: "n" }),
  },
}

/** Refused before anything is sent, by the operation named; the field reads as seeded. */
const passedRefused: Record<
  string,
  { readonly operation: string; readonly says: string; readonly reads: Record<"a" | "b", unknown> }
> = {
  // 1.40.0 applied it and left a row no read takes: `a` requires `z`, and `b` refuses `kind: "a"`.
  "opt.kind = a, opt.y = 2, remove opt.z": {
    operation: "update.pathSet",
    says:
      'the path operations on "opt" leave a value no member of its union reads: what one of ' +
      "them needs a member to hold, another removes or refuses. Nothing was sent.",
    reads: { a: { kind: "a", z: "zz" }, b: { kind: "b", y: 1, z: 1 } },
  },
}
// 1.40.0 wrote these by the names given, which no read takes; by the names stored, not every member
// reads what they leave.
for (const [label, operation] of [
  ["renamed.kind = b", "update.pathSet"],
  ["renamed.kind = a", "update.pathSet"],
  ["remove renamed.x", "update.pathRemove"],
  ["add renamed.y 1", "update.pathAdd"],
] as const) {
  passedRefused[label] = {
    operation,
    says:
      'the path operations on "renamed" write into its union\'s members by the names they store ' +
      "their keys under, and leave a value not every member reads: write every property of one " +
      'member, or all of "renamed". Nothing was sent.',
    reads: { a: { kind: "a", x: "s" }, b: { kind: "b", y: 1 } },
  }
}

/**
 * A `pathIfNotExists` 1.40.0 refused, by the union's first member, where every row holds its path:
 * such an operand is refused only where it would be stored (#236), so the update is written and
 * DynamoDB keeps the stored value. The update finds the path held by a read of the row (a retained
 * entity's, a transaction's plan) or by its write sent requiring the path, and the field reads as
 * seeded.
 */
const passedKept: Record<string, true> = { "ifNotExists pass.inner.v = str": true }

/**
 * `value` with each entry of an `ExpressionAttributeValues` (`map` = `values`) or
 * `ExpressionAttributeNames` (`names`) map replaced where the map holds it: a retained entity's
 * snapshot `Put`, which holds none of them, is left as it is.
 */
const replacing = (
  value: unknown,
  map: "ExpressionAttributeValues" | "ExpressionAttributeNames",
  entries: Record<string, unknown>,
): unknown => {
  if (Array.isArray(value)) return value.map((entry) => replacing(entry, map, entries))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([name, held]) => [
      name,
      name === map
        ? Object.fromEntries(
            Object.entries(held as object).map(([key, entry]) => [
              key,
              Object.hasOwn(entries, key) ? entries[key] : entry,
            ]),
          )
        : replacing(held, map, entries),
    ]),
  )
}

const PASSED_HOWS = [
  ["Docs", "a", ""],
  ["Docs", "b", ""],
  ["Kept", "a", ""],
  ["Kept", "b", ""],
  ["Docs", "a", " / in a transaction"],
  ["Docs", "b", " / in a transaction"],
  ["Kept", "a", " / in a transaction"],
  ["Kept", "b", " / in a transaction"],
] as const

export const unionPathWritesPassedSuite = (open: OpenTable) => {
  it("captures every case 1.40.0 was asked, and names each change for an update the suite runs", () => {
    const names = passedOps.flatMap(([label]) =>
      PASSED_HOWS.map(([entity, row, how]) => `${label} / ${entity} / row ${row}${how}`),
    )
    expect(names.sort()).toEqual(Object.keys(passedFixture.cases).sort())
    const labels = new Set(passedOps.map(([label]) => label))
    for (const named of [passedSent, passedRenamed, passedRefused, passedKept]) {
      for (const label of Object.keys(named)) expect(labels.has(label)).toBe(true)
    }
    for (const { twin } of Object.values(passedSent)) expect(labels.has(twin)).toBe(true)
  })
  for (const [label, field, op] of passedOps) {
    for (const [entity, row, how] of PASSED_HOWS) {
      const name = `${label} / ${entity} / row ${row}${how}`
      const was = passedFixture.cases[name]!
      const fixed = passedSent[label]
      const renamedNow = passedRenamed[label]
      const refusedNow = passedRefused[label]
      const keptNow = Object.hasOwn(passedKept, label)
      it.effect(
        fixed !== undefined
          ? `${name}: sent as 1.40.0 sent ${fixed.twin}, where it refused it`
          : renamedNow !== undefined
            ? `${name}: written by the names the member stores, where 1.40.0 wrote the names given`
            : refusedNow !== undefined
              ? `${name}: refused, nothing sent`
              : keptNow
                ? `${name}: kept where present, where 1.40.0 refused it`
                : `${name}: as 1.40.0`,
        () =>
          Effect.gen(function* () {
            const log: Array<unknown> = []
            let refusal: { operation: string; cause: string } | undefined
            let before: unknown
            const bound = (db: any) => db.entities[`${entity}_${field}`]
            const head = yield* onTable(
              recordingRequests(open, log),
              0,
              PassedTable,
              { entities: passedEntities },
              (db, table) =>
                Effect.gen(function* () {
                  for (const id of ["a", "b"] as const) {
                    yield* bound(db)
                      .put({ id, [field]: passedRows(id)[field] })
                      .asEffect()
                  }
                  before = rowsOf(yield* table.rows)
                  log.length = 0
                  const update = op(bound(db).update({ id: row }))
                  const exit = yield* Effect.exit(
                    Effect.tapError(
                      how === "" ? update.asEffect() : Lib.Transaction.transactWrite([update]),
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
                    yield* Effect.exit(bound(db).get({ id: row }) as Effect.Effect<unknown>),
                  )
                  return { outcome: outcomeOf(exit), sent: sentNow, rows, read }
                }),
            )
            const withRefusal = { ...head, ...(refusal === undefined ? {} : { refusal }) }
            if (
              fixed === undefined &&
              renamedNow === undefined &&
              refusedNow === undefined &&
              !keptNow
            ) {
              expect(withRefusal).toEqual(was)
              return
            }
            if (refusedNow !== undefined) {
              // Nothing sent, nothing written: the row reads as seeded.
              expect(head.sent).toEqual([])
              expect(head.outcome).toEqual({
                fail: "ValidationError",
                says: refusedNow.says.slice(0, 200),
              })
              expect(refusal).toEqual({ operation: refusedNow.operation, cause: refusedNow.says })
              expect(head.rows).toEqual(before)
              expect(head.read).toEqual({
                ok: {
                  id: row,
                  [field]: refusedNow.reads[row],
                  ...(entity === "Kept" ? { version: 1 } : {}),
                },
              })
              return
            }
            // The version a write moves the retained entity to.
            const version = (read: any) =>
              entity === "Kept" ? { version: (read.ok.version as number) + 1 } : {}
            if (keptNow) {
              // 1.40.0 refused it, sending nothing.
              expect(was.sent).toEqual([])
              expect(was.outcome.fail).toBe("ValidationError")
              // The path is found held by a read before the write, or by the write requiring it.
              const sent = head.sent as ReadonlyArray<any>
              const firstWrite = sent.findIndex((request) => Object.keys(request)[0] !== "getItem")
              expect(firstWrite).toBeGreaterThanOrEqual(0)
              const readFirst = firstWrite > 0 && Object.keys(sent[firstWrite - 1])[0] === "getItem"
              const required = /attribute_exists\(#fb\d+(\.#fb\d+)*\)/.test(
                String(sent[firstWrite]?.updateItem?.ConditionExpression),
              )
              expect(readFirst || required).toBe(true)
              const reads = { ...was.read.ok, ...version(was.read) }
              expect(head.outcome).toEqual(how === "" ? { ok: reads } : { ok: null })
              expect(head.read).toEqual({ ok: reads })
              return
            }
            if (fixed !== undefined) {
              // The twin's requests, but for the values 1.40.0 refused, and the row reads back.
              const twin = passedFixture.cases[`${fixed.twin} / ${entity} / row ${row}${how}`]!
              expect(head.sent).toEqual(
                replacing(twin.sent, "ExpressionAttributeValues", fixed.values),
              )
              const reads = { ...was.read.ok, [field]: fixed.reads[row], ...version(was.read) }
              expect(head.outcome).toEqual(how === "" ? { ok: reads } : { ok: null })
              expect(head.read).toEqual({ ok: reads })
              return
            }
            // 1.40.0's requests, but for the names; the row reads what was written.
            expect(head.sent).toEqual(
              replacing(was.sent, "ExpressionAttributeNames", renamedNow!.names),
            )
            const reads = { ...was.read.ok, [field]: renamedNow!.reads[row] }
            expect(head.outcome).toEqual(how === "" ? { ok: reads } : { ok: null })
            expect(head.read).toEqual({ ok: reads })
          }),
      )
    }
  }
}
