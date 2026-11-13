/**
 * A transaction's update of a sparse map a `field:` rename stores whole (`counts`, configured
 * `{ storedAs: SparseMap(), field: "sr" }`), racing a writer that changes the form the row holds the
 * map in between the plan's read and its write (#238).
 *
 * The plan reads the row and writes the entries where it holds the map: inside `sr` on a row holding
 * it (`SET sr.b`, `ADD sr.b`), as `counts#b` otherwise, guarded on the row still holding it that way
 * (`attribute_exists(sr)` / `attribute_not_exists(sr)`). Here, as the transaction is sent, the row
 * moves from `sr` to its entries or back. The guard refuses the write, the stored row returned is not
 * the one the plan read, so the plan is made again from a fresh read, and the second transaction
 * writes where the row now holds the map. Without the guard the first write lands: into `sr` on a row
 * that no longer holds it, which DynamoDB rejects, or as `counts#b` beside an `sr` a read takes in
 * its place, which reports success and loses the entry.
 *
 * A retained entity's `.set()` of the map isn't among them: it writes the map whole as it read it
 * (`SET sr = :whole`, removing the entries it read), as 1.40.0 did, under the version and incarnation
 * guard every write to a retained row moves.
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { expect } from "vitest"
import { DynamoClient, type DynamoClientService } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import { createPathBuilder } from "../../src/internal/PathBuilder.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { type OpenTable, onTable } from "./Kept139.js"

const primaryKey = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }

const definitions = () => {
  const model = DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      email: Schema.String,
      counts: Schema.Record(Schema.String, Schema.Number),
      note: Schema.optionalKey(Schema.String),
    }),
    { counts: { storedAs: DynamoModel.SparseMap(), field: "sr" } } as never,
  )
  return {
    Plain: Entity.make({ model, entityType: "Plain", primaryKey } as never),
    Versioned: Entity.make({
      model,
      entityType: "Versioned",
      primaryKey,
      versioned: true,
    } as never),
    Retained: Entity.make({
      model,
      entityType: "Retained",
      primaryKey,
      versioned: { retain: true },
    } as never),
    Unique: Entity.make({
      model,
      entityType: "Unique",
      primaryKey,
      unique: { byEmail: ["email"] },
    } as never),
  } as Record<string, any>
}

const keyOf = (entity: string) => ({
  pk: { S: `$rr#v1#${entity.toLowerCase()}#id_a` },
  sk: { S: `$rr#v1#${entity.toLowerCase()}` },
})

/** The row's map moved from `sr` to its entries, or from its entries to `sr`. */
const reform = (raw: DynamoClientService, tableName: string, entity: string, to: string) =>
  raw.updateItem({
    TableName: tableName,
    Key: keyOf(entity),
    UpdateExpression: to === "entries" ? "SET #e = :one REMOVE #w" : "SET #w = :whole REMOVE #e",
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeNames: { "#e": "counts#a", "#w": "sr" },
    ExpressionAttributeValues:
      to === "entries" ? { ":one": { N: "1" } } : { ":whole": { M: { a: { N: "1" } } } },
  })

/**
 * `open`'s table, whose client runs `race` once, just before the first `transactWriteItems` sent
 * while `armed.on` is set, and logs the name of every operation sent while it is.
 */
const racing =
  (
    open: OpenTable,
    armed: { on: boolean },
    log: Array<string>,
    race: (raw: DynamoClientService, tableName: string) => Effect.Effect<unknown, unknown>,
  ): OpenTable =>
  (MainTable) =>
    Effect.map(open(MainTable), (table) => ({
      ...table,
      layer: Layer.effect(
        DynamoClient,
        Effect.gen(function* () {
          const client = yield* DynamoClient
          let raced = false
          return Object.fromEntries(
            Object.entries(client).map(([name, operation]) => [
              name,
              typeof operation === "function"
                ? (input: unknown) =>
                    Effect.suspend(() => {
                      if (!armed.on) return operation.call(client, input)
                      log.push(name)
                      const sent = operation.call(client, input)
                      if (name !== "transactWriteItems" || raced) return sent
                      raced = true
                      return Effect.andThen(Effect.orDie(race(client, table.name)), sent)
                    })
                : operation,
            ]),
          ) as unknown as DynamoClientService
        }),
      ).pipe(Layer.provide(table.layer)),
    }))

const entryOf = (key: string) =>
  (createPathBuilder([], undefined, { counts: { prefix: "counts" } }) as any).counts.entry(key)
    .segments as ReadonlyArray<string>

/** Each update writing the entry `b` = 2 where the row holds the map. */
const writes: ReadonlyArray<readonly [label: string, op: (u: any) => any]> = [
  [".set({ counts: { b: 2 } })", (u) => u.set({ counts: { b: 2 } })],
  ["pathAdd of counts.entry('b'), 2", (u) => u.pathAdd({ segments: entryOf("b"), value: 2 })],
]

export const renamedSparseMapRacesSuite = (open: OpenTable) => {
  // A condition the library can't judge from the row (`size()` of text beyond ASCII), which the
  // table finds false, on a write whose row moves the map once: the refusal can't be told from
  // the race's, so the plan is made again and the caller's error comes from the second
  // transaction, in four requests where 1.40.0 took two (named in the changeset and DESIGN.md).
  it.effect(
    "Plain: a transaction's .set({ counts: { b: 2 } }) under a size() condition the table finds false, sent as the row moves the map: planned again, then the caller's error",
    () =>
      Effect.gen(function* () {
        const entities = definitions()
        const MainTable = Table.make({
          schema: DynamoSchema.make({ name: "rr", version: 1 }),
          entities,
        } as never)
        const armed = { on: false }
        const log: Array<string> = []
        const race = (raw: DynamoClientService, tableName: string) =>
          reform(raw, tableName, "Plain", "entries")
        const got = yield* onTable(
          racing(open, armed, log, race),
          0,
          MainTable,
          { entities },
          (db) =>
            Effect.gen(function* () {
              yield* db.entities.Plain.put({
                id: "a",
                email: "a@x",
                counts: { a: 1 },
                note: "é",
              }).asEffect()
              armed.on = true
              const exit = yield* Effect.exit(
                Transaction.transactWrite([
                  db.entities.Plain.update({ id: "a" })
                    .set({ counts: { b: 2 } })
                    .condition((t: any, { eq }: any) => eq(t.note.size(), 2)),
                ]),
              )
              armed.on = false
              const read = yield* db.entities.Plain.get({ id: "a" })
              return { exit, read }
            }),
        )
        expect(got.exit._tag).toBe("Failure")
        if (got.exit._tag === "Failure") {
          expect(String(got.exit.cause)).toContain("TransactionCancelled")
        }
        expect(log).toEqual(["getItem", "transactWriteItems", "getItem", "transactWriteItems"])
        expect(got.read.counts).toEqual({ a: 1 })
      }),
  )
  for (const entity of ["Plain", "Versioned", "Retained", "Unique"]) {
    for (const [label, op] of writes) {
      if (entity === "Retained" && label.startsWith(".set")) continue
      for (const [from, to] of [
        ["whole", "entries"],
        ["entries", "whole"],
      ] as const) {
        it.effect(
          `${entity}: a transaction's ${label} planned on the map ${from}, sent as the row moves it to ${to}: planned again, and written ${to === "whole" ? "into sr" : "as counts#b"}`,
          () =>
            Effect.gen(function* () {
              const entities = definitions()
              const MainTable = Table.make({
                schema: DynamoSchema.make({ name: "rr", version: 1 }),
                entities,
              } as never)
              const armed = { on: false }
              const log: Array<string> = []
              const race = (raw: DynamoClientService, tableName: string) =>
                reform(raw, tableName, entity, to)
              const got = yield* onTable(
                racing(open, armed, log, race),
                0,
                MainTable,
                { entities },
                (db, table) =>
                  Effect.gen(function* () {
                    yield* db.entities[entity]
                      .put({ id: "a", email: "a@x", counts: { a: 1 } })
                      .asEffect()
                    const raw = yield* DynamoClient
                    if (from === "entries") yield* reform(raw, table.name, entity, "entries")
                    armed.on = true
                    const exit = yield* Effect.exit(
                      Transaction.transactWrite([op(db.entities[entity].update({ id: "a" }))]),
                    )
                    armed.on = false
                    const read = yield* db.entities[entity].get({ id: "a" })
                    const rows = yield* table.rows
                    const live = rows.find((row) => row.sk?.S === keyOf(entity).sk.S)!
                    return { exit, read, live }
                  }),
              )
              expect(got.exit._tag).toBe("Success")
              expect(got.read.counts).toEqual({ a: 1, b: 2 })
              // The first transaction refused, the plan made again from a fresh read.
              expect(log.filter((name) => name === "transactWriteItems")).toHaveLength(2)
              const entries = Object.keys(got.live)
                .filter((name) => name.startsWith("counts#"))
                .sort()
              if (to === "whole") {
                expect(got.live.sr).toEqual({ M: { a: { N: "1" }, b: { N: "2" } } })
                expect(entries).toEqual([])
              } else {
                expect(got.live.sr).toBeUndefined()
                expect(entries).toEqual(["counts#a", "counts#b"])
                expect(got.live["counts#b"]).toEqual({ N: "2" })
              }
            }),
        )
      }
    }
  }
}
