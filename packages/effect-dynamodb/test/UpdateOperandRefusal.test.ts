/**
 * An update's operand its write schema refuses at its path — of `.append()`, `pathSet`,
 * `pathAppend`, `pathPrepend` or `pathIfNotExists` — refuses the update before it reads or sends
 * anything. The decision was made only when the write was built, so an update that reads first (a
 * retained entity's, every planned update of a transaction) read before it was refused, and a
 * failed read reported a `DynamoError` in place of the `ValidationError`.
 *
 * So an update refused for a second reason now reports the operand, where 1.39.0 reported whichever
 * it met first as it read and built the write: the last tests here pin each.
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const Positive = Schema.Number.check(Schema.isGreaterThan(0))

const definitions = () => {
  const schema = DynamoSchema.make({ name: "operands", version: 1 })
  const E = Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      list: Schema.Array(Positive),
      meta: Schema.Struct({ n: Positive }),
    }),
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    versioned: { retain: true },
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

const run = (
  operation: string,
  send: (db: any) => Effect.Effect<unknown, unknown, any>,
  options?: { readonly failReads?: boolean },
) => {
  const { E, Main } = definitions()
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
    yield* db.entities.E.put({ id: "a", list: [1], meta: { n: 1 } }).asEffect()
    yield* db.entities.E.put({ id: "b", list: [2], meta: { n: 2 } }).asEffect()
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
      expect(String(error.cause)).toContain("greater than 0")
    }
    expect(table.requests).toEqual([])
    expect([...table.items]).toEqual(stored)
  }).pipe(Effect.provide(Main.layer({ name: "t" })), Effect.provide(client)) as Effect.Effect<
    void,
    unknown
  >
}

describe("an update's operand its schema refuses fails the update before it reads anything", () => {
  for (const [operation, apply] of refused) {
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

describe("an update refused for another reason too reports the operand, with nothing sent", () => {
  class Team extends Schema.Class<Team>("OperandRefusalTeam")({
    id: Schema.String.pipe(DynamoModel.identifier),
    name: Schema.String,
  }) {}
  const key = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }
  const Teams = Entity.make({ model: Team, entityType: "Team", primaryKey: key } as never) as any
  const E = Entity.make({
    model: DynamoModel.configure(
      Schema.Struct({
        id: Schema.String,
        owner: Schema.String,
        team: Team.pipe(DynamoModel.ref),
        meta: Schema.Struct({ n: Positive }),
      }),
      { owner: { immutable: true } },
    ),
    entityType: "E",
    primaryKey: key,
    versioned: { retain: true },
    refs: { team: { entity: Teams } },
  } as never) as any
  const Main = Table.make({
    schema: DynamoSchema.make({ name: "operands", version: 1 }),
    entities: { E, Teams },
  } as never) as any
  const refusedOperand = (update: any) =>
    update.pathSet({ segments: ["meta", "n"], value: -1, isPath: false })

  // What 1.39.0 reported, each after a `GetItem`: the read's verdict, or the refusal it met first
  // as it built the write.
  const others: ReadonlyArray<readonly [name: string, was: string, update: (db: any) => any]> = [
    ["an item that isn't there", "ItemNotFound", (db) => db.entities.E.update({ id: "missing" })],
    [
      "a version the row isn't at",
      "OptimisticLockError",
      (db) => db.entities.E.update({ id: "a" }).expectedVersion(9),
    ],
    [
      "an immutable field restated with another value",
      "ValidationError (update), is immutable",
      (db) => db.entities.E.update({ id: "a" }).set({ owner: "another" }),
    ],
    [
      "a ref whose target isn't there",
      "RefNotFound",
      (db) => db.entities.E.update({ id: "a" }).set({ teamId: "missing" }),
    ],
  ]
  for (const [name, was, update] of others) {
    for (const transaction of [false, true]) {
      it.effect(`${name} (1.39.0: ${was}), ${transaction ? "in a transaction" : "alone"}`, () => {
        const table = makeRecordingTable()
        return Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { E, Teams },
            tables: { Main },
          } as never) as Effect.Effect<any, never, any>
          yield* db.entities.Teams.put({ id: "t1", name: "T" }).asEffect()
          yield* db.entities.E.put({ id: "a", owner: "o", teamId: "t1", meta: { n: 1 } }).asEffect()
          table.take()
          const exit = yield* Effect.exit(
            Effect.suspend(() => {
              const op = refusedOperand(update(db))
              return transaction ? Transaction.transactWrite([op] as never) : op.asEffect()
            }),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const error = Cause.squash(exit.cause) as any
            expect(error._tag).toBe("ValidationError")
            expect(error.operation).toBe("update.pathSet")
          }
          expect(table.requests).toEqual([])
        }).pipe(
          Effect.provide(Main.layer({ name: "t" })),
          Effect.provide(table.layer),
        ) as Effect.Effect<void, unknown>
      })
    }
  }

  // An entity used unbound, with no compressor for its packed field: the `.set()` of a value
  // that needs the codec failed with `ValidationError` `update.packed` (`CompressorNotRegistered`),
  // after a `GetItem` on a retained entity.
  for (const retain of [false, true]) {
    it.effect(
      `a packed value with no compressor (1.39.0: ValidationError (update.packed)), ${retain ? "a retained" : "an"} entity`,
      () => {
        const Packed = Entity.make({
          model: DynamoModel.configure(
            Schema.Struct({
              id: Schema.String,
              details: Schema.optionalKey(Schema.Struct({ text: Schema.String })),
              meta: Schema.Struct({ n: Positive }),
            }),
            {
              details: {
                storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "gzip" } }),
              },
            },
          ),
          entityType: "Packed",
          primaryKey: key,
          ...(retain ? { versioned: { retain: true } } : {}),
        } as never) as any
        const PackedTable = Table.make({
          schema: DynamoSchema.make({ name: "operands", version: 1 }),
          entities: { Packed },
        } as never) as any
        const table = makeRecordingTable()
        return Effect.gen(function* () {
          yield* Packed.put({ id: "a", meta: { n: 1 } }).asEffect()
          table.take()
          const exit = yield* Effect.exit(
            Effect.suspend(() =>
              Entity.pathSet(
                Packed.update({ id: "a" }).pipe(
                  Entity.set({ details: { text: "x".repeat(4000) } }),
                ),
                { segments: ["meta", "n"], value: -1, isPath: false },
              ).asEffect(),
            ),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const error = Cause.squash(exit.cause) as any
            expect(error._tag).toBe("ValidationError")
            expect(error.operation).toBe("update.pathSet")
          }
          expect(table.requests).toEqual([])
        }).pipe(
          Effect.provide(PackedTable.layer({ name: "t" })),
          Effect.provide(table.layer),
        ) as Effect.Effect<void, unknown>
      },
    )
  }
})
