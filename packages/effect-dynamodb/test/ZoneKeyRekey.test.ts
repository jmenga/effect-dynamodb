/**
 * Rows keyed by a zone's given name (#242 B1). Effect 4.1.3 keeps the name a zone was made from as
 * its `id` (`Etc/UTC`), where 4.1.2 held the name `Intl` resolves it to (`UTC`), and 1.38.0 to
 * 1.40.0 composed a zone's key text from its `id`. Every key is now composed from the resolved name
 * on either Effect (`storedZoneName`), the text 1.40.0 composed on 4.1.2, so a row those releases
 * wrote on 4.1.3 under an alias or a renamed zone is under a key nothing composes: `get` misses it,
 * an accessor doesn't see it, and a `delete` by key reports success and leaves it. `rekey` reads
 * such a row's values with each zone under the name it was given (`givenZoneReading`, a rekey-only
 * reading), recognises its key as an earlier position of the row, and moves it, its tombstone,
 * snapshots, events, unique sentinels and index keys with it.
 *
 * The rows are published 1.40.0's own, on Effect 4.1.3 (`fixtures/zone-keys-1.40.0-effect-4.1.3.json`:
 * a zoned date, a zone's name and a zone through Effect's string codecs, and a zoned date stored
 * as ISO text), and published 1.39.0's, on 4.1.3, for a zone itself, stored as its map
 * (`fixtures/named-zone-keys-1.39.0-effect-4.1.3.json`; 1.40.0 refused one as a key composite).
 * `europe/london` is a zone given in another case, which 4.1.3 names as `Intl` does
 * (`Europe/London`), and `America/New_York` a zone with no other name: neither row moves.
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Row = Record<string, AttributeValue>

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
    readonly results: Record<string, Record<string, unknown>>
    readonly rows: ReadonlyArray<Row>
  }

const ZONES = ["Etc/UTC", "Asia/Kolkata", "europe/london", "US/Pacific", "America/New_York"]
/** Zones whose given name isn't the one `Intl` resolves it to: their rows are under old keys. */
const MOVED = new Set(["Etc/UTC", "Asia/Kolkata", "US/Pacific"])
const zone = (name: string) => DateTime.zoneMakeNamedUnsafe(name)
const at = (name: string, ms: number) => DateTime.makeZonedUnsafe(ms, { timeZone: zone(name) })

/** A row's keys, a tombstone's deletion time as one text. */
const keysOf = (rows: ReadonlyArray<Row>) =>
  rows
    .map((row) =>
      [row.pk?.S, row.sk?.S, row.gsi1pk?.S, row.gsi1sk?.S]
        .map((text) => (text ?? "").replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<at>"))
        .join("|"),
    )
    .sort()

const rowsOf = (table: ReturnType<typeof makeRecordingTable>) =>
  [...table.items.values()] as unknown as ReadonlyArray<Row>

const seeded = (rows: ReadonlyArray<Row>) => {
  const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
  for (const row of rows)
    table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
  return table
}

const notFound = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => Exit.isFailure(exit))

// ---------------------------------------------------------------------------
// Published 1.40.0 on Effect 4.1.3: Effect's string codecs, and a zoned date
// ---------------------------------------------------------------------------

const written140 = load("zone-keys-1.40.0-effect-4.1.3.json")

const codecs = (() => {
  const model = Schema.Struct({
    id: Schema.String,
    at: Schema.DateTimeZonedFromString,
    tz: Schema.TimeZoneNamedFromString,
    tzf: Schema.TimeZoneFromString,
    note: Schema.optional(Schema.String),
  })
  const Soft = Entity.make({
    model,
    entityType: "Soft",
    primaryKey: {
      pk: { field: "pk", composite: ["id", "tz"] },
      sk: { field: "sk", composite: ["at"] },
    },
    softDelete: true,
  })
  const Retained = Entity.make({
    model,
    entityType: "Retained",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["at"] } },
    versioned: { retain: true },
  })
  const Unique = Entity.make({
    model,
    entityType: "Unique",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    unique: { byTz: ["tz"], byAt: ["at"] },
  })
  const Indexed = Entity.make({
    model,
    entityType: "Indexed",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    indexes: {
      byZone: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["tzf"] },
        sk: { field: "gsi1sk", composite: ["at"] },
      },
    },
  })
  const Series = Entity.make({
    model,
    entityType: "Series",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["tz"] } },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({
        id: Schema.String,
        tz: Schema.TimeZoneNamedFromString,
        at: Schema.DateTimeZonedFromString,
        note: Schema.optional(Schema.String),
      }),
    },
  })
  const Instant = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      zd: Schema.DateTimeZoned,
      note: Schema.optional(Schema.String),
    }),
    entityType: "Instant",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["zd"] } },
    unique: { byZd: ["zd"] },
  })
  const schema = DynamoSchema.make({ name: "zones", version: 1 })
  const Base = Table.make({
    schema,
    entities: { Soft, Retained, Unique, Indexed, Series, Instant },
  })
  const Roots = Aggregate.make(
    Schema.Struct({ id: Schema.String, tz: Schema.TimeZoneNamedFromString, note: Schema.String }),
    {
      table: Base,
      schema,
      pk: { field: "pk", composite: ["id", "tz"] },
      collection: { name: "roots" },
      root: { entityType: "Root" },
      edges: {},
    },
  )
  const Main = { ...Base, aggregates: { Roots } }
  return { Soft, Retained, Unique, Indexed, Series, Instant, Roots, Base, Main }
})()

const onCodecs = <A>(
  table: ReturnType<typeof makeRecordingTable>,
  body: (db: any) => Effect.Effect<A, unknown, any>,
) =>
  Effect.gen(function* () {
    const { Soft, Retained, Unique, Indexed, Series, Instant, Roots, Main } = codecs
    const db = yield* DynamoClient.make({
      entities: { Soft, Retained, Unique, Indexed, Series, Instant },
      aggregates: { Roots },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    return yield* body(db)
  }).pipe(
    Effect.provide(codecs.Base.layer({ name: "t" })),
    Effect.provide(table.layer),
  ) as Effect.Effect<A, unknown>

/** The generator's steps, by the head: the rows a table written by it holds, keys and all. */
const writeAll = (db: any) =>
  Effect.gen(function* () {
    for (const [n, name] of ZONES.entries()) {
      const t0 = at(name, 0)
      const all = { at: t0, tz: zone(name), tzf: zone(name) }
      yield* db.entities.Soft.put({ id: `a${n}`, ...all }).asEffect()
      yield* db.entities.Soft.delete({ id: `a${n}`, tz: zone(name), at: t0 }).asEffect()
      yield* db.entities.Soft.put({ id: `b${n}`, ...all }).asEffect()
      yield* db.entities.Retained.put({ id: `r${n}`, ...all }).asEffect()
      yield* db.entities.Retained.update({ id: `r${n}`, at: t0 })
        .set({ note: "x" })
        .asEffect()
      yield* db.entities.Unique.put({ id: `u${n}`, ...all }).asEffect()
      yield* db.entities.Indexed.put({ id: `i${n}`, ...all }).asEffect()
      yield* db.entities.Series.put({ id: `s${n}`, ...all }).asEffect()
      for (const [ms, note] of [
        [60_000, "one"],
        [120_000, "two"],
      ] as const) {
        yield* db.entities.Series.append({
          id: `s${n}`,
          tz: zone(name),
          at: at(name, ms),
          note,
        }).asEffect()
      }
      yield* db.entities.Instant.put({ id: `z${n}`, zd: t0 }).asEffect()
      yield* db.aggregates.Roots.create({ id: `g${n}`, tz: zone(name), note: "one" })
    }
  })

/** Is each of a zone's items found where its key says, by every path that keys one? */
const reach = (db: any, n: number, name: string) =>
  Effect.gen(function* () {
    const t0 = at(name, 0)
    return {
      soft: !(yield* notFound(db.entities.Soft.get({ id: `b${n}`, tz: zone(name), at: t0 }))),
      retained: !(yield* notFound(db.entities.Retained.get({ id: `r${n}`, at: t0 }))),
      series: !(yield* notFound(db.entities.Series.get({ id: `s${n}`, tz: zone(name) }))),
      instant: !(yield* notFound(db.entities.Instant.get({ id: `z${n}`, zd: t0 }))),
      root: !(yield* notFound(db.aggregates.Roots.get({ id: `g${n}`, tz: zone(name) }))),
      indexed: (yield* db.entities.Indexed.byZone({ tzf: zone(name) }).collect()).length,
    }
  })

const REACHED = {
  soft: true,
  retained: true,
  series: true,
  instant: true,
  root: true,
  indexed: 1,
}

describe("rows published 1.40.0 keyed by a zone's given name on Effect 4.1.3", () => {
  it("the fixture is 1.40.0's, on 4.1.3, and 1.40.0 found every row again there", () => {
    expect(written140.rows).toHaveLength(70)
    for (const name of ZONES) {
      const results = written140.results[name]!
      for (const [step, outcome] of Object.entries(results)) {
        expect([step, outcome]).toEqual([step, step === "indexedQuery" ? 1 : "ok"])
      }
    }
    // Keyed by the name each zone was given, where the head keys the resolved one.
    const keys = keysOf(written140.rows).join("\n")
    expect(keys).toContain("$zones#v1#soft#id_b0#tz_etc/utc|$zones#v1#soft#at_1970-01-01t00:00")
    expect(keys).toContain("[asia/kolkata]")
    expect(keys).toContain("$zones#v1#unique.bytz#us/pacific|")
    expect(keys).not.toContain("asia/calcutta")
  })

  it.effect("before rekey, an alias zone's rows are unreachable; a delete by key leaves them", () =>
    Effect.gen(function* () {
      const table = seeded(written140.rows)
      yield* onCodecs(table, (db) =>
        Effect.gen(function* () {
          for (const [n, name] of ZONES.entries()) {
            const reached = yield* reach(db, n, name)
            if (MOVED.has(name)) {
              expect([name, reached]).toEqual([
                name,
                {
                  soft: false,
                  retained: false,
                  series: false,
                  instant: false,
                  root: false,
                  indexed: 0,
                },
              ])
            } else {
              expect([name, reached]).toEqual([name, REACHED])
            }
          }
          // A delete by key reports success and leaves the row; one that reads the item first (a
          // soft delete, a unique constraint's release) reports it missing.
          const before = keysOf(rowsOf(table))
          const t0 = at("Asia/Kolkata", 0)
          yield* db.entities.Retained.delete({ id: "r1", at: t0 }).asEffect()
          yield* db.entities.Series.delete({ id: "s1", tz: zone("Asia/Kolkata") }).asEffect()
          for (const exit of [
            yield* Effect.exit(
              db.entities.Soft.delete({ id: "b1", tz: zone("Asia/Kolkata"), at: t0 }).asEffect(),
            ),
            yield* Effect.exit(db.entities.Instant.delete({ id: "z1", zd: t0 }).asEffect()),
          ]) {
            expect(JSON.stringify(exit)).toContain("ItemNotFound")
          }
          expect(keysOf(rowsOf(table))).toEqual(before)
        }),
      )
    }),
  )

  it.effect("rekey moves every alias zone's row to the key the head writes, and only those", () =>
    Effect.gen(function* () {
      const table = seeded(written140.rows)
      const fresh = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
      yield* onCodecs(fresh, writeAll)
      const controls = (rows: ReadonlyArray<Row>) =>
        rows.filter((row) =>
          ["europe/london", "america/new_york"].some((text) => JSON.stringify(row).includes(text)),
        )
      const untouched = structuredClone(controls(rowsOf(table)))
      yield* onCodecs(table, (db) =>
        Effect.gen(function* () {
          const dry = yield* db.tables.Main.rekey({ dryRun: true, repairIndexKeys: true })
          expect(keysOf(rowsOf(table))).toEqual(keysOf(written140.rows))
          const report = yield* db.tables.Main.rekey({ repairIndexKeys: true })
          expect(report.conflicts).toEqual([])
          expect(Object.values(report.skipped).every((n) => n === 0)).toBe(true)
          // Per alias zone: the Soft tombstone and item, the Retained item and its snapshot, the
          // Unique and Indexed items' sentinels and index key, the Series item and its events,
          // the Instant item and its sentinel, and the root.
          expect(report.moved).toEqual(dry.moved)
          expect(report.sentinelsMoved).toBe(dry.sentinelsMoved)
          expect(report.sentinelsMoved).toBe(3 * 3)
          expect(report.indexKeysRewritten).toBe(3)
          expect(report.indexKeysRewritten).toBe(dry.indexKeysRewritten)
          expect(Object.values(report.moved).reduce((a: number, b) => a + (b as number), 0)).toBe(
            3 * 9,
          )
          // Where the head itself writes each row.
          expect(keysOf(rowsOf(table))).toEqual(keysOf(rowsOf(fresh)))
          expect(controls(rowsOf(table))).toEqual(untouched)
          const again = yield* db.tables.Main.rekey({ repairIndexKeys: true })
          expect(Object.values(again.moved).every((n) => n === 0)).toBe(true)
          expect(again.sentinelsMoved).toBe(0)
          expect(again.indexKeysRewritten).toBe(0)
          expect(again.indexKeys.lagging).toBe(0)
          expect(again.conflicts).toEqual([])
        }),
      )
    }),
  )

  it.effect("after rekey, get, update, the accessors, restore and delete all find each row", () =>
    Effect.gen(function* () {
      const table = seeded(written140.rows)
      yield* onCodecs(table, (db) =>
        Effect.gen(function* () {
          yield* db.tables.Main.rekey({ repairIndexKeys: true })
          for (const [n, name] of ZONES.entries()) {
            const t0 = at(name, 0)
            expect([name, yield* reach(db, n, name)]).toEqual([name, REACHED])
            expect(
              (yield* db.entities.Retained.getVersion({ id: `r${n}`, at: t0 }, 1)).note,
            ).toBeUndefined()
            // Its sentinels hold the value: another item can't take it.
            const taken = yield* Effect.exit(
              db.entities.Unique.put({
                id: `other${n}`,
                at: t0,
                tz: zone(name),
                tzf: zone(name),
              }).asEffect(),
            )
            expect(JSON.stringify(taken)).toContain("UniqueConstraintViolation")
            const updated = yield* db.entities.Soft.update({ id: `b${n}`, tz: zone(name), at: t0 })
              .set({ note: "moved" })
              .asEffect()
            expect(updated.note).toBe("moved")
            yield* db.entities.Soft.restore({ id: `a${n}`, tz: zone(name), at: t0 })
            yield* db.entities.Soft.get({ id: `a${n}`, tz: zone(name), at: t0 })
            yield* db.entities.Unique.delete({ id: `u${n}` }).asEffect()
            yield* db.entities.Instant.delete({ id: `z${n}`, zd: t0 }).asEffect()
            yield* db.entities.Indexed.delete({ id: `i${n}` }).asEffect()
            expect(yield* db.entities.Indexed.byZone({ tzf: zone(name) }).collect()).toEqual([])
            yield* db.aggregates.Roots.delete({ id: `g${n}`, tz: zone(name) })
          }
          // Each delete released its sentinels and took its row.
          const left = rowsOf(table).map((row) => row.__edd_e__?.S)
          for (const gone of ["Unique", "Instant", "Indexed", "Root"]) {
            expect(left.filter((type) => type?.startsWith(gone))).toEqual([])
          }
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------------------
// Published 1.39.0 on Effect 4.1.3: a zone itself, stored as its map
// ---------------------------------------------------------------------------

const written139 = load("named-zone-keys-1.39.0-effect-4.1.3.json")

const named = (() => {
  const model = Schema.Struct({
    id: Schema.String,
    tz: Schema.TimeZoneNamed,
    note: Schema.optional(Schema.String),
  })
  const Keyed = Entity.make({
    model,
    entityType: "Keyed",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["tz"] } },
  })
  const Unique = Entity.make({
    model,
    entityType: "Unique",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    unique: { byTz: ["tz"] },
  })
  const Indexed = Entity.make({
    model,
    entityType: "Indexed",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    indexes: {
      byTz: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["tz"] },
        sk: { field: "gsi1sk", composite: [] },
      },
    },
  })
  const Retained = Entity.make({
    model,
    entityType: "Retained",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["tz"] } },
    versioned: { retain: true },
  })
  const schema = DynamoSchema.make({ name: "named", version: 1 })
  const Base = Table.make({ schema, entities: { Keyed, Unique, Indexed, Retained } })
  const Roots = Aggregate.make(
    Schema.Struct({ id: Schema.String, tz: Schema.TimeZoneNamed, note: Schema.String }),
    {
      table: Base,
      schema,
      pk: { field: "pk", composite: ["id", "tz"] },
      collection: { name: "roots" },
      root: { entityType: "Root" },
      edges: {},
    },
  )
  return { Keyed, Unique, Indexed, Retained, Roots, Base, Main: { ...Base, aggregates: { Roots } } }
})()

const onNamed = <A>(
  table: ReturnType<typeof makeRecordingTable>,
  body: (db: any) => Effect.Effect<A, unknown, any>,
) =>
  Effect.gen(function* () {
    const { Keyed, Unique, Indexed, Retained, Roots, Main } = named
    const db = yield* DynamoClient.make({
      entities: { Keyed, Unique, Indexed, Retained },
      aggregates: { Roots },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    return yield* body(db)
  }).pipe(
    Effect.provide(named.Base.layer({ name: "t" })),
    Effect.provide(table.layer),
  ) as Effect.Effect<A, unknown>

const reachNamed = (db: any, n: number, name: string) =>
  Effect.gen(function* () {
    return {
      keyed: !(yield* notFound(db.entities.Keyed.get({ id: `k${n}`, tz: zone(name) }))),
      retained: !(yield* notFound(db.entities.Retained.get({ id: `r${n}`, tz: zone(name) }))),
      root: !(yield* notFound(db.aggregates.Roots.get({ id: `g${n}`, tz: zone(name) }))),
      indexed: (yield* db.entities.Indexed.byTz({ tz: zone(name) }).collect()).length,
    }
  })

describe("rows published 1.39.0 keyed by a zone itself, on Effect 4.1.3", () => {
  it("the fixture is 1.39.0's, keyed by each zone's given name", () => {
    expect(written139.rows).toHaveLength(35)
    const keys = keysOf(written139.rows).join("\n")
    expect(keys).toContain("$named#v1#keyed#tz_timezone.named(etc/utc)")
    expect(keys).toContain("$named#v1#unique.bytz#timezone.named(asia/kolkata)|")
    expect(keys).not.toContain("calcutta")
  })

  it.effect("rekey moves them; get, the accessor, update and delete find them after", () =>
    Effect.gen(function* () {
      const table = seeded(written139.rows)
      yield* onNamed(table, (db) =>
        Effect.gen(function* () {
          for (const [n, name] of ZONES.entries()) {
            const reached = yield* reachNamed(db, n, name)
            expect([name, reached]).toEqual([
              name,
              MOVED.has(name)
                ? { keyed: false, retained: false, root: false, indexed: 0 }
                : { keyed: true, retained: true, root: true, indexed: 1 },
            ])
          }
          const report = yield* db.tables.Main.rekey({ repairIndexKeys: true })
          expect(report.conflicts).toEqual([])
          expect(Object.values(report.skipped).every((n) => n === 0)).toBe(true)
          expect(report.sentinelsMoved).toBe(3)
          expect(report.indexKeysRewritten).toBe(3)
          const keys = keysOf(rowsOf(table)).join("\n")
          expect(keys).not.toContain("etc/utc")
          expect(keys).not.toContain("asia/kolkata")
          expect(keys).not.toContain("us/pacific")
          expect(keys).toContain("$named#v1#unique.bytz#timezone.named(asia/calcutta)|")
          for (const [n, name] of ZONES.entries()) {
            expect([name, yield* reachNamed(db, n, name)]).toEqual([
              name,
              { keyed: true, retained: true, root: true, indexed: 1 },
            ])
            yield* db.entities.Keyed.update({ id: `k${n}`, tz: zone(name) })
              .set({ note: "moved" })
              .asEffect()
            const taken = yield* Effect.exit(
              db.entities.Unique.put({ id: `other${n}`, tz: zone(name) }).asEffect(),
            )
            expect(JSON.stringify(taken)).toContain("UniqueConstraintViolation")
            yield* db.entities.Unique.delete({ id: `u${n}` }).asEffect()
            yield* db.entities.Keyed.delete({ id: `k${n}`, tz: zone(name) }).asEffect()
          }
          expect(rowsOf(table).filter((row) => row.__edd_e__?.S?.startsWith("Unique"))).toEqual([])
          expect(rowsOf(table).filter((row) => row.__edd_e__?.S === "Keyed")).toEqual([])
          const again = yield* db.tables.Main.rekey({ repairIndexKeys: true })
          expect(Object.values(again.moved).every((n) => n === 0)).toBe(true)
          expect(again.sentinelsMoved).toBe(0)
          expect(again.indexKeysRewritten).toBe(0)
        }),
      )
    }),
  )
})
