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
import { DateTime, Effect, Option, Schema } from "effect"
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

  it.effect("1.40.0's map on Effect 4.1.3: the zone, written back as read", () => {
    const table = seeded(zoneMap413("Europe/London", "Europe/London"))
    return withDb(table, (db) =>
      Effect.gen(function* () {
        const place = yield* db.entities.Places.get({ id: "r" })
        expect(DateTime.isTimeZoneNamed(place.tz)).toBe(true)
        expect(Object.hasOwn(place.tz, MARKER)).toBe(false)
        expect(DateTime.zoneToString(place.tz)).toBe("Europe/London")
        yield* db.entities.Places.put(place).asEffect()
        expect(rowOf(table, "r").tz).toEqual(zoneMap413("Europe/London", "Europe/London"))
      }),
    )
  })

  it.effect(
    "1.40.0's map on Effect 4.1.3 for a name Intl resolves to another: written back as read",
    () => {
      const table = seeded(zoneMap413("Etc/UTC", "UTC"))
      return withDb(table, (db) =>
        Effect.gen(function* () {
          const place = yield* db.entities.Places.get({ id: "r" })
          yield* db.entities.Places.put(place).asEffect()
          expect(rowOf(table, "r").tz).toEqual(zoneMap413("Etc/UTC", "UTC"))
        }),
      )
    },
  )
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
})
