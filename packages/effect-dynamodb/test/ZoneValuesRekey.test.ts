/**
 * Named zones stored as values by published 1.38.0 to 1.40.0 on Effect 4.1.3 (#242). Each stored
 * named zone's map gained a `resolvedId` there, and the library's ISO text of a zoned date named the
 * zone by the name it was given; a write stores neither now, so an equality condition or filter, whose
 * operand is what a write stores, matched none of those rows. `rekey` rewrites them, at every place
 * the schema puts a zone (a field, a list, an `Option`, a struct; items, snapshots, tombstones and
 * time-series events; in place, or in the move of a row keyed by one), and leaves a value no schema
 * types and the text of Effect's own string codecs. The rows are 1.40.0's own, on 4.1.3
 * (`fixtures/zone-values-1.40.0-effect-4.1.3.json`) and on 4.1.2 (`…-4.1.2.json`, where nothing
 * needs rewriting); every assertion holds on either Effect.
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>
type Fixture = {
  readonly generatedFrom: string
  readonly results: Record<string, unknown>
  readonly rows: ReadonlyArray<Row>
}
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Fixture
const on413 = fixture("zone-values-1.40.0-effect-4.1.3.json")
const on412 = fixture("zone-values-1.40.0-effect-4.1.2.json")

const pk = { field: "pk", composite: ["id"] } as const
const Placed = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    tz: Schema.TimeZoneNamed,
    tzs: Schema.optional(Schema.Array(Schema.TimeZoneNamed)),
    opt: Schema.optional(Schema.Option(Schema.TimeZoneNamed)),
    nested: Schema.optional(Schema.Struct({ z: Schema.TimeZoneNamed, label: Schema.String })),
    at: Schema.optional(Schema.DateTimeZoned),
    codec: Schema.optional(Schema.TimeZoneNamedFromString),
    u: Schema.optional(Schema.Unknown),
    note: Schema.optional(Schema.String),
  }),
  entityType: "Placed",
  primaryKey: { pk, sk: { field: "sk", composite: [] } },
  versioned: { retain: true },
  softDelete: true,
})
const Keyed = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    kd: Schema.DateTimeZoned,
    tz: Schema.TimeZoneNamed,
    note: Schema.optional(Schema.String),
  }),
  entityType: "Keyed",
  primaryKey: { pk, sk: { field: "sk", composite: ["kd"] } },
  versioned: { retain: true },
})
const Reading = Entity.make({
  model: Schema.Struct({ id: Schema.String, n: Schema.Number, tz: Schema.TimeZoneNamed }),
  entityType: "Reading",
  primaryKey: { pk, sk: { field: "sk", composite: [] } },
  timeSeries: {
    orderBy: "n",
    appendInput: Schema.Struct({ id: Schema.String, n: Schema.Number, tz: Schema.TimeZoneNamed }),
  },
})
const Packed = Entity.make({
  model: DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      p: Schema.Struct({ z: Schema.TimeZoneNamed, u: Schema.Unknown }),
    }),
    { p: { storedAs: DynamoModel.Packed({ format: "json" }) } },
  ),
  entityType: "Packed",
  primaryKey: { pk, sk: { field: "sk", composite: [] } },
})
const entities = { Placed, Keyed, Reading, Packed }
const Main = Table.make({ schema: DynamoSchema.make({ name: "zv", version: 1 }), entities })

const zone = (name: string) => DateTime.zoneMakeNamedUnsafe(name)
const MARKER = "~effect/DateTime/TimeZone"

const seeded = (rows: ReadonlyArray<Row>) => {
  const table = makeRecordingTable()
  for (const row of rows)
    table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
  return table
}
const dump = (table: ReturnType<typeof makeRecordingTable>) =>
  [...table.items.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, row]) => JSON.stringify(row))
const rowAt = (table: ReturnType<typeof makeRecordingTable>, id: string, sk: string) =>
  [...table.items.values()].find((row) => row.pk?.S?.endsWith(`#id_${id}`) && row.sk?.S === sk)

const run = <A>(
  table: ReturnType<typeof makeRecordingTable>,
  body: (db: any) => Effect.Effect<A, unknown, unknown>,
) =>
  Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities, tables: { Main } })
    return yield* body(db)
  }).pipe(Effect.provide(Main.layer({ name: "zv" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >

/** What equality filters find, one per kind of row, and the moved item and its snapshot by key. */
const found = (db: any) =>
  Effect.gen(function* () {
    const count = (query: any) =>
      Effect.map(query.collect() as Effect.Effect<ReadonlyArray<unknown>>, (rows) => rows.length)
    return {
      etc: yield* count(db.entities.Placed.scan().filter({ tz: zone("Etc/UTC") })),
      london: yield* count(db.entities.Placed.scan().filter({ tz: zone("Europe/London") })),
      callback: yield* count(
        db.entities.Placed.scan().filter((t: any, { eq }: any) => eq(t.tz, zone("UTC"))),
      ),
      keyed: yield* count(db.entities.Keyed.scan().filter({ tz: zone("GMT") })),
      versions: yield* count(
        db.entities.Placed.versions({ id: "p1" }).filter({ tz: zone("Etc/UTC") }),
      ),
      events: yield* count(db.entities.Reading.history({ id: "r1" }).filter({ tz: zone("GMT") })),
    }
  })

/** Whether any stored attribute but `u` (no schema types it) holds a zone's map with `resolvedId`. */
const typedResolvedIds = (table: ReturnType<typeof makeRecordingTable>) =>
  [...table.items.values()].flatMap((row) =>
    Object.entries(row)
      .filter(([attr, value]) => attr !== "u" && JSON.stringify(value).includes('"resolvedId"'))
      .map(([attr]) => `${row.pk?.S}|${row.sk?.S}|${attr}`),
  )

describe("named zones published 1.40.0 stored as values", () => {
  it("the fixtures are 1.40.0's: on 4.1.3 every stored zone holds resolvedId, on 4.1.2 none", () => {
    expect(on413.generatedFrom).toBe("effect-dynamodb@1.40.0 + effect@4.1.3")
    expect(on412.generatedFrom).toBe("effect-dynamodb@1.40.0 + effect@4.1.2")
    for (const written of [on413, on412]) {
      expect(written.rows).toHaveLength(12)
      // 1.40.0's own equality filters found them, on the Effect it wrote with.
      expect([written.results.filterTzEtc, written.results.filterKeyedTz]).toEqual([1, 2])
    }
    expect(JSON.stringify(on413.rows)).toContain('"resolvedId"')
    expect(JSON.stringify(on413.rows)).toContain("[Asia/Kolkata]")
    expect(JSON.stringify(on412.rows)).not.toContain('"resolvedId"')
  })

  it.effect(
    "an equality filter misses 4.1.3's rows until rekey rewrites their zones; a dry run counts them",
    () =>
      Effect.gen(function* () {
        const table = seeded(on413.rows)
        yield* run(table, (db) =>
          Effect.gen(function* () {
            expect(yield* found(db)).toEqual({
              etc: 0,
              london: 0,
              callback: 0,
              keyed: 0,
              versions: 0,
              events: 0,
            })
            const before = dump(table)
            const dry = yield* db.tables.Main.rekey({ dryRun: true })
            expect(dump(table)).toEqual(before)
            const report = yield* db.tables.Main.rekey()
            expect(report.conflicts).toEqual([])
            // Every row but none: p1, its snapshot, p2, its snapshot, p3's snapshot and tombstone,
            // k1 (moved, keyed by a zoned date in Etc/UTC) and its snapshot (moved), k2 and its
            // snapshot, r1 and its event.
            expect(report.zonesRewritten).toBe(12)
            expect(dry.zonesRewritten).toBe(report.zonesRewritten)
            expect(report.byMember.Placed?.zonesRewritten).toBe(6)
            expect([report.moved.item, report.moved.snapshot]).toEqual([1, 1])
            expect(dry.moved).toEqual(report.moved)
            expect(typedResolvedIds(table)).toEqual([])
            expect(yield* found(db)).toEqual({
              etc: 1,
              london: 1,
              callback: 1,
              keyed: 2,
              versions: 1,
              events: 1,
            })
            const p1 = rowAt(table, "p1", "$zv#v1#placed")!
            // A zone's map as a write stores it: under the resolved name, no resolvedId.
            expect(p1.tz).toEqual({
              M: {
                format: { M: {} },
                id: { S: "UTC" },
                [MARKER]: { S: MARKER },
                _tag: { S: "Named" },
              },
            })
            expect(p1.opt?.M?.value?.M?.id).toEqual({ S: p1.nested?.M?.z?.M?.id?.S })
            expect(p1.at).toEqual({ S: "2023-11-15T03:43:20.000+05:30[Asia/Calcutta]" })
            // Text a string field holds, and an Effect codec's text, are left: neither is the library's.
            expect(p1.nested?.M?.label).toEqual({ S: "Etc/UTC" })
            expect(p1.codec).toEqual({ S: "Etc/UTC" })
            // No schema types `u`: it's left as read.
            expect(JSON.stringify(p1.u)).toContain('"resolvedId"')
            const item = yield* db.entities.Placed.get({ id: "p1" })
            expect(item.note).toBe("b")
            expect(DateTime.zoneToString(item.tz)).toBe("UTC")
            expect(Option.isSome(item.opt)).toBe(true)
            const after = dump(table)
            table.take()
            const again = yield* db.tables.Main.rekey()
            expect([again.zonesRewritten, again.unchanged]).toEqual([0, 12])
            expect(dump(table)).toEqual(after)
            expect([...new Set(table.take().map((request) => request.command))]).toEqual(["Scan"])
          }),
        )
      }),
  )

  it.effect(
    "4.1.2's rows hold nothing to rewrite: rekey sends only its scan, and no byte moves",
    () =>
      Effect.gen(function* () {
        const table = seeded(on412.rows)
        yield* run(table, (db) =>
          Effect.gen(function* () {
            expect(yield* found(db)).toEqual({
              etc: 1,
              london: 1,
              callback: 1,
              keyed: 2,
              versions: 1,
              events: 1,
            })
            const before = dump(table)
            table.take()
            const report = yield* db.tables.Main.rekey()
            expect([report.zonesRewritten, report.unchanged, report.conflicts]).toEqual([0, 12, []])
            expect(dump(table)).toEqual(before)
            expect([...new Set(table.take().map((request) => request.command))]).toEqual(["Scan"])
          }),
        )
      }),
  )

  it.effect(
    "a packed attribute holding one at a typed place is packed again, as a write packs it",
    () =>
      Effect.gen(function* () {
        // No release wrote this (1.40.0 refused to pack a zone): a packed map read back natively
        // and written into a packed field's untyped place, and a typed one beside it.
        const given = {
          format: {},
          id: "Etc/UTC",
          resolvedId: "UTC",
          [MARKER]: MARKER,
          _tag: "Named",
        }
        const table = seeded([
          {
            pk: { S: "$zv#v1#packed#id_a" },
            sk: { S: "$zv#v1#packed" },
            __edd_e__: { S: "Packed" },
            id: { S: "a" },
            p: { S: JSON.stringify({ z: given, u: given }) },
          },
        ])
        yield* run(table, (db) =>
          Effect.gen(function* () {
            const dry = yield* db.tables.Main.rekey({ dryRun: true })
            expect(dry.zonesRewritten).toBe(1)
            const report = yield* db.tables.Main.rekey()
            expect(report.zonesRewritten).toBe(1)
            const stored = [...table.items.values()][0]!.p!.S!
            const named = { format: {}, id: "UTC", [MARKER]: MARKER, _tag: "Named" }
            // The whole attribute is written as a write packs it, its untyped place too.
            expect(JSON.parse(stored)).toEqual({ z: named, u: named })
            const item = yield* db.entities.Packed.get({ id: "a" })
            expect(DateTime.zoneToString(item.p.z)).toBe("UTC")
            const again = yield* db.tables.Main.rekey()
            expect(again.zonesRewritten).toBe(0)
          }),
        )
      }),
  )
})

describe("named, left as 1.40.0: a zone in a sparse map's entry or an aggregate's row", () => {
  // `rekey` rewrites a zone where the schema puts one in an entity's field. A sparse map's entries
  // (top-level attributes of their own) and an aggregate's rows under their current keys it leaves
  // as 1.40.0 stored them on 4.1.3, `resolvedId` included, until they're next written.
  const Sparse = Entity.make({
    model: DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        zones: Schema.Record(Schema.String, Schema.TimeZoneNamed),
      }),
      { zones: { storedAs: DynamoModel.SparseMap() } },
    ),
    entityType: "Sparse",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const schema = DynamoSchema.make({ name: "zs", version: 1 })
  const Base = Table.make({ schema, entities: { Sparse } })
  const Roots = Aggregate.make(
    Schema.Struct({ id: Schema.String, tz: Schema.TimeZoneNamed, note: Schema.String }),
    {
      table: Base,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "roots" },
      root: { entityType: "Root" },
      edges: {},
    },
  )
  const Main = { ...Base, aggregates: { Roots } }
  const kolkata = () => DateTime.zoneMakeNamedUnsafe("Asia/Kolkata")
  // The map 1.40.0 stored on 4.1.3: the given name, and `resolvedId`.
  const as140 = (value: AttributeValue | undefined) => ({
    M: {
      ...(value as { M: Record<string, AttributeValue> }).M,
      id: { S: "Asia/Kolkata" },
      resolvedId: { S: "Asia/Calcutta" },
    },
  })

  it.effect("rekey leaves the zone as it is", () => {
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Sparse },
        aggregates: { Roots },
        tables: { Main },
      } as never) as Effect.Effect<any, never, any>
      yield* db.entities.Sparse.put({ id: "s", zones: { a: kolkata() } }).asEffect()
      yield* db.aggregates.Roots.create({ id: "r", tz: kolkata(), note: "n" })
      const rows = [...table.items.entries()]
      const [sparseKey, sparseRow] = rows.find(([, row]) => row.__edd_e__?.S === "Sparse")!
      const [rootKey, rootRow] = rows.find(([, row]) => row.__edd_e__?.S === "Root")!
      const entry = Object.keys(sparseRow).find((name) => name.startsWith("zones"))!
      // As this release writes them: the resolved name, no `resolvedId`.
      for (const written of [sparseRow[entry], rootRow.tz]) {
        expect(written?.M?.id).toEqual({ S: "Asia/Calcutta" })
        expect(written?.M?.resolvedId).toBeUndefined()
      }
      table.items.set(sparseKey, { ...sparseRow, [entry]: as140(sparseRow[entry]) })
      table.items.set(rootKey, { ...rootRow, tz: as140(rootRow.tz) })
      const before = structuredClone([...table.items.entries()])
      const report = yield* db.tables.Main.rekey({})
      expect(report.zonesRewritten).toBe(0)
      expect([...table.items.entries()]).toEqual(before)
    }).pipe(
      Effect.provide(Base.layer({ name: "zs" })),
      Effect.provide(table.layer),
    ) as Effect.Effect<void, unknown>
  })
})
