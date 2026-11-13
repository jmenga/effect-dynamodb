/**
 * A map entry keyed `__proto__` (#239, `EDD-9165`). The AWS SDK's marshaller assigns each entry to
 * a plain object, and assigning `__proto__` sets the object's prototype instead, so the entry was
 * never sent; stored by a path, its unmarshaller dropped it on every read, or, holding a map, made
 * that map the read object's prototype. A write holding one is refused with a `ValidationError`
 * naming the field and the key, and writes nothing; a read leaves one stored before out, whatever it
 * holds; `pathRemove` still removes it. Every other name, and the `__proto__` every object
 * inherits, is stored as before. `connected.inherited-names.test.ts` runs the same against
 * DynamoDB Local.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Expression from "../src/Expression.js"
import {
  fromAttributeMap,
  fromAttributeValue,
  toAttributeMap,
  UnstorableValue,
} from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

const AppSchema = DynamoSchema.make({ name: "proto", version: 1 })

/** An object holding each entry as its own property, `__proto__` included. */
const own = (entries: ReadonlyArray<readonly [string, unknown]>): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const [key, value] of entries) {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return out
}

const Docs = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    data: Schema.Record(Schema.String, Schema.Number),
  }),
  entityType: "Doc",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})
const Main = Table.make({ schema: AppSchema, entities: { Docs } })

class Noted extends Schema.TaggedClass<Noted>()("Noted", {
  tags: Schema.Record(Schema.String, Schema.Number),
}) {}
const Notes = EventStore.makeStream({
  table: Main,
  streamName: "Notes",
  events: [Noted],
  streamId: { composite: ["id"] },
} as never) as any

/** The document as stored, holding `{ ok: 2 }`. */
const stored = toAttributeMap({
  pk: "$proto#v1#doc#id_a",
  sk: "$proto#v1#doc",
  __edd_e__: "Doc",
  id: "a",
  data: { ok: 2 },
})

/** A client recording its writes; an update returns the document as stored. */
const recording = () => {
  const writes: Array<{ readonly command: string; readonly input: unknown }> = []
  const write = (command: string) => (input: unknown) =>
    Effect.sync(() => {
      writes.push({ command, input })
      return command === "updateItem" ? { Attributes: stored } : {}
    }) as never
  const layer = mockDynamoClientLayer({
    putItem: write("putItem"),
    updateItem: write("updateItem"),
    transactWriteItems: write("transactWriteItems"),
    batchWriteItem: write("batchWriteItem"),
  })
  return { writes, layer: Layer.merge(layer, Main.layer({ name: "proto-table" })) }
}

const refusal = (error: unknown, at: string) => {
  expect(error).toBeInstanceOf(ValidationError)
  const cause = String((error as ValidationError).cause)
  expect(cause).toContain(`"${at}": an attribute or a map entry named "__proto__" is lost`)
  expect(cause).toContain("[EDD-9165]")
}

/** Runs what `use` makes of a client of `Docs`, on `layer`. */
const withClient = (
  layer: Layer.Layer<any>,
  use: (db: any) => any,
): Effect.Effect<unknown, unknown> =>
  Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({ entities: { Docs }, tables: { Main } })
    const op = use(db)
    return yield* typeof op?.asEffect === "function" ? op.asEffect() : op
  }).pipe(Effect.provide(layer)) as Effect.Effect<unknown, unknown>

describe("[EDD-9165] a map entry keyed __proto__", () => {
  const writes_ = [
    ["put", (db: any) => db.entities.Docs.put({ id: "a", data: own([["__proto__", 1]]) })],
    ["create", (db: any) => db.entities.Docs.create({ id: "a", data: own([["__proto__", 1]]) })],
    ["upsert", (db: any) => db.entities.Docs.upsert({ id: "a", data: own([["__proto__", 1]]) })],
    [
      "set",
      (db: any) => db.entities.Docs.update({ id: "a" }).set({ data: own([["__proto__", 1]]) }),
    ],
  ] as const

  for (const [what, write] of writes_) {
    it.effect(`${what}: refused, nothing written`, () =>
      Effect.gen(function* () {
        const { writes, layer } = recording()
        const error = yield* withClient(layer, write).pipe(Effect.flip)
        refusal(error, "data.__proto__")
        expect(writes).toEqual([])
      }),
    )
  }

  const paths = [
    [
      "pathSet",
      (u: any) => u.pathSet({ segments: ["data", "__proto__"], value: 1, isPath: false }),
    ],
    ["pathAdd", (u: any) => u.pathAdd({ segments: ["data", "__proto__"], value: 1 })],
    [
      "pathIfNotExists",
      (u: any) => u.pathIfNotExists({ segments: ["data", "__proto__"], value: 1 }),
    ],
  ] as const

  for (const [what, operate] of paths) {
    it.effect(`${what} through the key: refused, nothing written`, () =>
      Effect.gen(function* () {
        const { writes, layer } = recording()
        const error = yield* withClient(layer, (db) =>
          operate(db.entities.Docs.update({ id: "a" })),
        ).pipe(Effect.flip)
        refusal(error, "data.__proto__")
        expect(String((error as ValidationError).cause)).toMatch(new RegExp(`^${what} of `))
        expect(writes).toEqual([])
      }),
    )
  }

  it.effect("pathRemove of it still removes one stored before", () =>
    Effect.gen(function* () {
      const { writes, layer } = recording()
      yield* withClient(layer, (db) =>
        db.entities.Docs.update({ id: "a" }).pathRemove(["data", "__proto__"]),
      )
      expect(writes.map((sent) => sent.command)).toEqual(["updateItem"])
      const input = writes[0]!.input as {
        readonly UpdateExpression: string
        readonly ExpressionAttributeNames: Record<string, string>
      }
      expect(input.UpdateExpression).toMatch(/^REMOVE /)
      expect(Object.values(input.ExpressionAttributeNames)).toContain("__proto__")
    }),
  )

  it("a stored one is not read, whatever it holds", () => {
    // As another writer could store them: an attribute, and a map's entry, each holding a map.
    const item = JSON.parse(
      JSON.stringify({
        pk: { S: "$proto#v1#doc#id_a" },
        id: { S: "a" },
        data: { M: { ok: { N: "2" } } },
        list: { L: [{ M: { ok: { N: "3" } } }] },
      })
        .replace('"data":{"M":{', '"data":{"M":{"__proto__":{"M":{"hidden":{"N":"9"}}},')
        .replace(
          '"list":{"L":[{"M":{',
          '"list":{"L":[{"M":{"__proto__":{"M":{"hidden":{"N":"9"}}},',
        )
        .replace('"id":', '"__proto__":{"M":{"note":{"S":"injected"}}},"id":'),
    )
    expect(Object.hasOwn(item, "__proto__")).toBe(true)
    const read = fromAttributeMap(item) as any
    expect(read).toEqual({ pk: "$proto#v1#doc#id_a", id: "a", data: { ok: 2 }, list: [{ ok: 3 }] })
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype)
    expect(read.note).toBeUndefined()
    expect(Object.getPrototypeOf(read.data)).toBe(Object.prototype)
    expect(read.data.hidden).toBeUndefined()
    expect(read.list[0].hidden).toBeUndefined()
    expect(fromAttributeValue(item.data)).toEqual({ ok: 2 })
    // Without one, the same reference is unmarshalled: nothing is copied.
    expect(fromAttributeMap(stored)).toEqual({
      pk: "$proto#v1#doc#id_a",
      sk: "$proto#v1#doc",
      __edd_e__: "Doc",
      id: "a",
      data: { ok: 2 },
    })
  })

  it.effect("every other inherited name is an entry like any other", () =>
    Effect.gen(function* () {
      const names = Object.getOwnPropertyNames(Object.prototype).filter((n) => n !== "__proto__")
      const { writes, layer } = recording()
      yield* withClient(layer, (db) =>
        db.entities.Docs.put({ id: "a", data: own(names.map((name, at) => [name, at] as const)) }),
      )
      const item = (writes[0]!.input as { readonly Item: any }).Item
      expect(Object.keys(item.data.M)).toEqual(names)
    }),
  )

  it.effect("an event stream's append: refused, nothing written", () =>
    Effect.gen(function* () {
      const { writes, layer } = recording()
      const error = yield* (
        Notes.append(
          { id: "a" },
          [new Noted({ tags: own([["__proto__", 1]]) })],
          0,
        ) as Effect.Effect<unknown, unknown>
      ).pipe(Effect.flip, Effect.provide(layer))
      refusal(error, "data.tags.__proto__")
      expect(writes).toEqual([])
    }),
  )

  it.effect("an event stream's append of any other inherited name writes", () =>
    Effect.gen(function* () {
      const { writes, layer } = recording()
      yield* (
        Notes.append(
          { id: "a" },
          [new Noted({ tags: own([["constructor", 1]]) })],
          0,
        ) as Effect.Effect<unknown, unknown>
      ).pipe(Effect.provide(layer))
      expect(writes.map((sent) => sent.command)).toEqual(["putItem"])
    }),
  )
})

describe("[EDD-9165] an Expression operand holding a map entry keyed __proto__", () => {
  // Measured on DynamoDB Local, 1.40.0 on Effect 4.1.3, for each shape below and every comparator:
  // `Expression.condition` compiled it without the entry, and DynamoDB refused every send of the
  // result ("Supplied AttributeValue is empty"), raw and through `Transaction.check` alike. The
  // builders still compile it exactly so; `Transaction.check`'s transaction refuses it.
  const operands = [
    ["by JSON.parse", () => JSON.parse('{"__proto__":{"a":1}}'), { M: {} }, "data.__proto__"],
    ["by defineProperty", () => own([["__proto__", 1]]), { M: {} }, "data.__proto__"],
    [
      "nested",
      () => ({ m: JSON.parse('{"__proto__":{"a":1}}') }),
      { M: { m: { M: {} } } },
      "data.m.__proto__",
    ],
    [
      "beside another entry",
      () => JSON.parse('{"__proto__":{"a":1},"b":2}'),
      { M: { b: { N: "2" } } },
      "data.__proto__",
    ],
    [
      "in a list",
      () => [JSON.parse('{"__proto__":{"a":1}}')],
      { L: [{ M: {} }] },
      "data[0].__proto__",
    ],
  ] as const

  for (const [what, make, compiled, at] of operands) {
    it(`${what}: each builder compiles it as 1.40.0 did`, () => {
      const plain = (result: Expression.ExpressionResult) =>
        JSON.parse(JSON.stringify(result.values))
      const condition = Expression.condition({ eq: { data: make() } })
      expect(condition.expression).toBe("#data = :v0")
      expect(plain(condition)).toEqual({ ":v0": compiled })
      expect(plain(Expression.filter({ between: { data: [make(), make()] } }))).toEqual({
        ":v0": compiled,
        ":v1": compiled,
      })
      expect(plain(Expression.update({ set: { data: make() } }))).toEqual({ ":v0": compiled })
    })

    it.effect(`${what}: Transaction.check refuses it, nothing sent`, () =>
      Effect.gen(function* () {
        const { writes, layer } = recording()
        const condition = Expression.condition({ eq: { data: make() } })
        const error = yield* withClient(layer, (db) =>
          Transaction.transactWrite([
            Transaction.check(db.entities.Docs.get({ id: "a" }), condition),
          ]),
        ).pipe(Effect.flip)
        refusal(error, at)
        expect(writes).toEqual([])
      }),
    )
  }

  it.effect("the result is recognised by identity: a copy of it is sent, as 1.40.0 sent it", () =>
    Effect.gen(function* () {
      const { writes, layer } = recording()
      const condition = Expression.condition({ eq: { data: JSON.parse('{"__proto__":1}') } })
      yield* withClient(layer, (db) =>
        Transaction.transactWrite([
          Transaction.check(db.entities.Docs.get({ id: "a" }), { ...condition }),
        ]),
      )
      expect(writes.map((sent) => sent.command)).toEqual(["transactWriteItems"])
    }),
  )

  it("anything else DynamoDB can't store still throws from the builder, as it did", () => {
    expect(() => Expression.condition({ eq: { data: new Set() } })).toThrow(UnstorableValue)
  })
})
