/**
 * The rule (#183, DESIGN.md "Never set a table key attribute"): no update the library sends
 * names an attribute of the table's primary key, whatever the index definitions, on any write
 * path. DynamoDB refuses such an update, so it would fail in production on the rows that reach
 * it. This records every `UpdateItem` and transactional `Update` and fails if any target one.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import {
  type Harness as InvertedHarness,
  multiCompositeOffScenarios,
  multiCompositeScenarios,
  numberAndDateScenarios,
  off136Scenarios,
  row136Scenarios,
  textScenarios,
  writePathScenarios,
} from "./helpers/InvertedIndexes.js"
import { makeRecordingTable, type Request } from "./helpers/RecordingTable.js"
import {
  aggregateScenario,
  historyScenarios,
  indexKeyScenarios,
  itemScenarios,
  limitScenarios,
  type Harness as Rows137Harness,
  sentinelScenario,
  streamScenario,
} from "./helpers/Rows137.js"
import {
  keptEntryScenarios,
  leavingIndexScenarios,
  offIndexScenarios,
  type Harness as SharedHarness,
  tableKeyScenarios,
} from "./helpers/SharedKeyAttributes.js"

/** Split on the commas and spaces at the top of an expression, not those in a function's call. */
const splitActions = (clause: string): ReadonlyArray<string> => {
  const actions: Array<string> = []
  let depth = 0
  let current = ""
  for (const character of clause) {
    if (character === "(") depth++
    if (character === ")") depth--
    if (character === "," && depth === 0) {
      actions.push(current)
      current = ""
    } else current += character
  }
  actions.push(current)
  return actions.map((action) => action.trim()).filter((action) => action !== "")
}

/** The attribute each action of an update's expression writes: a path's root, not what it reads. */
const writtenBy = (input: Record<string, any>): ReadonlyArray<string> => {
  const names: Record<string, string> = input.ExpressionAttributeNames ?? {}
  return String(input.UpdateExpression ?? "")
    .split(/\b(?=SET\s|REMOVE\s|ADD\s|DELETE\s)/)
    .flatMap((clause) => splitActions(clause.replace(/^(SET|REMOVE|ADD|DELETE)\s+/, "")))
    .map((action) => {
      const root = /^[^\s=.[]+/.exec(action)?.[0] ?? action
      return names[root] ?? root
    })
}

/** Every update among `requests`, alone or in a transaction. */
const updatesIn = (requests: ReadonlyArray<Request>): ReadonlyArray<Record<string, any>> =>
  requests.flatMap((request) => {
    if (request.command === "UpdateItem") return [request.input]
    if (request.command !== "TransactWriteItems") return []
    return (request.input.TransactItems as ReadonlyArray<Record<string, any>>).flatMap((item) =>
      item.Update === undefined ? [] : [item.Update],
    )
  })

const expectNoTableKeyWrite = (requests: ReadonlyArray<Request>) => {
  for (const update of updatesIn(requests)) {
    const written = writtenBy(update)
    expect(written, String(update.UpdateExpression)).not.toContain("pk")
    expect(written, String(update.UpdateExpression)).not.toContain("sk")
  }
}

describe("what the recorder reads", () => {
  it("names the target of each action, and nothing an action only reads", () => {
    expect(
      writtenBy({
        UpdateExpression:
          "SET #a = list_append(#read, :v), sk = :s, #b.#c = if_not_exists(#pk, :d) REMOVE #e, #f[0] ADD #g :n DELETE #h :m",
        ExpressionAttributeNames: {
          "#a": "a",
          "#read": "pk",
          "#b": "b",
          "#c": "pk",
          "#pk": "pk",
          "#e": "e",
          "#f": "f",
          "#g": "g",
          "#h": "h",
        },
      }),
    ).toEqual(["a", "sk", "b", "e", "f", "g", "h"])
  })

  it("reads an update alone or in a transaction, and nothing else", () => {
    const update = { UpdateExpression: "SET #a = :v" }
    expect(
      updatesIn([
        { command: "UpdateItem", input: update },
        {
          command: "TransactWriteItems",
          input: { TransactItems: [{ Update: update }, { Put: {} }, { Delete: {} }] },
        },
        { command: "PutItem", input: {} },
      ]),
    ).toEqual([update, update])
  })

  it("names a key attribute written by alias or by name", () => {
    expect(
      writtenBy({ UpdateExpression: "SET #x = :v", ExpressionAttributeNames: { "#x": "pk" } }),
    ).toEqual(["pk"])
    expect(writtenBy({ UpdateExpression: "REMOVE sk" })).toEqual(["sk"])
  })
})

// ---------------------------------------------------------------------------
// Definitions × lifecycles
// ---------------------------------------------------------------------------

const Row = Schema.Struct({
  tenant: Schema.String,
  id: Schema.String,
  status: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  at: Schema.optional(Schema.Number),
})

const primaryKey = {
  pk: { field: "pk", composite: ["tenant"] },
  sk: { field: "sk", composite: ["id"] },
} as const

const DEFINITIONS: Record<string, unknown> = {
  "an inverted index": {
    byId: {
      name: "gsi1",
      pk: { field: "sk", composite: ["id"] },
      sk: { field: "pk", composite: ["tenant"] },
    },
  },
  "an index sharing the table's sort key": {
    byId: {
      name: "gsi1",
      pk: { field: "gpk", composite: ["status"] },
      sk: { field: "sk", composite: ["id"] },
    },
  },
  "a sharded index sharing the table's sort key": {
    byId: {
      name: "gsi1",
      pk: { field: "gpk", composite: ["status"] },
      sk: { field: "sk", composite: ["id"] },
      shards: 8,
    },
  },
  "a local index": {
    byId: {
      name: "lsi1",
      pk: { field: "pk", composite: ["tenant"] },
      sk: { field: "lsk", composite: ["status"] },
    },
  },
  "dedicated attributes": {
    byId: {
      name: "gsi1",
      pk: { field: "gpk", composite: ["status"] },
      sk: { field: "gsk", composite: ["id"] },
    },
  },
}

const worldOf = (
  indexes: unknown,
  options: Record<string, unknown>,
  schemaOptions: { readonly escapeKeys?: boolean; readonly legacyKeys?: boolean } = {},
) => {
  const schema = DynamoSchema.make({ name: "nokey", version: 1, ...schemaOptions })
  const Rows = Entity.make({
    model: Row,
    entityType: "Row",
    primaryKey,
    indexes: indexes as never,
    ...options,
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Rows } }) as any
  return { schema, Rows, MainTable }
}

const tableFor = (indexes: Record<string, any>) => {
  const declared: Record<string, { readonly pk: string; readonly sk: string }> = {}
  for (const index of Object.values(indexes)) {
    declared[index.name] = { pk: index.pk.field, sk: index.sk.field }
  }
  return makeRecordingTable({ indexes: declared })
}

const key = { tenant: "a b", id: "c d" }
const row = { ...key, status: "x y", note: "n", email: "e f", at: 1 }

const LIFECYCLES: ReadonlyArray<{
  readonly name: string
  readonly options: Record<string, unknown>
  readonly run: (db: any, Rows: any) => Effect.Effect<void, unknown, any>
}> = [
  {
    name: "put, update, upsert, delete",
    options: {},
    run: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put(row).asEffect()
        yield* db.entities.Rows.update(key).set({ note: "m" }).asEffect()
        yield* db.entities.Rows.update(key).set({ status: "p q" }).asEffect()
        yield* db.entities.Rows.update(key).remove(["note"]).asEffect()
        yield* db.entities.Rows.update(key).remove(["status"]).asEffect()
        yield* db.entities.Rows.upsert({ ...row, note: "u" }).asEffect()
        yield* db.entities.Rows.delete(key).asEffect()
      }),
  },
  {
    name: "a batch and a transaction",
    options: {},
    run: (db, Rows) =>
      Effect.gen(function* () {
        yield* Batch.write([Rows.put(row)]).pipe(Effect.ignore)
        yield* db.entities.Rows.put(row).asEffect()
        yield* Transaction.transactWrite([Rows.update(key).pipe(Entity.set({ note: "t" }))])
        yield* Transaction.transactWrite([Rows.update(key).pipe(Entity.set({ status: "t u" }))])
      }),
  },
  {
    name: "retained versions",
    options: { versioned: { retain: true } },
    run: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put(row).asEffect()
        yield* db.entities.Rows.update(key).set({ note: "m" }).asEffect()
        yield* db.entities.Rows.update(key).set({ status: "p q" }).asEffect()
        yield* db.entities.Rows.update(key).remove(["status"]).asEffect()
        yield* db.entities.Rows.delete(key).asEffect()
      }),
  },
  {
    name: "soft delete, restore, purge",
    options: { softDelete: true },
    run: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put(row).asEffect()
        yield* db.entities.Rows.update(key).set({ status: "p q" }).asEffect()
        yield* db.entities.Rows.delete(key).asEffect()
        yield* db.entities.Rows.restore(key)
        yield* db.entities.Rows.purge(key)
      }),
  },
  {
    name: "a unique constraint",
    options: { unique: { contact: ["email"] } },
    run: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.put(row).asEffect()
        yield* db.entities.Rows.update(key).set({ email: "g h" }).asEffect()
        yield* db.entities.Rows.update(key).set({ status: "p q" }).asEffect()
        yield* db.entities.Rows.delete(key).asEffect()
      }),
  },
  {
    name: "time series",
    options: {
      timestamps: false,
      timeSeries: {
        orderBy: "at",
        appendInput: Schema.Struct({
          tenant: Schema.String,
          id: Schema.String,
          at: Schema.Number,
          status: Schema.optional(Schema.String),
        }),
      },
    },
    run: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Rows.append({ ...key, at: 2, status: "x y" }).asEffect()
        yield* db.entities.Rows.append({ ...key, at: 3, status: "p q" }).asEffect()
        yield* db.entities.Rows.append({ ...key, at: 4 }).asEffect()
      }),
  },
]

const SETTINGS = [
  { name: "escaped", schema: {} },
  { name: "escapeKeys off", schema: { escapeKeys: false } },
] as const

describe("no update names a table key attribute", () => {
  for (const [definition, indexes] of Object.entries(DEFINITIONS)) {
    for (const setting of SETTINGS) {
      describe(`${definition}, ${setting.name}`, () => {
        for (const lifecycle of LIFECYCLES) {
          it.effect(lifecycle.name, () => {
            const world = worldOf(indexes, lifecycle.options, setting.schema)
            const table = tableFor(indexes as Record<string, any>)
            return Effect.gen(function* () {
              const db = (yield* DynamoClient.make({
                entities: { Rows: world.Rows },
                tables: { MainTable: world.MainTable },
              } as never)) as any
              yield* lifecycle.run(db, world.Rows)
              expectNoTableKeyWrite(table.requests)
              // The recorder reads what's there: a lifecycle sends writes of some kind.
              expect(table.requests.length).toBeGreaterThan(0)
            }).pipe(
              Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "t" }))),
            ) as never
          })
        }
        it.effect("rekey over rows 1.36 wrote", () => {
          const world = worldOf(indexes, {}, setting.schema)
          const table = tableFor(indexes as Record<string, any>)
          return Effect.gen(function* () {
            const db = (yield* DynamoClient.make({
              entities: { Rows: world.Rows },
              tables: { MainTable: world.MainTable },
            } as never)) as any
            yield* db.entities.Rows.put(row).asEffect()
            // 1.36 didn't escape: for these values, its text is the current text unescaped.
            for (const [at, item] of [...table.items.entries()]) {
              table.items.delete(at)
              const old = Object.fromEntries(
                Object.entries(item).map(([name, value]) => [
                  name,
                  /k$/.test(name) && value.S !== undefined
                    ? { S: value.S.replaceAll("%20", " ") }
                    : value,
                ]),
              ) as Record<string, any>
              table.items.set(`${old.pk.S}|${old.sk.S}`, old)
            }
            const before = table.requests.length
            yield* db.tables.MainTable.rekey()
            yield* db.tables.MainTable.rekey()
            expectNoTableKeyWrite(table.requests.slice(before))
          }).pipe(
            Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "t" }))),
          ) as never
        })
      })
    }
  }

  it.effect("rekey's retry, after another writer, doesn't set the sort key an index shares", () => {
    const indexes = DEFINITIONS["an index sharing the table's sort key"] as Record<string, any>
    const world = worldOf(indexes, {})
    const table = tableFor(indexes)
    return Effect.gen(function* () {
      const db = (yield* DynamoClient.make({
        entities: { Rows: world.Rows },
        tables: { MainTable: world.MainTable },
      } as never)) as any
      yield* db.entities.Rows.put({ tenant: "t", id: "a b", status: "x y" }).asEffect()
      const at = "$nokey#v1#row#tenant_t|$nokey#v1#row#id_a%20b"
      const current = table.items.get(at)!
      expect(current.gpk?.S).toBe("$nokey#v1#row#status_x%20y")
      // The row is at its current key, and its index key at its 1.36 text.
      table.items.set(at, { ...current, gpk: { S: "$nokey#v1#row#status_x y" } })
      let landed = 0
      table.hooks.onRequest = ({ command }) => {
        if (command !== "UpdateItem" || landed++ > 0) return
        // Another writer lands first: this row's values stop agreeing with what rekey read.
        const row = table.items.get(at)!
        table.items.set(at, {
          ...row,
          ...toAttributeMap({
            id: "a%20b",
            status: "p q",
            gpk: "$nokey#v1#row#status_p%20q",
          }),
        })
      }
      const before = table.requests.length
      yield* db.tables.MainTable.rekey()
      expect(landed).toBeGreaterThan(0)
      expect(updatesIn(table.requests.slice(before)).length).toBeGreaterThan(0)
      expectNoTableKeyWrite(table.requests.slice(before))
      // The row stays where it is, however its values have come to compose.
      expect(table.items.get(at)?.sk?.S).toBe("$nokey#v1#row#id_a%20b")
    }).pipe(Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "t" })))) as never
  })

  it.effect("an aggregate's rekey sets no table key, with a list key and a local index", () => {
    const schema = DynamoSchema.make({ name: "nokey", version: 1 })
    const Item = Schema.Struct({ id: Schema.String, area: Schema.String })
    const Owner = Entity.make({
      model: Item,
      entityType: "Owner",
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
    }) as any
    const MainTable = Table.make({ schema, entities: { Owner } }) as any
    const Stop = Schema.Struct({ label: Schema.String, note: Schema.String })
    const Route = Schema.Struct({
      id: Schema.String,
      area: Schema.String,
      stops: Schema.Array(Stop),
    })
    const Routes = Aggregate.make(
      Route as never,
      {
        table: MainTable,
        schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { index: "lsi1", name: "routes", sk: { field: "lsi1sk", composite: ["area"] } },
        root: { entityType: "RouteItem" },
        edges: {
          stops: Aggregate.many({ entityType: "RouteStop", sk: { composite: ["label"] } }),
        },
        list: {
          index: "gsi1",
          name: "routelist",
          pk: { field: "gsi1pk", composite: ["area"] },
          sk: { field: "gsi1sk", composite: ["id"] },
        },
      } as never,
    ) as any
    const table = makeRecordingTable({
      indexes: {
        gsi1: { pk: "gsi1pk", sk: "gsi1sk" },
        lsi1: { pk: "pk", sk: "lsi1sk" },
      },
    })
    return Effect.gen(function* () {
      const db = (yield* DynamoClient.make({
        entities: { Owner },
        aggregates: { Routes },
        tables: { MainTable },
      } as never)) as any
      yield* db.aggregates.Routes.create({
        id: "a b",
        area: "n m",
        stops: [{ label: "x y", note: "o" }],
      })
      for (const [at, item] of [...table.items.entries()]) {
        table.items.delete(at)
        const old = Object.fromEntries(
          Object.entries(item).map(([name, value]) => [
            name,
            /k$/.test(name) && value.S !== undefined
              ? { S: value.S.replaceAll("%20", " ") }
              : value,
          ]),
        ) as Record<string, any>
        table.items.set(`${old.pk.S}|${old.sk.S}`, old)
      }
      const before = table.requests.length
      const report = yield* db.tables.MainTable.rekey()
      expect(report.moved.aggregate).toBeGreaterThan(0)
      yield* db.tables.MainTable.rekey()
      expectNoTableKeyWrite(table.requests.slice(before))
      expect((yield* db.aggregates.Routes.get({ id: "a b" })).stops).toHaveLength(1)
    }).pipe(Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "t" })))) as never
  })
})

// ---------------------------------------------------------------------------
// Every other suite's scenarios, recorded
// ---------------------------------------------------------------------------

describe("no update in the suites over these definitions names one", () => {
  const recording = (indexes: Record<string, { readonly pk: string; readonly sk: string }>) =>
    makeRecordingTable({ indexes })

  const indexesOf = (definition: any): Record<string, { pk: string; sk: string }> => {
    const declared: Record<string, { pk: string; sk: string }> = {}
    for (const index of Object.values<any>(definition.Rows?.indexes ?? {})) {
      if (index.index !== undefined)
        declared[index.index] = { pk: index.pk.field, sk: index.sk.field }
    }
    return declared
  }

  const shared: SharedHarness = {
    on: (world, body) => {
      const table = recording(indexesOf(world))
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Rows: world.Rows },
          tables: { MainTable: world.MainTable },
        } as never)
        const result = yield* body(db)
        expectNoTableKeyWrite(table.requests)
        return result
      }).pipe(
        Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "t" }))),
      ) as never
    },
  }

  for (const scenario of [
    ...tableKeyScenarios,
    ...leavingIndexScenarios,
    ...offIndexScenarios,
    ...keptEntryScenarios,
  ]) {
    it.effect(`shared attributes: ${scenario.name}`, () => scenario.run(shared))
  }

  const inverted: InvertedHarness = {
    on: (world, body) => {
      const table = recording(indexesOf(world))
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Rows: world.Rows },
          tables: { MainTable: world.MainTable },
        } as never)
        const result = yield* body(db, {
          seed: (row) =>
            Effect.sync(() => {
              table.items.set(`${row.pk.S}|${row.sk.S}`, row)
            }),
          rows: () => Effect.sync(() => [...table.items.values()]),
          as: (other, inner) =>
            Effect.gen(function* () {
              const current = yield* DynamoClient.make({
                entities: { Rows: other.Rows },
                tables: { MainTable: other.MainTable },
              } as never)
              return yield* inner(current)
            }).pipe(Effect.provide(other.MainTable.layer({ name: "t" }))),
        })
        expectNoTableKeyWrite(table.requests)
        return result
      }).pipe(
        Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "t" }))),
      ) as never
    },
  }

  for (const scenario of [
    ...textScenarios,
    ...numberAndDateScenarios,
    ...writePathScenarios,
    ...multiCompositeScenarios,
    ...multiCompositeOffScenarios,
    ...row136Scenarios,
    ...off136Scenarios,
  ]) {
    it.effect(`inverted: ${scenario.name}`, () => scenario.run(inverted))
  }

  const rows137: Rows137Harness = {
    on: (world, body) => {
      const table = recording({
        gsi1: { pk: "gsi1pk", sk: "gsi1sk" },
        lsi1: { pk: "pk", sk: "lsi1sk" },
      })
      return Effect.gen(function* () {
        const db = yield* world.client()
        const result = yield* body(db, {
          seed: (row) =>
            Effect.sync(() => {
              table.items.set(`${row.pk.S}|${row.sk.S}`, row)
            }),
          remove: (row) =>
            Effect.sync(() => {
              table.items.delete(`${row.pk.S}|${row.sk.S}`)
            }),
          rows: () => Effect.sync(() => [...table.items.values()]),
          as: (other, inner) =>
            Effect.gen(function* () {
              const current = yield* other.client()
              return yield* inner(current)
            }).pipe(Effect.provide(other.MainTable.layer({ name: "t" }))),
        })
        expectNoTableKeyWrite(table.requests)
        return result
      }).pipe(
        Effect.provide(Layer.merge(table.layer, world.MainTable.layer({ name: "t" }))),
      ) as never
    },
  }

  for (const scenario of [
    ...itemScenarios,
    ...indexKeyScenarios,
    ...historyScenarios,
    ...limitScenarios,
  ]) {
    it.effect(`1.37 rows: ${scenario.name}`, () => scenario.run(rows137))
  }
  it.effect("1.37 rows: a unique sentinel", () => sentinelScenario(rows137))
  it.effect("1.37 rows: a stream", () => streamScenario(rows137))
  it.effect("1.37 rows: an aggregate", () => aggregateScenario(rows137))
})
