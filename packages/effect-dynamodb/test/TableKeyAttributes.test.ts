/**
 * The library never sets any part of the primary key (#183, DESIGN.md "Never set a table key
 * attribute"). What would store a value in a table key attribute is refused when the definition
 * loads (`EDD-9109`, `EDD-9112`) or before the update is sent, and each definition position has a
 * form that isn't refused, whose rows keep the keys their values compose.
 */

import { describe, expect, it } from "@effect/vitest"
import * as PureAggregate from "@effect-dynamodb/schema/Aggregate.js"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import { Effect, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const schema = DynamoSchema.make({ name: "keys", version: 1, escapeKeys: true })

const Doc = Schema.Struct({ id: Schema.String, payload: Schema.optional(Schema.String) })
const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
}
const upperKey = {
  pk: { field: "PK", composite: ["id"] },
  sk: { field: "SK", composite: [] },
}

/** Each of Entity.make's positions naming a stored attribute: refused, then its accepted form. */
const ENTITY_POSITIONS: ReadonlyArray<{
  readonly name: string
  readonly refused: Record<string, unknown>
  readonly accepted: Record<string, unknown>
  /** The accepted form stores this attribute. */
  readonly stored: string
  /** The field the run-time input sets, when it isn't `payload` or the stored attribute. */
  readonly input?: string
}> = [
  {
    name: "a model attribute renamed onto the partition key",
    refused: { model: DynamoModel.configure(Doc, { payload: { field: "pk" } }), primaryKey },
    accepted: { model: DynamoModel.configure(Doc, { payload: { field: "stored" } }), primaryKey },
    stored: "stored",
  },
  {
    name: "a model attribute renamed onto the sort key",
    refused: { model: DynamoModel.configure(Doc, { payload: { field: "sk" } }), primaryKey },
    accepted: { model: DynamoModel.configure(Doc, { payload: { field: "stored" } }), primaryKey },
    stored: "stored",
  },
  {
    name: "a model attribute named as the partition key",
    refused: {
      model: Schema.Struct({ id: Schema.String, pk: Schema.optional(Schema.String) }),
      primaryKey,
    },
    accepted: {
      model: Schema.Struct({ id: Schema.String, pk: Schema.optional(Schema.String) }),
      primaryKey: upperKey,
    },
    stored: "pk",
  },
  {
    name: "a model attribute named as the sort key",
    refused: {
      model: Schema.Struct({ id: Schema.String, sk: Schema.optional(Schema.String) }),
      primaryKey,
    },
    accepted: {
      model: Schema.Struct({ id: Schema.String, sk: Schema.optional(Schema.String) }),
      primaryKey: upperKey,
    },
    stored: "sk",
  },
  {
    name: "a model attribute renamed onto a key attribute the entity names otherwise",
    refused: {
      model: DynamoModel.configure(Doc, { payload: { field: "SK" } }),
      primaryKey: upperKey,
    },
    accepted: {
      model: DynamoModel.configure(Doc, { payload: { field: "sk" } }),
      primaryKey: upperKey,
    },
    stored: "sk",
  },
  {
    name: "a model attribute named as the partition key under a rename",
    refused: {
      model: DynamoModel.configure(
        Schema.Struct({ id: Schema.String, pk: Schema.optional(Schema.String) }),
        { pk: { field: "stored" } },
      ),
      primaryKey,
    },
    accepted: {
      model: DynamoModel.configure(
        Schema.Struct({ id: Schema.String, pk: Schema.optional(Schema.String) }),
        { pk: { field: "stored" } },
      ),
      primaryKey: upperKey,
    },
    stored: "stored",
    input: "pk",
  },
  {
    name: "the created timestamp",
    refused: { model: Doc, primaryKey, timestamps: { created: "pk" } },
    accepted: { model: Doc, primaryKey, timestamps: { created: "stored" } },
    stored: "stored",
  },
  {
    name: "the updated timestamp",
    refused: { model: Doc, primaryKey, timestamps: { updated: "sk" } },
    accepted: { model: Doc, primaryKey, timestamps: { updated: "stored" } },
    stored: "stored",
  },
  {
    name: "the version",
    refused: { model: Doc, primaryKey, versioned: { field: "sk" } },
    accepted: { model: Doc, primaryKey, versioned: { field: "stored" } },
    stored: "stored",
  },
]

const ENTITY_MAKES = [
  ["the operational Entity.make", Entity.make],
  ["the pure Entity.make", PureEntity.make],
] as const

describe("EDD-9109: a value stored in a table key attribute", () => {
  for (const [make, build] of ENTITY_MAKES) {
    describe(make, () => {
      for (const position of ENTITY_POSITIONS) {
        it(`refuses ${position.name}`, () => {
          expect(() =>
            (build as (config: unknown) => unknown)({ entityType: "Doc", ...position.refused }),
          ).toThrow("[EDD-9109]")
        })
        it(`accepts ${position.name} stored elsewhere`, () => {
          expect(() =>
            (build as (config: unknown) => unknown)({ entityType: "Doc", ...position.accepted }),
          ).not.toThrow()
        })
      }
    })
  }

  for (const position of ENTITY_POSITIONS) {
    it.effect(`at run time, ${position.name} stored elsewhere keeps the composed key`, () => {
      const Docs = Entity.make({ entityType: "Doc", ...position.accepted } as never) as any
      const MainTable = Table.make({ schema, entities: { Docs } }) as any
      const table = makeRecordingTable()
      const named = position.name.includes("named as")
      const input = {
        id: "a b",
        [position.input ?? (named ? position.stored : "payload")]: "kept",
      }
      return Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({ entities: { Docs }, tables: { MainTable } })
        yield* db.entities.Docs.put(input).asEffect()
        const [row] = [...table.items.values()] as ReadonlyArray<Record<string, any>>
        const keyAttributes = position.accepted.primaryKey as typeof primaryKey
        expect(row![keyAttributes.pk.field].S).toBe("$keys#v1#doc#id_a%20b")
        expect(row![keyAttributes.sk.field].S).toBe("$keys#v1#doc")
        expect(row![position.stored]).toBeDefined()
        // The recorder's table keys on `pk` and `sk`: other names read back on DynamoDB Local.
        if (keyAttributes.pk.field === "pk") {
          expect((yield* db.entities.Docs.get({ id: "a b" })).id).toBe("a b")
        }
      }).pipe(Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "keys" })))) as never
    })
  }
})

// ---------------------------------------------------------------------------
// Secondary index key attributes
// ---------------------------------------------------------------------------

const Placed = Schema.Struct({
  id: Schema.String,
  region: Schema.String,
  beds: Schema.Number,
  payload: Schema.optional(Schema.String),
})
/** The index `byRegion` with its key attributes named `pk` (partition) and `sk` (sort). */
const byRegion = (pk: string, sk: string) => ({
  byRegion: {
    name: "gsi1",
    pk: { field: pk, composite: ["region"] },
    sk: { field: sk, composite: ["id"] },
  },
})
/** A local index: the table's partition key, and its own sort key attribute. */
const local = (sk: string) => ({
  byPlace: {
    name: "lsi1",
    pk: { field: "pk", composite: ["id"] },
    sk: { field: sk, composite: ["region"] },
  },
})
/** A Z-order sort key, stored in the attribute `sk`. */
const zorder = (sk: string) => ({
  byBeds: {
    name: "gsi2",
    pk: { field: "gsi2pk", composite: ["region"] },
    sk: { field: sk, zorder: [{ field: "beds", min: 0, max: 15 }] },
  },
})

/** Each way an entity could store a value in a secondary index's key attribute: refused, then its accepted form. */
const INDEX_POSITIONS: ReadonlyArray<{
  readonly name: string
  readonly refused: Record<string, unknown>
  readonly accepted: Record<string, unknown>
  /** What the refusal names. */
  readonly names: string
  /** The accepted form stores the value here. */
  readonly stored: string
  /** And the index key it composes here. */
  readonly key: string
}> = [
  {
    name: "a model attribute named as a secondary index's partition key",
    refused: {
      model: Schema.Struct({ ...Placed.fields, gsi1pk: Schema.optional(Schema.String) }),
      indexes: byRegion("gsi1pk", "gsi1sk"),
    },
    accepted: {
      model: Schema.Struct({ ...Placed.fields, gsi1pk: Schema.optional(Schema.String) }),
      indexes: byRegion("regionKey", "gsi1sk"),
    },
    names: `"gsi1pk" would be stored in "gsi1pk", the attribute that holds index "byRegion"'s partition key`,
    stored: "gsi1pk",
    key: "regionKey",
  },
  {
    // The write composed the key, then the rename moved it into "stored": the row held the key's
    // text as the field, and wasn't in the index.
    name: "a model attribute named as a secondary index's partition key under a rename",
    refused: {
      model: DynamoModel.configure(
        Schema.Struct({ ...Placed.fields, gsi1pk: Schema.optional(Schema.String) }),
        { gsi1pk: { field: "stored" } },
      ),
      indexes: byRegion("gsi1pk", "gsi1sk"),
    },
    accepted: {
      model: DynamoModel.configure(
        Schema.Struct({ ...Placed.fields, gsi1pk: Schema.optional(Schema.String) }),
        { gsi1pk: { field: "stored" } },
      ),
      indexes: byRegion("regionKey", "gsi1sk"),
    },
    names: `"gsi1pk" is named "gsi1pk", the attribute that holds index "byRegion"'s partition key, and is stored in "stored"`,
    stored: "stored",
    key: "regionKey",
  },
  {
    name: "a model attribute renamed onto a secondary index's sort key",
    refused: {
      model: DynamoModel.configure(Placed, { payload: { field: "gsi1sk" } }),
      indexes: byRegion("gsi1pk", "gsi1sk"),
    },
    accepted: {
      model: DynamoModel.configure(Placed, { payload: { field: "stored" } }),
      indexes: byRegion("gsi1pk", "gsi1sk"),
    },
    names: `"payload" would be stored in "gsi1sk", the attribute that holds index "byRegion"'s sort key`,
    stored: "stored",
    key: "gsi1sk",
  },
  {
    name: "a model attribute renamed onto a local index's sort key",
    refused: {
      model: DynamoModel.configure(Placed, { payload: { field: "lsi1sk" } }),
      indexes: local("lsi1sk"),
    },
    accepted: {
      model: DynamoModel.configure(Placed, { payload: { field: "stored" } }),
      indexes: local("lsi1sk"),
    },
    names: `"payload" would be stored in "lsi1sk", the attribute that holds index "byPlace"'s sort key`,
    stored: "stored",
    key: "lsi1sk",
  },
  {
    name: "a model attribute renamed onto a Z-order sort key",
    refused: {
      model: DynamoModel.configure(Placed, { payload: { field: "gsi2sk" } }),
      indexes: zorder("gsi2sk"),
    },
    accepted: {
      model: DynamoModel.configure(Placed, { payload: { field: "stored" } }),
      indexes: zorder("gsi2sk"),
    },
    names: `"payload" would be stored in "gsi2sk", the attribute that holds index "byBeds"'s sort key`,
    stored: "stored",
    key: "gsi2sk",
  },
  {
    name: "the created timestamp",
    refused: {
      model: Placed,
      indexes: byRegion("gsi1pk", "gsi1sk"),
      timestamps: { created: "gsi1pk" },
    },
    accepted: {
      model: Placed,
      indexes: byRegion("gsi1pk", "gsi1sk"),
      timestamps: { created: "made" },
    },
    names: `"gsi1pk" would be stored in "gsi1pk", the attribute that holds index "byRegion"'s partition key`,
    stored: "made",
    key: "gsi1pk",
  },
  {
    name: "the version",
    refused: {
      model: Placed,
      indexes: byRegion("gsi1pk", "gsi1sk"),
      versioned: { field: "gsi1sk" },
    },
    accepted: { model: Placed, indexes: byRegion("gsi1pk", "gsi1sk"), versioned: { field: "rev" } },
    names: `"gsi1sk" would be stored in "gsi1sk", the attribute that holds index "byRegion"'s sort key`,
    stored: "rev",
    key: "gsi1sk",
  },
]

describe("EDD-9109: a value stored in a secondary index's key attribute", () => {
  // On 1.39.0 the value and the composed index key replaced each other.
  for (const [make, build] of ENTITY_MAKES) {
    describe(make, () => {
      for (const position of INDEX_POSITIONS) {
        it(`refuses ${position.name}`, () => {
          expect(() =>
            (build as (config: unknown) => unknown)({
              entityType: "Doc",
              primaryKey,
              ...position.refused,
            }),
          ).toThrow(`[EDD-9109] Entity "Doc": ${position.names}`)
        })
        it(`accepts ${position.name} stored elsewhere`, () => {
          expect(() =>
            (build as (config: unknown) => unknown)({
              entityType: "Doc",
              primaryKey,
              ...position.accepted,
            }),
          ).not.toThrow()
        })
      }
    })
  }

  for (const position of INDEX_POSITIONS) {
    it.effect(`at run time, ${position.name} stored elsewhere keeps the index key`, () => {
      const Docs = Entity.make({
        entityType: "Doc",
        primaryKey,
        ...position.accepted,
      } as never) as any
      const MainTable = Table.make({ schema, entities: { Docs } }) as any
      const table = makeRecordingTable()
      const input = {
        id: "a",
        region: "north",
        beds: 3,
        payload: "kept",
        ...(position.name.includes("named as") ? { gsi1pk: "kept" } : {}),
      }
      return Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({ entities: { Docs }, tables: { MainTable } })
        yield* db.entities.Docs.put(input).asEffect()
        const [row] = [...table.items.values()] as ReadonlyArray<Record<string, any>>
        const key = row![position.key]
        if (key.B !== undefined) expect(key.B).toBeInstanceOf(Uint8Array)
        else expect(key.S).toMatch(/^\$keys#v1#/)
        expect(row![position.stored]).toBeDefined()
        const read = yield* db.entities.Docs.get({ id: "a" })
        expect(read.region).toBe("north")
        if (position.name.includes("named as")) expect(read.gsi1pk).toBe("kept")
      }).pipe(Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "keys" })))) as never
    })
  }
})

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

const Route = Schema.Struct({ id: Schema.String, area: Schema.String })

const dedicated = {
  list: {
    index: "gsi1",
    name: "byArea",
    pk: { field: "gsi1pk", composite: ["area"] },
    sk: { field: "gsi1sk", composite: ["id"] },
  },
  collection: {
    index: "lsi1",
    name: "routes",
    sk: { field: "lsi1sk", composite: ["area"] },
  },
}

const AGGREGATE_POSITIONS: ReadonlyArray<{
  readonly name: string
  readonly refused: Record<string, unknown>
}> = [
  {
    name: "a list partition key on the partition key",
    refused: {
      collection: { name: "routes" },
      list: { ...dedicated.list, pk: { field: "pk", composite: ["area"] } },
    },
  },
  {
    name: "a list partition key on the sort key",
    refused: {
      collection: { name: "routes" },
      list: { ...dedicated.list, pk: { field: "sk", composite: ["area"] } },
    },
  },
  {
    name: "a list sort key on the sort key",
    refused: {
      collection: { name: "routes" },
      list: { ...dedicated.list, sk: { field: "sk", composite: ["id"] } },
    },
  },
  {
    name: "a list sort key on the partition key",
    refused: {
      collection: { name: "routes" },
      list: { ...dedicated.list, sk: { field: "pk", composite: ["id"] } },
    },
  },
  {
    name: "a collection sort key on the sort key",
    refused: { collection: { ...dedicated.collection, sk: { field: "sk", composite: ["area"] } } },
  },
  {
    name: "a collection sort key on the partition key",
    refused: { collection: { ...dedicated.collection, sk: { field: "pk", composite: ["area"] } } },
  },
]

const aggregateConfig = (MainTable: unknown, position: Record<string, unknown>) => ({
  table: MainTable,
  schema,
  pk: { field: "pk", composite: ["id"] },
  root: { entityType: "RouteItem" },
  edges: {},
  ...position,
})

const holder = (key = primaryKey) => {
  const Holder = Entity.make({
    model: Schema.Struct({ id: Schema.String }),
    entityType: "Holder",
    primaryKey: key,
  } as never) as any
  return { Holder, MainTable: Table.make({ schema, entities: { Holder } } as never) as any }
}

describe("EDD-9112: an aggregate's key stored in a table key attribute", () => {
  const { MainTable } = holder()
  for (const position of AGGREGATE_POSITIONS) {
    it(`Aggregate.make refuses ${position.name}`, () => {
      expect(() =>
        Aggregate.make(Route as never, aggregateConfig(MainTable, position.refused) as never),
      ).toThrow("[EDD-9112]")
    })
    it(`the pure Aggregate.make refuses ${position.name}`, () => {
      expect(() =>
        PureAggregate.make(Route as never, aggregateConfig(MainTable, position.refused) as never),
      ).toThrow("[EDD-9112]")
    })
  }

  it("Aggregate.make judges by the attributes the table's members name", () => {
    const upper = holder(upperKey)
    expect(() =>
      Aggregate.make(
        Route as never,
        aggregateConfig(upper.MainTable, {
          pk: { field: "PK", composite: ["id"] },
          collection: { name: "routes" },
          list: { ...dedicated.list, sk: { field: "SK", composite: ["id"] } },
        }) as never,
      ),
    ).toThrow("[EDD-9112]")
  })

  it("the pure Aggregate.make accepts a list and a collection on attributes of their own", () => {
    expect(() =>
      PureAggregate.make(
        Route as never,
        aggregateConfig(MainTable, {
          collection: dedicated.collection,
          list: dedicated.list,
        }) as never,
      ),
    ).not.toThrow()
  })

  it.effect("on attributes of their own, every row keeps its composed key, and reads back", () => {
    const { Holder, MainTable: main } = holder()
    const Routes = Aggregate.make(
      Route as never,
      aggregateConfig(main, {
        collection: dedicated.collection,
        list: dedicated.list,
      }) as never,
    ) as any
    const table = makeRecordingTable({
      indexes: {
        gsi1: { pk: "gsi1pk", sk: "gsi1sk" },
        lsi1: { pk: "pk", sk: "lsi1sk" },
      },
    })
    return Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: { Holder },
        aggregates: { Routes },
        tables: { MainTable: main },
      } as never)
      yield* db.aggregates.Routes.create({ id: "a b", area: "north" })
      for (const row of table.items.values() as Iterable<Record<string, any>>) {
        expect(row.pk.S).toBe("$keys#v1#routes#a%20b")
        expect(row.sk.S).toBe("$keys#v1#routeitem")
        expect(row.gsi1pk.S).toContain("north")
        expect(row.lsi1sk.S).toContain("north")
      }
      expect((yield* db.aggregates.Routes.get({ id: "a b" })).area).toBe("north")
      const listed: any = yield* db.aggregates.Routes.list({ area: "north" })
      expect(listed.data.map((one: any) => one.id)).toEqual(["a b"])
    }).pipe(Effect.provide(Layer.merge(table.layer, main.layer({ name: "keys" })))) as never
  })
})

// ---------------------------------------------------------------------------
// An update naming a table key attribute
// ---------------------------------------------------------------------------

const Item = Schema.Struct({
  id: Schema.String,
  tags: Schema.optional(Schema.Array(Schema.String)),
  count: Schema.optional(Schema.Number),
})

const UPDATE_REFUSALS: ReadonlyArray<{
  readonly name: string
  readonly op: (update: any) => any
}> = [
  { name: ".remove of the partition key", op: (update) => update.remove(["pk"]) },
  { name: ".remove of the sort key", op: (update) => update.remove(["sk"]) },
  { name: ".set of the partition key", op: (update) => update.set({ pk: "x" }) },
  { name: ".set of the sort key", op: (update) => update.set({ sk: "x" }) },
  { name: ".add to the partition key", op: (update) => update.add({ pk: 1 }) },
  { name: ".subtract from the sort key", op: (update) => update.subtract({ sk: 1 }) },
  { name: ".append to the partition key", op: (update) => update.append({ pk: ["x"] }) },
  { name: ".deleteFromSet of the sort key", op: (update) => update.deleteFromSet({ sk: ["x"] }) },
  { name: ".pathRemove of the partition key", op: (update) => update.pathRemove(["pk"]) },
  {
    name: ".pathSet of the sort key",
    op: (update) => update.pathSet({ segments: ["sk"], value: "x" }),
  },
  {
    name: ".pathAdd to the partition key",
    op: (update) => update.pathAdd({ segments: ["pk"], value: 1 }),
  },
]

describe("an update naming a table key attribute", () => {
  const Items = Entity.make({
    model: Item,
    entityType: "Item",
    primaryKey,
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Items } } as never) as any
  const run = (body: (db: any) => Effect.Effect<unknown, unknown, any>) => {
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: { Items },
        tables: { MainTable },
      } as never)
      const error: any = yield* Effect.flip(body(db))
      expect(error._tag).toBe("ValidationError")
      expect(String(error.cause)).toContain("primary key")
      expect(
        table.requests.filter(
          (request) => request.command === "UpdateItem" || request.command === "TransactWriteItems",
        ),
      ).toEqual([])
    }).pipe(Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "keys" })))) as never
  }

  for (const refusal of UPDATE_REFUSALS) {
    it.effect(`refuses ${refusal.name}, sending nothing`, () =>
      run((db) => refusal.op(db.entities.Items.update({ id: "a" })).asEffect()),
    )
  }

  it.effect("refuses it in a transaction too", () =>
    run(() =>
      Transaction.transactWrite([Items.update({ id: "a" }).pipe(Entity.remove(["pk"] as never))]),
    ),
  )

  it.effect("an attribute named otherwise goes through", () => {
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: { Items },
        tables: { MainTable },
      } as never)
      yield* db.entities.Items.put({ id: "a", count: 1 }).asEffect()
      yield* db.entities.Items.update({ id: "a" }).remove(["count"]).asEffect()
      expect((yield* db.entities.Items.get({ id: "a" })).count).toBeUndefined()
    }).pipe(Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "keys" })))) as never
  })
})
