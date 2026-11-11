/**
 * What published 1.40.0 packed for each of Effect's look-alikes, a date, an `Option`, a `Result` and a
 * plain JSON value (`fixtures/packed-lookalikes-1.40.0.json`), with the generator's values and
 * definitions, for `PackedLookalikes.test.ts` and its connected twin.
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Option, Result, Schema } from "effect"
import * as Cookies from "effect/http/Cookies"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Table from "../../src/Table.js"
import { lookalikes } from "./Lookalikes.js"

export type Row = Record<string, AttributeValue>

export type Outcome = "ok" | { readonly refused: string; readonly operation?: string }

export interface Case {
  readonly outcome: Outcome
  readonly stored?: AttributeValue | null
  readonly data?: AttributeValue | null
  readonly state?: AttributeValue | null
}

export interface Captured {
  readonly plain: unknown
  readonly cases: Readonly<Record<string, Case>>
}

export const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/packed-lookalikes-1.40.0.json", import.meta.url), "utf8"),
  (_key, value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.hasOwn(value, "$bigint")
        ? BigInt(value.$bigint)
        : Object.hasOwn(value, "$bytes")
          ? new Uint8Array(value.$bytes)
          : value
      : value,
).kinds as Record<string, Captured>

export const iso = "2025-01-01T00:00:00.000Z"

/** Each value the fixture's generator wrote, by its name there. */
export const kinds = new Map<string, { readonly field: Schema.Top; readonly make: () => unknown }>([
  ...lookalikes.map((kind) => [kind.name, kind] as const),
  [
    "Cookie expires",
    {
      field: Schema.Cookie,
      make: () => Cookies.makeCookieUnsafe("a", "b", { expires: new Date(iso) }),
    },
  ],
  [
    "Option none(DateTimeUtc)",
    { field: Schema.Option(Schema.DateTimeUtc), make: () => Option.none() },
  ],
  ["Option(Number)", { field: Schema.Option(Schema.Number), make: () => Option.some(5) }],
  [
    "Result(Number, String)",
    { field: Schema.Result(Schema.Number, Schema.String), make: () => Result.succeed(5) },
  ],
  ["DateTimeUtc", { field: Schema.DateTimeUtc, make: () => DateTime.makeUnsafe(iso) }],
  [
    "DateTimeZoned named",
    {
      field: Schema.DateTimeZoned,
      make: () => DateTime.makeZonedUnsafe(iso, { timeZone: "Asia/Tokyo" }),
    },
  ],
  [
    "DateTimeZoned offset",
    {
      field: Schema.DateTimeZoned,
      make: () =>
        DateTime.makeZonedUnsafe(iso, { timeZone: DateTime.zoneMakeOffset(9 * 3600 * 1000) }),
    },
  ],
  [
    "Json",
    {
      field: Schema.Struct({
        b: Schema.Number,
        a: Schema.Array(Schema.Unknown),
        c: Schema.Struct({ z: Schema.Number, y: Schema.String }),
      }),
      make: () => ({ b: 1, a: [1, "x", null, true], c: { z: 1, y: "two" } }),
    },
  ],
])

export const kindOf = (name: string) => {
  const kind = kinds.get(name)
  if (kind === undefined) throw new Error(`no value for ${name}`)
  return kind
}

export const Json = DynamoModel.Packed({ format: "json" })

/** The generator's definitions: a typed (`p`) and an Unknown (`u`) packed field, and a stream. */
export const definitionsOf = (field: Schema.Top) => {
  const model = DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      p: Schema.optional(Schema.Struct({ v: field })),
      u: Schema.optional(Schema.Unknown),
    }),
    { p: { storedAs: Json }, u: { storedAs: Json } },
  )
  const P = Entity.make({
    model,
    entityType: "P",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never) as any
  const schema = DynamoSchema.make({ name: "pk", version: 1 })
  const Main = Table.make({ schema, entities: { P } } as never) as any
  const Stream = EventStore.makeStream({
    table: Main,
    streamName: "S",
    events: [Schema.TaggedStruct("Ev", { v: field })],
    streamId: { composite: ["sid"] },
    storedAs: { data: Json },
    snapshot: { schema: Schema.Struct({ v: field }), mode: "inline", storedAs: Json },
  } as never) as any
  return { P, Main, Stream }
}

/** The value a case wrote: a fresh instance, or the map a native read handed 1.40.0. */
export const inputOf = (name: string, label: string) =>
  label.endsWith("/instance") ? kindOf(name).make() : structuredClone(fixture[name]!.plain)

/** The text of `v` 1.40.0 packed for the map a native read hands back, where it packed it. */
export const packedMapText = (name: string): string | undefined => {
  const stored = fixture[name]!.cases["unknown/plain"]
  return stored?.outcome === "ok" ? stored.stored!.S!.slice('{"v":'.length, -1) : undefined
}

/** The kinds 1.40.0 packed the native map of: each of these is packed as a real instance now. */
export const packable = [...kinds.keys()].filter((name) => packedMapText(name) !== undefined)

/** What JSON can't hold: bytes, a bigint past 2^53. 1.40.0 refused the map of each, too. */
export const unpackable = [
  ["BigDecimal past 2^53", "p.v.value"],
  ["Duration nanos past 2^53", "p.v.value.nanos"],
  ["MacAddress", "p.v.bytes"],
  ["DnsTlsaRecord", "p.v.data"],
] as const

/** The kinds 1.40.0 packed anything of. */
export const packedBy140 = [...kinds.keys()].filter((name) =>
  Object.values(fixture[name]!.cases).some((c) => c.outcome === "ok"),
)
