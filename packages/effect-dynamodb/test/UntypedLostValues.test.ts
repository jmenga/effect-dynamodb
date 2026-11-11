/**
 * A value DynamoDB doesn't store, at a position no schema types (#242, `EDD-9161`): 1.40.0 wrote a
 * `Date` in a `Schema.Unknown` field as an empty map and read it back as `{}`, with no error. Every
 * write path refuses one and writes nothing, natively and packed alike, by one function
 * (`LostValues`); a row already holding `{}` reads as `{}`; and a model with no untyped position has
 * no check at all.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { lostIn } from "@effect-dynamodb/schema/internal/LostValues.js"
import { holdsUntyped } from "@effect-dynamodb/schema/internal/SchemaAccessors.js"
import { Cause, Effect, Exit, Layer, Redacted, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { readBackOf } from "../src/internal/RoundTrip.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { clientOf, membersOf, PATHS } from "./helpers/CustomDeclarationPaths.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

/** A client whose writes are recorded and whose reads find a row that holds nothing of note. */
const recording = () => {
  const writes: Array<string> = []
  const write = (name: string) => () =>
    Effect.sync(() => {
      writes.push(name)
      return {}
    }) as never
  const row = toAttributeMap({ pk: "p", sk: "s", __edd_e__: "Row", id: "a" })
  const orderRoot = toAttributeMap({ pk: "p", sk: "s", __edd_e__: "Order", id: "a" })
  const layer = mockDynamoClientLayer({
    putItem: write("putItem"),
    updateItem: write("updateItem"),
    deleteItem: write("deleteItem"),
    transactWriteItems: write("transactWriteItems"),
    batchWriteItem: write("batchWriteItem"),
    getItem: (input: { readonly Key?: unknown }) =>
      Effect.succeed(JSON.stringify(input.Key).includes("#row") ? { Item: row } : {}) as never,
    query: (input: unknown) =>
      Effect.succeed(
        JSON.stringify(input).includes("#order")
          ? { Items: [orderRoot], Count: 1, ScannedCount: 1 }
          : { Items: [], Count: 0, ScannedCount: 0 },
      ) as never,
  })
  return { writes, layer }
}

const failureOf = (exit: Exit.Exit<unknown, unknown>): any =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

describe("[EDD-9161] every write path refuses a Date in an untyped field", () => {
  for (const path of PATHS) {
    it.effect(`${path.operation}: ${path.name}`, () =>
      Effect.gen(function* () {
        const { writes, layer } = recording()
        const members = membersOf(Schema.Unknown)
        const provided = Layer.merge(layer, members.Base.layer({ name: "untyped-table" }))
        const exit = yield* Effect.gen(function* () {
          const db = yield* clientOf(members)
          return yield* path.run(db, members, new Date(0))
        }).pipe(Effect.provide(provided as never), Effect.exit)
        const error = failureOf(exit)
        expect(error).toBeInstanceOf(ValidationError)
        expect(String(error.cause)).toContain("is a Date, which DynamoDB doesn't store")
        expect(String(error.cause)).toContain("EDD-9161")
        expect(writes).toEqual([])
      }),
    )
  }

  it.effect("a value holding none still writes on every path", () =>
    Effect.gen(function* () {
      for (const path of PATHS) {
        const { layer } = recording()
        const members = membersOf(Schema.Unknown)
        const provided = Layer.merge(layer, members.Base.layer({ name: "untyped-table" }))
        const exit = yield* Effect.gen(function* () {
          const db = yield* clientOf(members)
          return yield* path.run(db, members, { at: "1970-01-01T00:00:00.000Z" })
        }).pipe(Effect.provide(provided as never), Effect.exit)
        expect([path.name, String(failureOf(exit)?.cause ?? "")]).not.toEqual([
          path.name,
          expect.stringContaining("EDD-9161"),
        ])
      }
    }),
  )
})

const Json = DynamoModel.Packed({ format: "json" })
const schema = DynamoSchema.make({ name: "lost", version: 1 })
const Values = Entity.make({
  model: DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      loose: Schema.optional(Schema.Unknown),
      packed: Schema.optional(Schema.Unknown),
    }),
    { packed: { storedAs: Json } },
  ),
  entityType: "V",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const Main = Table.make({ schema, entities: { Values } })

/**
 * Each value 1.40.0 lost at an untyped position, natively (what it stored, with no error) and packed
 * (refused, as JSON can't hold it): now refused in both with the same words, but for a map and
 * binary data, which packing refuses as not JSON first.
 */
const TABLE: ReadonlyArray<readonly [string, () => unknown, string, string]> = [
  ["a Date", () => new Date(0), "a Date", "a Date"],
  ["a Date in a list", () => [{ at: new Date(0) }], "a Date", "a Date"],
  ["a RegExp", () => /a/, "a RegExp", "a RegExp"],
  ["a WeakMap", () => new WeakMap(), "a WeakMap", "a WeakMap"],
  ["an Error", () => new Error("x"), "an Error with a message", "an Error with a message"],
  ["a Redacted", () => Redacted.make("s"), "a Redacted", "a Redacted"],
  ["a Map with a number key", () => new Map([[1, "a"]]), "a Map with a number key", "JSON"],
  ["an ArrayBuffer", () => new Uint8Array([1]).buffer, "binary data (ArrayBuffer)", "JSON"],
  ["a Float64Array", () => new Float64Array([1]), "binary data (Float64Array)", "JSON"],
]

describe("natively and packed, one decision", () => {
  for (const [name, make, loose, packed] of TABLE) {
    it.effect(name, () => {
      const table = makeRecordingTable()
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Values }, tables: { Main } })
        const said = (field: "loose" | "packed") =>
          db.entities.Values.put({ id: field, [field]: make() })
            .asEffect()
            .pipe(
              Effect.exit,
              Effect.map((exit) => String(failureOf(exit)?.cause ?? "written")),
            )
        const native = yield* said("loose")
        const json = yield* said("packed")
        expect(native).toContain(`is ${loose}, which DynamoDB doesn't store`)
        expect(native).toContain("[EDD-9161]")
        expect(json).toContain(
          packed === "JSON"
            ? "which JSON cannot represent"
            : `is ${packed}, which DynamoDB doesn't`,
        )
        expect(table.items.size).toBe(0)
      }).pipe(Effect.provide(Main.layer({ name: "lost" })), Effect.provide(table.layer))
    })
  }

  it.effect("a row already holding {} reads as {}", () => {
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Values }, tables: { Main } })
      yield* db.entities.Values.put({ id: "a" }).asEffect()
      const key = [...table.items.keys()][0]!
      table.items.set(key, { ...table.items.get(key)!, loose: { M: {} } })
      const row = yield* db.entities.Values.get({ id: "a" })
      expect(row.loose).toEqual({})
    }).pipe(Effect.provide(Main.layer({ name: "lost" })), Effect.provide(table.layer))
  })
})

describe("what a model with no untyped position pays", () => {
  it("no check at all, and a typed date is the schema's to store", () => {
    const typed = Schema.Struct({ at: Schema.DateTimeUtc, d: Schema.Date, n: Schema.Number })
    expect(holdsUntyped(typed.ast)).toBe(false)
    expect(readBackOf(typed, () => typed)).toBeUndefined()
    expect(holdsUntyped(Schema.Struct({ x: Schema.Option(Schema.Unknown) }).ast)).toBe(true)
    expect(holdsUntyped(Schema.Record(Schema.String, Schema.Any).ast)).toBe(true)
  })

  it("a value holding no lost part is looked through and passed", () => {
    expect(lostIn({ a: [1, "x", null, { b: new Uint8Array([1]) }], s: new Set(["a"]) })).toBe(
      undefined,
    )
  })
})
