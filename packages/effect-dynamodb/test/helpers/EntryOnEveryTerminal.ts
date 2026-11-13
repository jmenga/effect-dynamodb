/**
 * `.entry(key)` resolves the same way on every terminal that takes a path callback (#238). Through
 * 1.40.0 only an entity's own builder and a bound write's `.condition()` knew the model's sparse
 * maps: a query accessor's, `scan()`'s, `.history()`'s, `versions()`'s, `deleted.list()`'s and a
 * collection's callbacks threw "field … is not configured as a sparse map" on a map that is. Every
 * callback's builder is now `pathBuilderOf(models)`, so one table of sparse maps answers each.
 *
 * Each terminal filters (or conditions) on one entry of an unrenamed map (`zones`, prefix `z`), of
 * a map a `field:` rename stores whole (`marks`, prefix `m`, stored as `mk`), and of a map of
 * structs whose keys are renamed as stored (`deeps.entry("k").deep`, stored `d#k.dp`), under both
 * `escapeKeys`. Its expression is the query accessor's, as resolved names and values (placeholders
 * are numbered per request), and it returns the rows that accessor returns. On the unrenamed map
 * `.entry("east")` sends the request naming the attribute (`t["z#east"]`) sends.
 *
 * Two lookups that read a name as an inherited property, also through 1.40.0: `.entry()` on a
 * nested field named like a sparse map (`t.inner.zones`) baked the map's prefix into the nested
 * path (`inner.z#east`, which no row holds), and a field named like an `Object.prototype` member
 * (`valueOf`, `constructor`) beside a sparse map was taken for a sparse map whose prefix is
 * `undefined`: `.entry()` built `undefined#k`, and an update of the field wrote the attribute
 * `undefined#a` and returned the old value. Both now name only what they are: `.entry()` refuses
 * the nested field and the plain one, and the update writes the field. `fixtures/entry-terminals-
 * 1.40.0.json` holds what 1.40.0 did for each.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as Lib from "../../src/index.js"
import { type OpenTable, onTable, recordingRequests, sortedRows } from "./Kept139.js"
import { comparedCases, expectDiffersOnly } from "./WholeDiff.js"

const Deep = Schema.Struct({ deep: Schema.Number }).pipe(Schema.encodeKeys({ deep: "dp" }))
const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const
const byGroup = {
  name: "gsi1",
  collection: "zc",
  pk: { field: "gsi1pk", composite: ["group"] },
  sk: { field: "gsi1sk", composite: ["id"] },
} as const
const logFields = Schema.Struct({
  id: Schema.String,
  at: Schema.Number,
  zones: Schema.Record(Schema.String, Schema.String),
})
/** A sparse map is the current item's state, outside `appendInput` (DESIGN "timeSeries"). */
const logAppend = Schema.Struct({ id: Schema.String, at: Schema.Number })

const define = (escapeKeys: boolean) => {
  const Zones = Lib.Entity.make({
    model: Lib.DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        group: Schema.String,
        note: Schema.String,
        zones: Schema.Record(Schema.String, Schema.String),
        marks: Schema.Record(Schema.String, Schema.Number),
        deeps: Schema.Record(Schema.String, Deep),
        inner: Schema.optionalKey(
          Schema.Struct({ zones: Schema.Record(Schema.String, Schema.String) }),
        ),
      }),
      {
        zones: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "z" }) },
        marks: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "m" }), field: "mk" },
        deeps: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "d" }) },
      },
    ),
    entityType: "Zone",
    primaryKey,
    indexes: { byGroup },
    versioned: { retain: true },
    softDelete: true,
  })
  const Plains = Lib.Entity.make({
    model: Schema.Struct({ id: Schema.String, group: Schema.String, note: Schema.String }),
    entityType: "Plain",
    primaryKey,
    indexes: { byGroup },
  })
  const Logs = Lib.Entity.make({
    model: Lib.DynamoModel.configure(logFields, {
      zones: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "z" }) },
    }),
    entityType: "Log",
    primaryKey,
    timeSeries: { orderBy: "at", appendInput: logAppend },
  })
  const Protos = Lib.Entity.make({
    model: Lib.DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        zones: Schema.Record(Schema.String, Schema.Number),
        valueOf: Schema.Struct({ a: Schema.Number }),
        constructor: Schema.Record(Schema.String, Schema.Number),
      }),
      // A literal's own `valueOf` (inherited) is checked against the field's options: cast.
      { zones: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "z" }) } } as never,
    ),
    entityType: "Proto",
    primaryKey,
  })
  const entities = { Zones, Plains, Logs, Protos }
  const MainTable = Lib.Table.make({
    schema: Lib.DynamoSchema.make({ name: "et", version: 1, escapeKeys }),
    entities,
  })
  return { entities, MainTable }
}

type Db = any

const zone = (id: string, east: string, a: number, deep: number) => ({
  id,
  group: "g",
  note: id,
  zones: { east },
  marks: { a },
  deeps: { k: { deep } },
})

/** Rows `a` to `d`, each failing the filter on one map but `a`; `p` a member without the maps. */
const seed = (db: Db) =>
  Effect.gen(function* () {
    yield* db.entities.Zones.put({ ...zone("a", "x", 1, 7), inner: { zones: { east: "x" } } })
    yield* db.entities.Zones.put(zone("b", "y", 1, 7))
    yield* db.entities.Zones.put(zone("c", "x", 2, 7))
    yield* db.entities.Zones.put(zone("d", "x", 1, 8))
    yield* db.entities.Plains.put({ id: "p", group: "g", note: "p" })
    yield* db.entities.Logs.append({ id: "h", at: 1 })
    yield* db.entities.Logs.append({ id: "h", at: 2 })
    yield* db.entities.Logs.update({ id: "h" }).set({ zones: { east: "x" } })
    yield* db.entities.Protos.put({
      id: "q",
      zones: { e: 1 },
      valueOf: { a: 2 },
      constructor: { k: 3 },
    })
  })

const all = (t: any, { and, eq }: any) =>
  and(eq(t.zones.entry("east"), "x"), eq(t.marks.entry("a"), 1), eq(t.deeps.entry("k").deep, 7))
const zonesOnly = (t: any, { eq }: any) => eq(t.zones.entry("east"), "x")
const zonesNamed = (t: any, { eq }: any) => eq(t["z#east"], "x")

/** Each expression a request sent, its placeholders replaced by the names and values they stand for. */
const expressionsOf = (log: ReadonlyArray<unknown>): ReadonlyArray<string> =>
  log.flatMap((request) => {
    const [, input] = Object.entries(request as Record<string, any>)[0]!
    const inputs = [
      input,
      ...(input.TransactItems ?? []).map((item: any) => Object.values(item)[0]),
    ]
    return inputs.flatMap((each: any) =>
      [each.FilterExpression, each.ConditionExpression]
        .filter((expression): expression is string => typeof expression === "string")
        .map((expression) => resolved(expression, each)),
    )
  })

const resolved = (
  expression: string,
  input: {
    readonly ExpressionAttributeNames?: Record<string, string>
    readonly ExpressionAttributeValues?: Record<string, AttributeValue>
  },
): string =>
  expression.replace(/[#:][A-Za-z0-9_]+/g, (placeholder) => {
    const names = input.ExpressionAttributeNames ?? {}
    const values = input.ExpressionAttributeValues ?? {}
    if (placeholder.startsWith("#") && Object.hasOwn(names, placeholder))
      return `‹${names[placeholder]}›`
    if (placeholder.startsWith(":") && Object.hasOwn(values, placeholder))
      return JSON.stringify(values[placeholder])
    return placeholder
  })

/** The caller's part of a query accessor's filter: what follows the entity-type clause. */
const callersPart = (expression: string): string => {
  const match = /^‹__edd_e__› IN \(\{"S":"[A-Za-z]+"\}\) AND \((.*)\)$/.exec(expression)
  if (match === null) throw new Error(`not a query accessor's filter: ${expression}`)
  return match[1]!
}

/** A step's outcome: the ids it returned (per member for a collection), or its failure. */
const outcomeOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) {
    const ids = (items: unknown) =>
      Array.isArray(items)
        ? items
            .map((item: any) => (item.at !== undefined ? `${item.id}@${item.at}` : item.id))
            .sort()
        : items
    const value = exit.value as any
    if (Array.isArray(value)) return { ok: ids(value) }
    if (value !== null && typeof value === "object" && !("id" in value))
      return { ok: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ids(v)])) }
    return { ok: value?.id ?? null }
  }
  const failure = Cause.findErrorOption(exit.cause)
  if (failure._tag === "Some") return { fail: (failure.value as any)._tag }
  return { die: String(Cause.squash(exit.cause)).slice(0, 160) }
}

interface Terminal {
  readonly name: string
  /** The filter's reference: the query accessor (or scan) it is compared with, by expression. */
  readonly reference?: (db: Db) => Effect.Effect<unknown, unknown>
  readonly run: (
    db: Db,
    entities: ReturnType<typeof define>["entities"],
  ) => Effect.Effect<unknown, unknown>
  readonly outcome: unknown
  /** Runs on a table where `a` and `b` are soft-deleted first. */
  readonly afterDeletes?: true
  /** The paths at which its record differs from 1.40.0's; without them, it is 1.40.0's whole. */
  readonly differs?: ReadonlyArray<string>
}

/** 1.40.0 threw in the callback, before sending anything: its outcome and the request differ. */
const threw = ["outcome.die", "outcome.ok", "requests[0]"]

/** 1.40.0 refused a row the condition holds for (`ConditionalCheckFailed`); the head writes it. */
const wrote = ["outcome.fail", "outcome.ok"]

/** The tombstone a soft delete leaves where the live row was. */
const tombstoned = ["rows[5].gsi1pk", "rows[5].gsi1sk", "rows[5].sk.S", "rows[5].deletedAt"]

/** A write's item in the transaction a retained entity sends (its read first). */
const transactItem = (kind: "Put" | "Update" | "Delete") =>
  `requests[1].transactWriteItems.TransactItems[0].${kind}`

/**
 * The parts of an expression 1.40.0 named wrong: the entry of the map a `field:` rename stores
 * whole (`m#a`, where a row may hold it as `mk.a`), and the struct's key below an entry, stored
 * renamed (`d#k.deep`, stored `d#k.dp`). The unrenamed map's entry (`z#east`) was named right.
 */
const misnamed = (at: string, expression = "ConditionExpression") => [
  `${at}.${expression}`,
  ...["#e2", "#e3", "#e4", "#e5", "#e6", "#e7", "#e9", "#e10"].map(
    (name) => `${at}.ExpressionAttributeNames.${name}`,
  ),
  ...[":e3", ":e5", ":e6", ":e8", ":e11"].map((name) => `${at}.ExpressionAttributeValues.${name}`),
]

const byGroupOf = (db: Db) => db.entities.Zones.byGroup({ group: "g" }).filter(all).collect()
const byGroupZones = (db: Db) =>
  db.entities.Zones.byGroup({ group: "g" }).filter(zonesOnly).collect()
const logsScan = (db: Db) => db.entities.Logs.scan().filter(zonesOnly).collect()

const terminals: ReadonlyArray<Terminal> = [
  { name: "a query accessor", run: (db) => byGroupOf(db), outcome: { ok: ["a"] }, differs: threw },
  {
    name: "scan()",
    reference: byGroupOf,
    run: (db) => db.entities.Zones.scan().filter(all).collect(),
    outcome: { ok: ["a"] },
    differs: threw,
  },
  {
    name: "versions()",
    reference: byGroupOf,
    run: (db) => db.entities.Zones.versions({ id: "a" }).filter(all).collect(),
    outcome: { ok: ["a"] },
    differs: threw,
  },
  {
    name: "versions() of a row the filter refuses",
    reference: byGroupOf,
    run: (db) => db.entities.Zones.versions({ id: "b" }).filter(all).collect(),
    outcome: { ok: [] },
    differs: threw,
  },
  {
    name: "deleted.list()",
    reference: byGroupOf,
    run: (db) => db.entities.Zones.deleted.list({ id: "a" }).filter(all).collect(),
    outcome: { ok: ["a"] },
    differs: threw,
    afterDeletes: true,
  },
  {
    name: "deleted.list() of a row the filter refuses",
    reference: byGroupOf,
    run: (db) => db.entities.Zones.deleted.list({ id: "b" }).filter(all).collect(),
    outcome: { ok: [] },
    differs: threw,
    afterDeletes: true,
  },
  {
    name: "a collection accessor (a member without the maps reads them as absent)",
    reference: byGroupOf,
    run: (db) => db.collections.zc({ group: "g" }).filter(all).collect(),
    outcome: { ok: { Plains: [], Zones: ["a"] } },
    differs: threw,
  },
  {
    name: ".history()",
    reference: logsScan,
    run: (db) => db.entities.Logs.history({ id: "h" }).filter(zonesOnly).collect(),
    // An event item holds no sparse map (DESIGN "timeSeries"): the filter resolves, and matches none.
    outcome: { ok: [] },
    differs: threw,
  },
  {
    name: "a put's .condition()",
    reference: byGroupOf,
    run: (db) =>
      db.entities.Zones.put(zone("a", "x", 1, 7))
        .condition(all)
        .asEffect(),
    outcome: { ok: "a" },
    differs: [...wrote, ...misnamed(transactItem("Put")), "rows[5].inner", "rows[5].version.N"],
  },
  {
    name: "a put's .condition() on a row it refuses",
    reference: byGroupOf,
    run: (db) =>
      db.entities.Zones.put(zone("b", "x", 1, 7))
        .condition(all)
        .asEffect(),
    outcome: { fail: "ConditionalCheckFailed" },
    differs: misnamed(transactItem("Put")),
  },
  {
    name: "an update's .condition()",
    reference: byGroupOf,
    run: (db) => db.entities.Zones.update({ id: "a" }).set({ note: "n" }).condition(all).asEffect(),
    outcome: { ok: "a" },
    differs: [...wrote, ...misnamed(transactItem("Update")), "rows[5].note.S", "rows[5].version.N"],
  },
  {
    name: "an update's .condition() on a row it refuses",
    reference: byGroupOf,
    run: (db) => db.entities.Zones.update({ id: "c" }).set({ note: "n" }).condition(all).asEffect(),
    outcome: { fail: "ConditionalCheckFailed" },
    differs: misnamed(transactItem("Update")),
  },
  {
    name: "a delete's .condition()",
    reference: byGroupOf,
    run: (db) => db.entities.Zones.delete({ id: "a" }).condition(all).asEffect(),
    outcome: { ok: null },
    differs: [...wrote, ...misnamed(transactItem("Delete")), ...tombstoned],
  },
  {
    name: "a delete's .condition() on a row it refuses",
    reference: byGroupOf,
    run: (db) => db.entities.Zones.delete({ id: "d" }).condition(all).asEffect(),
    outcome: { fail: "ConditionalCheckFailed" },
    differs: misnamed(transactItem("Delete")),
  },
  ...(
    [
      ["a put's", (db: Db, id: string) => db.entities.Zones.put(zone(id, "x", 1, 7))],
      ["an update's", (db: Db, id: string) => db.entities.Zones.update({ id }).set({ note: "n" })],
      ["a delete's", (db: Db, id: string) => db.entities.Zones.delete({ id })],
    ] as const
  ).flatMap(
    ([op, write]): ReadonlyArray<Terminal> => [
      {
        name: `${op} .condition() on the unrenamed map`,
        reference: byGroupZones,
        run: (db) => write(db, "a").condition(zonesOnly).asEffect(),
        outcome: { ok: op === "a delete's" ? null : "a" },
      },
      {
        name: `${op} .condition() on the unrenamed map, on a row it refuses`,
        reference: byGroupZones,
        run: (db) => write(db, "b").condition(zonesOnly).asEffect(),
        outcome: { fail: "ConditionalCheckFailed" },
      },
    ],
  ),
  {
    name: "the entity's own condition, on an unbound update",
    reference: byGroupOf,
    run: (_db, { Zones }) =>
      Effect.gen(function* () {
        yield* (Zones.update({ id: "a" }) as any).pipe(
          Lib.Entity.set({ note: "u" }),
          Zones.condition(all as never),
        )
        return { id: "a" }
      }) as Effect.Effect<unknown, unknown>,
    outcome: { ok: "a" },
    differs: [...wrote, ...misnamed(transactItem("Update")), "rows[5].note.S", "rows[5].version.N"],
  },
  {
    name: "the entity's own filter, on an unbound query",
    reference: byGroupOf,
    run: (_db, { Zones }) =>
      Lib.Query.collect(
        (Zones as any).byGroup({ group: "g" }).pipe(Zones.filter(all as never)),
      ) as Effect.Effect<unknown, unknown>,
    outcome: { ok: ["a"] },
    differs: ["outcome.ok[0]", ...misnamed("requests[0].query", "FilterExpression")],
  },
]

/** A case as the fixture holds it: the outcome, the requests sent and the table's rows after. */
interface Record140 {
  readonly outcome: unknown
  readonly requests: ReadonlyArray<unknown>
  readonly rows: ReadonlyArray<unknown>
}

/** What 1.40.0 did for each case of this suite, captured once from the published 1.40.0 (never regenerate). */
const fixture: { readonly generatedFrom: string; readonly cases: Record<string, Record140> } =
  JSON.parse(
    readFileSync(new URL("../fixtures/entry-terminals-1.40.0.json", import.meta.url), "utf8"),
  )

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g

/** `value` with each instant set aside: a soft delete stamps the clock, which the capture's was not. */
const withoutInstants = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutInstants)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([name, held]) => [name, withoutInstants(held)]),
        )
      : typeof value === "string"
        ? value.replace(ISO, "<instant>")
        : value

/** Runs `body` on a seeded table of its own: its outcome, the requests it sent and the rows after. */
const onSeeded = (
  open: OpenTable,
  escapeKeys: boolean,
  body: (
    db: Db,
    entities: ReturnType<typeof define>["entities"],
  ) => Effect.Effect<unknown, unknown>,
  afterDeletes = false,
): Effect.Effect<Record140, unknown> =>
  Effect.gen(function* () {
    const { entities, MainTable } = define(escapeKeys)
    const log: Array<unknown> = []
    return yield* onTable(recordingRequests(open, log), 0, MainTable, { entities }, (db, table) =>
      Effect.gen(function* () {
        yield* seed(db)
        if (afterDeletes) {
          yield* db.entities.Zones.delete({ id: "a" })
          yield* db.entities.Zones.delete({ id: "b" })
        }
        log.length = 0
        const exit = yield* Effect.exit(Effect.suspend(() => body(db, entities)))
        const requests = [...log]
        const rows = withoutInstants(sortedRows(yield* table.rows)) as ReadonlyArray<unknown>
        return {
          outcome: outcomeOf(exit),
          requests: withoutInstants(requests) as ReadonlyArray<unknown>,
          rows,
        }
      }),
    )
  })

export const entryOnEveryTerminalSuite = (open: OpenTable) => {
  const { compared, asserted, everyCaseCompared } = comparedCases(
    "entry-terminals-1.40.0.json",
    fixture.cases,
  )

  for (const escapeKeys of [false, true]) {
    for (const terminal of terminals) {
      const name = caseName(terminal.name, escapeKeys)
      const was = compared(name)
      it.effect(name, () =>
        Effect.gen(function* () {
          const got = yield* onSeeded(open, escapeKeys, terminal.run, terminal.afterDeletes)
          expect(got.outcome).toEqual(terminal.outcome)
          if (terminal.reference !== undefined) {
            const reference = yield* onSeeded(open, escapeKeys, terminal.reference)
            const part = callersPart(expressionsOf(reference.requests)[0]!)
            expect(
              expressionsOf(got.requests).some((expression) => expression.includes(part)),
            ).toBe(true)
          }
          if (terminal.differs === undefined) expect(got).toEqual(was)
          else expectDiffersOnly(was, got, terminal.differs)
          asserted(name)
        }),
      )
    }

    it.effect(
      `\`.entry("east")\` sends the request naming its attribute sends, escapeKeys ${escapeKeys}`,
      () =>
        Effect.gen(function* () {
          for (const run of [
            (filter: typeof zonesOnly) => (db: Db) =>
              db.entities.Zones.byGroup({ group: "g" }).filter(filter).collect(),
            (filter: typeof zonesOnly) => (db: Db) =>
              db.entities.Zones.scan().filter(filter).collect(),
          ]) {
            const entry = yield* onSeeded(open, escapeKeys, run(zonesOnly))
            const named = yield* onSeeded(open, escapeKeys, run(zonesNamed))
            expect(entry).toEqual(named)
          }
        }),
    )

    for (const [what, run, outcome, differs] of refusals) {
      const name = caseName(what, escapeKeys)
      const was = compared(name)
      it.effect(name, () =>
        Effect.gen(function* () {
          const got = yield* onSeeded(open, escapeKeys, run)
          expect(got.outcome).toEqual(outcome)
          expectDiffersOnly(was, got, differs)
          asserted(name)
        }),
      )
    }
  }

  everyCaseCompared()

  it("a poisoned fixture record fails the comparison", () => {
    const was = fixture.cases[caseName("a put's .condition()", false)]!
    const poisoned = JSON.parse(JSON.stringify(was).replace("z#east", "z#west"))
    expect(() => expect(poisoned).toEqual(was)).toThrow()
    const refused = fixture.cases[caseName(refusals[2]![0], false)]!
    const poisonedRefused = { ...refused, rows: [...refused.rows, {}] }
    expect(() => expectDiffersOnly(poisonedRefused, refused, refusals[2]![3])).toThrow()
  })
}

const caseName = (terminal: string, escapeKeys: boolean) => `${terminal}, escapeKeys ${escapeKeys}`

/**
 * What resolves differently from 1.40.0: a nested field named like a sparse map, and a field named
 * like an `Object.prototype` member beside one (1.40.0's outcome is in the fixture).
 */
const refusals: ReadonlyArray<
  readonly [
    string,
    (db: Db) => Effect.Effect<unknown, unknown>,
    unknown,
    /** The paths at which the record differs from 1.40.0's. */
    ReadonlyArray<string>,
  ]
> = [
  [
    "`.entry()` on a nested field named like a sparse map, in a condition",
    (db) =>
      db.entities.Zones.update({ id: "a" })
        .set({ note: "n" })
        .condition((t: any, { eq }: any) => eq(t.inner.zones.entry("east"), "x"))
        .asEffect(),
    { die: 'Error: PathBuilder.entry: field "inner.zones" is not configured as a sparse map' },
    // 1.40.0 tested `inner.z#east`, which no row holds: `ConditionalCheckFailed` after its read.
    ["outcome.fail", "outcome.die", "requests[0]", "requests[1]"],
  ],
  [
    "`.entry()` on a field named `constructor` beside a sparse map, in a condition",
    (db) =>
      db.entities.Protos.update({ id: "q" })
        .set({ zones: { e: 2 } })
        .condition((t: any, { eq }: any) => eq(t.constructor.entry("k"), 3))
        .asEffect(),
    { die: 'Error: PathBuilder.entry: field "constructor" is not configured as a sparse map' },
    // 1.40.0 took `constructor` for a sparse map and tested `undefined#k`: `ConditionalCheckFailed`.
    ["outcome.fail", "outcome.die", "requests[0]"],
  ],
  [
    "an update of the fields named `valueOf` and `constructor` beside a sparse map",
    (db) =>
      Effect.flatMap(
        db.entities.Protos.update({ id: "q" })
          .set({ valueOf: { a: 5 }, constructor: { k: 4 } })
          .asEffect(),
        () =>
          Effect.map(db.entities.Protos.get({ id: "q" }), (row: any) => ({
            valueOf: row.valueOf,
            constructor: row.constructor,
          })),
      ),
    { ok: { valueOf: { a: 5 }, constructor: { k: 4 } } },
    // 1.40.0 wrote `undefined#a` and `undefined#k` (numbers) and returned the old values.
    [
      "outcome.ok.valueOf.a",
      "outcome.ok.constructor.k",
      "requests[0].updateItem.ExpressionAttributeNames.#u0",
      "requests[0].updateItem.ExpressionAttributeNames.#u1",
      "requests[0].updateItem.ExpressionAttributeValues.:u0.N",
      "requests[0].updateItem.ExpressionAttributeValues.:u0.M",
      "requests[0].updateItem.ExpressionAttributeValues.:u1.N",
      "requests[0].updateItem.ExpressionAttributeValues.:u1.M",
      "rows[4].constructor.M.k.N",
      "rows[4].undefined#a",
      "rows[4].undefined#k",
      "rows[4].valueOf.M.a.N",
    ],
  ],
]
