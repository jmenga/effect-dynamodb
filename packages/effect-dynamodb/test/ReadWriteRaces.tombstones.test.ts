/**
 * Updates of a read-model row a projection removed (#132, #154). The removal leaves a projection
 * tombstone at the row's key (`<entity>#tombstone`), which every read by key reports as absent. An
 * update of it is an update of a missing row by every path: standalone, in `transactWrite`, with
 * or without a payload, a condition or a return mode, and when the removal lands between a
 * transaction's plan and its commit. Nothing is written on the tombstone, and nothing beside it
 * commits.
 */

import type { UpdateItemCommandInput } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { hooks, InMemoryClient, resetStore, store } from "./helpers/InMemoryTables.js"

const schema = DynamoSchema.make({ name: "tombstones", version: 1 })

class Changed extends Schema.TaggedClass<Changed>()("Changed", {}) {}
class Removed extends Schema.TaggedClass<Removed>()("Removed", {}) {}
const Events = Table.make({ schema, entities: {} })
const Stream = EventStore.makeStream({
  table: Events,
  streamName: "Orders",
  events: [Changed, Removed],
  streamId: { composite: ["id"] },
})

const Model = Schema.Struct({ id: Schema.String, status: Schema.String, checkpoint: Schema.Number })
/** A read model whose rows a projection removes, leaving tombstones. */
const Orders = Entity.make({
  model: Model,
  entityType: "OrderView",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
/** No projection writes it: its requests are what they were. */
const Notes = Entity.make({
  model: Model,
  entityType: "Note",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const Main = Table.make({ schema, entities: { Orders, Notes } })
const Projection = EventStore.projection({
  stream: Stream,
  readModel: Orders,
  key: (key: { readonly id: string }) => key,
  initial: (key: { readonly id: string }) => ({ ...key, status: "open", checkpoint: 0 }),
  evolve: (state: typeof Model.Type, event: EventStore.StreamEvent<Changed | Removed>) =>
    Effect.succeed(event.data._tag === "Removed" ? EventStore.removeRow : state),
  checkpoint: "checkpoint",
  removal: {},
})

/** Every `UpdateItem` sent, in order. */
const updates: Array<UpdateItemCommandInput> = []
const Recording = Layer.effect(
  DynamoClient,
  Effect.gen(function* () {
    const real = yield* DynamoClient
    return {
      ...real,
      updateItem: (input: UpdateItemCommandInput) => {
        updates.push(structuredClone(input))
        return real.updateItem(input)
      },
    }
  }),
).pipe(Layer.provide(InMemoryClient))
const tables = Layer.merge(Main.layer({ name: "rows" }), Events.layer({ name: "events" }))
const layer = Layer.merge(Recording, tables)
const database = DynamoClient.make({ entities: { Orders, Notes }, tables: { Main } })

/** Row `a` written by the projection; returns the event that removes it. */
const seed = Effect.gen(function* () {
  yield* Stream.append({ id: "a" }, [new Changed({}), new Removed({})], 0)
  const events = yield* Stream.read({ id: "a" })
  yield* Projection.apply(events[0]!)
  return events[1]!
})
/** Row `a` written by the projection and removed: a tombstone at its key. */
const removed = Effect.flatMap(seed, (removal) => Projection.apply(removal))

const tombstone = () =>
  [...store.values()].find((row) => row.__edd_e__?.S === "OrderView#tombstone")
const orderIds = () =>
  [...store.values()]
    .filter((row) => row.__edd_e__?.S === "OrderView")
    .map((row) => row.id?.S)
    .sort()

type Runnable =
  | Effect.Effect<any, any, any>
  | { readonly asEffect: () => Effect.Effect<any, any, any> }
const outcome = (op: Runnable) =>
  ("asEffect" in op ? Effect.suspend(() => op.asEffect()) : op).pipe(
    Effect.map(() => "ok"),
    Effect.catch((error: { readonly _tag: string }) => Effect.succeed(error._tag)),
  )
const sibling = { id: "sibling", status: "must not commit", checkpoint: 0 }

beforeEach(() => {
  resetStore()
  updates.length = 0
})

describe("an update of a row a projection removed", () => {
  it.effect(
    "that sets nothing is ItemNotFound in every return mode, patch ConditionalCheckFailed",
    () =>
      Effect.gen(function* () {
        yield* removed
        const db = yield* database
        for (const mode of ["allNew", "allOld", "none", "updatedNew", "updatedOld"] as const) {
          expect(
            yield* outcome(db.entities.Orders.update({ id: "a" }).set({}).returnValues(mode)),
          ).toBe("ItemNotFound")
        }
        expect(yield* outcome(db.entities.Orders.patch({ id: "a" }).set({}))).toBe(
          "ConditionalCheckFailed",
        )
      }).pipe(Effect.provide(layer)),
  )

  it.effect("that sets nothing with a condition, returning nothing, is ItemNotFound", () =>
    Effect.gen(function* () {
      yield* removed
      const db = yield* database
      const result = yield* outcome(
        db.entities.Orders.update({ id: "a" })
          .set({})
          .condition((row, { gte }) => gte(row.checkpoint, 0))
          .returnValues("none"),
      )
      expect(result).toBe("ItemNotFound")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("with a payload, standalone, is ItemNotFound and leaves the tombstone as it was", () =>
    Effect.gen(function* () {
      yield* removed
      const before = structuredClone(tombstone())
      const db = yield* database
      expect(yield* outcome(db.entities.Orders.update({ id: "a" }).set({ status: "x" }))).toBe(
        "ItemNotFound",
      )
      expect(
        yield* outcome(
          db.entities.Orders.update({ id: "a" }).set({ status: "x" }).returnValues("none"),
        ),
      ).toBe("ItemNotFound")
      expect(yield* outcome(db.entities.Orders.patch({ id: "a" }).set({ status: "x" }))).toBe(
        "ConditionalCheckFailed",
      )
      expect(tombstone()).toEqual(before)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("whose payload is a whole row creates it over the tombstone, as create does", () =>
    Effect.gen(function* () {
      yield* removed
      const db = yield* database
      expect(
        // The key composite restated: a complete payload, untyped as such updates are.
        yield* outcome(
          (db.entities.Orders as any)
            .update({ id: "a" })
            .set({ id: "a", status: "again", checkpoint: 0 }),
        ),
      ).toBe("ok")
      expect(tombstone()).toBeUndefined()
      expect(orderIds()).toEqual(["a"])
    }).pipe(Effect.provide(layer)),
  )

  type Db = Effect.Success<typeof database>
  for (const [label, op] of [
    ["sets nothing", (db: Db) => db.entities.Orders.update({ id: "a" }).set({})],
    [
      "sets nothing, with a condition",
      (db: Db) =>
        db.entities.Orders.update({ id: "a" })
          .set({})
          .condition((row, { gte }) => gte(row.checkpoint, 0)),
    ],
    ["sets a value", (db: Db) => db.entities.Orders.update({ id: "a" }).set({ status: "x" })],
  ] as const) {
    it.effect(`in transactWrite, that ${label}, is ItemNotFound and commits nothing`, () =>
      Effect.gen(function* () {
        yield* removed
        const before = structuredClone(tombstone())
        const db = yield* database
        const result = yield* outcome(
          Transaction.transactWrite([op(db), db.entities.Orders.put(sibling)]),
        )
        expect(result).toBe("ItemNotFound")
        expect(orderIds()).toEqual([])
        expect(tombstone()).toEqual(before)
      }).pipe(Effect.provide(layer)),
    )

    it.effect(
      `in transactWrite, that ${label}, removed after the plan read it, commits nothing`,
      () =>
        Effect.gen(function* () {
          const removal = yield* seed
          let fired = false
          hooks.afterGetEffect.push(() =>
            Projection.apply(removal).pipe(
              Effect.provide(layer),
              Effect.tap(() =>
                Effect.sync(() => {
                  fired = true
                }),
              ),
              Effect.asVoid,
              Effect.orDie,
            ),
          )
          const db = yield* database
          const result = yield* outcome(
            Transaction.transactWrite([op(db), db.entities.Orders.put(sibling)]),
          )
          expect(fired).toBe(true)
          expect(result).toBe("ItemNotFound")
          expect(orderIds()).toEqual([])
          expect(tombstone()).toBeDefined()
        }).pipe(Effect.provide(layer)),
    )
  }
})

describe("the existence term", () => {
  it.effect("on a read model with removal, also requires the row not be a tombstone", () =>
    Effect.gen(function* () {
      yield* seed
      const db = yield* database
      yield* db.entities.Orders.update({ id: "a" }).set({ status: "x" })
      const [update] = updates
      expect(update!.ConditionExpression).toBe("attribute_exists(#exists) AND #eddLive <> :eddTomb")
      expect(update!.ExpressionAttributeNames?.["#eddLive"]).toBe("__edd_e__")
      expect(update!.ExpressionAttributeValues?.[":eddTomb"]).toEqual({ S: "OrderView#tombstone" })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("on any other entity, is what it was", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Notes.put({ id: "n", status: "s", checkpoint: 0 })
      yield* db.entities.Notes.update({ id: "n" }).set({ status: "x" })
      const [update] = updates
      expect(update!.ConditionExpression).toBe("attribute_exists(#exists)")
      expect(update!.ExpressionAttributeNames?.["#eddLive"]).toBeUndefined()
    }).pipe(Effect.provide(layer)),
  )
})
