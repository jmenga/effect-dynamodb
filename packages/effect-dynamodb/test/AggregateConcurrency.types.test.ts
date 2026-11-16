/**
 * Type-level tests for aggregate concurrency (#168, `docs/designs/aggregate-concurrency.md`):
 * `update`'s error channel gains the conflicts, `expectedVersion` is accepted only on a
 * `versioned` aggregate (`EDD-9178` is the runtime answer to an untyped caller), a version the
 * root declares is optional on input, and `versioned` takes no snapshot options (`EDD-9177`).
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type { ConcurrentModification, OptimisticLockError } from "@effect-dynamodb/schema/Errors.js"
import { type Effect, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import type { AggregateUpdateError, AggregateWriteError } from "../src/index.js"
import * as Table from "../src/Table.js"

const schema = DynamoSchema.make({ name: "t168", version: 1 })
const Main = Table.make({ schema, entities: {} })

const Order = Schema.Struct({ id: Schema.String, note: Schema.String })
const VersionedOrder = Schema.Struct({ id: Schema.String, note: Schema.String, rev: Schema.Number })

const base = {
  table: Main,
  schema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "orders" },
  root: { entityType: "Order" },
  edges: {},
} as const

const Plain = Aggregate.make(Order, base)
const Versioned = Aggregate.make(Order, { ...base, versioned: true })
const Declared = Aggregate.make(VersionedOrder, { ...base, versioned: { field: "rev" } })
const Fenced = Aggregate.make(Order, { ...base, fence: true })

describe("Aggregate concurrency types (#168)", () => {
  it("update's error channel holds the conflicts", () => {
    type E = Effect.Error<ReturnType<typeof Plain.update>>
    expectTypeOf<E>().toEqualTypeOf<AggregateUpdateError>()
    expectTypeOf<ConcurrentModification>().toExtend<E>()
    expectTypeOf<OptimisticLockError>().toExtend<E>()
    expectTypeOf<AggregateWriteError>().toExtend<E>()
    // `delete`'s doesn't change.
    expectTypeOf<ConcurrentModification>().not.toExtend<
      Effect.Error<ReturnType<typeof Plain.delete>>
    >()
    expect(true).toBe(true)
  })

  it("expectedVersion only on a versioned aggregate", () => {
    const fn = ({ state }: { state: typeof Order.Type }) => state
    Versioned.update({ id: "a" }, fn, { expectedVersion: 3 })
    Versioned.update({ id: "a" }, fn)
    Fenced.update({ id: "a" }, fn)
    // @ts-expect-error -- an unversioned aggregate keeps no version to compare
    Plain.update({ id: "a" }, fn, { expectedVersion: 3 })
    // @ts-expect-error -- `fence` alone keeps no version either
    Fenced.update({ id: "a" }, fn, { expectedVersion: 3 })
    expect(true).toBe(true)
  })

  it("UpdateContext.version is a number when given", () => {
    Versioned.update({ id: "a" }, (context) => {
      expectTypeOf(context.version).toEqualTypeOf<number | undefined>()
      return context.state
    })
    expect(true).toBe(true)
  })

  it("a version the root declares is optional on create: the library writes it", () => {
    Declared.create({ id: "a", note: "n" })
    Declared.create({ id: "a", note: "n", rev: 7 })
    expect(true).toBe(true)
  })

  it("versioned takes true or { field }, not an entity's snapshot options", () => {
    // Refused at load too, for an untyped caller (`EDD-9177`, `EDD-9179`).
    // @ts-expect-error -- an aggregate keeps no snapshots
    expect(() => Aggregate.make(Order, { ...base, versioned: { retain: true } })).toThrow(
      /EDD-9177/,
    )
    // @ts-expect-error -- fence is a boolean
    expect(() => Aggregate.make(Order, { ...base, fence: "yes" })).toThrow(/EDD-9179/)
  })
})
