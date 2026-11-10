/**
 * DynamoDB refuses a request whose body is over 16 MB; on DynamoDB Local, 16,777,216 bytes is
 * accepted and 16,777,217 refused (HTTP 413), whatever the operation. 25 items within 400 KB can
 * pass it as the JSON sent, where a control character is 6 bytes and 1 in the item. `Batch.write`
 * splits its own requests at it: here at the exact boundary, through a proxy that sees each request
 * DynamoDB Local is sent. A caller's own transaction over it is sent, refused, and named.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Config, Effect, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Batch from "../src/Batch.js"
import * as ConsumedCapacity from "../src/ConsumedCapacity.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { REQUEST_MAX_BYTES } from "../src/internal/ItemSize.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { type LocalServer, localServer } from "./helpers/LocalServer.js"

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

const schema = DynamoSchema.make({ name: "wire", version: 1 })

class Note extends Schema.Class<Note>("Note")({ noteId: Schema.String, body: Schema.String }) {}

const Notes = Entity.make({
  model: Note,
  entityType: "Note",
  primaryKey: { pk: { field: "pk", composite: ["noteId"] }, sk: { field: "sk", composite: [] } },
})

const VersionedNotes = Entity.make({
  model: Note,
  entityType: "VersionedNote",
  primaryKey: { pk: { field: "pk", composite: ["noteId"] }, sk: { field: "sk", composite: [] } },
  versioned: true,
})

const MainTable = Table.make({ schema, entities: { Notes, VersionedNotes } })

let tables = 0

/** A fresh table on DynamoDB Local, and a proxy in front of it that records every request. */
const scenario = <A, E>(
  body: (
    proxy: LocalServer,
    tableName: string,
  ) => Effect.Effect<A, E, DynamoClient | Table.TableConfig>,
  capacity: Layer.Layer<never> = Layer.empty,
) =>
  Effect.gen(function* () {
    const tableName = `wire-${Date.now()}-${tables++}`
    const direct = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })
    yield* Effect.gen(function* () {
      const client = yield* DynamoClient
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
    }).pipe(Effect.provide(direct))
    const drop = Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.deleteTable({ TableName: tableName })
    }).pipe(Effect.provide(direct), Effect.ignore)
    const proxy = yield* localServer(undefined, { upstream: ENDPOINT })
    return yield* body(proxy, tableName).pipe(
      Effect.provide(
        Layer.mergeAll(
          DynamoClient.layer({ region: "us-east-1", endpoint: proxy.endpoint, credentials }),
          MainTable.layer({ name: tableName }),
          capacity,
        ),
      ),
      Effect.ensuring(drop),
    )
  }).pipe(Effect.scoped)

const id = (prefix: string, i: number) => `${prefix}${String(i).padStart(3, "0")}`
const nul = (chars: number) => "\u0000".repeat(chars)

/** The bodies DynamoDB Local was sent for `operation`, in bytes, and what it answered. */
const sent = (proxy: LocalServer, operation: string) =>
  proxy.of(operation).map((request) => Buffer.byteLength(request.body, "utf8"))

/** How many items the table holds. */
const count = (tableName: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    let items = 0
    let start: Record<string, any> | undefined
    do {
      const page = yield* client.scan({
        TableName: tableName,
        Select: "COUNT",
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })
      items += page.Count ?? 0
      start = page.LastEvaluatedKey
    } while (start !== undefined)
    return items
  })

/**
 * `size` writes whose one request is `REQUEST_MAX_BYTES + extra` bytes as sent: measured from a
 * probe request DynamoDB Local was actually sent, NULs (6 bytes each) bringing it close and ASCII
 * (1 byte each) the rest. The probe's ids differ from the written ones only in their prefix.
 */
const atBoundary = (
  proxy: LocalServer,
  operation: string,
  size: number,
  make: (noteId: string, body: string) => Parameters<typeof Batch.write>[0][number],
  extra: number,
) =>
  Effect.gen(function* () {
    const writes = (prefix: string, chars: number, pad: number) =>
      Array.from({ length: size }, (_, i) =>
        make(id(prefix, i), nul(chars) + (i === 0 ? "a".repeat(pad) : "")),
      )
    yield* Batch.write(writes("p", 0, 0))
    const empty = sent(proxy, operation)[0]!
    const chars = Math.floor((REQUEST_MAX_BYTES - empty) / (6 * size))
    const before = proxy.of(operation).length
    yield* Batch.write(writes("n", chars, REQUEST_MAX_BYTES - empty - 6 * size * chars + extra))
    return sent(proxy, operation).slice(before)
  })

describeConnected("Batch.write at DynamoDB's 16 MB request limit", () => {
  const CAPACITY = [
    ["capacity reporting off", Layer.empty],
    ["capacity reporting on", ConsumedCapacity.layer()],
  ] as const

  describe.each(CAPACITY)("%s", (_label, capacity) => {
    it.effect("a BatchWriteItem of exactly 16,777,216 bytes is one request DynamoDB accepts", () =>
      scenario(
        (proxy, tableName) =>
          Effect.gen(function* () {
            const bodies = yield* atBoundary(
              proxy,
              "BatchWriteItem",
              25,
              (noteId, body) => Notes.put({ noteId, body }),
              0,
            )
            expect(bodies).toEqual([REQUEST_MAX_BYTES])
            expect(yield* count(tableName)).toBe(50)
          }),
        capacity,
      ),
    )

    it.effect("one byte more is two requests, both accepted", () =>
      scenario(
        (proxy, tableName) =>
          Effect.gen(function* () {
            const bodies = yield* atBoundary(
              proxy,
              "BatchWriteItem",
              25,
              (noteId, body) => Notes.put({ noteId, body }),
              1,
            )
            expect(bodies.length).toBe(2)
            for (const body of bodies) expect(body).toBeLessThanOrEqual(REQUEST_MAX_BYTES)
            expect(yield* count(tableName)).toBe(50)
          }),
        capacity,
      ),
    )
  })

  it.effect("a versioned transaction of exactly 16,777,216 bytes is one DynamoDB accepts", () =>
    scenario((proxy, tableName) =>
      Effect.gen(function* () {
        const bodies = yield* atBoundary(
          proxy,
          "TransactWriteItems",
          10,
          (noteId, body) => VersionedNotes.put({ noteId, body }),
          0,
        )
        expect(bodies).toEqual([REQUEST_MAX_BYTES])
        expect(yield* count(tableName)).toBe(20)
      }),
    ),
  )

  it.effect("one byte more is two transactions, both accepted", () =>
    scenario((proxy, tableName) =>
      Effect.gen(function* () {
        const bodies = yield* atBoundary(
          proxy,
          "TransactWriteItems",
          10,
          (noteId, body) => VersionedNotes.put({ noteId, body }),
          1,
        )
        expect(bodies.length).toBe(2)
        for (const body of bodies) expect(body).toBeLessThanOrEqual(REQUEST_MAX_BYTES)
        expect(yield* count(tableName)).toBe(20)
      }),
    ),
  )

  describe.each([
    ["capacity reporting off", Layer.empty],
    ["capacity reporting on", ConsumedCapacity.layer()],
    ["capacity reporting on, by index", ConsumedCapacity.layer({ level: "indexes" })],
  ] as const)("%s", (_label, capacity) => {
    it.effect("a caller's transaction one byte over 16 MB as sent is named at that size", () =>
      scenario(
        (proxy, tableName) =>
          Effect.gen(function* () {
            const puts = (prefix: string, chars: number, pad: number) =>
              Array.from({ length: 10 }, (_, i) =>
                Notes.put({
                  noteId: id(prefix, i),
                  body: nul(chars) + (i === 0 ? "a".repeat(pad) : ""),
                }),
              )
            yield* Transaction.transactWrite(puts("p", 0, 0))
            const empty = sent(proxy, "TransactWriteItems")[0]!
            const target = REQUEST_MAX_BYTES + 1
            const chars = Math.floor((target - empty) / 60)
            const error = yield* Transaction.transactWrite(
              puts("n", chars, target - empty - 60 * chars),
            ).pipe(Effect.flip)
            expect(sent(proxy, "TransactWriteItems").slice(1)).toEqual([target])
            expect(error).toBeInstanceOf(ValidationError)
            expect(String((error as ValidationError).cause)).toContain(
              `measures the body it sent at ${target} bytes`,
            )
            expect(yield* count(tableName)).toBe(10)
          }),
        capacity,
      ),
    )
  })

  it.effect("a caller's transaction over 16 MB is refused whole and named", () =>
    scenario((proxy, tableName) =>
      Effect.gen(function* () {
        const puts = Array.from({ length: 10 }, (_, i) =>
          Notes.put({ noteId: id("t", i), body: nul(280_000) }),
        )
        const error = yield* Transaction.transactWrite(puts).pipe(Effect.flip)
        expect(error).toBeInstanceOf(ValidationError)
        const message = String((error as ValidationError).cause)
        expect(message).toContain("transactWrite: DynamoDB rejected the transaction")
        expect(message).toContain("16777216 bytes (16 MB)")
        expect(sent(proxy, "TransactWriteItems").length).toBe(1)
        expect(sent(proxy, "TransactWriteItems")[0]!).toBeGreaterThan(REQUEST_MAX_BYTES)
        expect(yield* count(tableName)).toBe(0)
      }),
    ),
  )
})
