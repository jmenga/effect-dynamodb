/**
 * A sparse map's entries, stored one attribute each as `<prefix>#<key>`, as its writer and its
 * reader take them (`internal/SparseKey.ts` in the schema package).
 *
 * - Every write of an entry runs the writer's one check (`validateSparseKey`): a non-empty key
 *   without `#`, and an attribute name of at most 255 bytes. That limit is the library's own:
 *   DynamoDB takes an attribute name of up to 64 KB, and 255 bytes only for an index key or an
 *   attribute an index projects by name. `put` ran it; an update's `.set()`, `upsert`, and an
 *   operation naming an entry by its stored name checked less, or nothing.
 * - Everything that decides which stored attributes are entries asks the reader (`sparseReader`:
 *   `<prefix>#` and a non-empty key). `clearMap` removed any attribute starting `<prefix>#`, so
 *   `<prefix>#` itself too, which the reader never reads as an entry; `removeEntries` refused a key
 *   holding `#`, which the reader reads.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const schema = DynamoSchema.make({ name: "entries", version: 1 })
const model = DynamoModel.configure(
  Schema.Struct({ id: Schema.String, data: Schema.Record(Schema.String, Schema.Number) }),
  { data: { storedAs: DynamoModel.SparseMap() } },
)
const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
}

const world = (retain: boolean) => {
  const Docs = Entity.make({
    model,
    entityType: "Doc",
    primaryKey,
    ...(retain ? { versioned: { retain: true } } : {}),
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Docs } } as never) as any
  return { Docs, MainTable }
}

const run = <A>(
  retain: boolean,
  body: (db: any, table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, unknown, any>,
) => {
  const { Docs, MainTable } = world(retain)
  const table = makeRecordingTable()
  return Effect.gen(function* () {
    const db: any = yield* DynamoClient.make({ entities: { Docs }, tables: { MainTable } } as never)
    return yield* body(db, table)
  }).pipe(
    Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "entries" }))),
  ) as Effect.Effect<A, unknown>
}

/** `data#` and 250 characters: 255 bytes, the most the writer takes. */
const LONGEST = "k".repeat(250)
/** One byte more. */
const TOO_LONG = "k".repeat(251)

/** Each write of an entry, under the key `key`, of the row `a` (which exists). */
const WRITERS: ReadonlyArray<
  readonly [name: string, retain: boolean, write: (db: any, key: string) => any]
> = [
  ["put", false, (db, key) => db.entities.Docs.put({ id: "a", data: { [key]: 1 } }).asEffect()],
  [
    "Transaction.transactWrite of a put",
    false,
    (db, key) => Transaction.transactWrite([db.entities.Docs.put({ id: "a", data: { [key]: 1 } })]),
  ],
  [
    "update .set()",
    false,
    (db, key) =>
      db.entities.Docs.update({ id: "a" })
        .set({ data: { [key]: 1 } })
        .asEffect(),
  ],
  [
    "update .set() of a retained entity",
    true,
    (db, key) =>
      db.entities.Docs.update({ id: "a" })
        .set({ data: { [key]: 1 } })
        .asEffect(),
  ],
  [
    "put of a retained entity",
    true,
    (db, key) => db.entities.Docs.put({ id: "a", data: { [key]: 1 } }).asEffect(),
  ],
  [
    "Transaction.transactWrite of an update .set()",
    false,
    (db, key) =>
      Transaction.transactWrite([db.entities.Docs.update({ id: "a" }).set({ data: { [key]: 1 } })]),
  ],
  [
    "upsert",
    false,
    (db, key) => db.entities.Docs.upsert({ id: "a", data: { [key]: 1 } }).asEffect(),
  ],
  [
    "upsert of a retained entity",
    true,
    (db, key) => db.entities.Docs.upsert({ id: "a", data: { [key]: 1 } }).asEffect(),
  ],
  [
    "pathSet of the entry's attribute",
    false,
    (db, key) =>
      db.entities.Docs.update({ id: "a" })
        .pathSet({ segments: [`data#${key}`], value: 1 })
        .asEffect(),
  ],
  [
    "pathAdd of the entry's attribute",
    false,
    (db, key) =>
      db.entities.Docs.update({ id: "a" })
        .pathAdd({ segments: [`data#${key}`], value: 1 })
        .asEffect(),
  ],
  [
    ".add() of the entry's attribute",
    false,
    (db, key) =>
      db.entities.Docs.update({ id: "a" })
        .add({ [`data#${key}`]: 1 })
        .asEffect(),
  ],
]

describe("every write of a sparse map's entry runs the writer's check", () => {
  for (const [name, retain, write] of WRITERS) {
    for (const [refused, key] of [
      ["a key holding '#'", "a#b"],
      ["an attribute name over 255 bytes", TOO_LONG],
    ] as const) {
      it.effect(`${name}: ${refused} is refused, sending nothing`, () =>
        run(retain, (db, table) =>
          Effect.gen(function* () {
            yield* db.entities.Docs.put({ id: "a", data: { ok: 1 } }).asEffect()
            table.take()
            const stored = structuredClone([...table.items])
            const exit = yield* Effect.exit(Effect.suspend(() => write(db, key)))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(exit.cause.reasons[0]!._tag).toBe("Fail")
              expect((Cause.squash(exit.cause) as any)._tag).toBe("ValidationError")
            }
            expect(table.requests).toEqual([])
            expect([...table.items]).toEqual(stored)
          }),
        ),
      )
    }

    it.effect(`${name}: an attribute name of 255 bytes is written and read back`, () =>
      run(retain, (db) =>
        Effect.gen(function* () {
          yield* db.entities.Docs.put({ id: "a", data: { ok: 1 } }).asEffect()
          yield* write(db, LONGEST)
          const read = yield* db.entities.Docs.get({ id: "a" })
          expect(read.data[LONGEST]).toBeGreaterThanOrEqual(1)
        }),
      ),
    )
  }
})

describe("a write that reads a ref first refuses the entry key before the read", () => {
  class Owner extends Schema.Class<Owner>("Owner")({
    id: Schema.String.pipe(DynamoModel.identifier),
    name: Schema.String,
  }) {}
  const Owners = Entity.make({ model: Owner, entityType: "Owner", primaryKey } as never) as any
  const Docs = Entity.make({
    model: DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        owner: Owner.pipe(DynamoModel.ref),
        data: Schema.Record(Schema.String, Schema.Number),
      }),
      { data: { storedAs: DynamoModel.SparseMap() } },
    ),
    entityType: "Doc",
    primaryKey,
    refs: { owner: { entity: Owners } },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Owners, Docs } } as never) as any
  const WRITES: ReadonlyArray<readonly [name: string, write: (db: any) => any]> = [
    ["put", (db) => db.entities.Docs.put({ id: "a", ownerId: "o", data: { "a#b": 1 } }).asEffect()],
    [
      "update .set()",
      (db) =>
        db.entities.Docs.update({ id: "a" })
          .set({ ownerId: "o", data: { "a#b": 1 } })
          .asEffect(),
    ],
    [
      "upsert",
      (db) => db.entities.Docs.upsert({ id: "a", ownerId: "o", data: { "a#b": 1 } }).asEffect(),
    ],
  ]
  for (const [name, write] of WRITES) {
    it.effect(`${name}: refused, sending nothing`, () => {
      const table = makeRecordingTable()
      return Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: { Owners, Docs },
          tables: { MainTable },
        } as never)
        yield* db.entities.Owners.put({ id: "o", name: "Owner" }).asEffect()
        yield* db.entities.Docs.put({ id: "a", ownerId: "o", data: { ok: 1 } }).asEffect()
        table.take()
        const error: any = yield* Effect.flip(Effect.suspend(() => write(db)))
        expect(error._tag).toBe("ValidationError")
        expect(error.operation).toMatch(/\.sparse$/)
        expect(table.requests).toEqual([])
      }).pipe(
        Effect.provide(Layer.merge(table.layer, MainTable.layer({ name: "entries" }))),
      ) as never
    })
  }
})

describe("which attributes are a sparse map's entries is the reader's to say", () => {
  /** The row `a`, with entries the reader reads under `#` and `x#y`, and `data#`, which it doesn't. */
  const seeded = (db: any, table: ReturnType<typeof makeRecordingTable>) =>
    Effect.gen(function* () {
      yield* db.entities.Docs.put({ id: "a", data: { ok: 1 } }).asEffect()
      const [key, row] = [...table.items][0] as [string, Record<string, any>]
      table.items.set(key, {
        ...row,
        "data##": { N: "2" },
        "data#x#y": { N: "3" },
        "data#": { S: "not an entry" },
      })
      table.take()
      return key
    })

  it.effect("a get reads `data##` and `data#x#y` as entries, and not `data#`", () =>
    run(false, (db, table) =>
      Effect.gen(function* () {
        yield* seeded(db, table)
        expect(yield* db.entities.Docs.get({ id: "a" })).toEqual({
          id: "a",
          data: { ok: 1, "#": 2, "x#y": 3 },
        })
      }),
    ),
  )

  it.effect("clearMap removes exactly the entries the reader reads", () =>
    run(false, (db, table) =>
      Effect.gen(function* () {
        const key = yield* seeded(db, table)
        yield* db.entities.Docs.update({ id: "a" }).clearMap("data").asEffect()
        const update = table.requests.find((request) => request.command === "UpdateItem")!
        const removed = /REMOVE (.*)$/
          .exec(update.input.UpdateExpression)![1]!
          .split(", ")
          .map((name) => update.input.ExpressionAttributeNames[name])
        expect(removed.sort()).toEqual(["data##", "data#ok", "data#x#y"])
        expect(table.items.get(key)!["data#"]).toEqual({ S: "not an entry" })
        expect(yield* db.entities.Docs.get({ id: "a" })).toEqual({ id: "a", data: {} })
      }),
    ),
  )

  it.effect("removeEntries removes an entry the reader reads under a key holding '#'", () =>
    run(false, (db, table) =>
      Effect.gen(function* () {
        yield* seeded(db, table)
        yield* db.entities.Docs.update({ id: "a" }).removeEntries("data", ["x#y"]).asEffect()
        expect(yield* db.entities.Docs.get({ id: "a" })).toEqual({
          id: "a",
          data: { ok: 1, "#": 2 },
        })
      }),
    ),
  )

  it.effect("removeEntries refuses the empty key, which names `data#`, sending nothing", () =>
    run(false, (db, table) =>
      Effect.gen(function* () {
        yield* seeded(db, table)
        const error: any = yield* Effect.flip(
          db.entities.Docs.update({ id: "a" }).removeEntries("data", [""]).asEffect(),
        )
        expect(error._tag).toBe("ValidationError")
        expect(error.operation).toBe("update.removeEntries")
        expect(table.requests).toEqual([])
      }),
    ),
  )
})
