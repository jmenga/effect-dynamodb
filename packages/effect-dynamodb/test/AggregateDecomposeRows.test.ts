/**
 * Rows published 1.39.0 wrote through `many` edges with a custom `decompose`, read, updated and
 * moved by `rekey`.
 *
 * Each edge is keyed by a field whose transformation has one type on both sides (it multiplies by
 * 10 on decode). `pass` hands each element back unchanged; `enc` returns the field's stored form
 * (`f / 10`), so its rows are keyed by the value they read as, while decomposing that value again
 * keys them elsewhere (`f / 10` once more). `fixtures/aggregate-decompose-reads-1.39.0.json` holds
 * what 1.39.0 stored and read: generated once from the published package, don't regenerate or "fix"
 * it.
 *
 * - `Defaults`: the field has a decoding default of 5, and `create` leaves it out. 1.39.0 hands
 *   `decompose` 50, the default decoded once.
 * - `Overlaps`: the field's encoded side takes a number or a string, and `create` gives it "5".
 *   1.39.0 hands `decompose` 50.
 * - `Moves`: two lines on each edge, under an id holding a space.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, DateTime, Effect, Exit, Layer, Schema, SchemaGetter } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/aggregate-decompose-reads-1.39.0.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly cases: Record<
    string,
    { readonly rows: ReadonlyArray<Row>; readonly read: Record<string, unknown> }
  >
}
const at = (name: string) => fixture.cases[name]!

// The fixture's models: they must stay what the generator declared.
const times10 = {
  decode: SchemaGetter.transform((value: unknown) => Number(value) * 10),
  encode: SchemaGetter.transform((value: number) => value / 10),
}
const X10 = Schema.Number.pipe(Schema.decodeTo(Schema.Number, times10))
const Defaulted = X10.pipe(Schema.withDecodingDefault(Effect.succeed(5)))
const Overlap = Schema.Union([Schema.Number, Schema.String]).pipe(
  Schema.decodeTo(Schema.Number, times10),
)

/** What each `decompose` was handed. */
const handed: Array<unknown> = []

const world = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "dr", version: 1, escapeKeys })
  const Main = Table.make({ schema, entities: {} })
  const make = (name: string, field: Schema.Top) => {
    const Line = Schema.Struct({
      lineId: Schema.String,
      f: field as typeof X10,
      note: Schema.optional(Schema.String),
    })
    const Model = Schema.Struct({
      id: Schema.String,
      pass: Schema.Array(Line),
      enc: Schema.Array(Line),
    })
    return Aggregate.make(Model, {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: name.toLowerCase() },
      root: { entityType: name },
      edges: {
        pass: Aggregate.many({
          entityType: `${name}Pass`,
          sk: { composite: ["f"] },
          decompose: (lines) => {
            handed.push(lines)
            return (lines as ReadonlyArray<typeof Line.Type>).map((line) => ({ ...line }))
          },
        }),
        enc: Aggregate.many({
          entityType: `${name}Enc`,
          sk: { composite: ["f"] },
          decompose: (lines) =>
            (lines as ReadonlyArray<typeof Line.Type>).map((line) => ({ ...line, f: line.f / 10 })),
        }),
      },
    })
  }
  const aggregates = {
    Defaults: make("Defaults", Defaulted),
    Overlaps: make("Overlaps", Overlap),
    Moves: make("Moves", X10),
  }
  const table = makeRecordingTable()
  const run = <A, E>(body: (db: any) => Effect.Effect<A, E, never>) =>
    Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: {},
        aggregates,
        tables: { Main },
      } as never)
      return yield* body(db)
    }).pipe(
      Effect.provide(Layer.merge(table.layer, Main.layer({ name: "dr" })) as never),
      Effect.exit,
    ) as Effect.Effect<Exit.Exit<A, E>>
  const seed = (rows: ReadonlyArray<Row>) => {
    for (const row of rows) table.items.set(`${row.pk?.S}|${row.sk?.S}`, structuredClone(row))
  }
  /** One partition's rows, in key order. */
  const rowsOf = (pk: string) =>
    [...table.items.values()]
      .filter((row) => row.pk?.S === pk)
      .sort((a, b) => a.sk!.S!.localeCompare(b.sk!.S!))
  return { table, run, seed, rowsOf }
}

const succeed = (exit: Exit.Exit<unknown, unknown>): any => {
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
  return exit.value
}

/** An edge's rows as their sort keys and stored `f`. */
const edgeRows = (rows: ReadonlyArray<Row>, entityType: string) =>
  rows.filter((row) => row.__edd_e__?.S === entityType).map((row) => [row.sk?.S, row.f])

describe("a write hands a custom decompose the caller's value, read once", () => {
  it.effect("a decoding default left out is read once: stored and keyed as on 1.39.0", () =>
    Effect.gen(function* () {
      const { run, rowsOf } = world(false)
      handed.length = 0
      succeed(
        yield* run((db) =>
          db.aggregates.Defaults.create({
            id: "created",
            pass: [{ lineId: "p1" }],
            enc: [{ lineId: "e1" }],
          }),
        ),
      )
      expect(handed).toEqual([[{ lineId: "p1", f: 50 }]])
      expect(rowsOf("$dr#v1#defaults#created")).toEqual(at("defaults created").rows)
      expect(succeed(yield* run((db) => db.aggregates.Defaults.get({ id: "created" })))).toEqual(
        at("defaults created").read,
      )
    }),
  )

  it.effect(
    "a stored form the domain side refuses is read once: stored and keyed as on 1.39.0",
    () =>
      Effect.gen(function* () {
        const { run, rowsOf } = world(false)
        handed.length = 0
        succeed(
          yield* run((db) =>
            db.aggregates.Overlaps.create({
              id: "created",
              pass: [{ lineId: "p1", f: "5" }],
              enc: [{ lineId: "e1", f: "5" }],
            }),
          ),
        )
        expect(handed).toEqual([[{ lineId: "p1", f: 50 }]])
        expect(rowsOf("$dr#v1#overlaps#created")).toEqual(at("overlaps created").rows)
        expect(succeed(yield* run((db) => db.aggregates.Overlaps.get({ id: "created" })))).toEqual(
          at("overlaps created").read,
        )
      }),
  )

  for (const [name, aggregate, added] of [
    ["defaults", "Defaults", { lineId: "e2", note: "new line" }],
    ["overlaps", "Overlaps", { lineId: "e2", f: "5", note: "new line" }],
  ] as const) {
    it.effect(`${name}: an element added to rows 1.39.0 wrote is stored as 1.39.0 stored it`, () =>
      Effect.gen(function* () {
        const { run, seed, rowsOf } = world(false)
        seed(at(`${name} added before`).rows)
        const updated = yield* run((db) =>
          db.aggregates[aggregate].update({ id: "added" }, ({ state }: any) => ({
            ...state,
            enc: [...state.enc, added],
          })),
        )
        succeed(updated)
        expect(rowsOf(`$dr#v1#${name}#added`)).toEqual(at(`${name} added after`).rows)
        expect(succeed(yield* run((db) => db.aggregates[aggregate].get({ id: "added" })))).toEqual(
          at(`${name} added after`).read,
        )
      }),
    )
  }
})

describe("update deletes the rows read, at the keys they're stored under", () => {
  const pk = "$dr#v1#moves#a b"

  it.effect("removing an element deletes its row, whichever convention decompose follows", () =>
    Effect.gen(function* () {
      const { run, seed, rowsOf } = world(false)
      seed(at("moves created").rows)
      succeed(
        yield* run((db) =>
          db.aggregates.Moves.update({ id: "a b" }, ({ state }: any) => ({
            ...state,
            pass: state.pass.filter((line: any) => line.lineId !== "p1"),
            enc: state.enc.filter((line: any) => line.lineId !== "e1"),
          })),
        ),
      )
      const rows = rowsOf(pk)
      expect(edgeRows(rows, "MovesEnc")).toEqual([["$dr#v1#movesenc#0000000000000060", { N: "6" }]])
      // A value handed back unchanged is decoded once more on every update, as on 1.39.0.
      expect(edgeRows(rows, "MovesPass")).toEqual([
        ["$dr#v1#movespass#0000000000006000", { N: "600" }],
      ])
      const got = succeed(yield* run((db) => db.aggregates.Moves.get({ id: "a b" })))
      expect(got.enc).toEqual([{ lineId: "e2", f: 60 }])
      expect(got.pass).toEqual([{ lineId: "p2", f: 6000 }])
    }),
  )

  it.effect("changing a keyed value leaves one row, under the new key", () =>
    Effect.gen(function* () {
      const { run, seed, rowsOf } = world(false)
      seed(at("moves created").rows)
      succeed(
        yield* run((db) =>
          db.aggregates.Moves.update({ id: "a b" }, ({ state }: any) => ({
            ...state,
            enc: state.enc.map((line: any) => (line.lineId === "e1" ? { ...line, f: 70 } : line)),
          })),
        ),
      )
      expect(edgeRows(rowsOf(pk), "MovesEnc")).toEqual([
        ["$dr#v1#movesenc#0000000000000060", { N: "6" }],
        ["$dr#v1#movesenc#0000000000000070", { N: "7" }],
      ])
      const got = succeed(yield* run((db) => db.aggregates.Moves.get({ id: "a b" })))
      expect(got.enc).toEqual([
        { lineId: "e2", f: 60 },
        { lineId: "e1", f: 70 },
      ])
    }),
  )
})

describe("rekey moves a custom decompose's rows by the keys its value decomposes to", () => {
  const before = "$dr#v1#moves#a b"
  const after = "$dr#v1#moves#a%20b"
  const rekey = (run: ReturnType<typeof world>["run"]) =>
    run((db) => db.tables.Main.rekey({ repairIndexKeys: true }))

  it.effect("every row moves with the root, as stored, and reads as it did", () =>
    Effect.gen(function* () {
      const { run, seed, rowsOf } = world(true)
      seed(at("moves created").rows)
      const report = succeed(yield* rekey(run))
      expect(report.conflicts).toEqual([])
      expect(report.moved.aggregate).toBe(5)
      expect(rowsOf(before)).toEqual([])
      expect(rowsOf(after)).toEqual(
        at("moves created").rows.map((row) => ({ ...row, pk: { S: after } })),
      )
      expect(succeed(yield* run((db) => db.aggregates.Moves.get({ id: "a b" })))).toEqual(
        at("moves created").read,
      )
      // Nothing is left to move.
      const again = succeed(yield* rekey(run))
      expect(again.conflicts).toEqual([])
      expect(again.moved.aggregate).toBe(0)
    }),
  )

  it.effect("a row no value of the aggregate keys is left where it is, and the rest move", () =>
    Effect.gen(function* () {
      const { run, seed, rowsOf } = world(true)
      seed(at("moves created").rows)
      // A row of the edge under a key its value doesn't decompose to, either way: 7 reads as 70,
      // keyed 7 as read and 70 as a write's value, and it's stored under 80.
      const stray = {
        ...at("moves created").rows.find((row) => row.__edd_e__?.S === "MovesEnc")!,
        sk: { S: "$dr#v1#movesenc#0000000000000080" },
        lineId: { S: "e3" },
        f: { N: "7" },
      }
      seed([stray])
      const report = succeed(yield* rekey(run))
      expect(report.conflicts).toEqual([])
      expect(report.moved.aggregate).toBe(5)
      expect(rowsOf(before)).toEqual([stray])
      expect(rowsOf(after)).toEqual(
        at("moves created").rows.map((row) => ({ ...row, pk: { S: after } })),
      )
    }),
  )
})

describe("rekey moves the rows the aggregate's value keys, as c32e2bb did", () => {
  it.effect("a second row of a `one` edge, which assembly doesn't take, is left where it is", () =>
    Effect.gen(function* () {
      const schema = DynamoSchema.make({ name: "dr", version: 1, escapeKeys: true })
      const Main = Table.make({ schema, entities: {} })
      const Note = Schema.Struct({ text: Schema.String })
      const Doc = Aggregate.make(Schema.Struct({ id: Schema.String, note: Note }), {
        table: Main,
        schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "doc" },
        root: { entityType: "Doc" },
        edges: { note: Aggregate.one({ entityType: "DocNote" }) },
      })
      const table = makeRecordingTable()
      const pk = "$dr#v1#doc#a b"
      const moved = "$dr#v1#doc#a%20b"
      const rows: ReadonlyArray<Row> = [
        { pk: { S: pk }, sk: { S: "$dr#v1#doc" }, __edd_e__: { S: "Doc" }, id: { S: "a b" } },
        {
          pk: { S: pk },
          sk: { S: "$dr#v1#docnote" },
          __edd_e__: { S: "DocNote" },
          text: { S: "x" },
        },
        // The same edge's row again, under a key nothing composes.
        {
          pk: { S: pk },
          sk: { S: "$dr#v1#docnote#old" },
          __edd_e__: { S: "DocNote" },
          text: { S: "y" },
        },
      ]
      for (const row of rows) table.items.set(`${row.pk?.S}|${row.sk?.S}`, structuredClone(row))
      const report: any = succeed(
        yield* Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: {},
            aggregates: { Doc },
            tables: { Main },
          } as never)
          return yield* db.tables.Main.rekey()
        }).pipe(
          Effect.provide(Layer.merge(table.layer, Main.layer({ name: "dr" })) as never),
          Effect.exit,
        ) as Effect.Effect<Exit.Exit<unknown, unknown>>,
      )
      expect(report.conflicts).toEqual([])
      expect(report.moved.aggregate).toBe(2)
      const byKey = (list: ReadonlyArray<Row>) =>
        [...list].sort((x, y) => `${x.pk?.S}|${x.sk?.S}`.localeCompare(`${y.pk?.S}|${y.sk?.S}`))
      expect(byKey([...table.items.values()])).toEqual(
        byKey([{ ...rows[0]!, pk: { S: moved } }, { ...rows[1]!, pk: { S: moved } }, rows[2]!]),
      )
    }),
  )
})

describe("a custom decompose over a class with no transformation costs no schema check", () => {
  it.effect("create and update check each value as often as without the custom decompose", () =>
    Effect.gen(function* () {
      const counts = (custom: boolean) =>
        Effect.gen(function* () {
          let checks = 0
          const counted = Schema.Number.check(
            Schema.makeFilter(() => {
              checks++
              return true
            }),
          )
          class Line extends Schema.Class<Line>("DecomposeRowsLine")({
            lineId: Schema.String,
            f: counted,
          }) {}
          const schema = DynamoSchema.make({ name: "dr", version: 1 })
          const Main = Table.make({ schema, entities: {} })
          const Orders = Aggregate.make(
            Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) }),
            {
              table: Main,
              schema,
              pk: { field: "pk", composite: ["id"] },
              collection: { name: "order" },
              root: { entityType: "Order" },
              edges: {
                lines: Aggregate.many({
                  entityType: "OrderLine",
                  sk: { composite: ["lineId"] },
                  ...(custom && { decompose: (lines: unknown) => lines as ReadonlyArray<unknown> }),
                }),
              },
            },
          )
          const table = makeRecordingTable()
          const run = <A, E>(body: (db: any) => Effect.Effect<A, E, never>) =>
            Effect.gen(function* () {
              const db: any = yield* DynamoClient.make({
                entities: {},
                aggregates: { Orders },
                tables: { Main },
              } as never)
              return yield* body(db)
            }).pipe(
              Effect.provide(Layer.merge(table.layer, Main.layer({ name: "dr" })) as never),
              Effect.exit,
            ) as Effect.Effect<Exit.Exit<A, E>>
          const seen: Record<string, number> = {}
          checks = 0
          succeed(
            yield* run((db) =>
              db.aggregates.Orders.create({ id: "a", lines: [new Line({ lineId: "l", f: 5 })] }),
            ),
          )
          seen.create = checks
          checks = 0
          succeed(
            yield* run((db) =>
              db.aggregates.Orders.update({ id: "a" }, ({ state }: any) => ({
                ...state,
                lines: state.lines.map((line: any) => ({ ...line, f: 6 })),
              })),
            ),
          )
          seen.update = checks
          return seen
        })
      expect(yield* counts(true)).toEqual(yield* counts(false))
    }),
  )
})

describe("a transformed field under a custom decompose", () => {
  it.effect("a row the reading as written gives isn't put in its stored form unless compared", () =>
    Effect.gen(function* () {
      let checks = 0
      const counted = Schema.Number.check(
        Schema.makeFilter(() => {
          checks++
          return true
        }),
      ).pipe(
        Schema.decodeTo(Schema.Number, {
          decode: SchemaGetter.transform((n: number) => n * 10),
          encode: SchemaGetter.transform((n: number) => n / 10),
        }),
      )
      const schema = DynamoSchema.make({ name: "dc", version: 1 })
      const Main = Table.make({ schema, entities: {} })
      const Orders = Aggregate.make(
        Schema.Struct({
          id: Schema.String,
          lines: Schema.Array(Schema.Struct({ lineId: Schema.String, f: counted })),
        }),
        {
          table: Main,
          schema,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "order" },
          root: { entityType: "Order" },
          edges: {
            lines: Aggregate.many({
              entityType: "OrderLine",
              sk: { composite: ["lineId"] },
              decompose: (lines: unknown) => lines as ReadonlyArray<unknown>,
            }),
          },
        },
      )
      const table = makeRecordingTable()
      const run = <A, E>(body: (db: any) => Effect.Effect<A, E, never>) =>
        Effect.gen(function* () {
          checks = 0
          const db: any = yield* DynamoClient.make({
            entities: {},
            aggregates: { Orders },
            tables: { Main },
          } as never)
          succeed(yield* Effect.exit(body(db)))
          return checks
        }).pipe(
          Effect.provide(Layer.merge(table.layer, Main.layer({ name: "dc" })) as never),
        ) as Effect.Effect<number>
      // The input read as the domain value it is (3), then as 1.39.0 read it for `decompose` (1),
      // and the row's stored form (1).
      expect(
        yield* run((db) =>
          db.aggregates.Orders.create({ id: "a", lines: [{ lineId: "l", f: 5 }] }),
        ),
      ).toBe(5)
      // The rows read (1); the value read, as a write's value is (1); the new state, read as the
      // domain value it is (3); the old rows' stored form (1); the new value, as 1.39.0 read it (1);
      // the new rows' stored form (1). The reading as written keys its row where the reading as
      // read does, so that row is never compared, and never put in its stored form.
      for (const note of ["unchanged", "changed"]) {
        expect(
          yield* run((db) =>
            db.aggregates.Orders.update({ id: "a" }, ({ state }: any) =>
              note === "unchanged"
                ? state
                : { ...state, lines: state.lines.map((line: any) => ({ ...line, f: 6 })) },
            ),
          ),
        ).toBe(8)
      }
      // The rows read (1), their stored form (1), and the value read as a write's value is (1).
      expect(yield* run((db) => db.tables.Main.rekey())).toBe(3)
    }),
  )
})

/**
 * Keyed (`Schema.Record`) edges, whose `decompose` returns a date field's stored form. 1.39.0 stored a
 * keyed edge's attributes as `decompose` returned them; they now go through the element's encoders,
 * as an array edge's always did. `fixtures/aggregate-decompose-keyed-1.39.0.json` holds what 1.39.0
 * stored and read: generated once from the published package, don't regenerate or "fix" it.
 */
describe("a keyed edge whose decompose returns a field's stored form", () => {
  const keyedFixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/aggregate-decompose-keyed-1.39.0.json", import.meta.url),
      "utf8",
    ),
  ) as {
    readonly cases: Record<
      string,
      { readonly rows: ReadonlyArray<Row>; readonly read: Record<string, unknown> }
    >
  }
  const keyedAt = (name: string) => keyedFixture.cases[name]!

  const NumberToDate = Schema.Number.pipe(
    Schema.decodeTo(Schema.Date, {
      decode: SchemaGetter.transform((n: number) => new Date(n)),
      encode: SchemaGetter.transform((d: Date) => d.getTime()),
    }),
  )
  const line = <S extends Schema.Top>(at: S) =>
    Schema.Struct({ lineId: Schema.String, at, note: Schema.optional(Schema.String) })
  const Iso = line(Schema.DateTimeUtcFromString)
  const Millis = line(NumberToDate)
  const Nums = line(Schema.NumberFromString)
  type Lines = Record<string, { readonly lineId: string; readonly at: any; readonly note?: string }>
  const keyed = (lines: ReadonlyArray<unknown>) =>
    Object.fromEntries((lines as ReadonlyArray<{ lineId: string }>).map((l) => [l.lineId, l]))

  const keyedWorld = (options: {
    readonly array?: boolean
    readonly isoOf?: (at: any) => unknown
  }) => {
    const schema = DynamoSchema.make({ name: "dk", version: 1 })
    const Main = Table.make({ schema, entities: {} })
    const holder = <S extends Schema.Top>(element: S) =>
      options.array ? Schema.Array(element) : Schema.Record(Schema.String, element)
    const Model = Schema.Struct({
      id: Schema.String,
      iso: holder(Iso),
      millis: holder(Millis),
      nums: holder(Nums),
    })
    const elements = (lines: unknown) => Object.values(lines as Lines)
    const isoOf = options.isoOf ?? ((at: any) => DateTime.formatIso(at))
    const Dates = Aggregate.make(
      Model as any,
      {
        table: Main,
        schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "dates" },
        root: { entityType: "Dates" },
        edges: {
          iso: Aggregate.many({
            entityType: "DatesIso",
            sk: { composite: ["at"] },
            decompose: (lines) => elements(lines).map((l) => ({ ...l, at: isoOf(l.at) })),
            ...(!options.array && { assemble: keyed }),
          }),
          millis: Aggregate.many({
            entityType: "DatesMillis",
            sk: { composite: ["at"] },
            decompose: (lines) => elements(lines).map((l) => ({ ...l, at: l.at.getTime() })),
            ...(!options.array && { assemble: keyed }),
          }),
          nums: Aggregate.many({
            entityType: "DatesNums",
            sk: { composite: ["at"] },
            decompose: (lines) => elements(lines).map((l) => ({ ...l })),
            ...(!options.array && { assemble: keyed }),
          }),
        },
      } as any,
    )
    const table = makeRecordingTable()
    const run = <A, E>(body: (db: any) => Effect.Effect<A, E, never>) =>
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Dates },
          tables: { Main },
        } as never)
        return yield* body(db)
      }).pipe(
        Effect.provide(Layer.merge(table.layer, Main.layer({ name: "dk" })) as never),
        Effect.exit,
      ) as Effect.Effect<Exit.Exit<A, E>>
    const rows = () =>
      [...table.items.values()]
        .filter((row) => row.pk?.S === "$dk#v1#dates#a")
        .sort((a, b) => a.sk!.S!.localeCompare(b.sk!.S!))
    const seed = (seeded: ReadonlyArray<Row>) => {
      for (const row of seeded) table.items.set(`${row.pk?.S}|${row.sk?.S}`, structuredClone(row))
    }
    return { run, rows, seed }
  }

  const input = (array: boolean) => {
    const of = <A extends { lineId: string }>(l: A) => (array ? [l] : { [l.lineId]: l })
    return {
      id: "a",
      iso: of({ lineId: "l1", at: DateTime.makeUnsafe(0) }),
      millis: of({ lineId: "m1", at: new Date(5) }),
      nums: of({ lineId: "n1", at: 5 }),
    }
  }
  /** What `get` returned, each value in its stored form, as the fixture holds it. */
  const plain = (read: any) => ({
    id: read.id,
    iso: Object.values(read.iso as Lines).map((l) => [
      l.lineId,
      DateTime.formatIso(l.at),
      l.note ?? null,
    ]),
    millis: Object.values(read.millis as Lines).map((l) => [
      l.lineId,
      l.at.getTime(),
      l.note ?? null,
    ]),
    nums: Object.values(read.nums as Lines).map((l) => [l.lineId, l.at, l.note ?? null]),
  })
  /** 1.39.0's rows, but a `nums` row's `at` as its stored form, the text. */
  const asEncoded = (rows: ReadonlyArray<Row>) =>
    rows.map((row) => (row.__edd_e__?.S === "DatesNums" ? { ...row, at: { S: "5" } } : row))
  const noted = (lines: Lines) =>
    Object.fromEntries(Object.entries(lines).map(([k, l]) => [k, { ...l, note: "n" }]))

  it.effect("create stores the dates as 1.39.0 did, and the text field as its stored form", () =>
    Effect.gen(function* () {
      const { run, rows } = keyedWorld({})
      succeed(yield* run((db) => db.aggregates.Dates.create(input(false))))
      expect(rows()).toEqual(asEncoded(keyedAt("created").rows))
      expect(plain(succeed(yield* run((db) => db.aggregates.Dates.get({ id: "a" }))))).toEqual(
        keyedAt("created").read,
      )
    }),
  )

  it.effect("an update of 1.39.0's rows lands, in place", () =>
    Effect.gen(function* () {
      const { run, rows, seed } = keyedWorld({})
      seed(keyedAt("created").rows)
      expect(plain(succeed(yield* run((db) => db.aggregates.Dates.get({ id: "a" }))))).toEqual(
        keyedAt("created").read,
      )
      succeed(
        yield* run((db) =>
          db.aggregates.Dates.update({ id: "a" }, ({ state }: any) => ({
            ...state,
            iso: noted(state.iso),
            millis: noted(state.millis),
            nums: noted(state.nums),
          })),
        ),
      )
      expect(rows()).toEqual(asEncoded(keyedAt("noted").rows))
      expect(plain(succeed(yield* run((db) => db.aggregates.Dates.get({ id: "a" }))))).toEqual(
        keyedAt("noted").read,
      )
    }),
  )

  it.effect("an array edge stores them the same way (1.39.0 failed the create with a defect)", () =>
    Effect.gen(function* () {
      const { run, rows } = keyedWorld({ array: true })
      succeed(yield* run((db) => db.aggregates.Dates.create(input(true))))
      expect(rows()).toEqual(asEncoded(keyedAt("created").rows))
      expect(plain(succeed(yield* run((db) => db.aggregates.Dates.get({ id: "a" }))))).toEqual(
        keyedAt("created").read,
      )
    }),
  )

  it.effect("a value in neither form is refused with EDD-9127, and nothing is written", () =>
    Effect.gen(function* () {
      const { run, rows } = keyedWorld({ isoOf: () => "not a date" })
      const exit = yield* run((db) => db.aggregates.Dates.create(input(false)))
      expect(Exit.isFailure(exit) && !Exit.hasDies(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect((error as { _tag?: string })._tag).toBe("ValidationError")
      expect(String((error as { cause?: unknown }).cause)).toContain("EDD-9127")
      expect(rows()).toEqual([])
    }),
  )
})

describe("a Delete only the content decided is on condition the row is still as read", () => {
  // A sub-aggregate's edge whose `decompose` divides by 10: its row, stored at 50, is keyed there
  // only by the reading as written, so removing the element sends a guarded Delete. Another writer
  // replaces the row between the update's read and its transactions.
  const guarded = () => {
    const schema = DynamoSchema.make({ name: "dg", version: 1 })
    const Main = Table.make({ schema, entities: {} })
    const Line = Schema.Struct({ lineId: Schema.String, f: X10 })
    const Lines = Schema.Struct({ lines: Schema.Array(Line) })
    const Sub = Aggregate.make(Lines, {
      root: { entityType: "Sub" },
      edges: {
        lines: Aggregate.many({
          entityType: "SubLine",
          sk: { composite: ["f"] },
          decompose: (lines) =>
            (lines as ReadonlyArray<typeof Line.Type>).map((line) => ({ ...line, f: line.f / 10 })),
        }),
      },
    } as any)
    const Orders = Aggregate.make(
      Schema.Struct({ id: Schema.String, note: Schema.String, sub: Lines }),
      {
        table: Main,
        schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "orders" },
        root: { entityType: "Order" },
        edges: { sub: (Sub as any).with({}) },
      } as any,
    )
    const table = makeRecordingTable()
    const run = <A, E>(body: (db: any) => Effect.Effect<A, E, never>) =>
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Orders },
          tables: { Main },
        } as never)
        return yield* body(db)
      }).pipe(
        Effect.provide(Layer.merge(table.layer, Main.layer({ name: "dg" })) as never),
        Effect.exit,
      ) as Effect.Effect<Exit.Exit<A, E>>
    return { table, run }
  }
  const lineKey = "$dg#v1#subline#0000000000000050"
  const lineRow = (table: ReturnType<typeof makeRecordingTable>) =>
    [...table.items.values()].find((row) => row.sk?.S === lineKey)
  /** Another writer's row at the line's key, put before the `n`th transaction is answered. */
  const replaceBefore = (table: ReturnType<typeof makeRecordingTable>, n: number) => {
    let seen = 0
    table.hooks.onRequest = (request) => {
      if (request.command !== "TransactWriteItems" || ++seen !== n) return
      table.hooks.onRequest = undefined
      const row = lineRow(table)!
      table.items.set(`${row.pk!.S}|${row.sk!.S}`, { ...row, lineId: { S: "other" } })
    }
  }

  it.effect("with no other write, the row is deleted, and nothing else is sent", () =>
    Effect.gen(function* () {
      const { table, run } = guarded()
      succeed(
        yield* run((db) =>
          db.aggregates.Orders.create({
            id: "o",
            note: "n",
            sub: { lines: [{ lineId: "a", f: 50 }] },
          }),
        ),
      )
      expect(lineRow(table)?.f).toEqual({ N: "5" })
      table.requests.length = 0
      succeed(
        yield* run((db) =>
          db.aggregates.Orders.update({ id: "o" }, ({ state }: any) => ({
            ...state,
            sub: { lines: [] },
          })),
        ),
      )
      expect(lineRow(table)).toBeUndefined()
      expect(table.requests.map((request) => request.command)).toEqual([
        "Query",
        "TransactWriteItems",
      ])
      const [del] = (table.requests[1]!.input.TransactItems as ReadonlyArray<any>).flatMap(
        (item) => (item.Delete === undefined ? [] : [item.Delete]),
      )
      expect(del.Key.sk).toEqual({ S: lineKey })
      expect(del.ConditionExpression).toBe(
        "attribute_exists(#gpk) AND #g0 = :g0 AND #g1 = :g1 AND #g2 = :g2",
      )
    }),
  )

  it.effect(
    "replaced in its own transaction's group: the update reads again and keeps the row",
    () =>
      Effect.gen(function* () {
        const { table, run } = guarded()
        succeed(
          yield* run((db) =>
            db.aggregates.Orders.create({
              id: "o",
              note: "n",
              sub: { lines: [{ lineId: "a", f: 50 }] },
            }),
          ),
        )
        table.requests.length = 0
        replaceBefore(table, 1)
        const done = succeed(
          yield* run((db) =>
            db.aggregates.Orders.update({ id: "o" }, ({ state }: any) => ({
              ...state,
              sub: { lines: state.sub.lines.filter((line: any) => line.lineId !== "a") },
            })),
          ),
        )
        // Read again, the row is the other writer's line, which the update keeps: it's written as
        // the group's lines are (a value read back keys elsewhere, as on 1.39.0), and not deleted.
        expect(done.sub.lines).toEqual([{ lineId: "other", f: 50 }])
        expect(lineRow(table)).toMatchObject({ lineId: { S: "other" }, f: { N: "5" } })
        expect(table.requests.map((request) => request.command)).toEqual([
          "Query",
          "TransactWriteItems",
          "Query",
          "TransactWriteItems",
        ])
        const deleted = (table.requests[3]!.input.TransactItems as ReadonlyArray<any>).flatMap(
          (item) => (item.Delete === undefined ? [] : [item.Delete.Key.sk.S]),
        )
        expect(deleted).not.toContain(lineKey)
      }),
  )

  it.effect(
    "replaced after an earlier group committed: reported as cancelled, and the row is kept",
    () =>
      Effect.gen(function* () {
        const { table, run } = guarded()
        succeed(
          yield* run((db) =>
            db.aggregates.Orders.create({
              id: "o",
              note: "n",
              sub: { lines: [{ lineId: "a", f: 50 }] },
            }),
          ),
        )
        table.requests.length = 0
        replaceBefore(table, 2)
        const exit = yield* run((db) =>
          db.aggregates.Orders.update({ id: "o" }, ({ state }: any) => ({
            ...state,
            note: "changed",
            sub: { lines: state.sub.lines.filter((line: any) => line.lineId !== "a") },
          })),
        )
        expect(Exit.isFailure(exit) && (Cause.squash(exit.cause) as any)._tag).toBe(
          "TransactionCancelled",
        )
        expect(lineRow(table)?.lineId).toEqual({ S: "other" })
        expect(table.requests.map((request) => request.command)).toEqual([
          "Query",
          "TransactWriteItems",
          "TransactWriteItems",
        ])
      }),
  )
})
