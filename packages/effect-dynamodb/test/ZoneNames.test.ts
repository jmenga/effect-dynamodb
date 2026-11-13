/**
 * A named zone is stored as Effect 4.1.2 held it, whichever Effect is installed (#242).
 *
 * Effect 4.1.3 gave a named zone a `resolvedId`, the name its `Intl` formatter resolves it to, and
 * kept the name it was made from as its `id`. Stored as Effect holds it, the same zone became another
 * map (a `resolvedId` entry, and for a name `Intl` resolves to another, `Etc/UTC` to `UTC`, another
 * `id`), another key text and another ISO text than published 1.40.0 stored on 4.1.2. Each zone here
 * is one as 4.1.3 makes it, built on the installed Effect's own prototype, so every assertion holds
 * on either version, and the stored attributes are asserted literally.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Equal, Option, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { isInstanceOf } from "./helpers/Lookalikes.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

/** A zone as Effect 4.1.3 makes one from `given`, which `Intl` resolves as it resolves `resolving`. */
const madeAs413 = (given: string, resolving: string): DateTime.TimeZone => {
  const real = DateTime.zoneMakeNamedUnsafe(resolving) as unknown as {
    readonly format: Intl.DateTimeFormat
  }
  const zone = Object.create(Object.getPrototypeOf(real))
  zone.id = given
  zone.resolvedId = real.format.resolvedOptions().timeZone
  zone.format = real.format
  return zone
}

/** `Etc/UTC`, which `Intl` resolves to `UTC`: 4.1.2 held it as `UTC`. */
const etcUtc = () => madeAs413("Etc/UTC", "UTC") as DateTime.TimeZone.Named
const london = () => madeAs413("Europe/London", "Europe/London") as DateTime.TimeZone.Named

const MARKER = "~effect/DateTime/TimeZone"

/** A named zone's map as published 1.40.0 stored it on Effect 4.1.2. */
const zoneMap = (id: string) => ({
  M: { id: { S: id }, format: { M: {} }, [MARKER]: { S: MARKER }, _tag: { S: "Named" } },
})

/** The same map as 1.40.0 stored it on Effect 4.1.3: with `resolvedId`, and the name given. */
const zoneMap413 = (id: string, resolvedId: string) => ({
  M: {
    id: { S: id },
    resolvedId: { S: resolvedId },
    format: { M: {} },
    [MARKER]: { S: MARKER },
    _tag: { S: "Named" },
  },
})

const Json = DynamoModel.Packed({ format: "json" })
const AppSchema = DynamoSchema.make({ name: "zones", version: 1 })

const Places = Entity.make({
  model: DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      tz: Schema.optional(Schema.TimeZoneNamed),
      zoned: Schema.optional(Schema.DateTimeZoned),
      iso: Schema.optional(DynamoModel.DateTimeZoned),
      held: Schema.optional(Schema.Option(Schema.DateTimeZoned)),
      heldZone: Schema.optional(Schema.Option(Schema.TimeZoneNamed)),
      loose: Schema.optional(Schema.Unknown),
      packed: Schema.optional(Schema.Unknown),
      k: Schema.optional(Schema.TimeZoneNamed),
    }),
    { packed: { storedAs: Json } },
  ),
  entityType: "Place",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    byZone: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["id"] },
      sk: { field: "gsi1sk", composite: ["k"] },
    },
  },
})

const Streams = Table.make({ schema: AppSchema, entities: {} })
const Moves = EventStore.makeStream({
  table: Streams,
  streamName: "Moves",
  events: [Schema.TaggedStruct("Moved", { tz: Schema.TimeZoneNamed, at: Schema.DateTimeZoned })],
  streamId: { composite: ["id"] },
})

const Main = Table.make({ schema: AppSchema, entities: { Places } })

/** `body` with the tables and the recording client it runs against provided. */
const running = <A>(
  table: ReturnType<typeof makeRecordingTable>,
  on: typeof Main | typeof Streams,
  body: Effect.Effect<A, unknown, unknown>,
): Effect.Effect<A, unknown> =>
  body.pipe(
    Effect.provide(on.layer({ name: "zones" })),
    Effect.provide(table.layer),
  ) as unknown as Effect.Effect<A, unknown>

const withDb = <A>(
  table: ReturnType<typeof makeRecordingTable>,
  f: (db: any) => Effect.Effect<A, unknown, unknown>,
) =>
  running(
    table,
    Main,
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Places }, tables: { Main } })
      return yield* f(db)
    }),
  )

const rowOf = (table: ReturnType<typeof makeRecordingTable>, id: string): any =>
  table.items.get(`$zones#v1#place#id_${id}|$zones#v1#place`)

describe("a named zone is written as 1.40.0 wrote it on Effect 4.1.2", () => {
  it.effect("in a typed field, an untyped one, an Option, a date's text and a key", () => {
    const table = makeRecordingTable()
    const at = (zone: DateTime.TimeZone) => DateTime.makeZonedUnsafe(0, { timeZone: zone })
    return withDb(table, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Places.put({
          id: "a",
          tz: etcUtc(),
          zoned: at(etcUtc()),
          iso: at(etcUtc()),
          held: Option.some(at(etcUtc())),
          loose: { zone: etcUtc(), at: at(london()) },
          k: etcUtc(),
        }).asEffect()
        const row = rowOf(table, "a")
        expect(row.tz).toEqual(zoneMap("UTC"))
        expect(JSON.stringify(row.tz.M)).toBe(
          `{"id":{"S":"UTC"},"format":{"M":{}},"${MARKER}":{"S":"${MARKER}"},"_tag":{"S":"Named"}}`,
        )
        expect(row.zoned).toEqual({ S: "1970-01-01T00:00:00.000+00:00[UTC]" })
        expect(row.iso).toEqual({ S: "1970-01-01T00:00:00.000+00:00[UTC]" })
        expect(row.held.M.value.M.zone).toEqual(zoneMap("UTC"))
        expect(row.loose.M.zone).toEqual(zoneMap("UTC"))
        expect(row.loose.M.at.M.zone).toEqual(zoneMap("Europe/London"))
        expect(row.k).toEqual(zoneMap("UTC"))
        expect(row.gsi1sk).toEqual({ S: "$zones#v1#place#k_timezone.named(utc)" })
      }),
    )
  })

  it.effect("packed, as the map a native write stores", () => {
    const table = makeRecordingTable()
    return withDb(table, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Places.put({
          id: "p",
          packed: {
            zone: etcUtc(),
            at: DateTime.makeZonedUnsafe(0, { timeZone: etcUtc() }),
          },
        }).asEffect()
        expect(rowOf(table, "p").packed).toEqual({
          S:
            `{"zone":{"format":{},"id":"UTC","${MARKER}":"${MARKER}","_tag":"Named"},` +
            `"at":{"~effect/DateTime":"~effect/DateTime","epochMilliseconds":0,` +
            `"zone":{"format":{},"id":"UTC","${MARKER}":"${MARKER}","_tag":"Named"},"_tag":"Zoned"}}`,
        })
      }),
    )
  })

  it.effect("in an update's operand", () => {
    const table = makeRecordingTable()
    return withDb(table, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Places.put({ id: "u" }).asEffect()
        yield* db.entities.Places.update({ id: "u" }).set({ tz: etcUtc() }).asEffect()
        const update = table.requests.find((request) => request.command === "UpdateItem")
        const values = Object.values(update?.input.ExpressionAttributeValues ?? {})
        expect(values).toContainEqual(zoneMap("UTC"))
        expect(JSON.stringify(values)).not.toContain("resolvedId")
        expect(rowOf(table, "u").tz).toEqual(zoneMap("UTC"))
      }),
    )
  })

  it.effect("in a stream's event", () => {
    const table = makeRecordingTable()
    return running(
      table,
      Streams,
      Effect.gen(function* () {
        const stream = yield* EventStore.bind(Moves)
        yield* stream.append(
          { id: "s" },
          [
            {
              _tag: "Moved",
              tz: etcUtc(),
              at: DateTime.makeZonedUnsafe(0, { timeZone: london() }),
            },
          ],
          0,
        )
        const event = [...table.items.values()].find((row: any) => row.data !== undefined) as any
        expect(event.data.M.tz).toEqual(zoneMap("UTC"))
        expect(event.data.M.at.M.zone).toEqual(zoneMap("Europe/London"))
      }),
    )
  })
})

describe("a named zone reads back from either form", () => {
  const seeded = (tz: unknown) => {
    const table = makeRecordingTable()
    table.items.set("$zones#v1#place#id_r|$zones#v1#place", {
      pk: { S: "$zones#v1#place#id_r" },
      sk: { S: "$zones#v1#place" },
      __edd_e__: { S: "Place" },
      id: { S: "r" },
      tz,
    } as never)
    return table
  }

  it.effect("1.40.0's map on Effect 4.1.2: the zone, written back as read", () => {
    const table = seeded(zoneMap("Europe/London"))
    return withDb(table, (db) =>
      Effect.gen(function* () {
        const place = yield* db.entities.Places.get({ id: "r" })
        expect(
          isInstanceOf(
            place.tz,
            DateTime.zoneMakeNamedUnsafe("Europe/London"),
            Schema.TimeZoneNamed,
          ),
        ).toBe(true)
        yield* db.entities.Places.put(place).asEffect()
        expect(rowOf(table, "r").tz).toEqual(zoneMap("Europe/London"))
      }),
    )
  })

  it.effect("1.40.0's map on Effect 4.1.3: the zone, written as 4.1.2 held it", () => {
    const table = seeded(zoneMap413("Europe/London", "Europe/London"))
    return withDb(table, (db) =>
      Effect.gen(function* () {
        const place = yield* db.entities.Places.get({ id: "r" })
        expect(DateTime.isTimeZoneNamed(place.tz)).toBe(true)
        expect(Object.hasOwn(place.tz, MARKER)).toBe(false)
        expect(Equal.equals(place.tz, DateTime.zoneMakeNamedUnsafe("Europe/London"))).toBe(true)
        yield* db.entities.Places.put(place).asEffect()
        expect(rowOf(table, "r").tz).toEqual(zoneMap("Europe/London"))
      }),
    )
  })

  it.effect(
    "1.40.0's map on Effect 4.1.3 for a name Intl resolves to another: the zone, written as 4.1.2 held it",
    () => {
      const table = seeded(zoneMap413("Etc/UTC", "UTC"))
      return withDb(table, (db) =>
        Effect.gen(function* () {
          const place = yield* db.entities.Places.get({ id: "r" })
          expect(DateTime.isTimeZoneNamed(place.tz)).toBe(true)
          expect(Equal.equals(place.tz, DateTime.zoneMakeNamedUnsafe("UTC"))).toBe(true)
          yield* db.entities.Places.put(place).asEffect()
          expect(rowOf(table, "r").tz).toEqual(zoneMap("UTC"))
        }),
      )
    },
  )

  it.effect(
    "a map holding resolvedId reads as 4.1.2's map does in every position, and is written as it",
    () => {
      const table = makeRecordingTable()
      const date413 = {
        M: {
          epochMilliseconds: { N: "0" },
          zone: zoneMap413("Etc/UTC", "UTC"),
          "~effect/DateTime": { S: "~effect/DateTime" },
          _tag: { S: "Zoned" },
        },
      }
      const packedZone = `{"format":{},"id":"Etc/UTC","resolvedId":"UTC","${MARKER}":"${MARKER}","_tag":"Named"}`
      table.items.set("$zones#v1#place#id_r|$zones#v1#place", {
        pk: { S: "$zones#v1#place#id_r" },
        sk: { S: "$zones#v1#place" },
        __edd_e__: { S: "Place" },
        id: { S: "r" },
        tz: zoneMap413("Etc/UTC", "UTC"),
        zoned: { S: "1970-01-01T00:00:00.000+00:00[Etc/UTC]" },
        iso: { S: "1970-01-01T00:00:00.000+00:00[Etc/UTC]" },
        held: {
          M: { value: date413, "~effect/Option": { S: "~effect/Option" }, _tag: { S: "Some" } },
        },
        heldZone: {
          M: {
            value: zoneMap413("Etc/UTC", "UTC"),
            "~effect/Option": { S: "~effect/Option" },
            _tag: { S: "Some" },
          },
        },
        loose: { M: { zone: zoneMap413("Etc/UTC", "UTC"), at: date413 } },
        packed: { S: `{"zone":${packedZone}}` },
      } as never)
      return withDb(table, (db) =>
        Effect.gen(function* () {
          const utc = DateTime.zoneMakeNamedUnsafe("UTC")
          const place = yield* db.entities.Places.get({ id: "r" })
          expect(Equal.equals(place.tz, utc)).toBe(true)
          expect(Equal.equals(place.zoned.zone, utc)).toBe(true)
          expect(Equal.equals(place.iso.zone, utc)).toBe(true)
          expect(Equal.equals((Option.getOrThrow(place.held) as DateTime.Zoned).zone, utc)).toBe(
            true,
          )
          expect(Equal.equals(Option.getOrThrow(place.heldZone), utc)).toBe(true)
          // Where no schema types it, a zone's map reads back as a map, in either form, as 4.1.2's did.
          expect(Object.getPrototypeOf(place.loose.zone)).toBe(Object.prototype)
          expect(Object.getPrototypeOf(place.loose.at.zone)).toBe(Object.prototype)
          expect(Object.getPrototypeOf(place.packed.zone)).toBe(Object.prototype)
          yield* db.entities.Places.put(place).asEffect()
          const row = rowOf(table, "r")
          expect(row.tz).toEqual(zoneMap("UTC"))
          expect(row.zoned).toEqual({ S: "1970-01-01T00:00:00.000+00:00[UTC]" })
          expect(row.iso).toEqual({ S: "1970-01-01T00:00:00.000+00:00[UTC]" })
          expect(row.held.M.value.M.zone).toEqual(zoneMap("UTC"))
          expect(row.heldZone.M.value).toEqual(zoneMap("UTC"))
          expect(row.loose.M.zone).toEqual(zoneMap("UTC"))
          expect(row.loose.M.at.M.zone).toEqual(zoneMap("UTC"))
          expect(row.packed).toEqual({
            S: `{"zone":{"format":{},"id":"UTC","${MARKER}":"${MARKER}","_tag":"Named"}}`,
          })
        }),
      )
    },
  )

  it.effect("an update that leaves the zone alone leaves its stored map alone", () => {
    const table = seeded(zoneMap413("Etc/UTC", "UTC"))
    return withDb(table, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Places.update({ id: "r" }).set({ loose: 1 }).asEffect()
        expect(rowOf(table, "r").tz).toEqual(zoneMap413("Etc/UTC", "UTC"))
      }),
    )
  })

  it.effect("a map naming no zone stays a map", () => {
    const table = seeded(zoneMap413("No/SuchZone", "No/SuchZone"))
    return withDb(table, (db) =>
      Effect.gen(function* () {
        const place = yield* db.entities.Places.get({ id: "r" })
        expect(Object.getPrototypeOf(place.tz)).toBe(Object.prototype)
      }),
    )
  })
})

describe("a zone is written as 4.1.2 held it however it's reached", () => {
  it.effect("behind a getter, natively and packed", () => {
    const table = makeRecordingTable()
    return withDb(table, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Places.put({
          id: "g",
          loose: {
            get zone() {
              return etcUtc()
            },
          },
          packed: {
            get zone() {
              return etcUtc()
            },
          },
        }).asEffect()
        const row = rowOf(table, "g")
        expect(row.loose.M.zone).toEqual(zoneMap("UTC"))
        expect(row.packed).toEqual({
          S: `{"zone":{"format":{},"id":"UTC","${MARKER}":"${MARKER}","_tag":"Named"}}`,
        })
      }),
    )
  })

  it.effect("a getter is read once, packed", () => {
    const table = makeRecordingTable()
    let reads = 0
    return withDb(table, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Places.put({
          id: "o",
          packed: {
            get zone() {
              reads++
              return madeAs413("Etc/UTC", "UTC")
            },
          },
        }).asEffect()
        expect(reads).toBe(1)
        expect(rowOf(table, "o").packed).toEqual({
          S: `{"zone":{"format":{},"id":"UTC","${MARKER}":"${MARKER}","_tag":"Named"}}`,
        })
      }),
    )
  })

  it.effect("a map shaped as 4.1.3's, given as a map", () => {
    const table = makeRecordingTable()
    const shaped = () => ({
      id: "Etc/UTC",
      resolvedId: "UTC",
      format: {},
      [MARKER]: MARKER,
      _tag: "Named",
    })
    return withDb(table, (db) =>
      Effect.gen(function* () {
        yield* db.entities.Places.put({ id: "m", loose: shaped(), packed: shaped() }).asEffect()
        const row = rowOf(table, "m")
        expect(row.loose).toEqual(zoneMap("UTC"))
        expect(row.packed).toEqual({
          S: `{"id":"UTC","format":{},"${MARKER}":"${MARKER}","_tag":"Named"}`,
        })
      }),
    )
  })
})

describe("two zones Effect holds equal compose one key text, sentinel and ISO text", () => {
  const Keyed = Entity.make({
    model: Schema.Struct({ tz: Schema.TimeZoneNamed, at: Schema.DateTimeZoned }),
    entityType: "Keyed",
    primaryKey: { pk: { field: "pk", composite: [] }, sk: { field: "sk", composite: ["tz"] } },
    unique: { byTz: ["tz"] },
  })
  const Reads = Entity.make({
    model: Schema.Struct({ id: Schema.String, tz: Schema.TimeZoneNamed }),
    entityType: "Place",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const KeyedTable = Table.make({ schema: AppSchema, entities: { Keyed, Reads } })
  const NAMES = [
    "Etc/UTC",
    "UTC",
    "GMT",
    "Asia/Kolkata",
    "Asia/Calcutta",
    "ASIA/KOLKATA",
    "europe/london",
    "Europe/London",
    "GB",
    "US/Pacific",
    "America/Los_Angeles",
  ]
  const resolved = (name: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone
  /** A zone as Effect 4.1.2 made one from `name`: its `id` the resolved name, no `resolvedId`. */
  const madeAs412 = (name: string): DateTime.TimeZone => {
    const real = DateTime.zoneMakeNamedUnsafe(name) as unknown as {
      readonly format: Intl.DateTimeFormat
    }
    const zone = Object.create(Object.getPrototypeOf(real))
    zone.id = real.format.resolvedOptions().timeZone
    zone.format = real.format
    return zone
  }

  it.effect("made fresh, as each Effect makes one, or read back from either map", () => {
    const table = makeRecordingTable()
    return running(
      table,
      KeyedTable as never,
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: { Keyed, Reads },
          tables: { KeyedTable },
        } as never)
        const readBack = (id: string, map: unknown) =>
          Effect.gen(function* () {
            table.items.set(`$zones#v1#place#id_${id}|$zones#v1#place`, {
              pk: { S: `$zones#v1#place#id_${id}` },
              sk: { S: "$zones#v1#place" },
              __edd_e__: { S: "Place" },
              id: { S: id },
              tz: map,
            } as never)
            return (yield* db.entities.Reads.get({ id })).tz as DateTime.TimeZone
          })
        const zones: Array<{ readonly how: string; readonly zone: DateTime.TimeZone }> = []
        for (const name of NAMES) {
          zones.push({ how: `fresh ${name}`, zone: DateTime.zoneMakeNamedUnsafe(name) })
          zones.push({ how: `as 4.1.3 makes ${name}`, zone: madeAs413(name, name) })
          zones.push({ how: `as 4.1.2 made ${name}`, zone: madeAs412(name) })
          zones.push({
            how: `read from 4.1.2's map of ${name}`,
            zone: yield* readBack(`a${zones.length}`, zoneMap(resolved(name))),
          })
          zones.push({
            how: `read from 4.1.3's map of ${name}`,
            zone: yield* readBack(`b${zones.length}`, zoneMap413(name, resolved(name))),
          })
        }
        const texts = []
        for (const { how, zone } of zones) {
          table.items.clear()
          yield* db.entities.Keyed.put({
            tz: zone,
            at: DateTime.makeZonedUnsafe(0, { timeZone: zone }),
          }).asEffect()
          const rows = [...table.items.values()] as Array<any>
          const row = rows.find((item) => item.__edd_e__?.S === "Keyed")
          const sentinel = rows.find((item) => item !== row)
          texts.push({ how, zone, key: row.sk.S, sentinel: sentinel?.pk.S, iso: row.at.S })
        }
        let equalPairs = 0
        for (const a of texts) {
          for (const b of texts) {
            if (!Equal.equals(a.zone, b.zone)) continue
            if (a.how.split(" ").pop() !== b.how.split(" ").pop()) equalPairs++
            expect({ how: b.how, key: b.key, sentinel: b.sentinel, iso: b.iso }).toEqual({
              how: b.how,
              key: a.key,
              sentinel: a.sentinel,
              iso: a.iso,
            })
          }
        }
        // Not vacuous: zones made from different names are equal, on either Effect.
        expect(equalPairs).toBeGreaterThan(0)
        // And each is the text of the name Intl resolves its name to.
        for (const { how, key, iso } of texts) {
          const name = resolved(how.split(" ").pop()!)
          expect({ how, key, iso }).toEqual({
            how,
            key: `$zones#v1#keyed#tz_timezone.named(${name.toLowerCase()})`,
            iso: DateTime.formatIsoZoned(
              DateTime.makeZonedUnsafe(0, { timeZone: madeAs412(name) }),
            ),
          })
        }
      }),
    )
  })
})

describe("an aggregate compares a zone as it's stored", () => {
  class Office extends Schema.Class<Office>("Office")({
    officeId: Schema.String,
    zone: Schema.TimeZoneNamed,
  }) {}
  const Offices = Aggregate.make(Office, {
    table: Main,
    schema: AppSchema,
    pk: { field: "pk", composite: ["officeId"] },
    collection: { name: "office" },
    root: { entityType: "OfficeItem" },
    edges: {},
  })

  it.effect("a zone stored as the one already stored writes nothing", () => {
    const table = makeRecordingTable()
    return running(
      table,
      Main,
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Offices },
          tables: { Main },
        } as never)
        yield* db.aggregates.Offices.create({ officeId: "o", zone: etcUtc() })
        const root = [...table.items.values()].find(
          (row: any) => row.__edd_e__?.S === "OfficeItem",
        ) as any
        expect(root.zone).toEqual(zoneMap("UTC"))
        table.take()
        yield* db.aggregates.Offices.update({ officeId: "o" }, ({ state }: any) => ({
          ...state,
          zone: etcUtc(),
        }))
        expect(table.take().map(({ command }) => command)).toEqual(["Query"])
      }),
    )
  })

  it.effect("over a row holding resolvedId, an update writing nothing new writes nothing", () => {
    const table = makeRecordingTable()
    return running(
      table,
      Main,
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Offices },
          tables: { Main },
        } as never)
        yield* db.aggregates.Offices.create({ officeId: "o", zone: etcUtc() })
        const root = [...table.items.values()].find(
          (row: any) => row.__edd_e__?.S === "OfficeItem",
        ) as any
        root.zone = zoneMap413("Etc/UTC", "UTC")
        table.take()
        yield* db.aggregates.Offices.update({ officeId: "o" }, ({ state }: any) => state)
        yield* db.aggregates.Offices.update({ officeId: "o" }, ({ state }: any) => ({
          ...state,
          zone: etcUtc(),
        }))
        yield* db.aggregates.Offices.update({ officeId: "o" }, ({ state }: any) => ({
          ...state,
          zone: DateTime.zoneMakeNamedUnsafe("UTC"),
        }))
        expect(table.take().map(({ command }) => command)).toEqual(["Query", "Query", "Query"])
        expect(root.zone).toEqual(zoneMap413("Etc/UTC", "UTC"))
      }),
    )
  })

  describe("a zone carrying more than its own fields", () => {
    class Desk extends Schema.Class<Desk>("Desk")({
      deskId: Schema.String,
      zone: Schema.TimeZoneOffset,
    }) {}
    const Desks = Aggregate.make(Desk, {
      table: Main,
      schema: AppSchema,
      pk: { field: "pk", composite: ["deskId"] },
      collection: { name: "desk" },
      root: { entityType: "DeskItem" },
      edges: {},
    })
    const carrying = (metadata: unknown) =>
      Object.assign(DateTime.zoneMakeOffset(3_600_000), { metadata })
    const updated = (before: unknown, after: unknown) => {
      const table = makeRecordingTable()
      return running(
        table,
        Main,
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: {},
            aggregates: { Desks },
            tables: { Main },
          } as never)
          yield* db.aggregates.Desks.create({ deskId: "d", zone: carrying(before) })
          table.take()
          yield* db.aggregates.Desks.update({ deskId: "d" }, ({ state }: any) => ({
            ...state,
            zone: carrying(after),
          }))
          const root = [...table.items.values()].find(
            (row: any) => row.__edd_e__?.S === "DeskItem",
          ) as any
          return {
            sent: table.take().map(({ command }) => command),
            metadata: root.zone.M.metadata,
          }
        }),
      )
    }

    it.effect("a set it holds that changes is written", () =>
      Effect.gen(function* () {
        expect(yield* updated(new Set(["a"]), new Set(["b"]))).toEqual({
          sent: ["Query", "TransactWriteItems"],
          metadata: { SS: ["b"] },
        })
      }),
    )

    it.effect("a bigint past 2^53 that changes is written", () =>
      Effect.gen(function* () {
        expect(yield* updated(9007199254740993n, 9007199254740994n)).toEqual({
          sent: ["Query", "TransactWriteItems"],
          metadata: { N: "9007199254740994" },
        })
      }),
    )

    it.effect("a map it holds, in another key order, writes nothing", () =>
      Effect.gen(function* () {
        expect(yield* updated({ a: 1, e: 2 }, { e: 2, a: 1 })).toEqual({
          sent: ["Query"],
          metadata: { M: { a: { N: "1" }, e: { N: "2" } } },
        })
      }),
    )

    it.effect("bytes that change are written", () =>
      Effect.gen(function* () {
        expect(yield* updated(new Uint8Array([1]), new Uint8Array([2]))).toEqual({
          sent: ["Query", "TransactWriteItems"],
          metadata: { B: new Uint8Array([2]) },
        })
      }),
    )
  })
})
