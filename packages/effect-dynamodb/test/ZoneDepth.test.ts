/**
 * A named zone is keyed, reserved and stored under one name wherever a schema puts it (#242).
 *
 * Effect 4.1.3 kept the name a zone was made from as its `id` (`Etc/UTC`, resolved `UTC`), where
 * 4.1.2 held the resolved name. Every text naming a zone takes the resolved name (`storedZoneName`),
 * through one walk (`walkZones` in `internal/StoredForm.ts`): a zone in a list, a tuple, a struct or a
 * record in an `Option`, a `Result`, a union, a class instance in an `Option`, a list of zoned dates,
 * and a codec writing a zone as text inside a list or an `Option`. Up to now the walk stopped at a
 * list, so on 4.1.3 a list of zones keyed `timezone.named(etc/utc)`, a `get` by the zone made from
 * `UTC` found nothing, and the unique constraint took both names.
 *
 * Each container is a sort key composite, a unique constraint and (where packed storage holds it) a
 * packed attribute, and each zone is built every way: made fresh on the installed Effect, as 4.1.3 makes
 * one, as 4.1.2 made one, decoded from the value 4.1.3's codecs and maps hold, and read back from a
 * row holding either Effect's map. Equal zones compose one key text and one sentinel, each the text
 * of the resolved name (a literal table, so it's the same text on either Effect), and every zone's
 * map in the stored attribute, native or packed, holds the resolved name and no `resolvedId`. A
 * codec's own text is the codec's, as it writes it on the installed Effect (`DESIGN.md`).
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Option, Result, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const MARKER = "~effect/DateTime/TimeZone"

/** A zone as Effect 4.1.3 makes one from `given`: its `id` that name, `resolvedId` Intl's. */
const madeAs413 = (given: string): DateTime.TimeZone => {
  const real = DateTime.zoneMakeNamedUnsafe(given) as unknown as {
    readonly format: Intl.DateTimeFormat
  }
  const zone = Object.create(Object.getPrototypeOf(real))
  zone.id = given
  zone.resolvedId = real.format.resolvedOptions().timeZone
  zone.format = real.format
  return zone
}

/** A zone as Effect 4.1.2 made one from `given`: its `id` the resolved name, no `resolvedId`. */
const madeAs412 = (given: string): DateTime.TimeZone => {
  const real = DateTime.zoneMakeNamedUnsafe(given) as unknown as {
    readonly format: Intl.DateTimeFormat
  }
  const zone = Object.create(Object.getPrototypeOf(real))
  zone.id = real.format.resolvedOptions().timeZone
  zone.format = real.format
  return zone
}

const resolved = (name: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone

const at = (zone: DateTime.TimeZone) => DateTime.makeZonedUnsafe(0, { timeZone: zone })

class Located extends Schema.Class<Located>("Located")({ z: Schema.TimeZoneNamed }) {}

const Json = DynamoModel.Packed({ format: "json" })

interface Container {
  readonly name: string
  readonly field: Schema.Top
  readonly wrap: (zone: DateTime.TimeZone) => unknown
  /** The sort key's composite text for a zone resolving to `UTC`, on either Effect. */
  readonly text: string
  /** JSON holds it, so it's packed too. */
  readonly packs: boolean
  /** A codec writes the zone as text: its stored text is the codec's. */
  readonly codec?: true
}

const CONTAINERS: ReadonlyArray<Container> = [
  {
    name: "a list",
    field: Schema.Array(Schema.TimeZoneNamed),
    wrap: (z) => [z],
    text: "timezone.named(utc)",
    packs: true,
  },
  {
    name: "a tuple",
    field: Schema.Tuple([Schema.String, Schema.TimeZoneNamed]),
    wrap: (z) => ["x", z],
    text: "x,timezone.named(utc)",
    packs: true,
  },
  {
    name: "a list of lists",
    field: Schema.Array(Schema.Array(Schema.TimeZoneNamed)),
    wrap: (z) => [[z], [z]],
    text: "timezone.named(utc),timezone.named(utc)",
    packs: true,
  },
  {
    name: "a list of zoned dates",
    field: Schema.Array(Schema.DateTimeZoned),
    wrap: (z) => [at(z)],
    text: "1970-01-01t00:00:00.000+00:00[utc]",
    packs: true,
  },
  {
    name: "an Option of a list",
    field: Schema.Option(Schema.Array(Schema.TimeZoneNamed)),
    wrap: (z) => Option.some([z]),
    text: "some([timezone.named(utc)])",
    packs: false,
  },
  {
    name: "an Option of a struct",
    field: Schema.Option(Schema.Struct({ z: Schema.TimeZoneNamed })),
    wrap: (z) => Option.some({ z }),
    text: 'some({"z":timezone.named(utc)})',
    packs: false,
  },
  {
    name: "an Option of a record",
    field: Schema.Option(Schema.Record(Schema.String, Schema.TimeZoneNamed)),
    wrap: (z) => Option.some({ a: z }),
    text: 'some({"a":timezone.named(utc)})',
    packs: false,
  },
  {
    name: "a Result's success",
    field: Schema.Result(Schema.TimeZoneNamed, Schema.String),
    wrap: (z) => Result.succeed(z),
    text: "success(timezone.named(utc))",
    packs: false,
  },
  {
    name: "a Result's failure",
    field: Schema.Result(Schema.String, Schema.Array(Schema.TimeZoneNamed)),
    wrap: (z) => Result.fail([z]),
    text: "failure([timezone.named(utc)])",
    packs: false,
  },
  {
    name: "a union",
    field: Schema.Union([Schema.String, Schema.Array(Schema.TimeZoneNamed)]),
    wrap: (z) => [z],
    text: "timezone.named(utc)",
    packs: false,
  },
  {
    name: "a class instance in an Option",
    field: Schema.Option(Located),
    wrap: (z) => Option.some(new Located({ z: z as DateTime.TimeZone.Named })),
    text: 'some({"z":timezone.named(utc)})',
    packs: false,
  },
  {
    name: "a list of TimeZoneNamedFromString",
    field: Schema.Array(Schema.TimeZoneNamedFromString),
    wrap: (z) => [z, z],
    text: "utc,utc",
    packs: true,
    codec: true,
  },
  {
    name: "an Option of TimeZoneNamedFromString",
    field: Schema.Option(Schema.TimeZoneNamedFromString),
    wrap: (z) => Option.some(z),
    text: 'some("utc")',
    packs: false,
    codec: true,
  },
  {
    name: "a list of DateTimeZonedFromString",
    field: Schema.Array(Schema.DateTimeZonedFromString),
    wrap: (z) => [at(z)],
    text: "1970-01-01t00:00:00.000+00:00[utc]",
    packs: true,
    codec: true,
  },
]

const AppSchema = DynamoSchema.make({ name: "zd", version: 1 })

const memberOf = (container: Container, index: number) => {
  const model = Schema.Struct({
    id: Schema.String,
    f: container.field,
    ...(container.packs ? { p: Schema.optional(container.field) } : {}),
  })
  const configured = container.packs
    ? DynamoModel.configure(model as never, { p: { storedAs: Json } } as never)
    : model
  const Keyed = Entity.make({
    model: configured,
    entityType: `K${index}`,
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["f"] } },
    unique: { byF: ["f"] },
  } as never) as any
  const Reads = Entity.make({
    model,
    entityType: `R${index}`,
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never) as any
  return { Keyed, Reads, keyed: `K${index}`.toLowerCase(), reads: `R${index}` }
}

/**
 * The name each zone in a stored attribute is stored under, native or packed (JSON text): a zone's
 * map as `{ id, resolvedId }`, and a zoned date's ISO text as the name in its brackets.
 */
const zonesStoredIn = (attribute: unknown, found: Array<Record<string, unknown>> = []) => {
  if (typeof attribute === "string") {
    if (attribute.startsWith("{") || attribute.startsWith("[")) {
      zonesStoredIn(JSON.parse(attribute), found)
    } else {
      const iso = /\[([^\]]+)\]$/.exec(attribute)?.[1]
      if (iso !== undefined) found.push({ id: iso, resolvedId: undefined })
    }
    return found
  }
  if (typeof attribute !== "object" || attribute === null) return found
  const map = attribute as Record<string, any>
  if (map.M !== undefined && Object.hasOwn(map.M, MARKER)) {
    found.push({ id: map.M.id?.S, resolvedId: map.M.resolvedId?.S })
    for (const value of Object.values(map.M)) zonesStoredIn(value, found)
    return found
  }
  if (Object.hasOwn(map, MARKER)) found.push({ id: map.id, resolvedId: map.resolvedId })
  for (const value of Object.values(map)) zonesStoredIn(value, found)
  return found
}

/** An attribute with each zone's map written as 1.40.0 wrote it on Effect 4.1.3, named `given`. */
const as413Map = (attribute: any, given: string): any => {
  if (typeof attribute !== "object" || attribute === null) return attribute
  if (Array.isArray(attribute)) return attribute.map((value) => as413Map(value, given))
  if (attribute.M !== undefined && Object.hasOwn(attribute.M, MARKER)) {
    const named = attribute.M._tag?.S === "Named"
    return {
      M: {
        ...Object.fromEntries(Object.entries(attribute.M).map(([k, v]) => [k, as413Map(v, given)])),
        ...(named ? { id: { S: given }, resolvedId: { S: resolved(given) } } : {}),
      },
    }
  }
  return Object.fromEntries(Object.entries(attribute).map(([k, v]) => [k, as413Map(v, given)]))
}

const NAMES = ["Etc/UTC", "UTC", "GMT", "Asia/Kolkata", "Asia/Calcutta", "GB", "Europe/London"]

describe("a zone at any depth is keyed, reserved and stored under its resolved name", () => {
  CONTAINERS.forEach((container, index) => {
    it.effect(container.name, () => {
      const { Keyed, Reads, keyed, reads } = memberOf(container, index)
      const Main = Table.make({ schema: AppSchema, entities: { Keyed, Reads } } as never) as any
      const table = makeRecordingTable()
      return Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: { Keyed, Reads },
          tables: { Main },
        } as never)
        const encode = Schema.encodeUnknownEffect(container.field as never)
        const decode = Schema.decodeUnknownEffect(container.field as never)
        /** A row holding `attribute` as `f`, read back through the field. */
        const readBack = (id: string, attribute: unknown) =>
          Effect.gen(function* () {
            table.items.set(
              `$zd#v1#${reads.toLowerCase()}#id_${id}|$zd#v1#${reads.toLowerCase()}`,
              {
                pk: { S: `$zd#v1#${reads.toLowerCase()}#id_${id}` },
                sk: { S: `$zd#v1#${reads.toLowerCase()}` },
                __edd_e__: { S: reads },
                id: { S: id },
                f: attribute,
              } as never,
            )
            return (yield* db.entities.Reads.get({ id })).f
          })
        const stored412 = new Map<string, unknown>()
        const stored413 = new Map<string, unknown>()
        const values: Array<{ readonly how: string; readonly name: string; readonly value: any }> =
          []
        for (const name of NAMES) {
          values.push({
            how: "fresh",
            name,
            value: container.wrap(DateTime.zoneMakeNamedUnsafe(name)),
          })
          values.push({ how: "as 4.1.3 makes it", name, value: container.wrap(madeAs413(name)) })
          values.push({ how: "as 4.1.2 made it", name, value: container.wrap(madeAs412(name)) })
          // What 4.1.3's codecs and maps hold for it, decoded on the installed Effect.
          const encoded413 = yield* encode(container.wrap(madeAs413(name)))
          values.push({ how: "decoded from 4.1.3's form", name, value: yield* decode(encoded413) })
        }
        const texts: Array<{
          readonly how: string
          readonly name: string
          readonly value: unknown
          readonly key: string
          readonly sentinel: string
        }> = []
        const put = (how: string, name: string, value: unknown) =>
          Effect.gen(function* () {
            for (const k of [...table.items.keys()]) {
              if (!k.includes(`#${reads.toLowerCase()}`)) table.items.delete(k)
            }
            yield* db.entities.Keyed.put({
              id: "a",
              f: value,
              ...(container.packs ? { p: value } : {}),
            }).asEffect()
            const rows = [...table.items.values()] as Array<any>
            const row = rows.find((item) => item.__edd_e__?.S === Keyed.entityType)
            const sentinel = rows.find(
              (item) => item !== row && item.__edd_e__?.S !== Reads.entityType,
            )
            texts.push({ how, name, value, key: row.sk.S, sentinel: sentinel.pk.S })
            // Every zone it stores is stored under the resolved name, natively and packed: a
            // codec's text is the codec's, as it writes it on the installed Effect.
            if (container.codec !== true) {
              for (const attribute of [row.f, ...(container.packs ? [row.p] : [])]) {
                const zones = zonesStoredIn(attribute)
                expect(zones.length).toBeGreaterThan(0)
                for (const zone of zones) {
                  expect({ how, name, zone }).toEqual({
                    how,
                    name,
                    zone: { id: resolved(name), resolvedId: undefined },
                  })
                }
              }
            }
            return row.f
          })
        for (const { how, name, value } of values) {
          const f = yield* put(how, name, value)
          if (how === "as 4.1.2 made it") stored412.set(name, f)
          // A codec's text as 4.1.3 writes it: the name the zone was made from.
          if (how === "as 4.1.3 makes it") stored413.set(name, f)
        }
        // Read back from the form each Effect stored: 4.1.3's zone maps hold `resolvedId` beside
        // the name given, and its codecs write the name given.
        for (const name of NAMES) {
          const map412 = stored412.get(name)
          const from412 = yield* readBack(`a${texts.length}`, map412)
          yield* put("read back from 4.1.2's form", name, from412)
          const from413 = yield* readBack(
            `b${texts.length}`,
            container.codec ? stored413.get(name) : as413Map(map412, name),
          )
          yield* put("read back from 4.1.3's form", name, from413)
        }
        // Equal zones compose one key text and one sentinel.
        let equalPairs = 0
        for (const a of texts) {
          for (const b of texts) {
            if (resolved(a.name) !== resolved(b.name)) continue
            if (a.name !== b.name) equalPairs++
            expect({ how: b.how, name: b.name, key: b.key, sentinel: b.sentinel }).toEqual({
              how: b.how,
              name: b.name,
              key: a.key,
              sentinel: a.sentinel,
            })
          }
        }
        expect(equalPairs).toBeGreaterThan(0)
        // Each the text of the resolved name, the same on either Effect.
        for (const { how, name, key } of texts.filter((t) => resolved(t.name) === "UTC")) {
          expect({ how, name, key }).toEqual({
            how,
            name,
            key: `$zd#v1#${keyed}#f_${container.text}`,
          })
        }
      }).pipe(
        Effect.provide(Main.layer({ name: "zd" })),
        Effect.provide(table.layer),
      ) as Effect.Effect<void>
    })
  })
})
