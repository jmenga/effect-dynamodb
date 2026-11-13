/**
 * `Equal.equals`, `Hash.hash` and `BigDecimal.normalize` cache a normalized decimal on a
 * `BigDecimal`, and that decimal holds itself. An aggregate `update` compares the rows it would write
 * with the rows it read (`deepEqual` in `Aggregate.ts`), and that comparison followed the cache until
 * the stack ran out: a mutation comparing the stored decimal with a new one died with a defect and
 * wrote nothing, on published 1.39.0 and 1.40.0 alike. The comparison now leaves the cache out, as
 * the marshaller does when it writes one, so an equal decimal writes nothing and another value is
 * written as a fresh decimal of it.
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { BigDecimal, Effect, Equal, Hash, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const schema = DynamoSchema.make({ name: "dec", version: 1 })

/** What a fresh decimal of this value and scale is stored as. */
const storedDecimal = (value: string, scale: number): AttributeValue => ({
  M: {
    value: { N: value },
    scale: { N: String(scale) },
    "~effect/BigDecimal": { S: "~effect/BigDecimal" },
  },
})

const aggregateOf = (field: Schema.Top) => {
  const Base = Table.make({ schema, entities: {} } as never) as any
  const Root = Aggregate.make(
    Schema.Struct({ id: Schema.String, f: field, note: Schema.optional(Schema.String) }),
    {
      table: Base,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "root" },
      root: { entityType: "Root" },
      edges: {},
    } as never,
  ) as any
  return { Base, Root, Main: { ...Base, aggregates: { Root } } }
}

/** Creates `f`, runs `mutate` as an update, and hands back what it sent and what's stored. */
const updated = (
  field: Schema.Top,
  created: unknown,
  mutate: (state: any) => unknown,
): Effect.Effect<{
  readonly commands: ReadonlyArray<string>
  readonly stored: AttributeValue | undefined
  readonly read: unknown
}> => {
  const { Base, Root, Main } = aggregateOf(field)
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({
      entities: {},
      aggregates: { Root },
      tables: { Main },
    } as never)
    yield* db.aggregates.Root.create({ id: "a", f: created })
    table.take()
    yield* db.aggregates.Root.update({ id: "a" }, ({ state }: any) => mutate(state))
    const commands = table.take().map(({ command }) => command)
    const stored = [...table.items.values()][0]?.f
    const read = (yield* db.aggregates.Root.get({ id: "a" })).f
    return { commands, stored, read }
  }).pipe(Effect.provide(Base.layer({ name: "t" })), Effect.provide(table.layer)) as any
}

describe("an aggregate update comparing BigDecimals", () => {
  it.effect("an equal decimal compared with the stored one writes nothing", () =>
    Effect.gen(function* () {
      const { commands, stored, read } = yield* updated(
        Schema.BigDecimal,
        BigDecimal.make(150n, 2),
        (state) => {
          const next = BigDecimal.make(150n, 2)
          expect(Equal.equals(state.f, next)).toBe(true)
          return { ...state, f: next }
        },
      )
      expect(commands).toEqual(["Query"])
      expect(stored).toEqual(storedDecimal("150", 2))
      expect(Equal.equals(read, BigDecimal.make(150n, 2))).toBe(true)
    }),
  )

  it.effect("a decimal of another value compared with the stored one is written fresh", () =>
    Effect.gen(function* () {
      const { commands, stored, read } = yield* updated(
        Schema.BigDecimal,
        BigDecimal.make(150n, 2),
        (state) => {
          const next = BigDecimal.make(1600n, 3)
          expect(Equal.equals(state.f, next)).toBe(false)
          return { ...state, f: next }
        },
      )
      expect(commands).toEqual(["Query", "TransactWriteItems"])
      expect(stored).toEqual(storedDecimal("1600", 3))
      expect(Equal.equals(read, BigDecimal.make(16n, 1))).toBe(true)
    }),
  )

  it.effect("only the stored decimal holding its cache writes nothing", () =>
    Effect.gen(function* () {
      const { commands, stored } = yield* updated(
        Schema.BigDecimal,
        BigDecimal.make(150n, 2),
        (state) => {
          BigDecimal.normalize(state.f)
          return { ...state, f: BigDecimal.make(150n, 2) }
        },
      )
      expect(commands).toEqual(["Query"])
      expect(stored).toEqual(storedDecimal("150", 2))
    }),
  )

  it.effect("decimals nested in a struct and a list, hashed, write nothing when equal", () =>
    Effect.gen(function* () {
      const field = Schema.Struct({
        a: Schema.BigDecimal,
        list: Schema.Array(Schema.BigDecimal),
      })
      const { commands } = yield* updated(
        field,
        { a: BigDecimal.make(5n, 0), list: [BigDecimal.make(10n, 1)] },
        (state) => {
          const next = { a: BigDecimal.make(5n, 0), list: [BigDecimal.make(10n, 1)] }
          for (const decimal of [state.f.a, ...state.f.list, next.a, ...next.list]) {
            Hash.hash(decimal)
          }
          return { ...state, f: next }
        },
      )
      expect(commands).toEqual(["Query"])
    }),
  )

  it.effect("a nested decimal of another value, hashed, is written", () =>
    Effect.gen(function* () {
      const field = Schema.Struct({ a: Schema.BigDecimal })
      const { commands, stored } = yield* updated(field, { a: BigDecimal.make(5n, 0) }, (state) => {
        const next = { a: BigDecimal.make(7n, 0) }
        Equal.equals(state.f.a, next.a)
        return { ...state, f: next }
      })
      expect(commands).toEqual(["Query", "TransactWriteItems"])
      expect(stored).toEqual({ M: { a: storedDecimal("7", 0) } })
    }),
  )
})
