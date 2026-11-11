/**
 * An aggregate's `many` edge declaring `entity:` and a sort key over a field the entity's model
 * encodes (#241, DESIGN.md §11 "An `entity:` edge's sort key"). Up to 1.40.0 such an edge composed
 * its sort key from the field's stored text, where a plain edge composes it from the value:
 * `byn#5` where a plain edge writes `byn#0000000000000005`.
 *
 * - Under `escapeKeys: false` nothing changes: every step sends and stores what 1.40.0 did.
 * - Under `escapeKeys: true` the key is composed as a plain edge composes it. Rows 1.40.0 stored
 *   read as before, with the same request. A group's first changed write moves its rows: the
 *   write's own transaction deletes each row read under 1.40.0's text, and the row keeps its
 *   `created`. A no-op writes nothing, and `delete` removes rows under either text. A group whose
 *   rows and rows to move are over DynamoDB's 100 items fails with `AggregateTransactionOverflow`
 *   naming `rekey`; after `rekey` it's written.
 * - Two elements whose values compose one key now (letter case through a codec that keeps it, one
 *   instant in two zones) read as before. A write of their group is refused with the error a plain
 *   edge gives, `rekey` reports the aggregate `failed` and moves nothing, and an `update` removing
 *   one of them repairs it.
 * - `rekey` moves rows under 1.40.0's text, escaped or not, to this release's, and under `false`
 *   rows `escapeKeys: true` composed back.
 *
 * `fixtures/aggregate-entity-edge-keys-1.40.0.json` holds what published 1.40.0 stored and sent, at
 * a fixed clock. One suite, run on a recording table (`AggregateEntityEdgeKeys.test.ts`) and against
 * DynamoDB Local (`connected.aggregate-entity-edge-keys.test.ts`).
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, DateTime, Duration, Effect, Exit, Layer, Schema, SchemaGetter } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"

type Row = Record<string, AttributeValue>
type Request = { readonly command: string; readonly input: any }
type Step = {
  readonly step: string
  readonly outcome: any
  readonly requests: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
}
type Captured = "sheet" | "pair" | "bulk51" | "bulk50" | "split"

const published = JSON.parse(
  readFileSync(
    new URL("../fixtures/aggregate-entity-edge-keys-1.40.0.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly generatedFrom: ReadonlyArray<string>
  readonly clock: number
  readonly on: Record<Captured, readonly [Step, Step]>
  readonly off: ReadonlyArray<Step>
}

// ---------------------------------------------------------------------------
// The model the fixture was captured with
// ---------------------------------------------------------------------------

/** A codec whose stored text adds a space: `x` is stored `x `. */
const padded = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((text: string) => text.trim()),
    encode: SchemaGetter.transform((text: string) => `${text} `),
  }),
)
/** A codec storing a string's UTF-8 bytes as hex: `A` is `41`, `a` is `61`. */
const hex = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((text: string) => Buffer.from(text, "hex").toString("utf8")),
    encode: SchemaGetter.transform((text: string) => Buffer.from(text, "utf8").toString("hex")),
  }),
)
const Line = Schema.Struct({
  lineId: Schema.String,
  n: Schema.NumberFromString,
  big: Schema.BigIntFromString,
  ms: DynamoModel.DateEpochMs,
  sec: DynamoModel.DateEpochSeconds,
  stored: Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
  utc: Schema.DateTimeUtcFromString,
  zoned: Schema.DateTimeZonedFromString,
  padded,
  hex,
})
/** A wrapper element: its own `n` is a `Schema.Number`, named like the entity's `NumberFromString`. */
const Wrapped = Schema.Struct({ line: Line, n: Schema.Number })
const Tally = Schema.Struct({ tallyId: Schema.String, n: Schema.NumberFromString })
const Sheet = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  byN: Schema.Array(Line),
  byBig: Schema.Array(Line),
  byMs: Schema.Array(Line),
  bySec: Schema.Array(Line),
  byStored: Schema.Array(Line),
  byUtc: Schema.Array(Line),
  byZoned: Schema.Array(Line),
  byPadded: Schema.Array(Line),
  byHex: Schema.Array(Line),
  wrapped: Schema.Array(Wrapped),
  plain: Schema.Array(Line),
})
const Pair = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  cased: Schema.Array(Line),
  zones: Schema.Array(Line),
})
const Bulk = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  tallies: Schema.Array(Tally),
})
const Part = Schema.Struct({ partName: Schema.String, cased: Schema.Array(Line) })
const Split = Schema.Struct({ id: Schema.String, title: Schema.String, part: Part })

const define = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "edges", version: 1, escapeKeys })
  const one = (field: string) =>
    ({
      pk: { field: "pk", composite: [field] },
      sk: { field: "sk", composite: [] },
    }) as const
  const Lines = Entity.make({
    model: DynamoModel.configure(Line, { lineId: { identifier: true } }),
    entityType: "Line",
    primaryKey: one("lineId"),
  } as never) as any
  const Tallies = Entity.make({
    model: DynamoModel.configure(Tally, { tallyId: { identifier: true } }),
    entityType: "Tally",
    primaryKey: one("tallyId"),
  } as never) as any
  const Main = Table.make({ schema, entities: { Lines, Tallies } })
  const by = (entityType: string, composite: ReadonlyArray<string>) =>
    Aggregate.many({ entityType, entity: Lines, sk: { composite } } as never)
  const Sheets = Aggregate.make(
    Sheet as never,
    {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "sheet" },
      timestamps: true,
      root: { entityType: "Sheet" },
      edges: {
        byN: by("ByN", ["n"]),
        byBig: by("ByBig", ["big"]),
        byMs: by("ByMs", ["ms"]),
        bySec: by("BySec", ["sec"]),
        byStored: by("ByStored", ["stored"]),
        byUtc: by("ByUtc", ["utc"]),
        byZoned: by("ByZoned", ["zoned"]),
        byPadded: by("ByPadded", ["padded"]),
        byHex: by("ByHex", ["hex"]),
        wrapped: by("Wrapped", ["n"]),
        plain: Aggregate.many({ entityType: "Plain", sk: { composite: ["n"] } } as never),
      },
    } as never,
  ) as any
  const Pairs = Aggregate.make(
    Pair as never,
    {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "pair" },
      timestamps: true,
      root: { entityType: "Pair" },
      edges: { cased: by("Cased", ["hex"]), zones: by("Zones", ["zoned"]) },
    } as never,
  ) as any
  const Bulks = Aggregate.make(
    Bulk as never,
    {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "bulk" },
      root: { entityType: "Bulk" },
      edges: {
        tallies: Aggregate.many({
          entityType: "BulkTally",
          entity: Tallies,
          sk: { composite: ["n"] },
        } as never),
      },
    } as never,
  ) as any
  const Splits = Aggregate.make(
    Split as never,
    {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "split" },
      timestamps: true,
      root: { entityType: "Split" },
      edges: {
        part: (
          Aggregate.make(
            Part as never,
            { root: { entityType: "Part" }, edges: { cased: by("PartCased", ["hex"]) } } as never,
          ) as any
        ).with({ discriminator: { slot: "a" } }),
      },
    } as never,
  ) as any
  return { Lines, Tallies, Main, Sheets, Pairs, Bulks, Splits }
}

/** One definition per setting, each its own `Table.make`. */
export const ON = define(true)
export const OFF = define(false)

const day = (d: number) => DateTime.makeUnsafe(Date.UTC(2024, 4, d, 7, 8, 9))
const zone = (d: number, timeZone: string) =>
  DateTime.makeZonedUnsafe(Date.UTC(2024, 4, d, 7, 8, 9), { timeZone })
const line = (i: 1 | 2 | 3, over: Record<string, unknown> = {}) => ({
  lineId: `l${i}`,
  n: [5, 12, 40][i - 1],
  big: [5n, 12n, 40n][i - 1],
  ms: day(i + 1),
  sec: day(i + 3),
  stored: day(i + 5),
  utc: day(i + 7),
  zoned: zone(i + 9, "Europe/Paris"),
  padded: ["x", "y", "z"][i - 1],
  hex: ["b", "c", "d"][i - 1],
  ...over,
})
const sheet = (id: string) => ({
  id,
  title: "t",
  byN: [line(1), line(2)],
  byBig: [line(1), line(2)],
  byMs: [line(1), line(2)],
  bySec: [line(1), line(2)],
  byStored: [line(1), line(2)],
  byUtc: [line(1), line(2)],
  byZoned: [line(1), line(2)],
  byPadded: [line(1), line(2)],
  byHex: [line(1), line(2)],
  wrapped: [
    { line: line(1), n: 5 },
    { line: line(2), n: 12 },
  ],
  plain: [line(1), line(2)],
})
/** Two elements whose values compose one key under `escapeKeys: true`, in each edge, and a third. */
const pair = (id: string, without?: string) => {
  const keep = (elements: ReadonlyArray<{ readonly lineId: string }>) =>
    elements.filter((element) => element.lineId !== without)
  return {
    id,
    title: "t",
    cased: keep([line(1, { hex: "A" }), line(2, { hex: "a" }), line(3, { hex: "b" })]),
    zones: keep([
      line(1, { zoned: zone(20, "Europe/Paris") }),
      line(2, { zoned: zone(20, "UTC") }),
      line(3, { zoned: zone(21, "UTC") }),
    ]),
  }
}
const bulk = (id: string, count: number) => ({
  id,
  title: "t",
  tallies: Array.from({ length: count }, (_, i) => ({ tallyId: `t${i}`, n: i + 1 })),
})

const PK = {
  sheet: "$edges#v1#sheet#s1",
  pair: "$edges#v1#pair#p1",
  bulk51: "$edges#v1#bulk#b51",
  bulk50: "$edges#v1#bulk#b50",
  split: "$edges#v1#split#x1",
} as const

// ---------------------------------------------------------------------------
// Running steps
// ---------------------------------------------------------------------------

const keyOf = (row: Row) => `${row.pk?.S}|${row.sk?.S}`
const sorted = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
  [...rows]
    .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1))
    .map((row) =>
      Object.fromEntries(
        Object.keys(row)
          .sort()
          .map((name) => [name, row[name]!]),
      ),
    )
const sks = (rows: ReadonlyArray<Row>) => rows.map((row) => row.sk!.S!)
/** A value's JSON, every object's keys in order: a map's attributes come back in any order. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, held) =>
    held !== null && typeof held === "object" && !Array.isArray(held)
      ? Object.fromEntries(
          Object.keys(held)
            .sort()
            .map((name) => [name, held[name]]),
        )
      : held,
  )

const plain = (value: unknown): unknown =>
  value === undefined
    ? undefined
    : JSON.parse(
        JSON.stringify(value, function (this: Record<string, unknown>, key, encoded) {
          const held = this[key]
          if (held !== null && typeof held === "object" && DateTime.isDateTime(held)) {
            return DateTime.isZoned(held)
              ? { zoned: DateTime.formatIsoZoned(held) }
              : { date: DateTime.toEpochMillis(held) }
          }
          if (typeof held === "bigint") return { bigint: String(held) }
          return encoded
        }),
      )

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): any => {
  if (Exit.isSuccess(exit)) return { ok: plain(exit.value) ?? null }
  const failure = Cause.squash(exit.cause) as any
  return { fail: String(failure?._tag ?? "Error"), error: failure }
}

export interface Harness {
  /** Runs `body` on a fresh table with a `DynamoClient` bound to it. */
  readonly onTable: <A, E>(
    body: (tableName: string) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
  /** The table's rows. */
  readonly rows: (tableName: string) => Effect.Effect<ReadonlyArray<Row>>
  /** The requests sent since last asked, the table's name as `<table>`. */
  readonly requests: (tableName: string) => Effect.Effect<ReadonlyArray<Request>>
  /** Puts `rows` in the table as they are. */
  readonly seed: (tableName: string, rows: ReadonlyArray<Row>) => Effect.Effect<void>
  /** Whether DynamoDB answers, so its 100-item transaction limit is enforced. */
  readonly enforcesLimits: boolean
}

type Defs = ReturnType<typeof define>
type Session = {
  readonly db: any
  readonly step: (name: string, make: () => any, pk?: string) => Effect.Effect<Step>
  readonly rows: (pk?: string) => Effect.Effect<ReadonlyArray<Row>>
}

/** Runs `body` on a fresh table at the fixture's clock, with `defs`' client and each row of `seeded`. */
const session = <A>(
  harness: Harness,
  defs: Defs,
  seeded: ReadonlyArray<Row>,
  body: (session: Session) => Effect.Effect<A, unknown, any>,
) =>
  harness.onTable((tableName) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(published.clock)
      if (seeded.length > 0) yield* harness.seed(tableName, seeded)
      const db = yield* DynamoClient.make({
        entities: { Lines: defs.Lines, Tallies: defs.Tallies },
        aggregates: {
          Sheets: defs.Sheets,
          Pairs: defs.Pairs,
          Bulks: defs.Bulks,
          Splits: defs.Splits,
        },
        tables: { Main: defs.Main },
      })
      const rows = (pk?: string) =>
        Effect.map(harness.rows(tableName), (all) =>
          sorted(all.filter((row) => pk === undefined || row.pk?.S === pk)),
        )
      yield* harness.requests(tableName)
      const step = (name: string, make: () => any, pk?: string) =>
        Effect.gen(function* () {
          const outcome = outcomeOf(yield* Effect.exit(make() as Effect.Effect<unknown, unknown>))
          return {
            step: name,
            outcome,
            requests: yield* harness.requests(tableName),
            rows: yield* rows(pk),
          }
        })
      return yield* body({ db, step, rows })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(ON.Main.layer({ name: tableName }), OFF.Main.layer({ name: tableName })),
      ),
    ),
  )

const later = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.andThen(TestClock.adjust(Duration.seconds(5)), effect)
const retitled = ({ state }: any) => ({ ...state, title: "t2" })
const unchanged = ({ state }: any) => state

/** A transaction's Puts' sort keys and Deletes' sort keys. */
const transaction = (requests: ReadonlyArray<Request>) => {
  const writes = requests.filter((request) => request.command === "TransactWriteItems")
  expect(writes).toHaveLength(1)
  const items = writes[0]!.input.TransactItems as ReadonlyArray<any>
  return {
    puts: items
      .filter((item) => item.Put !== undefined)
      .map((item) => item.Put.Item.sk.S as string),
    deletes: items
      .filter((item) => item.Delete !== undefined)
      .map((item) => item.Delete.Key.sk.S as string),
  }
}

/** A rekey report's moved aggregate rows and conflicts, for `member`. */
const rekeyed = (outcome: any, member: string) => ({
  moved: outcome.ok.byMember?.[member]?.moved?.aggregate ?? 0,
  conflicts: (outcome.ok.conflicts as ReadonlyArray<any>).filter(
    (conflict) => conflict.member === member,
  ),
})

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export const suite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("an entity: many edge's sort key over a field the entity's model encodes", () => {
    const then = published.on

    it("the fixture is published 1.40.0's, whose entity edges keyed their rows by the stored text", () => {
      expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
      expect(sks(then.sheet[0].rows)).toEqual([
        "$edges#v1#bybig#12",
        "$edges#v1#bybig#5",
        "$edges#v1#byhex#62",
        "$edges#v1#byhex#63",
        "$edges#v1#byms#0001714633689000",
        "$edges#v1#byms#0001714720089000",
        "$edges#v1#byn#12",
        "$edges#v1#byn#5",
        "$edges#v1#bypadded#x%20",
        "$edges#v1#bypadded#y%20",
        "$edges#v1#bysec#0000001714806489",
        "$edges#v1#bysec#0000001714892889",
        "$edges#v1#bystored#0001714979289000",
        "$edges#v1#bystored#0001715065689000",
        "$edges#v1#byutc#2024-05-08t07:08:09.000z",
        "$edges#v1#byutc#2024-05-09t07:08:09.000z",
        "$edges#v1#byzoned#2024-05-10t09:08:09.000+02:00[europe/paris]",
        "$edges#v1#byzoned#2024-05-11t09:08:09.000+02:00[europe/paris]",
        "$edges#v1#plain#0000000000000005",
        "$edges#v1#plain#0000000000000012",
        "$edges#v1#sheet",
        "$edges#v1#wrapped#12",
        "$edges#v1#wrapped#5",
      ])
      // The pairs were two rows each, and read back as two elements.
      expect(sks(then.pair[0].rows)).toContain("$edges#v1#cased#41")
      expect(sks(then.pair[0].rows)).toContain("$edges#v1#cased#61")
      expect(then.pair[1].outcome.ok.cased).toHaveLength(3)
      expect(then.pair[1].outcome.ok.zones).toHaveLength(3)
      expect(then.bulk51[0].rows).toHaveLength(51)
      expect(then.bulk50[0].rows).toHaveLength(50)
    })

    it.effect(
      "under escapeKeys: false, every step sends and stores what 1.40.0 did, byte for byte",
      () =>
        Effect.gen(function* () {
          const actual = yield* session(harness, OFF, [], ({ db, step }) =>
            Effect.gen(function* () {
              const out: Array<Step> = []
              out.push(
                yield* step("create", () => db.aggregates.Sheets.create(sheet("s1")), PK.sheet),
              )
              out.push(yield* step("get", () => db.aggregates.Sheets.get({ id: "s1" }), PK.sheet))
              out.push(
                yield* step(
                  "update, changing nothing",
                  () => db.aggregates.Sheets.update({ id: "s1" }, unchanged),
                  PK.sheet,
                ),
              )
              out.push(
                yield* step(
                  "update, 5 s later, changing the title",
                  () => later(db.aggregates.Sheets.update({ id: "s1" }, retitled)),
                  PK.sheet,
                ),
              )
              out.push(
                yield* step(
                  "update, 5 s later, removing the first element of every edge",
                  () =>
                    later(
                      db.aggregates.Sheets.update({ id: "s1" }, ({ state }: any) =>
                        Object.fromEntries(
                          Object.entries(state).map(([k, v]) => [
                            k,
                            Array.isArray(v) ? v.slice(1) : v,
                          ]),
                        ),
                      ),
                    ),
                  PK.sheet,
                ),
              )
              out.push(yield* step("get", () => db.aggregates.Sheets.get({ id: "s1" }), PK.sheet))
              out.push(
                yield* step("delete", () => db.aggregates.Sheets.delete({ id: "s1" }), PK.sheet),
              )
              return out
            }),
          )
          expect(actual.map((s) => s.step)).toEqual(published.off.map((s) => s.step))
          for (const [i, s] of actual.entries()) {
            expect(s.outcome, s.step).toEqual(published.off[i]!.outcome)
            expect(s.requests, s.step).toEqual(published.off[i]!.requests)
            expect(s.rows, s.step).toEqual(published.off[i]!.rows)
          }
        }),
    )

    // What this release writes under `escapeKeys: true`, from scratch: create, then a title.
    const written = (seed: (db: any) => any, update: (db: any) => any, pk: string) =>
      session(harness, ON, [], ({ db, step }) =>
        Effect.gen(function* () {
          const create = yield* step("create", () => seed(db), pk)
          const after = yield* step("update", () => later(update(db)), pk)
          return { create, after }
        }),
      )

    it.effect(
      "under escapeKeys: true, a new aggregate keys each element as a plain edge does",
      () =>
        Effect.gen(function* () {
          const { create } = yield* written(
            (db) => db.aggregates.Sheets.create(sheet("s1")),
            (db) => db.aggregates.Sheets.update({ id: "s1" }, retitled),
            PK.sheet,
          )
          expect(sks(create.rows)).toEqual([
            "$edges#v1#bybig#00000000000000000000000000000000000005",
            "$edges#v1#bybig#00000000000000000000000000000000000012",
            "$edges#v1#byhex#b",
            "$edges#v1#byhex#c",
            "$edges#v1#byms#2024-05-02t07:08:09.000z",
            "$edges#v1#byms#2024-05-03t07:08:09.000z",
            "$edges#v1#byn#0000000000000005",
            "$edges#v1#byn#0000000000000012",
            "$edges#v1#bypadded#x",
            "$edges#v1#bypadded#y",
            "$edges#v1#bysec#2024-05-04t07:08:09.000z",
            "$edges#v1#bysec#2024-05-05t07:08:09.000z",
            "$edges#v1#bystored#2024-05-06t07:08:09.000z",
            "$edges#v1#bystored#2024-05-07t07:08:09.000z",
            "$edges#v1#byutc#2024-05-08t07:08:09.000z",
            "$edges#v1#byutc#2024-05-09t07:08:09.000z",
            "$edges#v1#byzoned#2024-05-10t07:08:09.000z",
            "$edges#v1#byzoned#2024-05-11t07:08:09.000z",
            "$edges#v1#plain#0000000000000005",
            "$edges#v1#plain#0000000000000012",
            "$edges#v1#sheet",
            "$edges#v1#wrapped#0000000000000005",
            "$edges#v1#wrapped#0000000000000012",
          ])
          // Only the key moved: every other attribute is what 1.40.0 stored.
          const withoutSk = (rows: ReadonlyArray<Row>) =>
            rows.map((row) => canonical({ ...row, sk: { S: "" } })).sort()
          expect(withoutSk(create.rows)).toEqual(withoutSk(then.sheet[0].rows))
        }),
    )

    it.effect(
      "under escapeKeys: true, over the rows 1.40.0 stored: read as before with its request, and a no-op update sends only its read",
      () =>
        Effect.gen(function* () {
          for (const name of ["sheet", "pair", "bulk51", "bulk50", "split"] as const) {
            const [get, noop] = yield* session(harness, ON, then[name][0].rows, ({ db, step }) =>
              Effect.gen(function* () {
                const id = { sheet: "s1", pair: "p1", bulk51: "b51", bulk50: "b50", split: "x1" }[
                  name
                ]
                const aggregate = {
                  sheet: db.aggregates.Sheets,
                  pair: db.aggregates.Pairs,
                  bulk51: db.aggregates.Bulks,
                  bulk50: db.aggregates.Bulks,
                  split: db.aggregates.Splits,
                }[name]
                return [
                  yield* step("get", () => aggregate.get({ id }), PK[name]),
                  yield* step(
                    "update, changing nothing",
                    () => aggregate.update({ id }, unchanged),
                    PK[name],
                  ),
                ] as const
              }),
            )
            expect(get.outcome, name).toEqual(then[name][1].outcome)
            expect(get.requests, name).toEqual(then[name][1].requests)
            expect(noop.outcome, name).toEqual(then[name][1].outcome)
            expect(
              noop.requests.map((request) => request.command),
              name,
            ).toEqual(["Query"])
            expect(noop.rows, name).toEqual(sorted(then[name][0].rows))
          }
        }),
    )

    it.effect(
      "under escapeKeys: true, a group's first changed write moves its rows in its own transaction, each keeping its created",
      () =>
        Effect.gen(function* () {
          const fresh = yield* written(
            (db) => db.aggregates.Sheets.create(sheet("s1")),
            (db) => db.aggregates.Sheets.update({ id: "s1" }, retitled),
            PK.sheet,
          )
          const [title, get, rekey] = yield* session(
            harness,
            ON,
            then.sheet[0].rows,
            ({ db, step }) =>
              Effect.gen(function* () {
                return [
                  yield* step(
                    "update title",
                    () => later(db.aggregates.Sheets.update({ id: "s1" }, retitled)),
                    PK.sheet,
                  ),
                  yield* step("get", () => db.aggregates.Sheets.get({ id: "s1" }), PK.sheet),
                  yield* step("rekey", () => db.tables.Main.rekey({ dryRun: true })),
                ] as const
              }),
          )
          expect(title.outcome).toHaveProperty("ok")
          // The group as this release writes it from scratch: every key, `created` kept as stored.
          expect(title.rows).toEqual(fresh.after.rows)
          const before = sks(then.sheet[0].rows)
          const moved = before.filter((sk) => !sks(fresh.create.rows).includes(sk))
          expect(moved).toHaveLength(18)
          // One transaction: this release's Puts, then a Delete of each row read under 1.40.0's text.
          expect(title.requests.map((request) => request.command)).toEqual([
            "Query",
            "TransactWriteItems",
          ])
          const sent = transaction(title.requests)
          // The elements in the order they were read: 1.40.0's text sorted `12` before `5`.
          expect([...sent.puts].sort()).toEqual([...transaction(fresh.after.requests).puts].sort())
          expect([...sent.deletes].sort()).toEqual([...moved].sort())
          // The wrapper's own `n`, which 1.40.0 ran through the entity's `NumberFromString`: moved,
          // its `created` carried.
          const wrapped = (rows: ReadonlyArray<Row>) =>
            rows.filter((row) => row.__edd_e__?.S === "Wrapped")
          expect(sks(wrapped(then.sheet[0].rows))).toEqual([
            "$edges#v1#wrapped#12",
            "$edges#v1#wrapped#5",
          ])
          expect(sks(wrapped(title.rows))).toEqual([
            "$edges#v1#wrapped#0000000000000005",
            "$edges#v1#wrapped#0000000000000012",
          ])
          for (const row of wrapped(title.rows)) {
            expect(row.createdAt).toEqual(wrapped(then.sheet[0].rows)[0]!.createdAt)
            expect(row.createdAt).toEqual({ S: new Date(published.clock).toISOString() })
            expect(row.updatedAt).toEqual({ S: new Date(published.clock + 5000).toISOString() })
          }
          // Read back as a group this release wrote, and nothing left for `rekey`.
          expect(get.outcome.ok.title).toBe("t2")
          expect(rekeyed(rekey.outcome, "Sheet")).toEqual({ moved: 0, conflicts: [] })
        }),
    )

    it.effect("under escapeKeys: true, delete removes an aggregate's rows under either text", () =>
      Effect.gen(function* () {
        const fresh = yield* written(
          (db) => db.aggregates.Sheets.create(sheet("s1")),
          (db) => db.aggregates.Sheets.update({ id: "s1" }, unchanged),
          PK.sheet,
        )
        // 1.40.0's rows, and the same elements under this release's text beside them.
        const both = [
          ...then.sheet[0].rows,
          ...fresh.create.rows.filter((row) => !sks(then.sheet[0].rows).includes(row.sk!.S!)),
        ]
        expect(both).toHaveLength(23 + 18)
        for (const seeded of [then.sheet[0].rows, both]) {
          const removed = yield* session(harness, ON, seeded, ({ db, step }) =>
            step("delete", () => db.aggregates.Sheets.delete({ id: "s1" }), PK.sheet),
          )
          expect(removed.outcome).toEqual({ ok: null })
          expect(removed.rows).toEqual([])
          expect(removed.requests[0]!.command).toBe("Query")
          expect(
            removed.requests.slice(1).every((request) => request.command === "BatchWriteItem"),
          ).toBe(true)
        }
      }),
    )

    it.effect(
      "under escapeKeys: true, two elements whose values compose one key: read as before, refused as a plain edge refuses, rekey moves nothing, and an update removing one repairs it",
      () =>
        Effect.gen(function* () {
          // What this release refuses for the same value, from scratch: a plain edge's error.
          const created = yield* session(harness, ON, [], ({ db, step }) =>
            step("create", () => db.aggregates.Pairs.create(pair("p1")), PK.pair),
          )
          expect(created.outcome.fail).toBe("AggregateDecompositionError")
          const casedError = created.outcome.error.reason as string
          expect(casedError).toBe(
            `"cased" and "cased" both compose the sort key "$edges#v1#cased#a", so one would ` +
              `overwrite the other. Give the "cased" edge a declared sort key naming attributes ` +
              `that differ between its elements: cased: Aggregate.many({ …, sk: { composite: [...] } }).`,
          )
          const fresh = yield* written(
            (db) => db.aggregates.Pairs.create(pair("p1", "l2")),
            (db) => db.aggregates.Pairs.update({ id: "p1" }, retitled),
            PK.pair,
          )
          const seeded = then.pair[0].rows
          const [get, title, casedOnly, dry, rekey, repair, after] = yield* session(
            harness,
            ON,
            seeded,
            ({ db, step }) =>
              Effect.gen(function* () {
                const drop =
                  (lineId: string, edges: ReadonlyArray<string>) =>
                  ({ state }: any) => ({
                    ...state,
                    title: "t2",
                    ...Object.fromEntries(
                      edges.map((edge) => [
                        edge,
                        state[edge].filter((l: any) => l.lineId !== lineId),
                      ]),
                    ),
                  })
                return [
                  yield* step("get", () => db.aggregates.Pairs.get({ id: "p1" }), PK.pair),
                  yield* step(
                    "update title",
                    () => db.aggregates.Pairs.update({ id: "p1" }, retitled),
                    PK.pair,
                  ),
                  yield* step(
                    "update removing one cased element",
                    () => db.aggregates.Pairs.update({ id: "p1" }, drop("l2", ["cased"])),
                    PK.pair,
                  ),
                  yield* step("rekey dry run", () => db.tables.Main.rekey({ dryRun: true })),
                  yield* step("rekey", () => db.tables.Main.rekey()),
                  yield* step(
                    "update removing one of each",
                    () =>
                      later(
                        db.aggregates.Pairs.update({ id: "p1" }, drop("l2", ["cased", "zones"])),
                      ),
                    PK.pair,
                  ),
                  yield* step("rekey after", () => db.tables.Main.rekey({ dryRun: true })),
                ] as const
              }),
          )
          // Read as 1.40.0 read them.
          expect(get.outcome).toEqual(then.pair[1].outcome)
          // A changed write of the group: refused as a plain edge refuses it, nothing written.
          expect(title.outcome.fail).toBe("AggregateDecompositionError")
          expect(title.outcome.error.reason).toBe(casedError)
          expect(title.requests.map((request) => request.command)).toEqual(["Query"])
          expect(title.rows).toEqual(sorted(seeded))
          // The zones pair alone: the same refusal, naming its key.
          expect(casedOnly.outcome.error.reason).toBe(
            `"zones" and "zones" both compose the sort key "$edges#v1#zones#2024-05-20t07:08:09.000z", ` +
              `so one would overwrite the other. Give the "zones" edge a declared sort key naming ` +
              `attributes that differ between its elements: zones: Aggregate.many({ …, sk: { composite: [...] } }).`,
          )
          expect(casedOnly.rows).toEqual(sorted(seeded))
          // `rekey`: the aggregate failed with that reason, and nothing moved.
          for (const run of [dry, rekey]) {
            const report = rekeyed(run.outcome, "Pair")
            expect(report.moved).toBe(0)
            expect(report.conflicts).toHaveLength(1)
            expect(report.conflicts[0].reason).toBe("failed")
            expect(report.conflicts[0].message).toBe(`AggregateDecompositionError: ${casedError}`)
          }
          expect(rekey.rows.filter((row) => row.pk?.S === PK.pair)).toEqual(sorted(seeded))
          // Removing one of each pair: one row each, under this release's key, the survivor's
          // `created` carried; then nothing for `rekey`.
          expect(repair.outcome).toHaveProperty("ok")
          expect(repair.rows).toEqual(fresh.after.rows)
          const sent = transaction(repair.requests)
          expect([...sent.deletes].sort()).toEqual(
            sks(seeded)
              .filter((sk) => sk !== "$edges#v1#pair")
              .sort(),
          )
          expect(rekeyed(after.outcome, "Pair")).toEqual({ moved: 0, conflicts: [] })
        }),
    )

    it.effect(
      "under escapeKeys: true, two elements whose values compose one key in a group the write leaves alone: the write goes ahead",
      () =>
        Effect.gen(function* () {
          const seeded = then.split[0].rows
          const isPart = (row: Row) => (row.__edd_e__?.S ?? "").startsWith("Part")
          const [title, part] = yield* session(harness, ON, seeded, ({ db, step }) =>
            Effect.gen(function* () {
              return [
                yield* step(
                  "update title",
                  () => later(db.aggregates.Splits.update({ id: "x1" }, retitled)),
                  PK.split,
                ),
                yield* step(
                  "update the part",
                  () =>
                    db.aggregates.Splits.update({ id: "x1" }, ({ state }: any) => ({
                      ...state,
                      part: { ...state.part, partName: "q" },
                    })),
                  PK.split,
                ),
              ] as const
            }),
          )
          // The root's group is written; the part's rows stay as 1.40.0 stored them.
          expect(title.outcome.ok.title).toBe("t2")
          expect(transaction(title.requests)).toEqual({ puts: ["$edges#v1#split"], deletes: [] })
          expect(title.rows.filter(isPart)).toEqual(sorted(seeded.filter(isPart)))
          // A write of the part's group is refused as a plain edge refuses it.
          expect(part.outcome.fail).toBe("AggregateDecompositionError")
          expect(part.outcome.error.reason).toContain(
            `"cased" and "cased" both compose the sort key "$edges#v1#partcased#slot#a#a"`,
          )
          expect(part.requests.map((request) => request.command)).toEqual(["Query"])
          expect(part.rows).toEqual(title.rows)
        }),
    )

    it.effect(
      "under escapeKeys: true, a group of 50 rows 1.40.0 stored is moved by its first changed write, with no rekey",
      () =>
        Effect.gen(function* () {
          const [title, rekey] = yield* session(harness, ON, then.bulk50[0].rows, ({ db, step }) =>
            Effect.gen(function* () {
              return [
                yield* step(
                  "update title",
                  () => db.aggregates.Bulks.update({ id: "b50" }, retitled),
                  PK.bulk50,
                ),
                yield* step("rekey", () => db.tables.Main.rekey({ dryRun: true })),
              ] as const
            }),
          )
          expect(title.outcome.ok.title).toBe("t2")
          const sent = transaction(title.requests)
          expect([sent.puts.length, sent.deletes.length]).toEqual([50, 49])
          expect(sks(title.rows)).toEqual([
            "$edges#v1#bulk",
            ...Array.from(
              { length: 49 },
              (_, i) => `$edges#v1#bulktally#${String(i + 1).padStart(16, "0")}`,
            ),
          ])
          expect(rekeyed(rekey.outcome, "Bulk")).toEqual({ moved: 0, conflicts: [] })
        }),
    )

    it.effect.skipIf(!harness.enforcesLimits)(
      "under escapeKeys: true, a group of more than 50 rows 1.40.0 stored can't be written until rekey moves them",
      () =>
        Effect.gen(function* () {
          const seeded = then.bulk51[0].rows
          const steps = yield* session(harness, ON, seeded, ({ db, step }) =>
            Effect.gen(function* () {
              return [
                yield* step(
                  "update title",
                  () => db.aggregates.Bulks.update({ id: "b51" }, retitled),
                  PK.bulk51,
                ),
                yield* step("get", () => db.aggregates.Bulks.get({ id: "b51" }), PK.bulk51),
                yield* step(
                  "update adding 50",
                  () =>
                    db.aggregates.Bulks.update({ id: "b51" }, ({ state }: any) => ({
                      ...state,
                      tallies: [...state.tallies, ...bulk("x", 100).tallies.slice(50)],
                    })),
                  PK.bulk51,
                ),
                yield* step(
                  "rekey dry run",
                  () => db.tables.Main.rekey({ dryRun: true }),
                  PK.bulk51,
                ),
                yield* step("rekey", () => db.tables.Main.rekey(), PK.bulk51),
                yield* step(
                  "update title",
                  () => db.aggregates.Bulks.update({ id: "b51" }, retitled),
                  PK.bulk51,
                ),
                yield* step("rekey again", () => db.tables.Main.rekey({ dryRun: true }), PK.bulk51),
              ] as const
            }),
          )
          const [title, get, adding, dry, rekey, retry, again] = steps
          // Over the limit only because of its moves: the overflow says so, and names `rekey`.
          expect(title.outcome.fail).toBe("AggregateTransactionOverflow")
          expect(title.outcome.error.itemCount).toBe(101)
          expect(title.outcome.error.previousKeyText).toBe(50)
          expect(title.outcome.error.message).toBe(
            `Aggregate "Bulk": the transaction of sub-aggregate "root" holds 101 items, over ` +
              `DynamoDB's limit of 100 for one transaction, and DynamoDB rejected it. Nothing was ` +
              `written. The group holds 50 rows under the previous key text, which the write ` +
              `deletes in the same transaction; without them it fits. Run ` +
              "`db.tables.<Table>.rekey()` to move them, then write again.",
          )
          expect(title.rows).toEqual(sorted(seeded))
          // Read as before.
          expect(get.outcome).toEqual(then.bulk51[1].outcome)
          // A group too large without its moves: an ordinary overflow, which names no `rekey`.
          expect(adding.outcome.fail).toBe("AggregateTransactionOverflow")
          expect(adding.outcome.error.itemCount).toBe(151)
          expect(adding.outcome.error.previousKeyText).toBeUndefined()
          expect(adding.outcome.error.message).not.toContain("rekey")
          expect(adding.rows).toEqual(sorted(seeded))
          // `rekey` reports the 50 rows, moves them, and the update then fits.
          expect(rekeyed(dry.outcome, "Bulk")).toEqual({ moved: 50, conflicts: [] })
          expect(dry.rows).toEqual(sorted(seeded))
          expect(rekeyed(rekey.outcome, "Bulk")).toEqual({ moved: 50, conflicts: [] })
          expect(retry.outcome.ok.title).toBe("t2")
          expect(transaction(retry.requests).deletes).toEqual([])
          expect(sks(retry.rows)).toEqual([
            "$edges#v1#bulk",
            ...Array.from(
              { length: 50 },
              (_, i) => `$edges#v1#bulktally#${String(i + 1).padStart(16, "0")}`,
            ),
          ])
          expect(rekeyed(again.outcome, "Bulk")).toEqual({ moved: 0, conflicts: [] })
        }),
    )

    it.effect(
      "rekey moves the rows 1.40.0 stored, escaped or not, to this release's text, and back under escapeKeys: false",
      () =>
        Effect.gen(function* () {
          const fresh = yield* written(
            (db) => db.aggregates.Sheets.create(sheet("s1")),
            (db) => db.aggregates.Sheets.update({ id: "s1" }, unchanged),
            PK.sheet,
          )
          // 1.40.0's rows under `true` and under `false`, rekeyed under `true`.
          for (const [seeded, count] of [
            [then.sheet[0].rows, 18],
            [published.off[0]!.rows, 18],
          ] as const) {
            const [dry, rekey, again] = yield* session(harness, ON, seeded, ({ db, step }) =>
              Effect.gen(function* () {
                return [
                  yield* step("dry run", () => db.tables.Main.rekey({ dryRun: true }), PK.sheet),
                  yield* step("rekey", () => db.tables.Main.rekey(), PK.sheet),
                  yield* step("again", () => db.tables.Main.rekey({ dryRun: true }), PK.sheet),
                ] as const
              }),
            )
            expect(rekeyed(dry.outcome, "Sheet").moved).toBe(count)
            expect(dry.rows).toEqual(sorted(seeded))
            expect(rekeyed(rekey.outcome, "Sheet").conflicts).toEqual([])
            expect(sks(rekey.rows)).toEqual(sks(fresh.create.rows))
            expect(rekeyed(again.outcome, "Sheet")).toEqual({ moved: 0, conflicts: [] })
          }
          // This release's rows under `true`, rekeyed under `false`: 1.40.0's text there.
          const back = yield* session(harness, OFF, fresh.create.rows, ({ db, step }) =>
            step("rekey", () => db.tables.Main.rekey(), PK.sheet),
          )
          expect(rekeyed(back.outcome, "Sheet").conflicts).toEqual([])
          expect(sks(back.rows)).toEqual(sks(published.off[0]!.rows))
        }),
    )
  })
