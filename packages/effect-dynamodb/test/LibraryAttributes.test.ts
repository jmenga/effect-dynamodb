/**
 * `EDD-9140`: an entity storing an attribute under one the library writes itself is refused when
 * the definition loads. That's a model field named or renamed `__edd_e__`, or a timestamp or the
 * version so named, where every row holds its entity type, and a sparse map whose entries
 * (`<prefix>#<key>`) can be named as a table key attribute is. Each position has a form that loads,
 * whose rows keep their type and keys, and no update reaches `__edd_e__`. The `ownsRows` bind check
 * (`EDD-9130`) relies on it: a model attribute is any name holding any text but these.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const schema = DynamoSchema.make({ name: "lib", version: 1 })

const Doc = Schema.Struct({ id: Schema.String, tag: Schema.optional(Schema.String) })
const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
}
const Counted = Schema.Struct({
  id: Schema.String,
  data: Schema.Record(Schema.String, Schema.Number),
})
const sparse = (prefix?: string) =>
  DynamoModel.configure(Counted, {
    data: { storedAs: DynamoModel.SparseMap(prefix === undefined ? undefined : { prefix }) },
  })

/** Each position storing an attribute where the library writes its own: refused, then accepted. */
const POSITIONS: ReadonlyArray<{
  readonly name: string
  readonly refused: Record<string, unknown>
  readonly accepted: Record<string, unknown>
  /** What the refusal names. */
  readonly names: string
}> = [
  {
    name: "a model field named `__edd_e__`",
    refused: {
      model: Schema.Struct({ id: Schema.String, __edd_e__: Schema.optional(Schema.String) }),
      primaryKey,
    },
    accepted: { model: DynamoModel.configure(Doc, { tag: { field: "kind" } }), primaryKey },
    names: '"__edd_e__" would be stored in "__edd_e__"',
  },
  {
    name: "a model field renamed `__edd_e__`",
    refused: { model: DynamoModel.configure(Doc, { tag: { field: "__edd_e__" } }), primaryKey },
    accepted: { model: DynamoModel.configure(Doc, { tag: { field: "kind" } }), primaryKey },
    names: '"tag" would be stored in "__edd_e__"',
  },
  {
    name: "the created timestamp",
    refused: { model: Doc, primaryKey, timestamps: { created: "__edd_e__" } },
    accepted: { model: Doc, primaryKey, timestamps: { created: "made" } },
    names: '"__edd_e__" would be stored in "__edd_e__"',
  },
  {
    name: "the updated timestamp",
    refused: { model: Doc, primaryKey, timestamps: { updated: "__edd_e__" } },
    accepted: { model: Doc, primaryKey, timestamps: { updated: "changed" } },
    names: '"__edd_e__" would be stored in "__edd_e__"',
  },
  {
    name: "the version",
    refused: { model: Doc, primaryKey, versioned: { field: "__edd_e__" } },
    accepted: { model: Doc, primaryKey, versioned: { field: "rev" } },
    names: '"__edd_e__" would be stored in "__edd_e__"',
  },
  {
    name: "a sparse map whose entry can be the partition key's attribute",
    refused: {
      model: sparse(),
      primaryKey: { ...primaryKey, pk: { field: "data#pk", composite: ["id"] } },
    },
    accepted: {
      model: sparse("d"),
      primaryKey: { ...primaryKey, pk: { field: "data#pk", composite: ["id"] } },
    },
    names:
      'sparse map "data" stores each entry as "data#<key>", and the entry "pk" would be stored in "data#pk"',
  },
  {
    name: "a sparse map whose entry can be the sort key's attribute",
    refused: {
      model: sparse("m"),
      primaryKey: { ...primaryKey, sk: { field: "m#sk", composite: [] } },
    },
    accepted: {
      model: sparse("data"),
      primaryKey: { ...primaryKey, sk: { field: "m#sk", composite: [] } },
    },
    names:
      'sparse map "data" stores each entry as "m#<key>", and the entry "sk" would be stored in "m#sk"',
  },
]

const MAKES = [
  ["the operational Entity.make", Entity.make],
  ["the pure Entity.make", PureEntity.make],
] as const

describe("EDD-9140: an attribute stored under one the library writes", () => {
  for (const [make, build] of MAKES) {
    describe(make, () => {
      for (const position of POSITIONS) {
        it(`refuses ${position.name}`, () => {
          expect(() =>
            (build as (config: unknown) => unknown)({ entityType: "Doc", ...position.refused }),
          ).toThrow(`[EDD-9140] Entity "Doc": ${position.names}`)
        })
        it(`accepts ${position.name} stored elsewhere`, () => {
          expect(() =>
            (build as (config: unknown) => unknown)({ entityType: "Doc", ...position.accepted }),
          ).not.toThrow()
        })
      }
    })
  }

  for (const position of POSITIONS) {
    it.effect(`at run time, ${position.name} stored elsewhere keeps the row's type and key`, () => {
      const Docs = Entity.make({ entityType: "Doc", ...position.accepted } as never) as any
      const MainTable = Table.make({ schema, entities: { Docs } }) as any
      const table = makeRecordingTable()
      const keys = position.accepted.primaryKey as typeof primaryKey
      const input = position.name.startsWith("a sparse map")
        ? { id: "a", data: { pk: 7, sk: 8 } }
        : { id: "a", tag: "kept" }
      return Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({ entities: { Docs }, tables: { MainTable } })
        yield* db.entities.Docs.put(input).asEffect()
        const [row] = [...table.items.values()] as ReadonlyArray<Record<string, any>>
        expect(row!.__edd_e__).toEqual({ S: "Doc" })
        expect(row![keys.pk.field]).toEqual({ S: "$lib#v1#doc#id_a" })
        expect(row![keys.sk.field]).toEqual({ S: "$lib#v1#doc" })
      }).pipe(Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "lib" })))) as never
    })
  }

  describe("an update can't reach `__edd_e__`", () => {
    const Docs = Entity.make({ entityType: "Doc", model: Doc, primaryKey } as never) as any
    const MainTable = Table.make({ schema, entities: { Docs } }) as any
    const UPDATES: ReadonlyArray<readonly [string, (update: any) => any]> = [
      [".remove()", (update) => update.remove(["__edd_e__"])],
      [".add()", (update) => update.add({ __edd_e__: 1 })],
      ["pathSet", (update) => update.pathSet({ segments: ["__edd_e__"], value: "Other" })],
      ["pathRemove", (update) => update.pathRemove(["__edd_e__"])],
    ]
    for (const [name, op] of UPDATES) {
      it.effect(`${name} of it is refused, sending nothing`, () => {
        const table = makeRecordingTable()
        return Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({ entities: { Docs }, tables: { MainTable } })
          yield* db.entities.Docs.put({ id: "a" }).asEffect()
          table.take()
          const error: any = yield* Effect.flip(op(db.entities.Docs.update({ id: "a" })).asEffect())
          expect(error._tag).toBe("ValidationError")
          expect(String(error.cause)).toContain('"__edd_e__" is an attribute the library manages')
          expect(table.requests).toEqual([])
          const [row] = [...table.items.values()] as ReadonlyArray<Record<string, any>>
          expect(row!.__edd_e__).toEqual({ S: "Doc" })
        }).pipe(Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "lib" })))) as never
      })
    }

    it.effect("`.set()` of it writes nothing: it isn't a model field", () => {
      const table = makeRecordingTable()
      return Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({ entities: { Docs }, tables: { MainTable } })
        yield* db.entities.Docs.put({ id: "a" }).asEffect()
        table.take()
        yield* db.entities.Docs.update({ id: "a" })
          .set({ __edd_e__: "Other" } as never)
          .asEffect()
        expect(table.requests.map((request) => request.command)).not.toContain("UpdateItem")
        const [row] = [...table.items.values()] as ReadonlyArray<Record<string, any>>
        expect(row!.__edd_e__).toEqual({ S: "Doc" })
      }).pipe(Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "lib" })))) as never
    })
  })
})
