/**
 * An update's operand its write schema refuses at its path — of `.append()`, `pathSet`,
 * `pathAppend`, `pathPrepend` or `pathIfNotExists` — refuses the update before it reads or sends
 * anything. The decision was made only when the write was built, so an update that reads first (a
 * retained entity's, every planned update of a transaction) read before it was refused, and a
 * failed read reported a `DynamoError` in place of the `ValidationError`.
 *
 * A path naming a sparse map's entry by its stored name (`buckets#a`) is checked against the map's
 * value schema, the schema the row's reader decodes it with. It was checked against nothing: a
 * transaction committed the value, and an update alone wrote it and then failed decoding the row
 * it returned.
 *
 * A transaction's planned update or delete has its condition refused before any op reads, as a put's
 * and a plain delete's are. Planning compiled it after the reads, and a value DynamoDB can't store
 * was a defect.
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const Positive = Schema.Number.check(Schema.isGreaterThan(0))

const definitions = (retain = true) => {
  const schema = DynamoSchema.make({ name: "operands", version: 1 })
  const E = Entity.make({
    model: DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        list: Schema.Array(Positive),
        meta: Schema.Struct({ n: Positive }),
        count: Schema.Number,
        buckets: Schema.Record(Schema.String, Schema.Struct({ n: Positive })),
      }),
      { buckets: { storedAs: DynamoModel.SparseMap() } },
    ),
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    ...(retain ? { versioned: { retain: true } } : {}),
  } as never) as any
  const Main = Table.make({ schema, entities: { E } } as never) as any
  return { E, Main }
}

/** Each operation with an operand its schema refuses (`-1` is not greater than 0). */
const refused: ReadonlyArray<readonly [operation: string, apply: (update: any) => any]> = [
  ["update.append", (update) => update.append({ list: [-1] })],
  [
    "update.pathSet",
    (update) => update.pathSet({ segments: ["meta", "n"], value: -1, isPath: false }),
  ],
  ["update.pathAppend", (update) => update.pathAppend({ segments: ["list"], value: [-1] })],
  ["update.pathPrepend", (update) => update.pathPrepend({ segments: ["list"], value: [-1] })],
  [
    "update.pathIfNotExists",
    (update) => update.pathIfNotExists({ segments: ["meta", "n"], value: -1 }),
  ],
]

/** The same, of a sparse map's entry named by its stored name, `buckets#<key>`. */
const refusedEntries: ReadonlyArray<readonly [operation: string, apply: (update: any) => any]> = [
  [
    "update.pathSet",
    (update) => update.pathSet({ segments: ["buckets#a", "n"], value: -1, isPath: false }),
  ],
  [
    "update.pathSet",
    (update) => update.pathSet({ segments: ["buckets#a"], value: { n: -1 }, isPath: false }),
  ],
  [
    "update.pathIfNotExists",
    (update) => update.pathIfNotExists({ segments: ["buckets#c"], value: { n: -1 } }),
  ],
]

const run = (
  operation: string,
  send: (db: any) => Effect.Effect<unknown, unknown, any>,
  options?: {
    readonly failReads?: boolean
    readonly retain?: boolean
    /** What the refusal's cause says. */
    readonly says?: string
  },
) => {
  const { E, Main } = definitions(options?.retain ?? true)
  const table = makeRecordingTable()
  // Once the items are written, every read fails.
  const reads = { fail: false }
  const failing =
    <I, A, E>(command: string, read: (input: I) => Effect.Effect<A, E>) =>
    (input: I): Effect.Effect<A, E | DynamoError> => {
      if (!reads.fail) return read(input)
      table.requests.push({ command, input: input as Record<string, any> })
      return Effect.fail(new DynamoError({ operation: command, cause: new Error("read failed") }))
    }
  const client =
    options?.failReads === true
      ? Layer.succeed(DynamoClient, {
          ...table.client,
          getItem: failing("GetItem", table.client.getItem),
          transactGetItems: failing("TransactGetItems", table.client.transactGetItems),
        })
      : table.layer
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { E },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    for (const [id, n] of [
      ["a", 1],
      ["b", 2],
    ] as const) {
      yield* db.entities.E.put({
        id,
        list: [n],
        meta: { n },
        count: n,
        buckets: { a: { n } },
      }).asEffect()
    }
    table.take()
    reads.fail = options?.failReads === true
    const stored = structuredClone([...table.items])
    const exit = yield* Effect.exit(Effect.suspend(() => send(db)))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons[0]!._tag).toBe("Fail")
      const error = Cause.squash(exit.cause) as any
      expect(error._tag).toBe("ValidationError")
      expect(error.operation).toBe(operation)
      expect(String(error.cause)).toContain(options?.says ?? "greater than 0")
    }
    expect(table.requests).toEqual([])
    expect([...table.items]).toEqual(stored)
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(client)) as Effect.Effect<
    void,
    unknown
  >
}

describe("an update's operand its schema refuses fails the update before it reads anything", () => {
  for (const [operation, apply] of refusedEntries) {
    // An update alone wrote the value, then failed decoding the row it returned.
    it.effect(`${operation} of an entry, update of an entity that doesn't read first`, () =>
      run(operation, (db) => apply(db.entities.E.update({ id: "a" })).asEffect(), {
        retain: false,
      }),
    )
  }
  for (const [operation, apply] of [...refused, ...refusedEntries]) {
    for (const kind of ["update", "patch"] as const) {
      it.effect(`${operation}, ${kind}`, () =>
        run(operation, (db) => apply(db.entities.E[kind]({ id: "a" })).asEffect()),
      )
      it.effect(`${operation}, ${kind}, with every read failing`, () =>
        run(operation, (db) => apply(db.entities.E[kind]({ id: "a" })).asEffect(), {
          failReads: true,
        }),
      )
      for (const first of [false, true]) {
        it.effect(
          `${operation}, ${kind} in Transaction.transactWrite, ${first ? "before" : "after"} another update`,
          () =>
            run(operation, (db) => {
              const bad = apply(db.entities.E[kind]({ id: "a" }))
              const good = db.entities.E.update({ id: "b" }).append({ list: [3] })
              return Transaction.transactWrite((first ? [bad, good] : [good, bad]) as never)
            }),
        )
      }
    }
  }
})

describe("a value for a sparse map's entry is written as the schema the reader decodes it with takes it", () => {
  for (const retain of [false, true]) {
    it.effect(`pathSet of an entry's field, ${retain ? "a retained" : "an"} entity`, () => {
      const { E, Main } = definitions(retain)
      const table = makeRecordingTable()
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { E },
          tables: { Main },
        } as never) as Effect.Effect<any, never, any>
        yield* db.entities.E.put({
          id: "a",
          list: [1],
          meta: { n: 1 },
          count: 1,
          buckets: { a: { n: 1 } },
        }).asEffect()
        table.take()
        const updated = yield* db.entities.E.update({ id: "a" })
          .pathSet({ segments: ["buckets#a", "n"], value: 5, isPath: false })
          .asEffect()
        expect(updated.buckets).toEqual({ a: { n: 5 } })
        const written = table.requests.find(
          (request) => request.command === (retain ? "TransactWriteItems" : "UpdateItem"),
        )!
        const update = retain
          ? written.input.TransactItems.find((item: any) => item.Update !== undefined).Update
          : written.input
        expect(update.UpdateExpression).toContain("#ps0.#ps1 = :ps2")
        expect(update.ExpressionAttributeNames["#ps0"]).toBe("buckets#a")
        expect(update.ExpressionAttributeNames["#ps1"]).toBe("n")
        expect(update.ExpressionAttributeValues[":ps2"]).toEqual({ N: "5" })
      }).pipe(
        Effect.provide(Main.layer({ name: "t" })),
        Effect.provide(table.layer),
      ) as Effect.Effect<void, unknown>
    })
  }
})

describe("a value for an entry's field is encoded as put encodes it", () => {
  const E = Entity.make({
    model: DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        visits: Schema.Record(Schema.String, Schema.Struct({ at: Schema.Date })),
      }),
      { visits: { storedAs: DynamoModel.SparseMap() } },
    ),
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never) as any
  const Main = Table.make({
    schema: DynamoSchema.make({ name: "operands", version: 1 }),
    entities: { E },
  } as never) as any

  // It was written as given: a `Date` was stored as an empty map, and the update failed decoding
  // the row it returned.
  for (const [given, value] of [
    ["a Date", new Date(1000)],
    ["its stored form", "1970-01-01T00:00:01.000Z"],
  ] as const) {
    it.effect(`pathSet of ${given}`, () => {
      const table = makeRecordingTable()
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { E },
          tables: { Main },
        } as never) as Effect.Effect<any, never, any>
        yield* db.entities.E.put({ id: "a", visits: { home: { at: new Date(0) } } }).asEffect()
        table.take()
        const updated = yield* db.entities.E.update({ id: "a" })
          .pathSet({ segments: ["visits#home", "at"], value, isPath: false })
          .asEffect()
        expect(updated.visits).toEqual({ home: { at: new Date(1000) } })
        const update = table.requests.find((request) => request.command === "UpdateItem")!
        expect(update.input.ExpressionAttributeValues[":ps2"]).toEqual({
          S: "1970-01-01T00:00:01.000Z",
        })
      }).pipe(
        Effect.provide(Main.layer({ name: "t" })),
        Effect.provide(table.layer),
      ) as Effect.Effect<void, unknown>
    })
  }
})

describe("a transaction refuses an op's condition before any op reads", () => {
  /**
   * Each op whose condition holds a value DynamoDB can't store, or a part that can't be empty, of a
   * retained entity unless `retain` is false. A transaction plans every update, and a retained
   * entity's delete; it refused a put's and an unplanned delete's condition before reading already.
   */
  const conditioned: ReadonlyArray<
    readonly [name: string, op: (db: any) => unknown, retain?: boolean]
  > = [
    [
      "a planned update",
      (db) => db.entities.E.update({ id: "a" }).set({ count: 3 }).condition({ count: Number.NaN }),
    ],
    [
      "a planned patch",
      (db) => db.entities.E.patch({ id: "a" }).set({ count: 3 }).condition({ count: Number.NaN }),
    ],
    [
      "a planned delete",
      (db) => db.entities.E.delete({ id: "a" }).condition({ count: Number.NaN }),
    ],
    [
      "a planned delete under or() of nothing",
      (db) => db.entities.E.delete({ id: "a" }).condition((_: any, { or }: any) => or()),
    ],
    [
      "a put",
      (db) =>
        db.entities.E.put({
          id: "a",
          list: [1],
          meta: { n: 1 },
          count: 1,
          buckets: {},
        }).condition({ count: Number.NaN }),
    ],
    [
      "a put of an entity that doesn't retain",
      (db) =>
        db.entities.E.put({
          id: "a",
          list: [1],
          meta: { n: 1 },
          count: 1,
          buckets: {},
        }).condition({ count: Number.NaN }),
      false,
    ],
    [
      "a delete of an entity that doesn't retain",
      (db) => db.entities.E.delete({ id: "a" }).condition({ count: Number.NaN }),
      false,
    ],
  ]
  for (const [name, op, retain] of conditioned) {
    for (const first of [false, true]) {
      it.effect(`${name}, ${first ? "before" : "after"} an update that reads`, () =>
        run(
          "transactWrite.condition",
          (db) => {
            const bad = op(db)
            const good = db.entities.E.update({ id: "b" }).append({ list: [3] })
            return Transaction.transactWrite((first ? [bad, good] : [good, bad]) as never)
          },
          { says: "Nothing was sent.", retain: retain ?? true },
        ),
      )
    }
  }

  it.effect("Transaction.check of an empty condition, after an update that reads", () =>
    run(
      "transactWrite.check",
      (db) =>
        Transaction.transactWrite([
          db.entities.E.update({ id: "b" }).append({ list: [3] }),
          Transaction.check(db.entities.E.get({ id: "a" }), Expression.condition({})),
        ] as never),
      { says: "Transaction.check() was given an empty condition" },
    ),
  )

  it("Transaction.check of a value DynamoDB can't store: building the condition throws", () => {
    expect(() => Expression.condition({ eq: { count: Number.NaN } } as never)).toThrow(
      "Special numeric value NaN is not allowed",
    )
  })
})
