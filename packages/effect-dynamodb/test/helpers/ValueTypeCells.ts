/**
 * Each of Effect's value types in each position the library stores or compares one: what a typed
 * field and an untyped one store natively, what a packed field stores, the key text an index composes
 * and whether an aggregate update setting an equal value writes. Built on the installed Effect, for
 * `EffectValueTypes.test.ts` to hold to one literal table on every Effect version.
 */
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  BigDecimal,
  Cause,
  Chunk,
  Data,
  DateTime,
  Duration,
  Effect,
  Exit,
  HashMap,
  HashSet,
  Option,
  Redacted,
  Schema,
} from "effect"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import { makeRecordingTable } from "./RecordingTable.js"

/** A zone as Effect 4.1.3 makes one from `given`, which `Intl` resolves as it resolves `resolving`. */
export const madeAs413 = (given: string, resolving: string): DateTime.TimeZone => {
  const real = DateTime.zoneMakeNamedUnsafe(resolving) as unknown as {
    readonly format: Intl.DateTimeFormat
  }
  const zone = Object.create(Object.getPrototypeOf(real))
  zone.id = given
  zone.resolvedId = real.format.resolvedOptions().timeZone
  zone.format = real.format
  return zone
}

class Point extends Data.Class<{ readonly x: number; readonly y: number }> {}
class Moved extends Data.TaggedClass("Moved")<{ readonly by: number }> {}

/** A value type: its schema, and a value of it made afresh on each call. */
interface Kind {
  readonly schema: Schema.Top
  readonly make: () => unknown
}

export const KINDS: Readonly<Record<string, Kind>> = {
  DateTimeUtc: { schema: Schema.DateTimeUtc, make: () => DateTime.makeUnsafe(0) },
  "DateTimeZoned named": {
    schema: Schema.DateTimeZoned,
    make: () => DateTime.makeZonedUnsafe(0, { timeZone: "Europe/London" }),
  },
  "DateTimeZoned named, made from an alias on 4.1.3": {
    schema: Schema.DateTimeZoned,
    make: () => DateTime.makeZonedUnsafe(0, { timeZone: madeAs413("Etc/UTC", "UTC") }),
  },
  "DateTimeZoned offset": {
    schema: Schema.DateTimeZoned,
    make: () => DateTime.makeZonedUnsafe(0, { timeZone: DateTime.zoneMakeOffset(3_600_000) }),
  },
  "TimeZone named": {
    schema: Schema.TimeZoneNamed,
    make: () => DateTime.zoneMakeNamedUnsafe("Europe/London"),
  },
  "TimeZone named, as 4.1.3 makes it": {
    schema: Schema.TimeZoneNamed,
    make: () => madeAs413("Europe/London", "Europe/London"),
  },
  "TimeZone named, made from an alias on 4.1.3": {
    schema: Schema.TimeZoneNamed,
    make: () => madeAs413("Etc/UTC", "UTC"),
  },
  "TimeZone offset": {
    schema: Schema.TimeZoneOffset,
    make: () => DateTime.zoneMakeOffset(3_600_000),
  },
  Duration: { schema: Schema.Duration, make: () => Duration.millis(1500) },
  BigDecimal: { schema: Schema.BigDecimal, make: () => BigDecimal.fromStringUnsafe("1.50") },
  "Option some": { schema: Schema.Option(Schema.Number), make: () => Option.some(1) },
  "Option none": { schema: Schema.Option(Schema.Number), make: () => Option.none() },
  Redacted: { schema: Schema.Redacted(Schema.String), make: () => Redacted.make("s") },
  Chunk: { schema: Schema.Chunk(Schema.Number), make: () => Chunk.make(1, 2) },
  HashSet: { schema: Schema.HashSet(Schema.Number), make: () => HashSet.make(1, 2) },
  HashMap: {
    schema: Schema.HashMap(Schema.String, Schema.Number),
    make: () => HashMap.make(["a", 1]),
  },
  "Data class": { schema: Schema.Unknown, make: () => new Point({ x: 1, y: 2 }) },
  "Data tagged class": { schema: Schema.Unknown, make: () => new Moved({ by: 1 }) },
}

/** What a position did with the value: the stored attribute as JSON text, or the refusal. */
export type Cell = string

const said = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const error = Cause.squash(exit.cause) as any
  const message = String(error?.cause?.message ?? error?.message ?? "")
  const code = /\[EDD-\d+\]/.exec(message)?.[0] ?? /EDD-\d+/.exec(JSON.stringify(error))?.[0]
  return `refused: ${error?._tag ?? "defect"}${code === undefined ? "" : ` ${code}`}`
}

const Json = DynamoModel.Packed({ format: "json" })
/** Key text as 1.40.0 composed it by default, unescaped, in the escape-on run too. */
const schema = DynamoSchema.make({ name: "vt", version: 1, escapeKeys: false })

/** A definition refused when it's made, as its code. */
const refusedDefinition = (make: () => unknown): string | undefined => {
  try {
    make()
    return undefined
  } catch (error) {
    return `definition refused: ${/EDD-\d+/.exec(String(error))?.[0] ?? "defect"}`
  }
}

const valuesOf = (kind: Kind, typed: boolean): any =>
  Entity.make({
    model: DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        ...(typed && { typed: Schema.optional(kind.schema), key: Schema.optional(kind.schema) }),
        loose: Schema.optional(Schema.Unknown),
        packed: Schema.optional(Schema.Unknown),
      }),
      { packed: { storedAs: Json } },
    ),
    entityType: "V",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...(typed && {
      indexes: {
        byKey: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["id"] },
          sk: { field: "gsi1sk", composite: ["key"] },
        },
      },
    }),
  } as never)

/** Each position's outcome for one kind. */
export const cellsOf = (name: string): Effect.Effect<Record<string, Cell>> => {
  const kind = KINDS[name]!
  const typedRefusal = refusedDefinition(() => valuesOf(kind, true))
  const Values = valuesOf(kind, typedRefusal === undefined)
  const Main = Table.make({ schema, entities: { Values } } as never) as any
  const rootOf = () =>
    Aggregate.make(Schema.Struct({ id: Schema.String, f: kind.schema }), {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "root" },
      root: { entityType: "Root" },
      edges: {},
    } as never) as any
  const rootRefusal = refusedDefinition(rootOf)
  const Root = rootRefusal === undefined ? rootOf() : undefined
  const table = makeRecordingTable()
  const row = (id: string): any => table.items.get(`$vt#v1#v#id_${id}|$vt#v1#v`)
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({
      entities: { Values },
      aggregates: Root === undefined ? {} : { Root },
      tables: { Main },
    } as never)
    const put = (id: string, field: string) =>
      Effect.exit(db.entities.Values.put({ id, [field]: kind.make() }).asEffect())
    const cells: Record<string, Cell> = {}
    for (const field of ["typed", "loose", "packed", "key"]) {
      if (typedRefusal !== undefined && (field === "typed" || field === "key")) {
        cells[field] = typedRefusal
        if (field === "key") cells.keyText = typedRefusal
        continue
      }
      const exit = yield* put(field, field)
      cells[field] = said(exit) ?? JSON.stringify(row(field)?.[field])
      if (field === "key") cells.keyText = said(exit) ?? JSON.stringify(row(field)?.gsi1sk)
    }
    if (Root === undefined) {
      cells.aggregateUpdate = rootRefusal!
      return cells
    }
    const created = yield* Effect.exit(db.aggregates.Root.create({ id: "a", f: kind.make() }))
    if (Exit.isSuccess(created)) {
      table.take()
      const updated = yield* Effect.exit(
        db.aggregates.Root.update({ id: "a" }, ({ state }: any) => ({ ...state, f: kind.make() })),
      )
      cells.aggregateUpdate =
        said(updated) ??
        table
          .take()
          .map(({ command }: { command: string }) => command)
          .join(",")
    } else {
      cells.aggregateUpdate = `create ${said(created)}`
    }
    return cells
  }).pipe(Effect.provide(Main.layer({ name: "vt" })), Effect.provide(table.layer)) as never
}

/** Effect's string codecs for a zone and a zoned date, each given a zone made fresh from a name. */
export const CODECS: Readonly<Record<string, Kind>> = Object.fromEntries(
  (
    [
      ["TimeZoneNamedFromString", Schema.TimeZoneNamedFromString, false],
      ["TimeZoneFromString", Schema.TimeZoneFromString, false],
      ["DateTimeZonedFromString", Schema.DateTimeZonedFromString, true],
    ] as const
  ).flatMap(([codec, schema, dated]) =>
    ["Etc/UTC", "Asia/Kolkata"].map(
      (zone) =>
        [
          `${codec}, ${zone}`,
          {
            schema,
            make: () =>
              dated
                ? DateTime.makeZonedUnsafe(0, { timeZone: zone })
                : DateTime.zoneMakeNamedUnsafe(zone),
          },
        ] as const,
    ),
  ),
)

/**
 * For one of {@link CODECS}: the attribute a typed field stores, and the key text each key composed
 * from it holds: the primary sort key, an index's sort key, a unique sentinel's partition key and a
 * time-series event's sort key (the codec as `orderBy`), and the events a `history().where()` bound
 * equal to the value finds.
 */
export const codecCellsOf = (name: string): Effect.Effect<Record<string, Cell>> => {
  const kind = CODECS[name]!
  const model = Schema.Struct({
    id: Schema.String,
    k: kind.schema,
    n: Schema.optional(Schema.String),
  })
  const Keyed = Entity.make({
    model,
    entityType: "C",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: ["k"] } },
    indexes: {
      byK: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["id"] },
        sk: { field: "gsi1sk", composite: ["k"] },
      },
    },
    unique: { u: ["k"] },
  } as never)
  const Series = Entity.make({
    model,
    entityType: "S",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    timeSeries: { orderBy: "k", appendInput: model },
  } as never)
  const Main = Table.make({ schema, entities: { Keyed, Series } } as never) as any
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({
      entities: { Keyed, Series },
      tables: { Main },
    } as never)
    yield* db.entities.Keyed.put({ id: "a", k: kind.make() }).asEffect()
    const rows = [...table.items.values()] as Array<Record<string, any>>
    const row = rows.find((one) => one.__edd_e__?.S === "C")!
    const sentinel = rows.find((one) => one.__edd_e__?.S !== "C")!
    table.items.clear()
    yield* db.entities.Series.append({ id: "b", k: kind.make() }).asEffect()
    const event = [...table.items.values()].find((one: any) => one.sk.S.includes("#e#")) as any
    const bounded = yield* db.entities.Series.history({ id: "b" })
      .where((t: any, { eq }: any) => eq(t.k, kind.make()))
      .collect()
    return {
      typed: JSON.stringify(row.k),
      sk: row.sk.S,
      keyText: row.gsi1sk.S,
      sentinel: sentinel.pk.S,
      event: event.sk.S,
      historyEq: `${bounded.length} event`,
    }
  }).pipe(Effect.provide(Main.layer({ name: "vt" })), Effect.provide(table.layer)) as never
}
