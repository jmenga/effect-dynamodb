/**
 * Paths below structs that rename their keys as they're stored (`Schema.encodeKeys`), spelled by
 * the names they're stored under and by their own (#238): path operations, conditions, filters and
 * selects.
 *
 * `fixtures/nested-key-encodings-1.40.0.json` holds what the published 1.40.0 did. A path spelled
 * by stored names (`meta.am`, `outer.in.dp`, and `swap.a` where `encodeKeys({ a: "b", b: "a" })`
 * stores property `b` under `a`) sends what 1.40.0 sent. A path spelled by a property's own name
 * (`meta.amount`), which 1.40.0 sent as written, naming an attribute no row holds, now sends what
 * its stored spelling sent on 1.40.0 (`twinOf`), and a select of it hands the value back under the
 * names it was selected by. A path through a union whose members name it differently
 * (`either.amount`) is sent as written, as before.
 *
 * A removal of a required property, by either name, is refused, nothing sent: 1.40.0 removed it
 * (by its stored name; by its own name it removed nothing) and left a row no read takes.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as Lib from "../../src/index.js"
import { type OpenTable, onTable, type Row, recordingRequests } from "./Kept139.js"

export interface Captured {
  readonly outcome: unknown
  readonly sent: ReadonlyArray<Record<string, unknown>>
  readonly row: Row | null
  readonly read: unknown
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/nested-key-encodings-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, Captured> }

const Amount = Schema.Struct({
  amount: Schema.Number,
  note: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
}).pipe(Schema.encodeKeys({ amount: "am", tags: "tg" }))
const Swap = Schema.Struct({ a: Schema.Number, b: Schema.Number }).pipe(
  Schema.encodeKeys({ a: "b", b: "a" }),
)
const Deep = Schema.Struct({ deep: Schema.Number }).pipe(Schema.encodeKeys({ deep: "dp" }))
const Outer = Schema.Struct({ inner: Deep, list: Schema.Array(Deep) }).pipe(
  Schema.encodeKeys({ inner: "in" }),
)
const Other = Schema.Struct({ amount: Schema.Number, kind: Schema.Literal("other") })
const model = () =>
  Lib.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      meta: Amount,
      swap: Swap,
      outer: Outer,
      maybe: Schema.optional(Schema.NullOr(Amount)),
      recs: Schema.Record(Schema.String, Deep),
      either: Schema.Union([Amount, Other]),
      counts: Schema.Record(Schema.String, Deep),
    }),
    {
      outer: { field: "ot" },
      counts: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "c" }) },
    },
  )
const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const
const Plain = Lib.Entity.make({ model: model(), entityType: "Plain", primaryKey })
const Retained = Lib.Entity.make({
  model: model(),
  entityType: "Retained",
  primaryKey,
  versioned: { retain: true },
})
const entities = { Plain, Retained }
const MainTable = Lib.Table.make({
  schema: Lib.DynamoSchema.make({ name: "nk", version: 1 }),
  entities,
})

const SEED = {
  id: "a",
  meta: { amount: 5, note: "n", tags: ["t"] },
  swap: { a: 1, b: 2 },
  outer: { inner: { deep: 3 }, list: [{ deep: 4 }, { deep: 6 }] },
  maybe: { amount: 7 },
  recs: { k: { deep: 8 } },
  either: { amount: 9 },
  counts: { k: { deep: 10 } },
}

type Segments = ReadonlyArray<string | number>
type How = "alone" | "in a transaction" | "read"
type Scenario = readonly [
  entity: keyof typeof entities,
  how: How,
  run: (db: any) => Effect.Effect<unknown, unknown, any>,
]

/** Segments `.entry("k")` built on `counts`, and below it. */
const entryPath = (...rest: ReadonlyArray<string>): Segments => {
  const built = (
    Lib.createPathBuilder([], undefined, { counts: { prefix: "c" } }) as any
  ).counts.entry("k")
  return rest.reduce((path: any, segment) => path[segment], built).segments
}

const scenarios: Record<string, Scenario> = {}
const write = (name: string, op: (update: any) => any) => {
  for (const E of ["Plain", "Retained"] as const) {
    scenarios[`${name} / ${E} / alone`] = [
      E,
      "alone",
      (db) => op(db.entities[E].update({ id: "a" })).asEffect(),
    ]
  }
  scenarios[`${name} / Plain / in a transaction`] = [
    "Plain",
    "in a transaction",
    (db) => Lib.Transaction.transactWrite([op(db.entities.Plain.update({ id: "a" }))]),
  ]
}
const set = (segments: Segments, value: unknown) => (u: any) =>
  u.pathSet({ segments, value, isPath: false })
for (const leaf of ["am", "amount"]) {
  write(`pathSet meta.${leaf}`, set(["meta", leaf], 11))
  write(`pathAdd meta.${leaf}`, (u) => u.pathAdd({ segments: ["meta", leaf], value: 1 }))
  write(`pathSubtract meta.${leaf}`, (u) =>
    u.pathSubtract({ segments: ["meta", leaf], value: 1, isPath: false }),
  )
}
for (const leaf of ["tg", "tags"]) {
  write(`pathRemove meta.${leaf}`, (u) => u.pathRemove(["meta", leaf]))
  write(`pathAppend meta.${leaf}`, (u) => u.pathAppend({ segments: ["meta", leaf], value: ["u"] }))
  write(`pathIfNotExists meta.${leaf}`, (u) =>
    u.pathIfNotExists({ segments: ["meta", leaf], value: ["u"] }),
  )
}
write("pathRemove meta.am", (u) => u.pathRemove(["meta", "am"]))
write("pathRemove meta.amount", (u) => u.pathRemove(["meta", "amount"]))
write("pathRemove swap.a", (u) => u.pathRemove(["swap", "a"]))
write("pathSet swap.a", set(["swap", "a"], 12))
write("pathSet swap.b", set(["swap", "b"], 12))
write("pathSet outer.in.dp", set(["outer", "in", "dp"], 13))
write("pathSet outer.inner.deep", set(["outer", "inner", "deep"], 13))
write("pathSet outer.list[1].dp", set(["outer", "list", 1, "dp"], 14))
write("pathSet outer.list[1].deep", set(["outer", "list", 1, "deep"], 14))
write("pathSet recs.k.dp", set(["recs", "k", "dp"], 15))
write("pathSet recs.k.deep", set(["recs", "k", "deep"], 15))
write("pathSet maybe.am", set(["maybe", "am"], 16))
write("pathSet maybe.amount", set(["maybe", "amount"], 16))
write("pathSet either.am", set(["either", "am"], 17))
write("pathSet either.amount", set(["either", "amount"], 17))
write("pathSet of a copy, meta.am from outer.in.dp", (u) =>
  u.pathSet({
    segments: ["meta", "am"],
    value: undefined,
    isPath: true,
    valueSegments: ["outer", "in", "dp"],
  }),
)
write("pathSet of a copy, meta.amount from outer.inner.deep", (u) =>
  u.pathSet({
    segments: ["meta", "amount"],
    value: undefined,
    isPath: true,
    valueSegments: ["outer", "inner", "deep"],
  }),
)
write("pathSet of the entry .entry() built, .dp", (u) =>
  u.pathSet({ segments: entryPath("dp"), value: 18, isPath: false }),
)
write("pathSet of the entry .entry() built, .deep", (u) =>
  u.pathSet({ segments: entryPath("deep"), value: 18, isPath: false }),
)
const guarded = (name: string, condition: (t: any, ops: any) => unknown) =>
  write(`a condition on ${name}`, (u) =>
    u.pathSet({ segments: ["meta", "note"], value: "m", isPath: false }).condition(condition),
  )
guarded("meta.am = 5", (t, { eq }) => eq(t.meta.am, 5))
guarded("meta.amount = 5", (t, { eq }) => eq(t.meta.amount, 5))
guarded("size(meta.tg) = 1", (t, { eq }) => eq(t.meta.tg.size(), 1))
guarded("size(meta.tags) = 1", (t, { eq }) => eq(t.meta.tags.size(), 1))
guarded("swap.a = 2", (t, { eq }) => eq(t.swap.a, 2))
guarded("outer.list[0].dp = 4", (t, { eq }) => eq(t.outer.list.at(0).dp, 4))
guarded("outer.list[0].deep = 4", (t, { eq }) => eq(t.outer.list.at(0).deep, 4))
guarded("counts.entry(k).dp = 10", (t, { eq }) => eq(t.counts.entry("k").dp, 10))
guarded("counts.entry(k).deep = 10", (t, { eq }) => eq(t.counts.entry("k").deep, 10))
for (const leaf of ["am", "amount"]) {
  scenarios[`a delete's condition on meta.${leaf} = 5 / Plain / alone`] = [
    "Plain",
    "alone",
    (db) =>
      db.entities.Plain.delete({ id: "a" })
        .condition((t: any, { eq }: any) => eq(t.meta[leaf], 5))
        .asEffect(),
  ]
}
const read = (name: string, query: (q: any) => any) => {
  scenarios[`${name} / Plain / read`] = [
    "Plain",
    "read",
    (db) => query(db.entities.Plain.scan()).collect(),
  ]
}
read("a filter on meta.am = 5", (q) => q.filter((t: any, { eq }: any) => eq(t.meta.am, 5)))
read("a filter on meta.amount = 5", (q) => q.filter((t: any, { eq }: any) => eq(t.meta.amount, 5)))
read("a filter on outer.in.dp = 3", (q) => q.filter((t: any, { eq }: any) => eq(t.outer.in.dp, 3)))
read("a filter on outer.inner.deep = 3", (q) =>
  q.filter((t: any, { eq }: any) => eq(t.outer.inner.deep, 3)),
)
read("a filter on swap.a = 2", (q) => q.filter((t: any, { eq }: any) => eq(t.swap.a, 2)))
read("a select of meta.am", (q) => q.select((t: any) => [t.meta.am]))
read("a select of meta.amount", (q) => q.select((t: any) => [t.meta.amount]))
read("a select of outer.in.dp and outer.list[1].dp", (q) =>
  q.select((t: any) => [t.outer.in.dp, t.outer.list.at(1).dp]),
)
read("a select of outer.inner.deep and outer.list[1].deep", (q) =>
  q.select((t: any) => [t.outer.inner.deep, t.outer.list.at(1).deep]),
)
read("a select of swap.a", (q) => q.select((t: any) => [t.swap.a]))
read("a select of recs.k.dp", (q) => q.select((t: any) => [t.recs.k.dp]))
read("a select of recs.k.deep", (q) => q.select((t: any) => [t.recs.k.deep]))
read("a select of meta.am and meta.note", (q) => q.select((t: any) => [t.meta.am, t.meta.note]))
read("a select of meta.amount and meta.note", (q) =>
  q.select((t: any) => [t.meta.amount, t.meta.note]),
)

/** A property's own name, and the name it's stored under, as the case names spell them. */
const SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ["meta.amount", "meta.am"],
  ["meta.tags", "meta.tg"],
  ["outer.inner.deep", "outer.in.dp"],
  ["outer.list[1].deep", "outer.list[1].dp"],
  ["outer.list[0].deep", "outer.list[0].dp"],
  ["recs.k.deep", "recs.k.dp"],
  ["maybe.amount", "maybe.am"],
  ["counts.entry(k).deep", "counts.entry(k).dp"],
  [".entry() built, .deep", ".entry() built, .dp"],
]

/**
 * The case spelled by stored names that a case spelled by a property's own name now does, or
 * `undefined` for a case that does what 1.40.0 did. `either` holds `amount` in one member and
 * stores it as `am` in the other: sent as written, as before.
 */
export const twinOf = (name: string): string | undefined => {
  if (name.includes("either.")) return undefined
  let twin = name
  for (const [own, stored] of SPELLINGS) twin = twin.replaceAll(own, stored)
  return twin === name ? undefined : twin
}

/** A select spelled by a property's own name: the value, under the names it was selected by. */
const SELECTED: Record<string, unknown> = {
  "a select of meta.amount / Plain / read": { ok: [{ meta: { amount: 5 } }] },
  "a select of outer.inner.deep and outer.list[1].deep / Plain / read": {
    ok: [{ outer: { list: [{ deep: 6 }], inner: { deep: 3 } } }],
  },
  "a select of recs.k.deep / Plain / read": { ok: [{ recs: { k: { deep: 8 } } }] },
  "a select of meta.amount and meta.note / Plain / read": {
    ok: [{ meta: { amount: 5, note: "n" } }],
  },
}

/** A removal of a required property, by either name: refused, nothing sent. */
const REFUSED = new Map([
  ["pathRemove meta.am", "meta.am"],
  ["pathRemove meta.amount", "meta.amount"],
  ["pathRemove swap.a", "swap.a"],
])

/** Why a refused case is refused: its `ValidationError`'s cause. */
export const refusal = (name: string): RegExp | undefined => {
  const refused = REFUSED.get(name.split(" / ")[0]!)
  return refused === undefined
    ? undefined
    : new RegExp(`"${refused.replace(".", "\\.")}": the model requires it`)
}

/** What the head does. */
export const expected = (name: string): Captured => {
  const [op, entity, how] = name.split(" / ") as [string, string, string]
  if (REFUSED.has(op)) {
    // The row as seeded: a condition on a note write that didn't hold left it as it was.
    const untouched = fixture.cases[`a condition on meta.amount = 5 / ${entity} / ${how}`]!
    return {
      outcome: { fail: "ValidationError", says: "" },
      sent: [],
      row: untouched.row,
      read: untouched.read,
    }
  }
  const twin = twinOf(name)
  const captured = fixture.cases[twin ?? name]!
  return Object.hasOwn(SELECTED, name) ? { ...captured, outcome: SELECTED[name] } : captured
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
  "FilterExpression",
  "ProjectionExpression",
  "ExpressionAttributeNames",
  "ExpressionAttributeValues",
] as const
const partsOf = (input: Record<string, unknown>) =>
  Object.fromEntries(PARTS.filter((part) => input[part] !== undefined).map((p) => [p, input[p]]))

/** The expression parts of a request, a transaction's per item; reads leave out GetItem and Query. */
const sentOf = (request: unknown): Record<string, unknown> | undefined => {
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

const rowOf = (rows: ReadonlyArray<Row>, entity: string): Row | null => {
  const row = rows.find(
    (r) =>
      r.pk?.S === `$nk#v1#${entity.toLowerCase()}#id_a` &&
      r.sk?.S === `$nk#v1#${entity.toLowerCase()}`,
  )
  if (row === undefined) return null
  return normal(
    Object.fromEntries(
      Object.keys(row)
        .sort()
        .filter((name) => name !== "createdAt" && name !== "updatedAt")
        .map((name) => [name, row[name]]),
    ),
  )
}

/** Each scenario on a table of its own: the outcome, what it sent, the row and its read. */
export const nestedKeyEncodingsSuite = (open: OpenTable) => {
  for (const [name, [entity, , run]] of Object.entries(scenarios)) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const log: Array<unknown> = []
        const got = yield* onTable(
          recordingRequests(open, log),
          0,
          MainTable,
          { entities },
          (db, table) =>
            Effect.gen(function* () {
              yield* db.entities[entity].put(SEED).asEffect()
              log.length = 0
              const exit = yield* Effect.exit(Effect.suspend(() => run(db)))
              const why = Exit.isFailure(exit)
                ? String((Cause.squash(exit.cause) as any)?.cause)
                : undefined
              const sent = log.flatMap((request) => {
                const parts = sentOf(request)
                return parts === undefined ? [] : [parts]
              })
              const row = rowOf(yield* table.rows, entity)
              const back = yield* Effect.exit(db.entities[entity].get({ id: "a" }))
              return {
                outcome: outcomeOf(exit),
                why,
                sent,
                row,
                read: Exit.isSuccess(back)
                  ? normal(back.value)
                  : { fail: String((Cause.squash(back.cause) as any)?._tag) },
              }
            }),
        )
        const want = expected(name)
        expect(got.sent).toEqual(want.sent)
        expect(got.row).toEqual(want.row)
        expect(got.read).toEqual(want.read)
        expect(got.outcome).toEqual(want.outcome)
        const says = refusal(name)
        if (says !== undefined) expect(got.why).toMatch(says)
      }),
    )
  }
}

// ---------------------------------------------------------------------------
// A collection whose members store a path differently
// ---------------------------------------------------------------------------

/**
 * `Ones` stores `meta.amount` as `meta.am`; `Twos` holds a `meta` that renames nothing, so it
 * stores `meta.amount` as `meta.amount`. A collection names each member's rows by that member's
 * names: a filter or select of `meta.amount` reads `meta.am` on a `Ones` row and `meta.amount` on a
 * `Twos` row, and hands both back as `meta.amount`. 1.40.0 named `meta.amount` on both, which no
 * `Ones` row holds. A stored spelling (`meta.am`) is sent as written on both members and handed
 * back as written, as before: `Twos` has no property `am`, so the walk leaves it alone.
 */
const byGroup = {
  name: "gsi1",
  collection: "group",
  pk: { field: "gsi1pk", composite: ["group"] },
  sk: { field: "gsi1sk", composite: ["id"] },
} as const
const Ones = Lib.Entity.make({
  model: Schema.Struct({ id: Schema.String, group: Schema.String, meta: Amount }),
  entityType: "One",
  primaryKey,
  indexes: { byGroup },
})
const Twos = Lib.Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    group: Schema.String,
    meta: Schema.Struct({ amount: Schema.Number, note: Schema.optional(Schema.String) }),
  }),
  entityType: "Two",
  primaryKey,
  indexes: { byGroup },
})
const grouped = { Ones, Twos }
const GroupTable = Lib.Table.make({
  schema: Lib.DynamoSchema.make({ name: "nk", version: 1 }),
  entities: grouped,
})

const COLLECTED: ReadonlyArray<
  readonly [name: string, run: (group: any) => any, outcome: Record<string, unknown>]
> = [
  [
    "a filter on meta.amount = 5 reads each member's own attribute",
    (group) => group.filter((t: any, { eq }: any) => eq(t.meta.amount, 5)),
    {
      Ones: [{ id: "1", group: "g", meta: { amount: 5, note: "n" } }],
      Twos: [{ id: "2", group: "g", meta: { amount: 5, note: "o" } }],
    },
  ],
  [
    "a filter on meta.am = 5 is sent as written",
    (group) => group.filter((t: any, { eq }: any) => eq(t.meta.am, 5)),
    { Ones: [{ id: "1", group: "g", meta: { amount: 5, note: "n" } }], Twos: [] },
  ],
  [
    "a select of meta.amount reads each member's own attribute",
    (group) => group.select((t: any) => [t.meta.amount]),
    { Ones: [{ meta: { amount: 5 } }], Twos: [{ meta: { amount: 5 } }] },
  ],
  [
    "a select of meta.am and meta.note is sent as written",
    (group) => group.select((t: any) => [t.meta.am, t.meta.note]),
    { Ones: [{ meta: { am: 5, note: "n" } }], Twos: [{ meta: { note: "o" } }] },
  ],
]

/** Each collection read on a table of its own: what it returns. */
export const nestedKeyCollectionSuite = (open: OpenTable) => {
  for (const [name, run, outcome] of COLLECTED) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const got = yield* onTable(open, 0, GroupTable, { entities: grouped }, (db) =>
          Effect.gen(function* () {
            yield* db.entities.Ones.put({
              id: "1",
              group: "g",
              meta: { amount: 5, note: "n" },
            }).asEffect()
            yield* db.entities.Twos.put({
              id: "2",
              group: "g",
              meta: { amount: 5, note: "o" },
            }).asEffect()
            return yield* run(db.collections.group({ group: "g" })).collect()
          }),
        )
        expect(normal(got)).toEqual(outcome)
      }),
    )
  }
}
