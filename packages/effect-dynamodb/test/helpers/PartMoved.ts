/**
 * A table holding one of each unit `rekey` moves (#240), every one written with escaping off under
 * keys escaping changes: an item, an item and its reservation (a unique sentinel), a reservation
 * alone, an aggregate, an event stream with a snapshot and one without, and a projection's
 * read-model row, its tombstone and its outbox items. A run with escaping on cut short after any of
 * its writes ({@link cutShort}) leaves the table part-moved: some units moved, one half-way, the
 * rest not started. `RekeyVisitOrder.test.ts` starts the next run from each such table.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Schema } from "effect"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient, type DynamoClientService } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Table from "../../src/Table.js"
import { type Around, gatedClient } from "./GatedClient.js"
import { makeRecordingTable } from "./RecordingTable.js"

type Row = Record<string, AttributeValue>

class Stop extends Schema.Class<Stop>("Stop")({ label: Schema.String, note: Schema.String }) {}
class Route extends Schema.Class<Route>("Route")({
  id: Schema.String,
  name: Schema.String,
  stops: Schema.Array(Stop),
}) {}
class Logged extends Schema.TaggedClass<Logged>()("Logged", { note: Schema.String }) {}
class Opened extends Schema.TaggedClass<Opened>()("Opened", {}) {}
class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}
class Closed extends Schema.TaggedClass<Closed>()("Closed", {}) {}

const Plain = Schema.Struct({ id: Schema.String, note: Schema.String })
const Member = Schema.Struct({ id: Schema.String, email: Schema.String })
const Tally = Schema.Struct({
  shop: Schema.String,
  name: Schema.String,
  total: Schema.Number,
  version: Schema.Number,
  rev: Schema.Number,
})
const Notice = Schema.Struct({ account: Schema.String, total: Schema.Number })

/** Each account's read-model row: `a 1`'s moves in its sort key, `a 2`'s in both halves. */
const ROWS: Record<string, { readonly shop: string; readonly name: string }> = {
  "a 1": { shop: "s1", name: "a b" },
  "a 2": { shop: "x y", name: "c d" },
}

/** The outbox index the projection writes its items to. */
export const OUTBOX_INDEX = { outbox: { pk: "obpk", sk: "obsk" } } as const

export const partMovedWorld = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "part", version: 1, escapeKeys })
  const Rows = Entity.make({
    model: Plain,
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: [] }, sk: { field: "sk", composite: ["id"] } },
  })
  const Members = Entity.make({
    model: Member,
    entityType: "Member",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    unique: { email: ["email"] },
  })
  const Tallies = Entity.make({
    model: Tally,
    entityType: "Tally",
    primaryKey: {
      pk: { field: "pk", composite: ["shop"] },
      sk: { field: "sk", composite: ["name"] },
    },
    timestamps: true,
  })
  const MainTable = Table.make({ schema, entities: { Rows, Members, Tallies } })
  const Routes = Aggregate.make(Route, {
    table: MainTable,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "routes" },
    root: { entityType: "RouteItem" },
    edges: {
      stops: Aggregate.many({ entityType: "RouteStop", sk: { composite: ["label"] } }),
    },
  })
  const Logs = EventStore.makeStream({
    table: MainTable,
    streamName: "Log",
    events: [Logged],
    streamId: { composite: ["id"] },
  })
  const Snaps = EventStore.makeStream({
    table: MainTable,
    streamName: "Snap",
    events: [Logged],
    streamId: { composite: ["id"] },
    snapshot: { schema: Schema.Struct({ count: Schema.Number }) },
  })
  const Accounts = EventStore.makeStream({
    table: MainTable,
    streamName: "Account",
    events: [Opened, Added, Closed],
    streamId: { composite: ["account"] },
  })
  const Notifying = EventStore.projection({
    stream: Accounts,
    readModel: Tallies,
    key: (id) => ROWS[id.account]!,
    initial: (id) => ({ ...ROWS[id.account]!, total: 0, version: 0, rev: 0 }),
    evolve: (state, event) =>
      Effect.succeed(
        event.data._tag === "Closed"
          ? EventStore.removeRow
          : event.data._tag === "Added"
            ? { ...state, total: state.total + event.data.amount }
            : state,
      ),
    checkpoint: "version",
    revision: "rev",
    removal: {},
    outbox: {
      schema: Notice,
      effects: (event, next) =>
        event.data._tag === "Added" ? [{ account: event.streamId, total: next?.total ?? -1 }] : [],
      index: { name: "outbox", ...OUTBOX_INDEX.outbox },
    },
  })
  return {
    MainTable,
    streams: [Logs, Snaps, Accounts],
    client: DynamoClient.make({
      entities: { Rows, Members, Tallies },
      aggregates: { Routes },
      tables: { MainTable },
    }),
    write: Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Rows, Members, Tallies },
        aggregates: { Routes },
        tables: { MainTable },
      })
      yield* db.entities.Rows.put({ id: "a b", note: "moves" }).asEffect()
      yield* db.entities.Rows.put({ id: "c", note: "stays" }).asEffect()
      // An item and its reservation, and a reservation alone.
      yield* db.entities.Members.put({ id: "m 1", email: "e 1" }).asEffect()
      yield* db.entities.Members.put({ id: "m2", email: "f 2" }).asEffect()
      yield* db.aggregates.Routes.create({
        id: "r 1",
        name: "n",
        stops: [new Stop({ label: "a b", note: "1" }), new Stop({ label: "c", note: "2" })],
      })
      const logged = [1, 2, 3].map((n) => new Logged({ note: `${n}` }))
      yield* Logs.append({ id: "l 1" }, logged, 0)
      yield* Snaps.append({ id: "s 1" }, logged, 0)
      yield* Snaps.writeSnapshot({ id: "s 1" }, { count: 3 }, 3)
      // A read-model row and two outbox items; a tombstone and one.
      yield* Accounts.append(
        { account: "a 1" },
        [new Opened(), new Added({ amount: 2 }), new Added({ amount: 3 })],
        0,
      )
      yield* Notifying.applyBatch(yield* Accounts.read({ account: "a 1" }))
      yield* Accounts.append(
        { account: "a 2" },
        [new Opened(), new Added({ amount: 4 }), new Closed()],
        0,
      )
      yield* Notifying.applyBatch(yield* Accounts.read({ account: "a 2" }))
    }),
  }
}

/** The rows {@link partMovedWorld}'s `write` stores with escaping off. */
export const writtenOff = Effect.gen(function* () {
  const table = makeRecordingTable({ indexes: OUTBOX_INDEX })
  const off = partMovedWorld(false)
  yield* off.write.pipe(
    Effect.provide(Layer.merge(table.layer, off.MainTable.layer({ name: "t" }))),
  ) as Effect.Effect<void, unknown>
  return [...table.items.values()]
})

const WRITES = new Set([
  "putItem",
  "deleteItem",
  "updateItem",
  "transactWriteItems",
  "batchWriteItem",
])

/** Whether a request writes. */
export const writes = (command: string) => WRITES.has(command)

/**
 * The rows a run with escaping on leaves when every write after its first `after` fails: the run
 * stops there, its units in flight cut short too. `undefined` when the run sends no more than
 * `after` writes and finishes. `options` and `order` (a scan's pages, as `RekeyVisitOrder.test.ts`
 * shuffles them) decide which units are in flight.
 */
export const cutShort = (
  rows: ReadonlyArray<Row>,
  after: number,
  options: { readonly segments: number; readonly concurrency: number } = {
    segments: 1,
    concurrency: 1,
  },
  order: Around = (_command, _input, send) => send,
) =>
  Effect.gen(function* () {
    const table = makeRecordingTable({ indexes: OUTBOX_INDEX })
    for (const row of rows) table.items.set(`${row.pk?.S}|${row.sk?.S}`, row)
    const on = partMovedWorld(true)
    let sent = 0
    const client = gatedClient(table.client as DynamoClientService, (command, input, send) => {
      if (!writes(command)) return order(command, input, send)
      if (sent++ < after) return send
      return Effect.fail(
        new DynamoError({ operation: command, cause: new Error(`cut short after ${after}`) }),
      )
    })
    yield* Effect.exit(
      Effect.gen(function* () {
        const db = yield* on.client
        return yield* db.tables.MainTable.rekey({ ...options, streams: on.streams, pageSize: 3 })
      }).pipe(
        Effect.provide(
          Layer.merge(Layer.succeed(DynamoClient, client), on.MainTable.layer({ name: "t" })),
        ),
      ),
    )
    return sent > after ? [...table.items.values()] : undefined
  })
