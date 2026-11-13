/**
 * Random tables for `rekey` (#240): a seeded run of ordinary library writes over every kind of row
 * `rekey` moves — items with unique constraints (one `preserveUnique` soft-deleting entity with
 * retained versions, one hard-deleting entity with two constraints, one releasing its reservations
 * on a soft delete), time-series events, an aggregate and an event stream. The values come from
 * pools whose texts chain between the two `escapeKeys` settings (`a b` escapes to where `a%20b` is
 * stored raw, and so on), so a table written under one setting and rekeyed under the other has
 * rows, sentinels and partitions whose current keys are where others are stored. A write that
 * fails (a taken value, a missing item) is part of the sequence: it writes nothing.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient, type DynamoClientService } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Table from "../../src/Table.js"
import { type Around, gatedLayer } from "./GatedClient.js"
import { makeRecordingTable } from "./RecordingTable.js"

export type Row = Record<string, AttributeValue>

class Counted extends Schema.TaggedClass<Counted>()("Counted", { by: Schema.Number }) {}

const Line = Schema.Struct({ lid: Schema.String, qty: Schema.Number })

/** The members, under `escapeKeys`. */
export const randomWorld = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "fz", version: 1, escapeKeys })
  const Rows = Entity.make({
    model: Schema.Struct({ id: Schema.String, note: Schema.String }),
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: [] }, sk: { field: "sk", composite: ["id"] } },
  })
  const Users = Entity.make({
    model: Schema.Struct({
      team: Schema.String,
      id: Schema.String,
      email: Schema.String,
      name: Schema.String,
    }),
    entityType: "User",
    primaryKey: {
      pk: { field: "pk", composite: ["team"] },
      sk: { field: "sk", composite: ["id"] },
    },
    indexes: {
      byName: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["team"] },
        sk: { field: "gsi1sk", composite: ["name"] },
      },
    },
    unique: { email: ["email"] },
    timestamps: true,
    versioned: { retain: true },
    softDelete: { preserveUnique: true },
  })
  const Members = Entity.make({
    model: Schema.Struct({ id: Schema.String, email: Schema.String, nick: Schema.String }),
    entityType: "Member",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    unique: { email: ["email"], nick: ["nick"] },
  })
  const Soft = Entity.make({
    model: Schema.Struct({ id: Schema.String, code: Schema.String }),
    entityType: "Soft",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    unique: { code: ["code"] },
    softDelete: true,
  })
  const Readings = Entity.make({
    model: Schema.Struct({ device: Schema.String, at: Schema.Number, value: Schema.Number }),
    entityType: "Reading",
    primaryKey: { pk: { field: "pk", composite: ["device"] }, sk: { field: "sk", composite: [] } },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({
        device: Schema.String,
        at: Schema.Number,
        value: Schema.Number,
      }),
    },
  })
  const entities = { Rows, Users, Members, Soft, Readings }
  const MainTable = Table.make({ schema, entities })
  const Orders = Aggregate.make(
    Schema.Struct({ id: Schema.String, customer: Schema.String, lines: Schema.Array(Line) }),
    {
      schema,
      table: MainTable,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "orders" },
      root: { entityType: "Order" },
      edges: { lines: Aggregate.many({ entityType: "OrderLine", sk: { composite: ["lid"] } }) },
    },
  )
  const Counters = EventStore.makeStream({
    table: MainTable,
    streamName: "Counters",
    events: [Counted],
    streamId: { composite: ["name"] },
  })
  const client = DynamoClient.make({ entities, aggregates: { Orders }, tables: { MainTable } })
  return { MainTable, Counters, client }
}

/** A seeded generator in [0, 1). */
export const seeded = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const POOLS: ReadonlyArray<ReadonlyArray<string>> = [
  ["a b", "a%20b", "a%2520b", "a%252520b"],
  ["a b", "a%20b", "c d", "c%20d", "plain"],
  ["a b", "a%20b", "a%2520b", "p#q", "p%23q", "plain", "x y", "x%20y", "Z z", "q$r", "q%24r"],
]

/** The rows `seed`'s writes leave, written under `escapeKeys`. */
export const writeRandom = (escapeKeys: boolean, seed: number) =>
  Effect.gen(function* () {
    const table = makeRecordingTable()
    const world = randomWorld(escapeKeys)
    const next = seeded(seed)
    const pool = POOLS[seed % 2 === 0 ? 0 : seed % 3 === 0 ? 1 : 2]!
    const pick = () => pool[Math.floor(next() * pool.length)]!
    const writes = seed % 2 === 0 ? 30 : 6 + Math.floor(next() * 14)
    yield* Effect.gen(function* () {
      const db = yield* world.client
      const attempt = <A, E, R>(write: { readonly asEffect: () => Effect.Effect<A, E, R> }) =>
        Effect.ignore(Effect.suspend(() => write.asEffect()))
      for (let i = 0; i < writes; i++) {
        const kind = Math.floor(next() * 12)
        if (kind === 0) yield* attempt(db.entities.Rows.put({ id: pick(), note: `n${i}` }))
        else if (kind === 1) {
          yield* attempt(
            db.entities.Users.put({ team: pick(), id: pick(), email: pick(), name: pick() }),
          )
        } else if (kind === 2) {
          yield* attempt(
            db.entities.Users.update({ team: pick(), id: pick() }).set({ name: pick() }),
          )
        } else if (kind === 3)
          yield* attempt(db.entities.Users.delete({ team: pick(), id: pick() }))
        else if (kind === 4) {
          yield* attempt(db.entities.Members.put({ id: pick(), email: pick(), nick: pick() }))
        } else if (kind === 5) yield* attempt(db.entities.Members.delete({ id: pick() }))
        else if (kind === 6) yield* attempt(db.entities.Soft.put({ id: pick(), code: pick() }))
        else if (kind === 7) yield* attempt(db.entities.Soft.delete({ id: pick() }))
        else if (kind === 8) {
          yield* attempt(db.entities.Readings.append({ device: pick(), at: i, value: i }))
        } else if (kind === 9) {
          yield* Effect.ignore(
            db.aggregates.Orders.create({
              id: pick(),
              customer: pick(),
              lines: [
                { lid: pick(), qty: 1 },
                { lid: `l${i}`, qty: 2 },
              ],
            }),
          )
        } else if (kind === 10) {
          yield* Effect.ignore(world.Counters.append({ name: pick() }, [new Counted({ by: i })], 0))
        } else yield* attempt(db.entities.Members.update({ id: pick() }).set({ nick: pick() }))
      }
    }).pipe(Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "t" }))))
    return [...table.items.values()]
  })

/** A table holding `rows`. */
export const tableOf = (rows: Iterable<Row>) => {
  const table = makeRecordingTable()
  for (const row of rows) table.items.set(`${row.pk?.S}|${row.sk?.S}`, structuredClone(row))
  return table
}

/** Scans whose pages come back in an order of `seed`'s (0: as read). */
export const scanShuffled =
  (seed: number): Around =>
  (command, _input, send) => {
    if (command !== "scan" || seed === 0) return send
    let page = 0
    return Effect.map(send, (output: any) => {
      const next = seeded(seed * 7919 + page++)
      const items = [...(output.Items ?? [])]
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[items[i], items[j]] = [items[j], items[i]]
      }
      return { ...output, Items: items }
    })
  }

/**
 * Every request first yields a number of times of `seed`'s, 0 to 7: the fibers of a run, and of
 * runs started together, interleave as they would against a table answering at random speeds.
 */
export const jittered = (seed: number): Around => {
  const next = seeded(seed)
  return (_command, _input, send) => {
    let request = send
    for (let n = Math.floor(next() * 8); n > 0; n--)
      request = Effect.andThen(Effect.yieldNow, request)
    return request
  }
}

/** Every request yields first: runs started together interleave request by request. */
export const yieldingFirst: Around = (_command, _input, send) =>
  Effect.andThen(Effect.yieldNow, send)

/**
 * `rekey` runs under `escapeKeys`, started together, through `client` over the table `name`: the
 * recording table's ({@link rekeyRuns}) or DynamoDB Local's.
 */
export const rekeyRunsOn = (
  escapeKeys: boolean,
  client: Layer.Layer<DynamoClient>,
  name: string,
  runs: ReadonlyArray<Table.RekeyOptions>,
) => {
  const world = randomWorld(escapeKeys)
  return Effect.gen(function* () {
    const db = yield* world.client
    return yield* Effect.all(
      runs.map((options) => db.tables.MainTable.rekey({ ...options, streams: [world.Counters] })),
      { concurrency: "unbounded" },
    )
  }).pipe(Effect.provide(Layer.merge(client, world.MainTable.layer({ name }))))
}

/** `rekey` runs over `table` under `escapeKeys`, started together, each request through `around`. */
export const rekeyRuns = (
  escapeKeys: boolean,
  table: ReturnType<typeof makeRecordingTable>,
  runs: ReadonlyArray<Table.RekeyOptions>,
  around: Around = (_command, _input, send) => send,
) => rekeyRunsOn(escapeKeys, gatedLayer(table.client as DynamoClientService, around), "t", runs)

/** One `rekey` run over `table` under `escapeKeys`. */
export const rekeyOnce = (
  escapeKeys: boolean,
  table: ReturnType<typeof makeRecordingTable>,
  options: Table.RekeyOptions,
  around?: Around,
) => Effect.map(rekeyRuns(escapeKeys, table, [options], around), (reports) => reports[0]!)

/**
 * Every unique value a row of the table holds, as a write of a new item that would take it: a
 * live Member's email and nick, a live Soft item's code, a live User's email and one a User's
 * tombstone keeps (`preserveUnique`). Each must be refused while the reservation stands.
 */
export const takenValues = (rows: Iterable<Row>) => {
  const values: Array<{ readonly member: "Members" | "Soft" | "Users"; readonly value: string }> =
    []
  for (const row of rows) {
    const type = row.__edd_e__?.S
    const sk = row.sk?.S ?? ""
    const live = !sk.includes("#deleted#") && !sk.includes("#v#")
    if (type === "Member" && live) {
      values.push({ member: "Members", value: `email:${row.email!.S}` })
      values.push({ member: "Members", value: `nick:${row.nick!.S}` })
    } else if (type === "Soft" && live) {
      values.push({ member: "Soft", value: `code:${row.code!.S}` })
    } else if (type === "User" && !sk.includes("#v#")) {
      values.push({ member: "Users", value: `email:${row.email!.S}` })
    }
  }
  return values
}

/**
 * Try to take `value` with a new item, under `escapeKeys`: `refused` when the reservation stands
 * (`UniqueConstraintViolation`), `accepted` when the write took it, or the failure's tag.
 */
export const takeValue = (
  escapeKeys: boolean,
  table: ReturnType<typeof makeRecordingTable>,
  taken: ReturnType<typeof takenValues>[number],
  n: number,
) => takeValueOn(escapeKeys, table.layer, "t", taken, n)

/** {@link takeValue} through `client` over the table `name`. */
export const takeValueOn = (
  escapeKeys: boolean,
  client: Layer.Layer<DynamoClient>,
  name: string,
  taken: ReturnType<typeof takenValues>[number],
  n: number,
) => {
  const world = randomWorld(escapeKeys)
  const [field, value] = [
    taken.value.slice(0, taken.value.indexOf(":")),
    taken.value.slice(taken.value.indexOf(":") + 1),
  ]
  return Effect.gen(function* () {
    const db = yield* world.client
    if (taken.member === "Members") {
      return yield* db.entities.Members.put({
        id: `dup-${n}`,
        email: field === "email" ? value : `dup-email-${n}`,
        nick: field === "nick" ? value : `dup-nick-${n}`,
      }).asEffect()
    }
    if (taken.member === "Soft") {
      return yield* db.entities.Soft.put({ id: `dup-${n}`, code: value }).asEffect()
    }
    return yield* db.entities.Users.put({
      team: "dup",
      id: `dup-${n}`,
      email: value,
      name: "dup",
    }).asEffect()
  }).pipe(
    Effect.provide(Layer.merge(client, world.MainTable.layer({ name }))),
    Effect.as("accepted"),
    Effect.catchTag("UniqueConstraintViolation", () => Effect.succeed("refused")),
    Effect.catch((error: { readonly _tag: string }) => Effect.succeed(error._tag)),
  )
}

/**
 * Each unique sentinel whose back-pointer names a key where no row of its entity is, and no
 * tombstone of one (`preserveUnique` keeps its reservations), or a row that doesn't hold its value.
 */
export const strayed = (rows: ReadonlyArray<Row>) => {
  const at = new Map(rows.map((row) => [`${row.pk?.S}|${row.sk?.S}`, row]))
  const out: Array<string> = []
  for (const sentinel of rows) {
    const type = sentinel.__edd_e__?.S ?? ""
    if (!type.includes("._unique.")) continue
    const entityType = type.slice(0, type.indexOf("."))
    const field = type.slice(type.indexOf("._unique.") + "._unique.".length)
    const pk = sentinel._entity_pk?.S
    const sk = sentinel._entity_sk?.S ?? ""
    const live = at.get(`${pk}|${sk}`)
    const tombstones = rows.filter(
      (row) =>
        row.__edd_e__?.S === entityType &&
        row.pk?.S === pk &&
        row.sk?.S?.includes("#deleted#") === true,
    )
    const holders = [...(live === undefined ? [] : [live]), ...tombstones]
    const text = sentinel.pk!.S!.slice(sentinel.sk!.S!.length + 1)
    // Escaped or not, the value's key text (lower-cased) ends the sentinel's partition key.
    const holds = holders.some((row) => {
      const value = row[field]?.S?.toLowerCase()
      return value !== undefined && (value === text || escaped(value) === text)
    })
    if (!holds) out.push(`${sentinel.pk!.S} names ${pk}|${sk}`)
  }
  return out
}

/** `text` as escaped key text: each code point U+0000–U+0025 as `%` and two hex digits. */
const escaped = (text: string) =>
  [...text]
    .map((c) => {
      const code = c.codePointAt(0)!
      return code <= 0x25 ? `%${code.toString(16).padStart(2, "0")}` : c
    })
    .join("")
