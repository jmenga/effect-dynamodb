/**
 * A write of a custom declaration's value reads back what it marshalled (`EDD-9126`,
 * `internal/RoundTrip.ts`): the declaration's parser runs once more than the write's own encode
 * runs it. CPU only, with no request of its own.
 */
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const schema = DynamoSchema.make({ name: "app", version: 1 })

/** A duck-typed declaration, which reads back, counting each run of its parser. */
const counted = () => {
  const calls = { count: 0 }
  const Point = Schema.declare((u: unknown): u is { readonly x: number } => {
    calls.count++
    return typeof u === "object" && u !== null && "x" in u
  })
  return { calls, Point }
}

const on = <A>(layer: any, body: (table: ReturnType<typeof makeRecordingTable>) => any) => {
  const table = makeRecordingTable()
  return (body(table) as Effect.Effect<A, unknown, any>).pipe(
    Effect.provide(layer),
    Effect.provide(table.layer),
  ) as Effect.Effect<A>
}

describe("a custom declaration's parser, on a write of its value", () => {
  it.effect("a stream append: once to encode the event, once reading it back", () => {
    const { calls, Point } = counted()
    const Base = Table.make({ schema, entities: {} } as never) as any
    const Moves = EventStore.makeStream({
      table: Base,
      streamName: "Moves",
      events: [Schema.Struct({ _tag: Schema.tag("Moved"), to: Point })],
      streamId: { composite: ["id"] },
    } as never) as any
    return on(Base.layer({ name: "t" }), (table) =>
      Effect.gen(function* () {
        calls.count = 0
        yield* Moves.append({ id: "a" }, [{ _tag: "Moved", to: { x: 1 } }], 0)
        expect(calls.count).toBe(2)
        expect(table.take().map(({ command }) => command)).toEqual(["PutItem"])
      }),
    )
  })

  it.effect(
    "an entity put: to encode the row, reading it back, and decoding what it returns",
    () => {
      const { calls, Point } = counted()
      const Rows = Entity.make({
        model: Schema.Struct({ id: Schema.String, at: Point }),
        entityType: "Row",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      } as never) as any
      const Main = Table.make({ schema, entities: { Rows } } as never) as any
      return on(Main.layer({ name: "t" }), (table) =>
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: { Rows },
            tables: { Main },
          } as never)
          calls.count = 0
          yield* db.entities.Rows.put({ id: "a", at: { x: 1 } }).asEffect()
          expect(calls.count).toBe(3)
          expect(table.take().map(({ command }) => command)).toEqual(["PutItem"])
        }),
      )
    },
  )

  it.effect("an aggregate create: once to encode the row, once reading it back", () => {
    const { calls, Point } = counted()
    const Base = Table.make({ schema, entities: {} } as never) as any
    const Root = Aggregate.make(Schema.Struct({ id: Schema.String, at: Point }), {
      table: Base,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "root" },
      root: { entityType: "Root" },
      edges: {},
    } as never) as any
    return on(Base.layer({ name: "t" }), (table) =>
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Root },
          tables: { Main: { ...Base, aggregates: { Root } } },
        } as never)
        calls.count = 0
        yield* db.aggregates.Root.create({ id: "a", at: { x: 1 } })
        expect(calls.count).toBe(2)
        expect(table.take().map(({ command }) => command)).toEqual(["TransactWriteItems"])
      }),
    )
  })
})
