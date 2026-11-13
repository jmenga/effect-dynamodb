/**
 * Connected tests for `Entity.insert` (#189) against DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 *
 * DynamoDB Local doesn't enforce IAM, so these tests can't prove the role
 * limit `insert` exists for (`docs/designs/partiql-insert.md` §8 has that
 * evidence). They prove the writes: what a statement stores, and how a
 * duplicate fails, including how Local words it (`DuplicateItem`, and a
 * `ValidationError` reason inside a transaction).
 */

import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ItemAlreadyExists, UniqueConstraintViolation } from "@effect-dynamodb/schema/Errors.js"
import { Config, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

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

const AppSchema = DynamoSchema.make({ name: "insert-conn", version: 1 })
const tableName = `insert-conn-${Date.now()}`

class Entry extends Schema.Class<Entry>("Entry")({
  logId: Schema.String,
  at: Schema.String,
  action: Schema.String,
  tags: Schema.ReadonlySet(Schema.String),
  size: Schema.Number,
}) {}

const AuditLog = Entity.make({
  model: Entry,
  entityType: "Entry",
  primaryKey: {
    pk: { field: "pk", composite: ["logId"] },
    sk: { field: "sk", composite: ["at"] },
  },
  indexes: {
    byAction: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["action"] },
      sk: { field: "gsi1sk", composite: ["at"] },
    },
  },
  timestamps: true,
  versioned: true,
})

class Account extends Schema.Class<Account>("Account")({
  accountId: Schema.String,
  email: Schema.String,
  handle: Schema.optional(Schema.String),
}) {}

const Accounts = Entity.make({
  model: Account,
  entityType: "Account",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
  unique: { email: ["email"], handle: ["handle"] },
})

class Document extends Schema.Class<Document>("Document")({
  docId: Schema.String,
  title: Schema.String,
  details: Schema.Struct({ pages: Schema.Number }),
  counters: Schema.Record(Schema.String, Schema.Number),
}) {}

const Documents = Entity.make({
  model: DynamoModel.configure(Document, {
    title: { field: "it's a title" },
    details: { storedAs: DynamoModel.Packed({ format: "json" }) },
    counters: { storedAs: DynamoModel.SparseMap() },
  }),
  entityType: "Document",
  primaryKey: {
    pk: { field: "pk", composite: ["docId"] },
    sk: { field: "sk", composite: [] },
  },
})

class Device extends Schema.Class<Device>("Device")({
  deviceId: Schema.String,
  tenantId: Schema.String,
}) {}

const Devices = Entity.make({
  model: Device,
  entityType: "Device",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byTenant: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
      shards: 8,
    },
  },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { AuditLog, Accounts, Documents, Devices },
})

const EscapedLog = Entity.make({
  model: Entry,
  entityType: "EscapedEntry",
  primaryKey: {
    pk: { field: "pk", composite: ["logId"] },
    sk: { field: "sk", composite: ["at"] },
  },
})

const EscapedTable = Table.make({
  schema: DynamoSchema.make({ name: "insert-esc", version: 1, escapeKeys: true }),
  entities: { EscapedLog },
})

const TestLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MainTable.layer({ name: tableName }),
)

const database = DynamoClient.make({
  entities: { AuditLog, Accounts, Documents, Devices },
  tables: { MainTable },
})

const rawRow = (key: { readonly pk: string; readonly sk: string }) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    return yield* client.getItem({
      TableName: tableName,
      Key: toAttributeMap(key),
      ConsistentRead: true,
    })
  })

const entry = (logId: string) => ({
  logId,
  at: "2026-11-06",
  action: "login",
  tags: new Set(["a", "b"]),
  size: 3,
})

describeConnected("Entity.insert — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
      }).pipe(Effect.provide(TestLayer)),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        Effect.provide(TestLayer),
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  it.effect("a second insert at the key is ItemAlreadyExists and changes nothing", () =>
    Effect.gen(function* () {
      const db = yield* database
      const input = entry("dup")
      yield* db.entities.AuditLog.insert(input)
      const error = yield* db.entities.AuditLog.insert({ ...input, action: "logout" })
        .asEffect()
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ItemAlreadyExists)
      expect(error).toMatchObject({
        entityType: "Entry",
        key: { logId: "dup", at: "2026-11-06" },
      })
      const stored = yield* db.entities.AuditLog.get({ logId: "dup", at: input.at })
      expect(stored.action).toBe("login")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a row put at the key is not replaced either", () =>
    Effect.gen(function* () {
      const db = yield* database
      const input = entry("over-put")
      yield* db.entities.AuditLog.put(input)
      const error = yield* db.entities.AuditLog.insert({ ...input, action: "logout" })
        .asEffect()
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ItemAlreadyExists)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("reads back through get and through its GSI", () =>
    Effect.gen(function* () {
      const db = yield* database
      const input = { ...entry("gsi"), action: "unique-action" }
      const inserted = yield* db.entities.AuditLog.insert(input)
      expect(inserted).toMatchObject({ logId: "gsi", action: "unique-action", size: 3 })
      const got = yield* db.entities.AuditLog.get({ logId: "gsi", at: input.at })
      expect(got.tags).toEqual(new Set(["a", "b"]))
      const found = yield* db.entities.AuditLog.byAction({ action: "unique-action" }).collect()
      expect(found.map((row) => row.logId)).toEqual(["gsi"])
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("stores what put stores, attribute for attribute", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.AuditLog.put(entry("same-put"))
      yield* db.entities.AuditLog.insert(entry("same-insert"))
      const key = (logId: string) => ({
        pk: `$insert-conn#v1#entry#logid_${logId}`,
        sk: "$insert-conn#v1#entry#at_2026-11-06",
      })
      const put = (yield* rawRow(key("same-put"))).Item
      const inserted = (yield* rawRow(key("same-insert"))).Item
      expect(put).toBeDefined()
      expect(inserted).toBeDefined()
      expect(Object.keys(inserted ?? {}).sort()).toEqual(Object.keys(put ?? {}).sort())
      expect(inserted?.tags).toEqual(put?.tags)
      expect(inserted?.size).toEqual(put?.size)
      expect(inserted?.version).toEqual({ N: "1" })
      expect(inserted?.__edd_e__).toEqual(put?.__edd_e__)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("awkward attribute names, packed and sparse fields round-trip", () =>
    Effect.gen(function* () {
      const db = yield* database
      const input = {
        docId: "doc",
        title: "T",
        details: { pages: 2 },
        counters: { "a.b c": 1, "it's": 2 },
      }
      yield* db.entities.Documents.insert(input)
      const read = yield* db.entities.Documents.get({ docId: "doc" })
      expect(read).toMatchObject(input)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a sharded index finds every row inserted into it", () =>
    Effect.gen(function* () {
      const db = yield* database
      const ids = Array.from({ length: 12 }, (_, i) => `d-${String(i).padStart(2, "0")}`)
      yield* Effect.forEach(ids, (deviceId) =>
        db.entities.Devices.insert({ deviceId, tenantId: "t-1" }).asEffect(),
      )
      const found = yield* db.entities.Devices.byTenant({ tenantId: "t-1" }).collect()
      expect(found.map((row) => row.deviceId).sort()).toEqual(ids)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("under escapeKeys, a value holding # and a space round-trips and can't repeat", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { EscapedLog },
        tables: { EscapedTable },
      })
      const input = { ...entry("a#b c"), at: "2026-11-06 10:00" }
      yield* db.entities.EscapedLog.insert(input)
      const read = yield* db.entities.EscapedLog.get({ logId: input.logId, at: input.at })
      expect(read.action).toBe("login")
      const again = yield* db.entities.EscapedLog.insert(input).asEffect().pipe(Effect.flip)
      expect(again).toBeInstanceOf(ItemAlreadyExists)
    }).pipe(Effect.provide(Layer.merge(TestLayer, EscapedTable.layer({ name: tableName })))),
  )

  describe("unique", () => {
    it.effect("the sentinels are written with the item, and put's writes honour them", () =>
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.insert({
          accountId: "a-1",
          email: "one@x.io",
          handle: "one",
        })
        const put = yield* db.entities.Accounts.put({ accountId: "a-2", email: "one@x.io" })
          .asEffect()
          .pipe(Effect.flip)
        expect(put).toMatchObject({ _tag: "UniqueConstraintViolation", constraint: "email" })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a duplicate key is ItemAlreadyExists, and rolls its sentinels back", () =>
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.insert({ accountId: "a-3", email: "three@x.io" })
        const error = yield* db.entities.Accounts.insert({
          accountId: "a-3",
          email: "other@x.io",
        })
          .asEffect()
          .pipe(Effect.flip)
        expect(error).toBeInstanceOf(ItemAlreadyExists)
        // The value the failed insert tried to reserve is free.
        yield* db.entities.Accounts.insert({ accountId: "a-4", email: "other@x.io" })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("a taken value is UniqueConstraintViolation, and writes nothing", () =>
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.insert({
          accountId: "a-5",
          email: "five@x.io",
          handle: "five",
        })
        const error = yield* db.entities.Accounts.insert({
          accountId: "a-6",
          email: "six@x.io",
          handle: "five",
        })
          .asEffect()
          .pipe(Effect.flip)
        expect(error).toBeInstanceOf(UniqueConstraintViolation)
        expect(error).toMatchObject({ constraint: "handle", fields: { handle: "five" } })
        const missing = yield* db.entities.Accounts.get({ accountId: "a-6" }).pipe(Effect.flip)
        expect(missing._tag).toBe("ItemNotFound")
        // The email the failed insert tried to reserve is free.
        yield* db.entities.Accounts.insert({ accountId: "a-7", email: "six@x.io" })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("an unset sparse constraint leaves its value free", () =>
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Accounts.insert({ accountId: "a-8", email: "eight@x.io" })
        yield* db.entities.Accounts.insert({ accountId: "a-9", email: "nine@x.io" })
      }).pipe(Effect.provide(TestLayer)),
    )
  })
})
