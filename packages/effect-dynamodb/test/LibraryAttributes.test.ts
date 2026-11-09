/**
 * `EDD-9140`: an entity storing an attribute under one the library writes itself is refused when
 * the definition loads. That's a model field named or renamed `__edd_e__`, or a timestamp or the
 * version so named, where every row holds its entity type, and a table key attribute a row's
 * reader takes as a sparse map's entry (`<prefix>#` and a non-empty key). Each position has a form
 * that loads, whose rows keep their type and keys, and no update reaches `__edd_e__`. The
 * `ownsRows` bind check (`EDD-9130`) relies on it: a model attribute is any name holding any text
 * but these.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import { Effect, Exit, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { holds } from "./helpers/InMemoryTables.js"
import { applyUpdate, mockDynamoClient } from "./helpers/MockDynamoClient.js"
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
    // The write set the row's type, then the rename moved it into "kind": the row had no type,
    // and the caller's value was gone.
    name: "a model field named `__edd_e__` under a rename",
    refused: {
      model: DynamoModel.configure(
        Schema.Struct({ id: Schema.String, __edd_e__: Schema.optional(Schema.String) }),
        { __edd_e__: { field: "kind" } },
      ),
      primaryKey,
    },
    accepted: { model: DynamoModel.configure(Doc, { tag: { field: "kind" } }), primaryKey },
    names:
      '"__edd_e__" is named "__edd_e__", the attribute that holds each row\'s entity type, which every read filters on, and is stored in "kind"',
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
      'sparse map "data" stores each entry as "data#<key>", and a row\'s reader takes "data#pk", an attribute of the table\'s primary key, as its entry "pk"',
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
      'sparse map "data" stores each entry as "m#<key>", and a row\'s reader takes "m#sk", an attribute of the table\'s primary key, as its entry "sk"',
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

describe("EDD-9140: a key attribute the reader takes as a sparse map's entry", () => {
  // The reader takes `<prefix>#` and a non-empty key as an entry: `data#a`, `data##` (the key
  // `#`) and `data#x#y` (the key `x#y`) are entries, so as key attributes they'd read as phantom
  // entries. `data#` alone is none.
  const MAPS = [
    ["number", Schema.Number, [7, 9]],
    ["string", Schema.String, ["seven", "nine"]],
  ] as const
  const definition = (half: "pk" | "sk", field: string, value: Schema.Top) => ({
    entityType: "Doc",
    model: DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        note: Schema.String,
        data: Schema.Record(Schema.String, value),
      }),
      { data: { storedAs: DynamoModel.SparseMap() } },
    ),
    primaryKey: {
      pk: { field: half === "pk" ? field : "pk", composite: ["id"] },
      sk: { field: half === "sk" ? field : "sk", composite: [] },
    },
  })

  for (const half of ["pk", "sk"] as const) {
    for (const [map, value] of MAPS) {
      for (const [make, build] of MAKES) {
        it(`${make}, a ${map} map: "data#" as the ${half} attribute loads; "data#a", "data##" and "data#x#y" don't`, () => {
          const load = (field: string) => () =>
            (build as (config: unknown) => unknown)(definition(half, field, value))
          expect(load("data#")).not.toThrow()
          for (const [field, key] of [
            ["data#a", "a"],
            ["data##", "#"],
            ["data#x#y", "x#y"],
          ] as const) {
            expect(load(field)).toThrow(
              `[EDD-9140] Entity "Doc": sparse map "data" stores each entry as "data#<key>", and a row's reader takes "${field}", an attribute of the table's primary key, as its entry "${key}"`,
            )
          }
        })
      }
    }
  }

  for (const half of ["pk", "sk"] as const) {
    for (const [map, value, [first, then]] of MAPS) {
      it.effect(
        `"data#" as the ${half} attribute, a ${map} map: rows keep their keys, the map its entries, and clearMap leaves the key`,
        () => {
          const config = definition(half, "data#", value)
          const pkField = config.primaryKey.pk.field
          const skField = config.primaryKey.sk.field
          const Docs = Entity.make(config as never) as any
          const MainTable = Table.make({ schema, entities: { Docs } }) as any
          const items = new Map<string, Record<string, any>>()
          const requests: Array<string> = []
          const updates: Array<Record<string, any>> = []
          const keyOf = (key: Record<string, any>) => {
            expect(typeof key[pkField]?.S).toBe("string")
            expect(typeof key[skField]?.S).toBe("string")
            return `${key[pkField].S}|${key[skField].S}`
          }
          const client = mockDynamoClient({
            putItem: (input) =>
              Effect.sync(() => {
                requests.push("PutItem")
                items.set(keyOf(input.Item!), structuredClone(input.Item!))
                return {} as never
              }),
            getItem: (input) =>
              Effect.sync(() => {
                requests.push("GetItem")
                const item = items.get(keyOf(input.Key!))
                return (item === undefined ? {} : { Item: structuredClone(item) }) as never
              }),
            updateItem: (input) =>
              Effect.sync(() => {
                requests.push("UpdateItem")
                updates.push(input)
                const id = keyOf(input.Key!)
                const current = items.get(id)
                expect(
                  holds(
                    input.ConditionExpression,
                    current,
                    input.ExpressionAttributeNames ?? {},
                    input.ExpressionAttributeValues ?? {},
                  ),
                ).toBe(true)
                const next = applyUpdate(current!, input)!
                expect(keyOf(next)).toBe(id)
                items.set(id, next)
                return { Attributes: next } as never
              }),
            deleteItem: (input) =>
              Effect.sync(() => {
                requests.push("DeleteItem")
                items.delete(keyOf(input.Key!))
                return {} as never
              }),
          })
          return Effect.gen(function* () {
            const db: any = yield* DynamoClient.make({ entities: { Docs }, tables: { MainTable } })
            for (const id of ["a", "b"]) {
              yield* db.entities.Docs.put({ id, note: "first", data: { ok: first } }).asEffect()
            }
            for (const id of ["a", "b"]) {
              expect(yield* db.entities.Docs.get({ id })).toEqual({
                id,
                note: "first",
                data: { ok: first },
              })
            }
            for (const row of items.values()) {
              expect(row[pkField]).toEqual({ S: `$lib#v1#doc#id_${row.id.S}` })
              expect(row[skField]).toEqual({ S: "$lib#v1#doc" })
            }
            yield* db.entities.Docs.update({ id: "a" })
              .set({ note: "then", data: { more: then } })
              .asEffect()
            expect(yield* db.entities.Docs.get({ id: "a" })).toEqual({
              id: "a",
              note: "then",
              data: { ok: first, more: then },
            })
            // clearMap removes the attributes the reader takes as entries, never the key attribute.
            updates.length = 0
            yield* db.entities.Docs.update({ id: "a" }).clearMap("data").asEffect()
            expect(updates).toHaveLength(1)
            const removed = /REMOVE (.*)$/
              .exec(updates[0]!.UpdateExpression)![1]!
              .split(", ")
              .map((name) => updates[0]!.ExpressionAttributeNames[name])
            expect(removed.sort()).toEqual(["data#more", "data#ok"])
            expect(yield* db.entities.Docs.get({ id: "a" })).toEqual({
              id: "a",
              note: "then",
              data: {},
            })
            // The one key that would name the key attribute is the writer's to refuse.
            const sent = requests.length
            const stored = structuredClone([...items.entries()])
            const empty = yield* Effect.exit(
              db.entities.Docs.put({ id: "c", note: "x", data: { "": first } }).asEffect(),
            )
            expect(Exit.isFailure(empty)).toBe(true)
            expect(requests).toHaveLength(sent)
            expect([...items.entries()]).toEqual(stored)
            yield* db.entities.Docs.delete({ id: "a" }).asEffect()
            expect(items.size).toBe(1)
            expect(yield* db.entities.Docs.get({ id: "b" })).toEqual({
              id: "b",
              note: "first",
              data: { ok: first },
            })
          }).pipe(
            Effect.provide(
              Layer.merge(Layer.succeed(DynamoClient, client), MainTable.layer({ name: "lib" })),
            ),
          ) as never
        },
      )
    }
  }
})

describe("EDD-9140: a secondary index's key attribute the reader takes as a sparse map's entry", () => {
  const model = DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      region: Schema.String,
      beds: Schema.Number,
      data: Schema.Record(Schema.String, Schema.Number),
    }),
    { data: { storedAs: DynamoModel.SparseMap() } },
  )
  const INDEXES: ReadonlyArray<
    readonly [what: string, index: (field: string) => Record<string, unknown>, holds: string]
  > = [
    [
      "a secondary index's partition key",
      (field) => ({
        name: "gsi1",
        pk: { field, composite: ["region"] },
        sk: { field: "gsi1sk", composite: ["id"] },
      }),
      `index "byPlace"'s partition key`,
    ],
    [
      "a secondary index's sort key",
      (field) => ({
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["region"] },
        sk: { field, composite: ["id"] },
      }),
      `index "byPlace"'s sort key`,
    ],
    [
      "a local index's sort key",
      (field) => ({
        name: "lsi1",
        pk: { field: "pk", composite: ["id"] },
        sk: { field, composite: ["region"] },
      }),
      `index "byPlace"'s sort key`,
    ],
    [
      "a Z-order sort key",
      (field) => ({
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["region"] },
        sk: { field, zorder: [{ field: "beds", min: 0, max: 15 }] },
      }),
      `index "byPlace"'s sort key`,
    ],
  ]
  for (const [what, index, holds] of INDEXES) {
    for (const [make, build] of MAKES) {
      it(`${make}: "data#x" as ${what} is refused; "data#" loads`, () => {
        const load = (field: string) => () =>
          (build as (config: unknown) => unknown)({
            entityType: "Doc",
            model,
            primaryKey,
            indexes: { byPlace: index(field) },
          })
        expect(load("data#x")).toThrow(
          `[EDD-9140] Entity "Doc": sparse map "data" stores each entry as "data#<key>", and a row's reader takes "data#x", the attribute that holds ${holds}, as its entry "x"`,
        )
        expect(load("data#")).not.toThrow()
      })
    }
  }

  it.effect(
    'at run time, "data#" as a secondary index\'s partition key keeps the key, and clearMap leaves it',
    () => {
      const Docs = Entity.make({
        entityType: "Doc",
        model,
        primaryKey,
        indexes: {
          byPlace: {
            name: "gsi1",
            pk: { field: "data#", composite: ["region"] },
            sk: { field: "gsi1sk", composite: ["id"] },
          },
        },
      } as never) as any
      const MainTable = Table.make({ schema, entities: { Docs } }) as any
      const table = makeRecordingTable()
      return Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({ entities: { Docs }, tables: { MainTable } })
        yield* db.entities.Docs.put({
          id: "a",
          region: "north",
          beds: 1,
          data: { ok: 1 },
        }).asEffect()
        expect((yield* db.entities.Docs.get({ id: "a" })).data).toEqual({ ok: 1 })
        table.take()
        yield* db.entities.Docs.update({ id: "a" }).clearMap("data").asEffect()
        const update = table.requests.find((request) => request.command === "UpdateItem")!
        const removed = /REMOVE (.*)$/
          .exec(update.input.UpdateExpression)![1]!
          .split(", ")
          .map((name: string) => update.input.ExpressionAttributeNames[name])
        expect(removed).toEqual(["data#ok"])
        const [row] = [...table.items.values()] as ReadonlyArray<Record<string, any>>
        expect(row!["data#"]).toEqual({ S: "$lib#v1#doc#region_north" })
      }).pipe(Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "lib" })))) as never
    },
  )
})

describe("EDD-9140: a model field stored under a vector index's attribute", () => {
  const vectorIndexes = {
    byText: { name: "vec1", dimensions: 2, source: { fields: ["text"] } },
  }
  const withField = (field: string, renamed?: string) => ({
    entityType: "Doc",
    model: DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        text: Schema.String,
        [field]: Schema.optional(Schema.String),
      }),
      renamed === undefined ? {} : { [field]: { field: renamed } },
    ),
    primaryKey,
    vectorIndexes,
  })
  for (const [make, build] of MAKES) {
    for (const attribute of ["__edd_v_vec1__", "__edd_vp_vec1__"]) {
      it(`${make}: a field named or renamed "${attribute}" is refused; another name loads`, () => {
        const load = (config: unknown) => () => (build as (config: unknown) => unknown)(config)
        expect(load(withField(attribute))).toThrow(
          `[EDD-9140] Entity "Doc": "${attribute}" would be stored in "${attribute}", an attribute of vector index "byText", which the library writes`,
        )
        expect(load(withField("note", attribute))).toThrow(
          `[EDD-9140] Entity "Doc": "note" would be stored in "${attribute}", an attribute of vector index "byText", which the library writes`,
        )
        expect(load(withField(attribute, "stored"))).toThrow(
          `[EDD-9140] Entity "Doc": "${attribute}" is named "${attribute}", an attribute of vector index "byText", which the library writes, and is stored in "stored"`,
        )
        expect(load(withField("note"))).not.toThrow()
        expect(load(withField("note", "stored"))).not.toThrow()
      })
    }
  }
})
