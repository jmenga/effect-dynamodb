/**
 * What Effect's parser reads of a caller's payload (#239). The library hands the parser the very
 * object the caller gave, so what it reads is the parser's to decide (Effect 4.1.3):
 *
 * - A field whose name is also an `Object.prototype` member (`toString`, `constructor`, …) is read
 *   only as the payload's own property. Given through a prototype, a class getter or a proxy without
 *   own-key traps, it is not seen: an optional field is left out, a required one fails `Missing key`.
 * - Any other field is read however the payload gives it.
 * - A declared own getter that throws while the parser reads it is a defect, as it was on 1.40.0.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { fromAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

const Docs = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    label: Schema.optional(Schema.String),
    toString: Schema.optional(Schema.String),
    constructor: Schema.optional(Schema.String),
  }),
  entityType: "Doc",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const Strict = Entity.make({
  model: Schema.Struct({ id: Schema.String, valueOf: Schema.String }),
  entityType: "Strict",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const Main = Table.make({
  schema: DynamoSchema.make({ name: "parser", version: 1 }),
  entities: { Docs, Strict },
})

/** A client recording the items it is asked to put. */
const recording = () => {
  const items: Array<Record<string, unknown>> = []
  const layer = mockDynamoClientLayer({
    putItem: (input: any) =>
      Effect.sync(() => {
        items.push(fromAttributeMap(input.Item))
        return {}
      }) as never,
  })
  return { items, layer: Layer.merge(layer, Main.layer({ name: "parser-table" })) }
}

const put = (layer: Layer.Layer<any>, entity: "Docs" | "Strict", payload: object) =>
  Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({ entities: { Docs, Strict }, tables: { Main } })
    return yield* db.entities[entity].put(payload).asEffect()
  }).pipe(Effect.provide(layer)) as Effect.Effect<unknown, unknown>

/** `fields` given every way but as the object's own properties. */
const inherited = (fields: Record<string, string>): Record<string, object> => {
  class Getters {}
  for (const [name, value] of Object.entries(fields)) {
    Object.defineProperty(Getters.prototype, name, { get: () => value, configurable: true })
  }
  return {
    "Object.create": Object.create(fields),
    "a class getter": new Getters(),
    "a proxy without own-key traps": new Proxy(
      {},
      { get: (_t, name) => Reflect.get(fields, name), has: (_t, name) => name in fields },
    ),
  }
}

describe("what Effect's parser reads of a payload (#239)", () => {
  it.effect("a name Object.prototype holds too is read only as the payload's own", () =>
    Effect.gen(function* () {
      const { items, layer } = recording()
      const fields = { id: "a", label: "l", toString: "t", constructor: "c" }
      yield* put(layer, "Docs", { ...fields })
      for (const payload of Object.values(inherited(fields))) yield* put(layer, "Docs", payload)
      // Given as its own: stored. Given any other way: an optional field is left out, and every
      // other field is read however it is given.
      const held = (item: Record<string, unknown>) => ({
        id: item.id,
        label: item.label,
        toString: Object.hasOwn(item, "toString") ? item.toString : "left out",
        constructor: Object.hasOwn(item, "constructor") ? item.constructor : "left out",
      })
      expect(items.map(held)).toEqual([
        { id: "a", label: "l", toString: "t", constructor: "c" },
        { id: "a", label: "l", toString: "left out", constructor: "left out" },
        { id: "a", label: "l", toString: "left out", constructor: "left out" },
        { id: "a", label: "l", toString: "left out", constructor: "left out" },
      ])
    }),
  )

  it.effect("a required one given any other way fails Missing key, writing nothing", () =>
    Effect.gen(function* () {
      for (const [shape, payload] of Object.entries(inherited({ id: "a", valueOf: "v" }))) {
        const { items, layer } = recording()
        const error = yield* put(layer, "Strict", payload).pipe(Effect.flip)
        expect({ shape, error }).toEqual({ shape, error: expect.any(ValidationError) })
        expect(String((error as ValidationError).cause)).toContain("Missing key")
        expect(String((error as ValidationError).cause)).toContain("valueOf")
        expect(items).toEqual([])
      }
    }),
  )

  it.effect("a declared own getter that throws while the parser reads it is a defect", () =>
    Effect.gen(function* () {
      const { items, layer } = recording()
      const payload = {
        id: "a",
        get label(): string {
          throw new Error("declared getter threw")
        },
      }
      const exit = yield* Effect.exit(put(layer, "Docs", payload))
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(String(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause))).toContain(
        "declared getter threw",
      )
      expect(items).toEqual([])
    }),
  )
})
