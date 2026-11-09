/**
 * Projections whose read model's key composite is a codec `encode` takes on its
 * own output (`x:` prepended), and the rows published 1.39.0 wrote for them
 * (`fixtures/key-codec-projection-1.39.0.json`), under `escapeKeys` off and on.
 * `Removable` removes the row on `Cancelled`; `Effected` writes an outbox effect
 * per event, in the read model's table.
 *
 * 1.39.0 keyed each read model's row by its stored text encoded once more
 * (`orderid_x:x:o 1`), and read it, tombstoned it and keyed its outbox items at
 * the stored text (`orderid_x:o 1`). So after the first event (`seed`), every
 * later event failed (`ConcurrentModification`: the engine found no row where it
 * read, and its `create` met the row), and a removal (`final`) left the row in
 * place and wrote its tombstone where 1.40.0 keys the row.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema, SchemaGetter } from "effect"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Table from "../../src/Table.js"

export type Row = Record<string, AttributeValue>
export type Setting = "off" | "on"

/** What 1.39.0 did under one `escapeKeys` setting. */
export interface Written {
  readonly schema: { readonly name: string; readonly version: number; readonly escapeKeys: boolean }
  readonly id: { readonly orderId: string }
  /** The rows after the first event, caught up by both projections. */
  readonly seed: { readonly events: ReadonlyArray<Row>; readonly read: ReadonlyArray<Row> }
  /** Each event appended, then `A` and `B` caught up: what each returned. */
  readonly steps: ReadonlyArray<{
    readonly label: string
    readonly A: unknown
    readonly B: unknown
  }>
  /** The rows after the last step: `Removable`'s removal tombstoned the stored text's key. */
  readonly final: { readonly events: ReadonlyArray<Row>; readonly read: ReadonlyArray<Row> }
  /** Each read model's `get` of the id after the first event. */
  readonly gets: { readonly A: unknown; readonly B: unknown }
}

export const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/key-codec-projection-1.39.0.json", import.meta.url), "utf8"),
) as { readonly writtenBy: Record<string, string> } & Readonly<Record<Setting, Written>>

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

const Summary = Schema.Struct({ orderId: Prefixed, total: Schema.Number, version: Schema.Number })
type Summary = typeof Summary.Type
const EffectedSummary = Schema.Struct({ ...Summary.fields, rev: Schema.Number })
type EffectedSummary = typeof EffectedSummary.Type

const primaryKey = {
  pk: { field: "pk", composite: ["orderId"] },
  sk: { field: "sk", composite: [] },
} as const

const total = <S extends Summary>(state: S, event: EventStore.StreamEvent<OrderEvent>): S =>
  event.data._tag === "Cancelled" ? state : { ...state, total: state.total + event.data.amount }

/** The id every row is for: a space, which `escapeKeys: true` escapes. */
export const id = { orderId: "o 1" } as const

/** The stream, read models and projections 1.39.0 wrote the rows with, under `setting`. */
export const world = (setting: Setting) => {
  const schema = DynamoSchema.make({ name: "kp", version: 1, escapeKeys: setting === "on" })
  const EventsTable = Table.make({ schema, entities: {} })
  const Orders = EventStore.makeStream({
    table: EventsTable,
    streamName: "Order",
    events: [Placed, Added, Cancelled],
    streamId: { composite: ["orderId"] },
  })
  const Removable = Entity.make({ model: Summary, entityType: "Removable", primaryKey })
  const Effected = Entity.make({ model: EffectedSummary, entityType: "Effected", primaryKey })
  const ReadTable = Table.make({ schema, entities: { Removable, Effected } })

  const A = EventStore.projection({
    stream: Orders,
    readModel: Removable,
    key: (key: { readonly orderId: string }) => ({ orderId: key.orderId }),
    initial: (key: { readonly orderId: string }): Summary => ({
      orderId: key.orderId,
      total: 0,
      version: 0,
    }),
    evolve: (state: Summary, event: EventStore.StreamEvent<OrderEvent>) =>
      Effect.succeed(event.data._tag === "Cancelled" ? EventStore.removeRow : total(state, event)),
    checkpoint: "version",
    removal: {},
  })

  const B = EventStore.projection({
    stream: Orders,
    readModel: Effected,
    key: (key: { readonly orderId: string }) => ({ orderId: key.orderId }),
    initial: (key: { readonly orderId: string }): EffectedSummary => ({
      orderId: key.orderId,
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

  /** `o 1` as a key holds it under this setting. */
  const text = setting === "on" ? "o%201" : "o 1"
  const key = (entity: "removable" | "effected", value: string) => ({
    pk: `$kp#v1#${entity}#orderid_${value}`,
    sk: `$kp#v1#${entity}`,
  })
  return {
    schema,
    EventsTable,
    Orders,
    Removable,
    Effected,
    ReadTable,
    A,
    B,
    /** The key a write gives each read model's row now: the stored text's, which 1.39.0 read at. */
    rowKey: { Removable: key("removable", `x:${text}`), Effected: key("effected", `x:${text}`) },
    /** The key 1.39.0's `put` wrote each row at: its stored text encoded once more. */
    doubledKey: {
      Removable: key("removable", `x:x:${text}`),
      Effected: key("effected", `x:x:${text}`),
    },
    /** The partition `Effected`'s outbox items are in, 1.39.0's and now. */
    outboxPk: `$kp#v1#effected#orderid_x:${text}`,
  }
}
