/**
 * Writes of a sparse map's entry that 1.39.0 stored and read back, against DynamoDB Local: every
 * case of `helpers/SparseEntryWrites.ts` (an entry under an attribute name over 255 bytes, an entry
 * named by its attribute under a key holding `#`, a field named as an entry and stored elsewhere)
 * is written and read back as `fixtures/sparse-entry-writes-1.39.0.json` records 1.39.0 read it.
 * `test/SparseEntries.test.ts` compares the requests.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Cause, Config, Effect, Exit, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"
import {
  counted,
  ENTRY_OPS,
  primaryKey as entryKey,
  KEYS,
  WORLDS,
} from "./helpers/SparseEntryOps.js"
import { cases, definitions, plain, type World } from "./helpers/SparseEntryWrites.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}
const describeConnected = dynamoAvailable ? describe : describe.skip

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const ClientLayer = Lib.DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/sparse-entry-writes-1.39.0.json", import.meta.url), "utf8"),
) as { readonly cases: Record<string, { readonly read: Record<string, unknown> }> }

let tables = 0
/** Runs `body` with a client bound to `world`'s entity on a table of its own. */
const onTable = <A>(world: World, body: (db: any) => Effect.Effect<A, unknown, any>) => {
  const { Docs, MainTable } = definitions(Lib as never, world)
  const tableName = `sparse-entries-${Date.now()}-${tables++}`
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* Lib.DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
      })
    }),
    () =>
      Effect.gen(function* () {
        const db: any = yield* Lib.DynamoClient.make({
          entities: { Docs },
          tables: { MainTable },
        } as never)
        return yield* body(db)
      }),
    () =>
      Effect.gen(function* () {
        const client = yield* Lib.DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(
      Layer.merge(ClientLayer, MainTable.layer({ name: tableName }) as Layer.Layer<never>),
    ),
  ) as Effect.Effect<A, unknown>
}

describeConnected("a write of a sparse map's entry that 1.39.0 stored, on DynamoDB Local", () => {
  for (const each of cases) {
    it.effect(`${each.key}: written, and read back as 1.39.0 read it`, () =>
      onTable(each.world, (db) =>
        Effect.gen(function* () {
          yield* db.entities.Docs.put({
            id: "a",
            data: { ok: 1 },
            ...(each.world === "renamed" ? { "data#x#y": 1 } : {}),
          }).asEffect()
          const exit = yield* Effect.exit(Effect.suspend(() => each.write(db, Lib as never)))
          expect(Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "written").toBe(
            "written",
          )
          const read = yield* db.entities.Docs.get({ id: "a" })
          expect(plain(read)).toEqual(fixture.cases[each.key]!.read)
        }),
      ),
    )
  }
})

describeConnected(
  "a retained entity's update of a row holding a field and an entry of one name",
  () => {
    // A field named `data#x` and stored as `counter`, beside the entry `x` of the sparse `data`.
    const Docs = Lib.Entity.make({
      model: Lib.DynamoModel.configure(
        Schema.Struct({
          id: Schema.String,
          note: Schema.String,
          data: Schema.Record(Schema.String, Schema.Number),
          "data#x": Schema.optionalKey(Schema.Number),
        }),
        { data: { storedAs: Lib.DynamoModel.SparseMap() }, "data#x": { field: "counter" } },
      ),
      entityType: "Doc",
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
      versioned: { retain: true },
    } as never) as any
    const MainTable = Lib.Table.make({
      schema: Lib.DynamoSchema.make({ name: "entries", version: 1 }),
      entities: { Docs },
    } as never) as any

    for (const transaction of [false, true]) {
      it.effect(
        `keeps both, and a record operation on an entry reaches it (${transaction ? "in a transaction" : "alone"})`,
        () => {
          const tableName = `sparse-entries-${Date.now()}-${tables++}`
          const send = (update: any) =>
            transaction ? Lib.Transaction.transactWrite([update]) : update.asEffect()
          return Effect.acquireUseRelease(
            Effect.gen(function* () {
              const client = yield* Lib.DynamoClient
              yield* client.createTable({
                TableName: tableName,
                BillingMode: "PAY_PER_REQUEST",
                KeySchema: [
                  { AttributeName: "pk", KeyType: "HASH" },
                  { AttributeName: "sk", KeyType: "RANGE" },
                ],
                AttributeDefinitions: [
                  { AttributeName: "pk", AttributeType: "S" },
                  { AttributeName: "sk", AttributeType: "S" },
                ],
              })
            }),
            () =>
              Effect.gen(function* () {
                const db: any = yield* Lib.DynamoClient.make({
                  entities: { Docs },
                  tables: { MainTable },
                } as never)
                const docs = db.entities.Docs
                yield* docs
                  .put({ id: "a", note: "ok", data: { safe: 1, x: 99 }, "data#x": 7 })
                  .asEffect()
                yield* send(docs.update({ id: "a" }).set({ note: "new" }))
                expect(yield* docs.get({ id: "a" })).toMatchObject({
                  note: "new",
                  data: { safe: 1, x: 99 },
                  "data#x": 7,
                })
                yield* send(docs.update({ id: "a" }).add({ "data#safe": 2 }))
                yield* send(docs.update({ id: "a" }).remove(["data#x"]))
                const read = yield* docs.get({ id: "a" })
                expect(read.data).toEqual({ safe: 3, x: 99 })
                expect(read["data#x"]).toBeUndefined()
              }),
            () =>
              Effect.gen(function* () {
                const client = yield* Lib.DynamoClient
                yield* client.deleteTable({ TableName: tableName })
              }).pipe(Effect.ignore),
          ).pipe(
            Effect.provide(
              Layer.merge(ClientLayer, MainTable.layer({ name: tableName }) as Layer.Layer<never>),
            ),
          ) as Effect.Effect<void, unknown>
        },
      )
    }
  },
)

describeConnected(
  "an entry operation reaches the entry, whatever its key is called, on DynamoDB Local",
  () => {
    // Every operation that changes one entry by its attribute's name, on a plain, a retained and a
    // unique entity, with the entry present and absent, under an ordinary key and under the names
    // every object inherits. The update that reads the row and writes it whole looked an entry up
    // on a plain object. One test per world and key, each sending 70 to 140 requests: all six keys
    // in one test were 435 to 849 requests, and went over the 30 s budget when other suites shared
    // DynamoDB Local and the machine (#243).
    const raw = new DynamoDBClient({ region: "us-east-1", endpoint: ENDPOINT, credentials })
    for (const world of WORLDS) {
      for (const key of KEYS) {
        it.effect(`on a ${world} entity, the entry \`${key}\``, () => {
          const Docs = Lib.Entity.make({
            entityType: "Doc",
            primaryKey: entryKey,
            model: counted(Lib as never),
            ...(world === "retain" ? { versioned: { retain: true } } : {}),
            ...(world === "unique" ? { unique: { note: ["note"] } } : {}),
          } as never) as any
          const MainTable = Lib.Table.make({
            schema: Lib.DynamoSchema.make({ name: "ops", version: 1 }),
            entities: { Docs },
          } as never) as any
          const tableName = `sparse-entry-ops-${Date.now()}-${tables++}`
          return Effect.acquireUseRelease(
            Effect.gen(function* () {
              const client = yield* Lib.DynamoClient
              yield* client.createTable({
                TableName: tableName,
                BillingMode: "PAY_PER_REQUEST",
                KeySchema: [
                  { AttributeName: "pk", KeyType: "HASH" },
                  { AttributeName: "sk", KeyType: "RANGE" },
                ],
                AttributeDefinitions: [
                  { AttributeName: "pk", AttributeType: "S" },
                  { AttributeName: "sk", AttributeType: "S" },
                ],
              })
            }),
            () =>
              Effect.gen(function* () {
                const db: any = yield* Lib.DynamoClient.make({
                  entities: { Docs },
                  tables: { MainTable },
                } as never)
                let n = 0
                for (const op of ENTRY_OPS) {
                  for (const present of [true, false]) {
                    const id = `a${n++}`
                    const attribute = `data#${key}`
                    const label = `${op.name} of ${attribute}, ${present ? "present" : "absent"}`
                    yield* db.entities.Docs.put({ id, note: `note-${id}`, data: {} }).asEffect()
                    if (present) {
                      yield* db.entities.Docs.update({ id })
                        .pathSet({ segments: [attribute], value: op.seedValue, isPath: false })
                        .asEffect()
                    }
                    const base = db.entities.Docs.update({ id })
                    const exit = yield* Effect.exit(
                      op
                        .apply(
                          world === "unique" && op.name.startsWith(".")
                            ? base.set({ note: `after-${id}` })
                            : base,
                          attribute,
                        )
                        .asEffect(),
                    )
                    const stored = yield* Effect.promise(() =>
                      raw.send(
                        new GetItemCommand({
                          TableName: tableName,
                          Key: { pk: { S: `$ops#v1#doc#id_${id}` }, sk: { S: "$ops#v1#doc" } },
                          ConsistentRead: true,
                        }),
                      ),
                    )
                    const held: any = stored.Item?.[attribute]
                    const entry = held?.SS !== undefined ? { SS: [...held.SS].sort() } : held
                    if (present || "absent" in op) {
                      expect(
                        Exit.isFailure(exit)
                          ? `${label}: ${String(Cause.squash(exit.cause))}`
                          : "ok",
                      ).toBe("ok")
                      expect([label, entry]).toEqual([label, present ? op.present : op.absent])
                    }
                    const read = yield* Effect.exit(db.entities.Docs.get({ id }))
                    expect(Exit.isSuccess(read) ? "read" : `${label}: not read back`).toBe("read")
                  }
                }
              }),
            () =>
              Effect.gen(function* () {
                const client = yield* Lib.DynamoClient
                yield* client.deleteTable({ TableName: tableName })
              }).pipe(Effect.ignore),
          ).pipe(
            Effect.provide(
              Layer.merge(ClientLayer, MainTable.layer({ name: tableName }) as Layer.Layer<never>),
            ),
          ) as Effect.Effect<void, unknown>
        })
      }
    }
  },
)
