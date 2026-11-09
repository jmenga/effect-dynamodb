/**
 * Projections whose read model's key composite is a codec `encode` takes on its
 * own output (`x:` prepended), and the rows published 1.39.0 wrote for them
 * (`fixtures/key-codec-projection-1.39.0.json`): after the first event, the
 * stream's event and each read model's row at the key its `put` wrote
 * (`orderid_x:x:o1`). `Removable` removes the row on `Cancelled`; `Effected`
 * writes an outbox effect per event, in the read model's table.
 *
 * On 1.39.0 every later event failed (`ConcurrentModification`: the engine read
 * the row at `orderid_x:o1`, found none, and its `create` met the row), and a
 * removal wrote its tombstone at `orderid_x:o1`, leaving the row in place.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema, SchemaGetter } from "effect"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Table from "../../src/Table.js"

export type Row = Record<string, AttributeValue>

export const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/key-codec-projection-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly writtenBy: string
  readonly seed: { readonly events: ReadonlyArray<Row>; readonly read: ReadonlyArray<Row> }
  readonly steps: ReadonlyArray<{
    readonly label: string
    readonly A: unknown
    readonly B: unknown
    readonly outbox: ReadonlyArray<{
      readonly pk: string
      readonly sk: string
      readonly rowPk: string
      readonly rowSk: string
    }>
    readonly rows: ReadonlyArray<{ readonly pk: string; readonly sk: string; readonly e: string }>
  }>
  readonly gets: { readonly A: unknown; readonly B: unknown }
}

const Prefixed = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((s: string) => s.slice(2)),
    encode: SchemaGetter.transform((s: string) => `x:${s}`),
  }),
)

export class Placed extends Schema.TaggedClass<Placed>()("Placed", { amount: Schema.Number }) {}
export class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}
export class Cancelled extends Schema.TaggedClass<Cancelled>()("Cancelled", {}) {}
type OrderEvent = Placed | Added | Cancelled

/** 1.39.0's default (`escapeKeys` off): the rows these tests seed were written under it. */
const schema = DynamoSchema.make({ name: "kp", version: 1, escapeKeys: false })
export const EventsTable = Table.make({ schema, entities: {} })
export const Orders = EventStore.makeStream({
  table: EventsTable,
  streamName: "Order",
  events: [Placed, Added, Cancelled],
  streamId: { composite: ["orderId"] },
})

const Summary = Schema.Struct({ orderId: Prefixed, total: Schema.Number, version: Schema.Number })
type Summary = typeof Summary.Type
const EffectedSummary = Schema.Struct({ ...Summary.fields, rev: Schema.Number })
type EffectedSummary = typeof EffectedSummary.Type

const primaryKey = {
  pk: { field: "pk", composite: ["orderId"] },
  sk: { field: "sk", composite: [] },
} as const
export const Removable = Entity.make({ model: Summary, entityType: "Removable", primaryKey })
export const Effected = Entity.make({
  model: EffectedSummary,
  entityType: "Effected",
  primaryKey,
})
export const ReadTable = Table.make({ schema, entities: { Removable, Effected } })

const total = <S extends Summary>(state: S, event: EventStore.StreamEvent<OrderEvent>): S =>
  event.data._tag === "Cancelled" ? state : { ...state, total: state.total + event.data.amount }

export const A = EventStore.projection({
  stream: Orders,
  readModel: Removable,
  key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
  initial: (id: { readonly orderId: string }): Summary => ({
    orderId: id.orderId,
    total: 0,
    version: 0,
  }),
  evolve: (state: Summary, event: EventStore.StreamEvent<OrderEvent>) =>
    Effect.succeed(event.data._tag === "Cancelled" ? EventStore.removeRow : total(state, event)),
  checkpoint: "version",
  removal: {},
})

export const B = EventStore.projection({
  stream: Orders,
  readModel: Effected,
  key: (id: { readonly orderId: string }) => ({ orderId: id.orderId }),
  initial: (id: { readonly orderId: string }): EffectedSummary => ({
    orderId: id.orderId,
    total: 0,
    version: 0,
    rev: 0,
  }),
  evolve: (state: EffectedSummary, event: EventStore.StreamEvent<OrderEvent>) =>
    Effect.succeed(total(state, event)),
  checkpoint: "version",
  revision: "rev",
  outbox: {
    schema: Schema.Struct({ note: Schema.String }),
    effects: (event) => [{ note: `${event.eventType} v${event.version}` }],
  },
})

/** The key `put` wrote for each read model's row (1.39.0 and now). */
export const rowKey = {
  Removable: { pk: "$kp#v1#removable#orderid_x:x:o1", sk: "$kp#v1#removable" },
  Effected: { pk: "$kp#v1#effected#orderid_x:x:o1", sk: "$kp#v1#effected" },
} as const

/** The key 1.39.0 read the row at, and wrote a tombstone at. */
export const singleKey = { pk: "$kp#v1#removable#orderid_x:o1", sk: "$kp#v1#removable" } as const

/** The partition 1.39.0 put `Effected`'s outbox items in, which they keep. */
export const outboxPk = "$kp#v1#effected#orderid_x:o1"
