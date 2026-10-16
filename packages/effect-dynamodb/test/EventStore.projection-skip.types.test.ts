/**
 * Type-level tests for `EventStore.skipEvent` (#162).
 *
 * - `evolve` may return `SkipEvent` in `projection` and in each
 *   `multiProjection` source, without declaring `removal`, alongside the state
 *   and `RemoveRow`.
 * - `skipped` is typed as the stream's event on `ProjectionApplied`,
 *   `ProjectionCaughtUp` and `ProjectionRebuiltRow`, and per source on a
 *   multi-source instance result (narrowed by `source`).
 *
 * Uses vitest's `expectTypeOf`; the assertions are compile-time only and are
 * checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"

const AppSchema = DynamoSchema.make({ name: "skiptypes", version: 1 })
const EventsTable = Table.make({ schema: AppSchema, entities: {} })

class Moved extends Schema.TaggedClass<Moved>()("Moved", { to: Schema.String }) {}
class Charged extends Schema.TaggedClass<Charged>()("Charged", {
  itemId: Schema.String,
  amount: Schema.Number,
}) {}

const Moves = EventStore.makeStream({
  table: EventsTable,
  streamName: "Move",
  events: [Moved],
  streamId: { composite: ["itemId"] },
})
const Charges = EventStore.makeStream({
  table: EventsTable,
  streamName: "Charge",
  events: [Charged],
  streamId: { composite: ["accountId"] },
})

const Item = Schema.Struct({
  itemId: Schema.String,
  at: Schema.String,
  total: Schema.Number,
  version: Schema.Number,
  checkpoints: Schema.Record(Schema.String, Schema.Number),
  revision: Schema.Number,
})
type Item = typeof Item.Type

const Items = Entity.make({
  model: Item,
  entityType: "Item",
  primaryKey: {
    pk: { field: "pk", composite: ["itemId"] },
    sk: { field: "sk", composite: [] },
  },
})

const empty = (itemId: string): Item => ({
  itemId,
  at: "",
  total: 0,
  version: 0,
  checkpoints: {},
  revision: 0,
})

describe("skipEvent", () => {
  it("is a value `evolve` may return without `removal`", () => {
    expectTypeOf(EventStore.skipEvent).toEqualTypeOf<EventStore.SkipEvent>()

    const projection = EventStore.projection({
      stream: Moves,
      readModel: Items,
      key: (id) => ({ itemId: id.itemId }),
      initial: (id) => empty(id.itemId),
      evolve: (state, event) =>
        Effect.succeed(
          event.data.to === state.at ? EventStore.skipEvent : { ...state, at: event.data.to },
        ),
      checkpoint: "version",
    })

    type Applied = Effect.Success<ReturnType<typeof projection.apply>>
    expectTypeOf<Applied["skipped"]>().toEqualTypeOf<Applied["applied"]>()
    expectTypeOf<Applied["skipped"][number]["data"]>().toEqualTypeOf<Moved>()
    type CaughtUp = Effect.Success<ReturnType<typeof projection.catchUp>>
    expectTypeOf<CaughtUp["skipped"][number]["data"]>().toEqualTypeOf<Moved>()
    type Rebuilt = Effect.Success<ReturnType<typeof projection.rebuild>>
    expectTypeOf<Rebuilt["rows"][number]["skipped"][number]["data"]>().toEqualTypeOf<Moved>()
    expect(projection.entityType).toBe("Item")
  })

  it("may be returned next to the state and `removeRow`", () => {
    const projection = EventStore.projection({
      stream: Moves,
      readModel: Items,
      key: (id) => ({ itemId: id.itemId }),
      initial: (id) => empty(id.itemId),
      evolve: (state, event) =>
        Effect.succeed(
          event.data.to === ""
            ? EventStore.removeRow
            : event.data.to === state.at
              ? EventStore.skipEvent
              : { ...state, at: event.data.to },
        ),
      checkpoint: "version",
      removal: {},
    })
    expect(projection.entityType).toBe("Item")
  })

  it("is accepted from every multi-source source, and `skipped` is typed per source", () => {
    const projection = EventStore.multiProjection({
      readModel: Items,
      initial: (key) => empty(key.itemId),
      sources: (source) => ({
        move: source(Moves, {
          key: (id) => ({ itemId: id.itemId }),
          evolve: (state, event) =>
            Effect.succeed(
              event.data.to === state.at ? EventStore.skipEvent : { ...state, at: event.data.to },
            ),
          mode: "latest",
        }),
        charge: source(Charges, {
          key: (_id, event) => ({ itemId: event.data.itemId }),
          evolve: (state, event) =>
            Effect.succeed(
              event.data.amount === 0
                ? EventStore.skipEvent
                : { ...state, total: state.total + event.data.amount },
            ),
        }),
      }),
      checkpoints: { field: "checkpoints" },
      revision: "revision",
    })

    type Applied = Effect.Success<ReturnType<typeof projection.catchUp>>
    type Instance = Applied["instances"][number]
    expectTypeOf<
      Extract<Instance, { source: "move" }>["skipped"][number]["data"]
    >().toEqualTypeOf<Moved>()
    expectTypeOf<
      Extract<Instance, { source: "charge" }>["skipped"][number]["data"]
    >().toEqualTypeOf<Charged>()
    expect(projection.entityType).toBe("Item")
  })

  it("is not a state", () => {
    EventStore.projection({
      stream: Moves,
      readModel: Items,
      key: (id) => ({ itemId: id.itemId }),
      initial: (id) => empty(id.itemId),
      // @ts-expect-error — a sentinel other than skipEvent / removeRow is not a state
      evolve: () => Effect.succeed({ skip: true }),
      checkpoint: "version",
    })
  })
})
