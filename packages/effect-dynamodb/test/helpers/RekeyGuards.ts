/**
 * `rekey` moves whose guard 1.39.0 sent, and what came of them, from the published 1.39.0.
 *
 * `test/fixtures/rekey-guards-1.39.0.json` holds, for every case here, what `capture` returned
 * against the published 1.39.0; `test/RekeyGuards.test.ts` runs the same cases against this source.
 * Rows are written with `escapeKeys` off and moved with it on, under a fixed clock.
 *
 * - **An aggregate with nothing absent to guard**, timestamped and not, and a timestamped one
 *   with a row too wide to guard whole: the requests `rekey` sends.
 * - **A wide entity row whose `updatedAt` or version is stored under another name**, and an update
 *   that lands between `rekey`'s read and its move: whether the move kept the update.
 * - **An entity row whose stamps are stored under other names**, with a unique constraint and
 *   soft delete: the requests `rekey` sends, and a delete afterwards.
 * - **An aggregate whose first wave moved**, and an update that lands before its root's move and
 *   adds a row too wide to guard whole, or one whose run stopped before its root's move and was
 *   updated so before the next: where the aggregate ends up.
 * - **An event stream whose run stopped after its flip**, and an event too wide to guard whole that
 *   lands under its old key before the next run: where the stream ends up.
 * - **A timestamped aggregate's row too wide to guard whole, whose node declares its own `updatedAt`
 *   as a string**, required or optional, and an update that lands before the move: how the
 *   aggregate reads first, what `rekey` reports, and whether any row changed.
 *
 * The library is taken as a parameter, so one definition serves both.
 */

import { Duration, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { makeRecordingTable } from "./RecordingTable.js"

/** The library's public modules, of whichever release is under test. */
export interface Api {
  readonly Aggregate: any
  readonly DynamoClient: any
  readonly DynamoModel: any
  readonly DynamoSchema: any
  readonly Entity: any
  readonly EventStore: any
  readonly Table: any
}

/** What a case did. */
export interface Outcome {
  /** The requests `rekey` sent, whole, in order: for the cases that pin them. */
  readonly requests?: ReadonlyArray<{ readonly command: string; readonly input: unknown }>
  /** The requests a delete sent after the move, whole, in order: for the cases that pin them. */
  readonly deleteRequests?: ReadonlyArray<{ readonly command: string; readonly input: unknown }>
  /** The rows afterwards, as stored, by key: for the cases that pin them. */
  readonly rows?: ReadonlyArray<Record<string, unknown>>
  /** `rekey`'s report: rows moved, and each conflict's reason and key. */
  readonly moved: Record<string, number>
  readonly conflicts: ReadonlyArray<{ readonly reason: string; readonly key: unknown }>
  /** Whether the update that landed in between is in the row at its new key. */
  readonly kept?: boolean
  /** The partitions holding the aggregate's rows afterwards. */
  readonly partitions?: number
  /** The aggregate, or the stream's events, as read under the new key text afterwards. */
  readonly read?: unknown
  /** Whether every row is as it was before `rekey` ran. */
  readonly unchanged?: boolean
}

export const CASES = [
  "aggregate, no timestamps: the move's requests",
  "aggregate, timestamps: the move's requests",
  "aggregate, timestamps, a row too wide to guard whole: the move's requests",
  "wide entity, updatedAt stored as zzTime: an update lands before the move",
  "wide entity, version stored as zzVer: an update lands before the move",
  "entity, stamps stored as zzTime and zzMade, unique and soft delete: the move's and a delete's requests",
  "aggregate part-moved: an update adds a wide row before the root's move",
  "aggregate part-moved by a run cut short: an update adds a wide row, and rekey runs again",
  "stream flipped by a run cut short: a wide event lands under its old key, and rekey runs again",
  "aggregate, timestamps, a wide row whose node declares updatedAt a string: an update lands before the move",
  "aggregate, timestamps, a wide row whose node declares updatedAt an optional string: an update lands before the move",
] as const
export type Case = (typeof CASES)[number]

const wideFields = Object.fromEntries(
  Array.from({ length: 160 }, (_, i) => [`f${String(i).padStart(3, "0")}`, Schema.String]),
)
const wideFill = Object.fromEntries(Object.keys(wideFields).map((field) => [field, "old"]))

/** JSON as a fixture holds it. */
const plain = <A>(value: A): A =>
  JSON.parse(JSON.stringify(value, (_key, held) => (held === undefined ? null : held)))

const byKey = (items: Iterable<Record<string, any>>) =>
  [...items].sort((a, b) =>
    `${a.pk?.S}|${a.sk?.S}` < `${b.pk?.S}|${b.sk?.S}`
      ? -1
      : `${a.pk?.S}|${a.sk?.S}` > `${b.pk?.S}|${b.sk?.S}`
        ? 1
        : 0,
  )

const reportOf = (report: any) => ({
  moved: Object.fromEntries(
    Object.entries(report.moved ?? {}).filter(([, count]) => (count as number) > 0),
  ) as Record<string, number>,
  conflicts: (report.conflicts ?? []).map((conflict: any) => ({
    reason: conflict.reason,
    key: conflict.key,
  })),
})

/** Run `body` with a typed client of `world` over `client`. */
const on = (
  api: Api,
  world: { readonly Main: any; readonly client: Effect.Effect<any, any, any> },
  client: unknown,
  body: (db: any) => Effect.Effect<any, any, any>,
) =>
  Effect.gen(function* () {
    const db = yield* world.client
    return yield* body(db)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(world.Main.layer({ name: "t" }), Layer.succeed(api.DynamoClient, client)),
    ),
  )

/** `client`, with `write` landing just before the first transaction that `when` picks. */
const racing = (
  client: any,
  write: () => Effect.Effect<unknown, unknown, any>,
  when: (input: any) => boolean = () => true,
) => {
  let landed = false
  return new Proxy(client, {
    get(target, prop) {
      const method = Reflect.get(target, prop)
      if (typeof method !== "function") return method
      return (input: any) =>
        Effect.suspend(() => {
          if (prop === "transactWriteItems" && !landed && when(input)) {
            landed = true
            return Effect.flatMap(write(), () => method.call(target, input))
          }
          return method.call(target, input)
        })
    },
  })
}

const aggregateRequests = (api: Api, timestamps: boolean, wide = false) =>
  Effect.gen(function* () {
    const world = (escapeKeys: boolean) => {
      const schema = api.DynamoSchema.make({ name: "guards", version: 1, escapeKeys })
      const Main = api.Table.make({ schema, entities: {} })
      const line = wide
        ? Schema.Struct({
            name: Schema.String,
            v: Schema.String,
            note: Schema.optionalKey(Schema.String),
            ...wideFields,
          })
        : Schema.Struct({ name: Schema.String, v: Schema.String })
      const Order = api.Aggregate.make(
        Schema.Struct({ id: Schema.String, lines: Schema.Array(line) }),
        {
          schema,
          table: Main,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "orders" },
          root: { entityType: "Order" },
          ...(timestamps && { timestamps: true }),
          edges: { lines: api.Aggregate.many({ entityType: "Line", sk: { composite: ["name"] } }) },
        },
      )
      return {
        Main,
        client: api.DynamoClient.make({ entities: {}, aggregates: { Order }, tables: { Main } }),
      }
    }
    const table = makeRecordingTable()
    yield* on(api, world(false), table.client, (db) =>
      db.aggregates.Order.create({
        id: "a b",
        lines: [{ name: "one", v: "v", ...(wide ? wideFill : {}) }],
      }),
    )
    table.take()
    const report = yield* on(api, world(true), table.client, (db) => db.tables.Main.rekey())
    return { requests: table.take(), rows: byKey(table.items.values()), ...reportOf(report) }
  })

const wideEntityRace = (api: Api, renamed: "updatedAt" | "version") =>
  Effect.gen(function* () {
    const world = (escapeKeys: boolean) => {
      const schema = api.DynamoSchema.make({ name: "guards", version: 1, escapeKeys })
      const Item = api.Entity.make({
        entityType: "Item",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
        ...(renamed === "updatedAt"
          ? {
              model: api.DynamoModel.configure(
                Schema.Struct({ id: Schema.String, ...wideFields, updatedAt: Schema.DateTimeUtc }),
                { updatedAt: { field: "zzTime" } },
              ),
              timestamps: true,
            }
          : {
              model: Schema.Struct({ id: Schema.String, ...wideFields }),
              versioned: { field: "zzVer" },
            }),
      })
      const Main = api.Table.make({ schema, entities: { Item } })
      return { Main, client: api.DynamoClient.make({ entities: { Item }, tables: { Main } }) }
    }
    const table = makeRecordingTable()
    yield* on(api, world(false), table.client, (db) =>
      db.entities.Item.put({ id: "a b", ...wideFill }),
    )
    yield* TestClock.adjust(Duration.seconds(1))
    const update = () =>
      on(api, world(false), table.client, (db) =>
        db.entities.Item.update({ id: "a b" }).set({ f159: "changed" }),
      )
    const report = yield* on(api, world(true), racing(table.client, update), (db) =>
      db.tables.Main.rekey(),
    )
    const rows: Array<any> = [...table.items.values()]
    return {
      ...reportOf(report),
      kept: rows.length === 1 && rows[0]!.f159?.S === "changed",
    }
  })

const renamedStampRequests = (api: Api) =>
  Effect.gen(function* () {
    const world = (escapeKeys: boolean) => {
      const schema = api.DynamoSchema.make({ name: "guards", version: 1, escapeKeys })
      const Item = api.Entity.make({
        entityType: "Item",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
        model: api.DynamoModel.configure(
          Schema.Struct({
            id: Schema.String,
            code: Schema.String,
            note: Schema.optionalKey(Schema.String),
            createdAt: Schema.DateTimeUtc,
            updatedAt: Schema.DateTimeUtc,
          }),
          { createdAt: { field: "zzMade" }, updatedAt: { field: "zzTime" } },
        ),
        timestamps: true,
        unique: { code: ["code"] },
        softDelete: true,
      })
      const Main = api.Table.make({ schema, entities: { Item } })
      return { Main, client: api.DynamoClient.make({ entities: { Item }, tables: { Main } }) }
    }
    const table = makeRecordingTable()
    yield* on(api, world(false), table.client, (db) =>
      db.entities.Item.put({ id: "a b", code: "c" }),
    )
    yield* TestClock.adjust(Duration.seconds(1))
    table.take()
    const report = yield* on(api, world(true), table.client, (db) => db.tables.Main.rekey())
    const requests = table.take()
    yield* on(api, world(true), table.client, (db) => db.entities.Item.delete({ id: "a b" }))
    return { requests, deleteRequests: table.take(), ...reportOf(report) }
  })

const partMovedAggregate = (api: Api, cutShort: boolean) =>
  Effect.gen(function* () {
    const world = (escapeKeys: boolean) => {
      const schema = api.DynamoSchema.make({ name: "guards", version: 1, escapeKeys })
      const Main = api.Table.make({ schema, entities: {} })
      const Order = api.Aggregate.make(
        Schema.Struct({
          id: Schema.String,
          status: Schema.String,
          lines: Schema.Array(Schema.Struct({ name: Schema.String })),
          wide: Schema.Array(Schema.Struct({ name: Schema.String, ...wideFields })),
        }),
        {
          schema,
          table: Main,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "orders" },
          root: { entityType: "Order" },
          edges: {
            lines: api.Aggregate.many({ entityType: "Line", sk: { composite: ["name"] } }),
            wide: api.Aggregate.many({ entityType: "Wide", sk: { composite: ["name"] } }),
          },
        },
      )
      return {
        Main,
        client: api.DynamoClient.make({ entities: {}, aggregates: { Order }, tables: { Main } }),
      }
    }
    const table = makeRecordingTable()
    yield* on(api, world(false), table.client, (db) =>
      db.aggregates.Order.create({ id: "a b", status: "old", lines: [{ name: "one" }], wide: [] }),
    )
    const update = () =>
      on(api, world(false), table.client, (db) =>
        db.aggregates.Order.update({ id: "a b" }, ({ state }: any) => ({
          ...state,
          status: "changed",
          wide: [{ name: "new", ...wideFill }],
        })),
      )
    // The root moves last: the update lands once the line's move has committed.
    const rootMove = (input: any) =>
      input.TransactItems.some((item: any) => item.Delete?.Key?.sk?.S?.endsWith("#order"))
    if (cutShort) {
      // The run stops at the root's move, with the line moved; the update lands before the next.
      const stopped = racing(table.client, () => Effect.fail("stopped"), rootMove)
      yield* on(api, world(true), stopped, (db) => db.tables.Main.rekey()).pipe(Effect.ignore)
      yield* update()
    }
    const report = yield* on(
      api,
      world(true),
      cutShort ? table.client : racing(table.client, update, rootMove),
      (db) => db.tables.Main.rekey(),
    )
    const read = yield* on(api, world(true), table.client, (db) =>
      db.aggregates.Order.get({ id: "a b" }),
    ).pipe(Effect.orElseSucceed(() => "unreadable"))
    return {
      ...reportOf(report),
      partitions: new Set([...table.items.values()].map((row: any) => row.pk.S)).size,
      read,
    }
  })

class Changed extends Schema.TaggedClass<Changed>()("Changed", { n: Schema.Number }) {}

const flippedStream = (api: Api) =>
  Effect.gen(function* () {
    const world = (escapeKeys: boolean) => {
      const schema = api.DynamoSchema.make({ name: "guards", version: 1, escapeKeys })
      const Main = api.Table.make({ schema, entities: {} })
      const stream = api.EventStore.makeStream({
        table: Main,
        streamName: "Events",
        streamId: { composite: ["id"] },
        events: [Changed],
      })
      return {
        Main,
        stream,
        client: api.DynamoClient.make({ entities: {}, tables: { Main } }),
      }
    }
    const old = world(false)
    const now = world(true)
    const table = makeRecordingTable()
    yield* on(api, old, table.client, () =>
      old.stream.append({ id: "a b" }, [new Changed({ n: 1 }), new Changed({ n: 2 })], 0),
    )
    // The run stops at its first delete, after the flip: the stream's rows are under both keys.
    const stopped = new Proxy(table.client, {
      get(target, prop) {
        if (prop === "deleteItem") return () => Effect.fail("stopped")
        return Reflect.get(target, prop)
      },
    })
    yield* on(api, now, stopped, (db) => db.tables.Main.rekey({ streams: [now.stream] })).pipe(
      Effect.ignore,
    )
    // Event 3 lands under the old key, written with 200 more attributes than an event holds.
    const rows: Array<any> = [...table.items.values()]
    const flipped = rows.find((row: any) => row.__edd_moved__ !== undefined)!
    const second = rows.find((row: any) => row.pk.S === flipped.pk.S && row.version?.N === "2")!
    const third: Record<string, any> = {
      ...structuredClone(second),
      sk: { S: second.sk.S.replace(/2$/, "3") },
      version: { N: "3" },
    }
    for (let i = 0; i < 200; i++) third[`x${i}`] = { S: "v" }
    table.items.set(`${third.pk.S}|${third.sk.S}`, third)
    const report = yield* on(api, now, table.client, (db) =>
      db.tables.Main.rekey({ streams: [now.stream] }),
    )
    const read = yield* on(api, now, table.client, () => now.stream.read({ id: "a b" })).pipe(
      Effect.map((events: any) => events.map((event: any) => [event.version, event.data.n])),
      Effect.orElseSucceed(() => "unreadable"),
    )
    return {
      ...reportOf(report),
      partitions: new Set([...table.items.values()].map((row: any) => row.pk.S)).size,
      read,
    }
  })

const ownUpdatedAt = (api: Api, optional: boolean) =>
  Effect.gen(function* () {
    const world = (escapeKeys: boolean) => {
      const schema = api.DynamoSchema.make({ name: "guards", version: 1, escapeKeys })
      const Main = api.Table.make({ schema, entities: {} })
      const Order = api.Aggregate.make(
        Schema.Struct({
          id: Schema.String,
          lines: Schema.Array(
            Schema.Struct({
              name: Schema.String,
              updatedAt: optional ? Schema.optionalKey(Schema.String) : Schema.String,
              ...wideFields,
            }),
          ),
        }),
        {
          schema,
          table: Main,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "orders" },
          root: { entityType: "Order" },
          timestamps: true,
          edges: { lines: api.Aggregate.many({ entityType: "Line", sk: { composite: ["name"] } }) },
        },
      )
      return {
        Main,
        client: api.DynamoClient.make({ entities: {}, aggregates: { Order }, tables: { Main } }),
      }
    }
    const table = makeRecordingTable()
    yield* on(api, world(false), table.client, (db) =>
      db.aggregates.Order.create({
        id: "a b",
        lines: [{ name: "one", updatedAt: "the caller's", ...wideFill }],
      }),
    )
    const read = yield* on(api, world(false), table.client, (db) =>
      db.aggregates.Order.get({ id: "a b" }),
    ).pipe(
      Effect.map((order: any) => order.lines[0].updatedAt ?? null),
      Effect.orElseSucceed(() => "unreadable"),
    )
    yield* TestClock.adjust(Duration.seconds(1))
    const before = JSON.stringify(byKey(table.items.values()))
    const update = () =>
      on(api, world(false), table.client, (db) =>
        db.aggregates.Order.update({ id: "a b" }, ({ state }: any) => ({
          ...state,
          lines: state.lines.map((line: any) => ({ ...line, f159: "changed" })),
        })),
      )
    const report = yield* on(api, world(true), racing(table.client, update), (db) =>
      db.tables.Main.rekey(),
    )
    const line: any = [...table.items.values()].find((row: any) => row.__edd_e__?.S === "Line")
    return {
      ...reportOf(report),
      read,
      unchanged: JSON.stringify(byKey(table.items.values())) === before,
      kept: line?.f159?.S === "changed",
    }
  })

/** Run one case and return what it did. */
export const capture = (api: Api, name: Case): Effect.Effect<Outcome> => {
  const run: Effect.Effect<object, unknown, unknown> = (() => {
    switch (name) {
      case "aggregate, no timestamps: the move's requests":
        return aggregateRequests(api, false)
      case "aggregate, timestamps: the move's requests":
        return aggregateRequests(api, true)
      case "aggregate, timestamps, a row too wide to guard whole: the move's requests":
        return aggregateRequests(api, true, true)
      case "wide entity, updatedAt stored as zzTime: an update lands before the move":
        return wideEntityRace(api, "updatedAt")
      case "wide entity, version stored as zzVer: an update lands before the move":
        return wideEntityRace(api, "version")
      case "entity, stamps stored as zzTime and zzMade, unique and soft delete: the move's and a delete's requests":
        return renamedStampRequests(api)
      case "aggregate part-moved: an update adds a wide row before the root's move":
        return partMovedAggregate(api, false)
      case "aggregate part-moved by a run cut short: an update adds a wide row, and rekey runs again":
        return partMovedAggregate(api, true)
      case "stream flipped by a run cut short: a wide event lands under its old key, and rekey runs again":
        return flippedStream(api)
      case "aggregate, timestamps, a wide row whose node declares updatedAt a string: an update lands before the move":
        return ownUpdatedAt(api, false)
      case "aggregate, timestamps, a wide row whose node declares updatedAt an optional string: an update lands before the move":
        return ownUpdatedAt(api, true)
    }
  })()
  return Effect.map(run, (outcome) => plain(outcome) as Outcome) as Effect.Effect<Outcome>
}
