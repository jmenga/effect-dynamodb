/**
 * `Entity.insert` (#189): the item `put` would write, sent as a PartiQL `INSERT`.
 *
 * A role holding only `dynamodb:PartiQLInsert` can do nothing else, so these
 * tests run against clients whose every other operation dies: a read, or a
 * `PutItem`, anywhere on the path fails the test as a defect.
 */

import type { ExecuteStatementCommandInput, ParameterizedStatement } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Embedder } from "@effect-dynamodb/schema/Embedder.js"
import { DynamoError, ItemAlreadyExists, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach, describe, expect } from "vitest"
import * as Batch from "../src/Batch.js"
import * as ConsumedCapacity from "../src/ConsumedCapacity.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Capacity from "../src/internal/Capacity.js"
import { insertStatement, STATEMENT_MAX_LENGTH } from "../src/internal/InsertStatement.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { clientLayer, collectReports, withConsumedCapacity } from "./helpers/CapacityMock.js"
import {
  calls,
  InMemoryClient,
  insertedBy,
  resetCalls,
  resetStore,
  store,
} from "./helpers/InMemoryTables.js"
import {
  awsTransactionCanceled,
  awsValidationException,
  DDB_ITEM_SIZE,
  mockDynamoClient,
} from "./helpers/MockDynamoClient.js"

const AppSchema = DynamoSchema.make({ name: "app", version: 1 })

class AuditEntry extends Schema.Class<AuditEntry>("AuditEntry")({
  logId: Schema.String,
  at: Schema.String,
  action: Schema.String,
}) {}

const AuditLog = Entity.make({
  model: AuditEntry,
  entityType: "AuditEntry",
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
})

const EscapedLog = Entity.make({
  model: AuditEntry,
  entityType: "EscapedEntry",
  primaryKey: {
    pk: { field: "pk", composite: ["logId"] },
    sk: { field: "sk", composite: ["at"] },
  },
})

const EscapedTable = Table.make({
  schema: DynamoSchema.make({ name: "app", version: 1, escapeKeys: true }),
  entities: { EscapedLog },
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
    byGroup: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["tenantId"] },
      sk: { field: "gsi2sk", composite: ["deviceId"] },
      shards: { count: 4, by: ["deviceId"] },
    },
  },
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

/** A reservation that lapses: the sentinel carries the table's TTL attribute. */
const Holds = Entity.make({
  model: Account,
  entityType: "Hold",
  primaryKey: {
    pk: { field: "pk", composite: ["accountId"] },
    sk: { field: "sk", composite: [] },
  },
  unique: { email: { fields: ["email"], ttl: "1 hour" } },
})

class Note extends Schema.Class<Note>("Note")({
  noteId: Schema.String,
  body: Schema.String,
}) {}

const notePrimaryKey = {
  pk: { field: "pk", composite: ["noteId"] },
  sk: { field: "sk", composite: [] },
} as const

const VersionedNotes = Entity.make({
  model: Note,
  entityType: "VersionedNote",
  primaryKey: notePrimaryKey,
  versioned: true,
})

const RetainedNotes = Entity.make({
  model: Note,
  entityType: "RetainedNote",
  primaryKey: notePrimaryKey,
  versioned: { retain: true },
})

const SoftNotes = Entity.make({
  model: Note,
  entityType: "SoftNote",
  primaryKey: notePrimaryKey,
  softDelete: true,
})

const GeneratedNotes = Entity.make({
  model: Note,
  entityType: "GeneratedNote",
  primaryKey: notePrimaryKey,
  generatedId: { field: "noteId" },
})

const VectorNotes = Entity.make({
  model: Note,
  entityType: "VectorNote",
  primaryKey: notePrimaryKey,
  vectorIndexes: {
    byBody: { name: "vec1", dimensions: 2, source: { fields: ["body"] } },
  },
})

class Reading extends Schema.Class<Reading>("Reading")({
  deviceId: Schema.String,
  at: Schema.String,
  value: Schema.Number,
}) {}

const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      deviceId: Schema.String,
      at: Schema.String,
      value: Schema.Number,
    }),
  },
})

class Document extends Schema.Class<Document>("Document")({
  docId: Schema.String,
  title: Schema.String,
  details: Schema.Struct({ pages: Schema.Number }),
  counters: Schema.Record(Schema.String, Schema.Number),
}) {}

const Documents = Entity.make({
  model: DynamoModel.configure(Document, {
    title: { field: "t" },
    details: { storedAs: DynamoModel.Packed({ format: "json" }) },
    counters: { storedAs: DynamoModel.SparseMap() },
  }),
  entityType: "Document",
  primaryKey: {
    pk: { field: "pk", composite: ["docId"] },
    sk: { field: "sk", composite: [] },
  },
})

class Project extends Schema.Class<Project>("Project")({
  projectId: Schema.String,
  name: Schema.String,
}) {}

const Projects = Entity.make({
  model: DynamoModel.configure(Project, { projectId: { identifier: true } }),
  entityType: "Project",
  primaryKey: {
    pk: { field: "pk", composite: ["projectId"] },
    sk: { field: "sk", composite: [] },
  },
})

class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  project: DynamoModel.ref(Project),
}) {}

const Tasks = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: [] },
  },
  refs: { project: { entity: Projects } },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: {
    AuditLog,
    Devices,
    Accounts,
    Holds,
    VersionedNotes,
    RetainedNotes,
    SoftNotes,
    GeneratedNotes,
    VectorNotes,
    Readings,
    Documents,
    Projects,
    Tasks,
  },
})

const Deposited = Schema.TaggedStruct("Deposited", { amount: Schema.Number })

const Ledgers = EventStore.makeStream({
  table: MainTable,
  streamName: "Ledger",
  events: [Deposited],
  streamId: { composite: ["ledgerId"] },
})

const TABLE = "insert-table"

const FixedEmbedder = Layer.succeed(Embedder, {
  dimensions: 2,
  embed: () => Effect.succeed([1, 0]),
})

/** What the fixtures bind, on whichever client `layer` supplies. */
const database = DynamoClient.make({
  entities: {
    AuditLog,
    Devices,
    Accounts,
    Holds,
    VersionedNotes,
    RetainedNotes,
    SoftNotes,
    GeneratedNotes,
    VectorNotes,
    Readings,
    Documents,
    Projects,
    Tasks,
  },
  tables: { MainTable },
})

const withClient = (client: Layer.Layer<DynamoClient>) =>
  Layer.mergeAll(client, MainTable.layer({ name: TABLE }), FixedEmbedder)

/**
 * A client that answers only statements and records them. Everything else dies,
 * so a test passing on it sent nothing but what it recorded.
 */
const statementsOnly = (answers?: Partial<DynamoClientService>) => {
  const statements: Array<ExecuteStatementCommandInput> = []
  const transactions: Array<ReadonlyArray<ParameterizedStatement>> = []
  const client: DynamoClientService = mockDynamoClient({
    executeStatement: (input) => {
      statements.push(input)
      return answers?.executeStatement?.(input) ?? Effect.succeed({} as never)
    },
    executeTransaction: (input) => {
      transactions.push(input.TransactStatements ?? [])
      return answers?.executeTransaction?.(input) ?? Effect.succeed({} as never)
    },
  })
  return { statements, transactions, layer: withClient(clientLayer(client)) }
}

const statementFailing = (cause: unknown) => ({
  executeStatement: () => Effect.fail(new DynamoError({ operation: "ExecuteStatement", cause })),
})

const transactionFailing = (cause: unknown) => ({
  executeTransaction: () =>
    Effect.fail(new DynamoError({ operation: "ExecuteTransaction", cause })),
})

const named = (name: string, message = "Duplicate primary key exists in table") =>
  Object.assign(new Error(message), { name })

beforeEach(() => resetStore())

const entry = { logId: "log-1", at: "2026-11-06", action: "login" }

describe("insertStatement", () => {
  it("inlines names and sends every value as a parameter, in order", () => {
    const result = insertStatement("my-table", {
      pk: { S: "a" },
      sk: { S: "b" },
      n: { N: "1" },
    })
    expect(result.Statement).toBe(`INSERT INTO "my-table" VALUE {'pk': ?, 'sk': ?, 'n': ?}`)
    expect(result.Parameters).toEqual([{ S: "a" }, { S: "b" }, { N: "1" }])
  })

  it("doubles a quote in an attribute name, and leaves other characters alone", () => {
    const { Statement } = insertStatement("t", {
      "it's": { S: "a" },
      'a"b': { S: "b" },
      "a#b.c d?": { S: "c" },
    })
    expect(Statement).toBe(`INSERT INTO "t" VALUE {'it''s': ?, 'a"b': ?, 'a#b.c d?': ?}`)
  })

  it("keeps a value out of the statement text", () => {
    const { Statement } = insertStatement("t", { pk: { S: "'; DROP" } })
    expect(Statement).not.toContain("DROP")
  })
})

describe("Entity.insert sends one write and no reads", () => {
  it.effect("a plain entity with a GSI", () => {
    const { layer, statements, transactions } = statementsOnly()
    return Effect.gen(function* () {
      const db = yield* database
      const inserted = yield* db.entities.AuditLog.insert(entry)
      expect(inserted).toMatchObject(entry)
      expect(statements).toHaveLength(1)
      expect(transactions).toHaveLength(0)
      const { item, table } = insertedBy(statements[0] ?? {})
      expect(table).toBe(TABLE)
      expect(item.pk?.S).toBe("$app#v1#auditentry#logid_log-1")
      expect(item.gsi1pk?.S).toBe("$app#v1#auditentry#action_login")
      expect(item.__edd_e__?.S).toBe("AuditEntry")
      expect(item.createdAt).toBeDefined()
      expect(item.updatedAt).toBeDefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect("the unbound op, with its record terminal", () => {
    const { layer, statements } = statementsOnly()
    return Effect.gen(function* () {
      const record = yield* Entity.asRecord(AuditLog.insert(entry))
      expect(record.createdAt).toBeDefined()
      expect(statements).toHaveLength(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("versioned without retain writes version 1", () => {
    const { layer, statements } = statementsOnly()
    return Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.VersionedNotes.insert({ noteId: "n", body: "b" })
      expect(statements).toHaveLength(1)
      expect(insertedBy(statements[0] ?? {}).item.version).toEqual({ N: "1" })
    }).pipe(Effect.provide(layer))
  })

  it.effect("softDelete", () => {
    const { layer, statements } = statementsOnly()
    return Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.SoftNotes.insert({ noteId: "n", body: "b" })
      expect(statements).toHaveLength(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("timeSeries writes the current row and no event", () => {
    const { layer, statements, transactions } = statementsOnly()
    return Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Readings.insert({ deviceId: "d", at: "2026-11-06", value: 1 })
      expect(transactions).toHaveLength(0)
      expect(statements).toHaveLength(1)
      expect(insertedBy(statements[0] ?? {}).item.sk?.S).not.toContain("#e#")
    }).pipe(Effect.provide(layer))
  })

  it.effect("a generated id is filled and returned", () => {
    const { layer, statements } = statementsOnly()
    return Effect.gen(function* () {
      const db = yield* database
      const inserted = yield* db.entities.GeneratedNotes.insert({ body: "b" })
      expect(inserted.noteId).not.toBe("")
      expect(insertedBy(statements[0] ?? {}).item.noteId).toEqual({ S: inserted.noteId })
    }).pipe(Effect.provide(layer))
  })

  it.effect("vectors, embedded or supplied", () => {
    const { layer, statements } = statementsOnly()
    return Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.VectorNotes.insert({ noteId: "n", body: "b" })
      yield* db.entities.VectorNotes.insert({ noteId: "m", body: "b" }).withVector("byBody", [0, 1])
      expect(statements).toHaveLength(2)
      const [embedded, supplied] = statements.map((s) => insertedBy(s).item)
      expect(embedded?.__edd_v_vec1__?.L).toHaveLength(2)
      expect(supplied?.__edd_v_vec1__?.L?.[1]).toEqual({ N: "1" })
    }).pipe(Effect.provide(layer))
  })

  it.effect("renamed, packed and sparse fields are stored as put stores them", () => {
    const { layer, statements } = statementsOnly()
    const input = { docId: "d", title: "T", details: { pages: 2 }, counters: { a: 1 } }
    return Effect.gen(function* () {
      const db = yield* database
      const inserted = yield* db.entities.Documents.insert(input)
      expect(inserted).toMatchObject(input)
      const { item } = insertedBy(statements[0] ?? {})
      expect(item.t).toEqual({ S: "T" })
      expect(item.title).toBeUndefined()
      expect(item.details).toEqual({ S: JSON.stringify({ pages: 2 }) })
      expect(Object.keys(item).some((name) => name.endsWith("a"))).toBe(true)
      expect(item.counters).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect("either key text sends one request, under the text its schema composes", () => {
    const { layer, statements, transactions } = statementsOnly()
    const spaced = { ...entry, at: "2026-11-06 10:00" }
    return Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.AuditLog.insert(spaced)
      yield* EscapedLog.insert(spaced)
      expect(statements).toHaveLength(2)
      expect(transactions).toHaveLength(0)
      const [plain, escaped] = statements.map((s) => insertedBy(s).item.sk?.S)
      // The app's schema leaves `escapeKeys` to the default, which a `test:escape-on` run turns on.
      expect(plain).toContain(AppSchema.escapeKeys ? "2026-11-06%2010:00" : "2026-11-06 10:00")
      expect(escaped).toContain("2026-11-06%2010:00")
    }).pipe(Effect.provide(Layer.merge(layer, EscapedTable.layer({ name: TABLE }))))
  })

  it.effect("refs read the referenced item, and nothing else", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Projects.put({ projectId: "p", name: "P" })
      resetCalls()
      yield* db.entities.Tasks.insert({ taskId: "t", projectId: "p" })
      expect(calls.getItem).toBe(1)
      expect(calls.executeStatement).toBe(1)
      expect(calls.putItem).toBe(0)
      expect(calls.transactWriteItems).toBe(0)
    }).pipe(Effect.provide(withClient(InMemoryClient))),
  )
})

describe("Entity.insert writes what put writes", () => {
  it.effect("the same attributes, and it reads back through get", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.AuditLog.put(entry)
      const written = [...store.values()][0]
      resetStore()
      yield* db.entities.AuditLog.insert(entry)
      expect([...store.values()][0]).toEqual(written)
      const read = yield* db.entities.AuditLog.get({ logId: entry.logId, at: entry.at })
      expect(read).toMatchObject(entry)
    }).pipe(Effect.provide(withClient(InMemoryClient))),
  )

  it.effect("a sharded index gets the shard put chooses, in one request", () =>
    Effect.gen(function* () {
      const db = yield* database
      const device = { deviceId: "d-1", tenantId: "t-1" }
      yield* db.entities.Devices.put(device)
      const written = [...store.values()][0]
      expect(written?.gsi1pk?.S).toMatch(/#!8\.\d+#/)
      expect(written?.gsi2pk?.S).toMatch(/#!4\.\d+#/)
      resetStore()
      yield* db.entities.Devices.insert(device)
      expect([...store.values()][0]).toEqual(written)
      expect(calls.executeStatement).toBe(1)
      expect(calls.getItem).toBe(0)
      expect(calls.query).toBe(0)
    }).pipe(Effect.provide(withClient(InMemoryClient))),
  )

  it.effect("a sentinel that lapses gets the TTL create gives it", () =>
    Effect.gen(function* () {
      const db = yield* database
      const hold = { accountId: "h-1", email: "h@x.io" }
      yield* db.entities.Holds.create(hold)
      const created = [...store.entries()].sort(([a], [b]) => a.localeCompare(b))
      expect(created.some(([, row]) => row._ttl?.N === "3600")).toBe(true)
      resetStore()
      yield* db.entities.Holds.insert(hold)
      expect([...store.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual(created)
      expect(calls.executeTransaction).toBe(1)
    }).pipe(Effect.provide(withClient(InMemoryClient))),
  )

  it.effect("a row already at the key is never replaced", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.AuditLog.insert(entry)
      const written = [...store.values()][0]
      const error = yield* db.entities.AuditLog.insert({ ...entry, action: "logout" }).pipe(
        (op) => op.asEffect(),
        Effect.flip,
      )
      expect(error._tag).toBe("ItemAlreadyExists")
      expect([...store.values()]).toEqual([written])
    }).pipe(Effect.provide(withClient(InMemoryClient))),
  )
})

describe("Entity.insert errors", () => {
  for (const name of ["DuplicateItemException", "DuplicateItem"]) {
    it.effect(`${name} is ItemAlreadyExists, keyed by the primary key composites`, () => {
      const { layer } = statementsOnly(statementFailing(named(name)))
      return Effect.gen(function* () {
        const db = yield* database
        const error = yield* db.entities.AuditLog.insert(entry).asEffect().pipe(Effect.flip)
        expect(error).toBeInstanceOf(ItemAlreadyExists)
        expect(error).toMatchObject({
          entityType: "AuditEntry",
          key: { logId: entry.logId, at: entry.at },
        })
        expect((error as ItemAlreadyExists).key).not.toHaveProperty("action")
      }).pipe(Effect.provide(layer))
    })
  }

  it.effect("any other failure passes through unchanged", () => {
    const denied = named("AccessDeniedException", "not authorized")
    const { layer } = statementsOnly(statementFailing(denied))
    return Effect.gen(function* () {
      const db = yield* database
      const error = yield* db.entities.AuditLog.insert(entry).asEffect().pipe(Effect.flip)
      expect(error).toBeInstanceOf(DynamoError)
      expect((error as DynamoError).cause).toBe(denied)
    }).pipe(Effect.provide(layer))
  })

  it.effect("a retained entity is refused before anything is sent", () => {
    const { layer, statements, transactions } = statementsOnly()
    return Effect.gen(function* () {
      const db = yield* database
      const error = yield* db.entities.RetainedNotes.insert({ noteId: "n", body: "b" })
        .asEffect()
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toContain("EDD-9110")
      expect(statements).toHaveLength(0)
      expect(transactions).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("an untyped caller's condition is refused, not ignored", () => {
    const { layer, statements } = statementsOnly()
    return Effect.gen(function* () {
      const conditioned = AuditLog.condition({ action: "login" })(
        AuditLog.insert(entry) as never,
      ) as unknown as { asEffect: () => Effect.Effect<unknown, ValidationError> }
      const error = yield* Effect.flip(conditioned.asEffect())
      expect(error).toBeInstanceOf(ValidationError)
      expect(String(error.cause)).toContain("EDD-9110")
      expect(statements).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })
})

describe("Entity.insert with unique constraints", () => {
  const account = { accountId: "a", email: "a@x.io", handle: "ada" }

  it.effect("sends one INSERT-only transaction, the item first", () => {
    const { layer, statements, transactions } = statementsOnly()
    return Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Accounts.insert(account)
      expect(statements).toHaveLength(0)
      expect(transactions).toHaveLength(1)
      const sent = transactions[0] ?? []
      expect(sent).toHaveLength(3)
      for (const statement of sent) expect(statement.Statement).toMatch(/^INSERT INTO /)
      const [main, email, handle] = sent.map((s) => insertedBy(s).item)
      expect(main?.__edd_e__?.S).toBe("Account")
      expect(email?.__edd_e__?.S).toBe("Account._unique.email")
      expect(handle?.__edd_e__?.S).toBe("Account._unique.handle")
      expect(email?._entity_pk).toEqual(main?.pk)
      expect(email?._entity_sk).toEqual(main?.sk)
    }).pipe(Effect.provide(layer))
  })

  it.effect("an unset sparse constraint takes no sentinel", () => {
    const { layer, transactions } = statementsOnly()
    return Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Accounts.insert({ accountId: "a", email: "a@x.io" })
      expect(transactions[0]).toHaveLength(2)
    }).pipe(Effect.provide(layer))
  })

  const duplicateAt = (index: number, reason: { Code: string; Message?: string }) =>
    awsTransactionCanceled(
      [0, 1, 2].map((position) => (position === index ? reason : { Code: "None" })),
    )
  const onAws = { Code: "DuplicateItem" }
  const onLocal = { Code: "ValidationError", Message: "Duplicate primary key exists in table" }

  for (const [label, reason] of [
    ["AWS", onAws],
    ["DynamoDB Local", onLocal],
  ] as const) {
    it.effect(`position 0 is ItemAlreadyExists (${label})`, () => {
      const { layer } = statementsOnly(transactionFailing(duplicateAt(0, reason)))
      return Effect.gen(function* () {
        const db = yield* database
        const error = yield* db.entities.Accounts.insert(account).asEffect().pipe(Effect.flip)
        expect(error).toBeInstanceOf(ItemAlreadyExists)
        expect(error).toMatchObject({ key: { accountId: "a" } })
      }).pipe(Effect.provide(layer))
    })

    it.effect(`a sentinel's position names its constraint (${label})`, () => {
      const { layer } = statementsOnly(transactionFailing(duplicateAt(2, reason)))
      return Effect.gen(function* () {
        const db = yield* database
        const error = yield* db.entities.Accounts.insert(account).asEffect().pipe(Effect.flip)
        expect(error).toMatchObject({
          _tag: "UniqueConstraintViolation",
          entityType: "Account",
          constraint: "handle",
          fields: { handle: "ada" },
        })
      }).pipe(Effect.provide(layer))
    })
  }

  it.effect("the item's own duplicate wins over a sentinel's", () => {
    const both = awsTransactionCanceled([onAws, onAws, { Code: "None" }])
    const { layer } = statementsOnly(transactionFailing(both))
    return Effect.gen(function* () {
      const db = yield* database
      const error = yield* db.entities.Accounts.insert(account).asEffect().pipe(Effect.flip)
      expect(error).toBeInstanceOf(ItemAlreadyExists)
    }).pipe(Effect.provide(layer))
  })

  it.effect("a role missing the sentinel prefix fails unchanged", () => {
    const refused = awsTransactionCanceled([
      { Code: "None" },
      { Code: "AccessDenied", Message: "not authorized" },
      { Code: "None" },
    ])
    const { layer } = statementsOnly(transactionFailing(refused))
    return Effect.gen(function* () {
      const db = yield* database
      const error = yield* db.entities.Accounts.insert(account).asEffect().pipe(Effect.flip)
      expect(error).toBeInstanceOf(DynamoError)
      expect((error as DynamoError).cause).toBe(refused)
    }).pipe(Effect.provide(layer))
  })

  it.effect("nothing is left behind when a sentinel is taken", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Accounts.insert(account)
      const before = store.size
      const error = yield* db.entities.Accounts.insert({ ...account, accountId: "b" })
        .asEffect()
        .pipe(Effect.flip)
      expect(error._tag).toBe("UniqueConstraintViolation")
      expect(store.size).toBe(before)
    }).pipe(Effect.provide(withClient(InMemoryClient))),
  )
})

describe("Entity.insert on multi-item paths", () => {
  it.effect("Transaction.transactWrite refuses it, bound and unbound", () => {
    const { layer, statements } = statementsOnly()
    return Effect.gen(function* () {
      const db = yield* database
      for (const op of [AuditLog.insert(entry), db.entities.AuditLog.insert(entry)]) {
        const error = yield* Transaction.transactWrite([op as never]).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("insert")
      }
      expect(statements).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("Batch.write refuses it, bound and unbound", () => {
    const { layer, statements } = statementsOnly()
    return Effect.gen(function* () {
      const db = yield* database
      for (const op of [AuditLog.insert(entry), db.entities.AuditLog.insert(entry)]) {
        const error = yield* Batch.write([op as never]).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        expect(String((error as ValidationError).cause)).toContain("insert")
      }
      expect(statements).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("EventStore additionalItems refuses it", () => {
    const { layer, statements } = statementsOnly()
    return Effect.gen(function* () {
      const ledgers = yield* EventStore.bind(Ledgers)
      const error = yield* ledgers
        .append({ ledgerId: "l" }, [], 0, {
          additionalItems: [AuditLog.insert(entry) as never],
        })
        .pipe(Effect.flip)
      expect(error._tag).toBe("ValidationError")
      expect(String((error as ValidationError).cause)).toContain("insert")
      expect(statements).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })
})

describe("Entity.insert diagnosis", () => {
  const manyCounters = Object.fromEntries(
    Array.from({ length: 500 }, (_, i) => [`counter-${String(i).padStart(6, "0")}`, i]),
  )
  const wide = { docId: "d", title: "T", details: { pages: 1 }, counters: manyCounters }
  const rejected = awsValidationException(
    "1 validation error detected: Value 'INSERT INTO ...' at 'statement' failed to satisfy " +
      "constraint: Member must have length less than or equal to 8192",
  )

  it.effect("a statement over the limit is a ValidationError naming it", () => {
    const { layer, statements } = statementsOnly(statementFailing(rejected))
    return Effect.gen(function* () {
      const db = yield* database
      const error = yield* db.entities.Documents.insert(wide).asEffect().pipe(Effect.flip)
      expect((statements[0]?.Statement ?? "").length).toBeGreaterThan(STATEMENT_MAX_LENGTH)
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toContain(String(STATEMENT_MAX_LENGTH))
      expect(String((error as ValidationError).cause)).toContain("attribute name")
    }).pipe(Effect.provide(layer))
  })

  it.effect("the same rejection of a short statement passes through unconfirmed", () => {
    const { layer } = statementsOnly(statementFailing(rejected))
    return Effect.gen(function* () {
      const db = yield* database
      const error = yield* db.entities.AuditLog.insert(entry).asEffect().pipe(Effect.flip)
      expect(error._tag).not.toBe("ValidationError")
    }).pipe(Effect.provide(layer))
  })

  it.effect("a transaction's over-long statement names the item", () => {
    const { layer } = statementsOnly(transactionFailing(rejected))
    const Wide = Entity.make({
      model: DynamoModel.configure(
        class WideAccount extends Schema.Class<WideAccount>("WideAccount")({
          accountId: Schema.String,
          email: Schema.String,
          counters: Schema.Record(Schema.String, Schema.Number),
        }) {},
        { counters: { storedAs: DynamoModel.SparseMap() } },
      ),
      entityType: "WideAccount",
      primaryKey: {
        pk: { field: "pk", composite: ["accountId"] },
        sk: { field: "sk", composite: [] },
      },
      unique: { email: ["email"] },
    })
    return Effect.gen(function* () {
      const error = yield* Wide.insert({
        accountId: "a",
        email: "a@x.io",
        counters: manyCounters,
      })
        .asEffect()
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toContain(String(STATEMENT_MAX_LENGTH))
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          layer,
          Table.make({ schema: AppSchema, entities: { Wide } }).layer({ name: TABLE }),
        ),
      ),
    )
  })

  it.effect("an item over 400 KB is diagnosed against the item sent", () => {
    const { layer } = statementsOnly(statementFailing(awsValidationException(DDB_ITEM_SIZE)))
    return Effect.gen(function* () {
      const db = yield* database
      const error = yield* db.entities.AuditLog.insert({
        ...entry,
        action: "x".repeat(410_000),
      })
        .asEffect()
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toContain("409600")
    }).pipe(Effect.provide(layer))
  })
})

describe("Entity.insert capacity", () => {
  const reported = <A, E>(
    capacity: unknown,
    run: Effect.Effect<A, E, DynamoClient | Table.TableConfig | Embedder>,
    level: "total" | "indexes" = "total",
  ) =>
    Effect.gen(function* () {
      const { service, sent } = withConsumedCapacity(
        mockDynamoClient({
          executeStatement: () => Effect.succeed({} as never),
          executeTransaction: () => Effect.succeed({} as never),
        }),
        { capacity: () => capacity },
      )
      const { reports, onOperation } = collectReports()
      yield* run.pipe(
        Effect.orDie,
        Effect.provide(ConsumedCapacity.layer({ level, onOperation })),
        Effect.provide(withClient(clientLayer(service))),
      )
      return { reports, sent }
    })

  it.effect("a statement is reported under Entity.insert, as a write, per index", () =>
    Effect.gen(function* () {
      const { reports, sent } = yield* reported(
        {
          TableName: TABLE,
          CapacityUnits: 3,
          Table: { CapacityUnits: 1 },
          GlobalSecondaryIndexes: { gsi1: { CapacityUnits: 1 }, gsi2: { CapacityUnits: 1 } },
        },
        Effect.flatMap(database, (db) => db.entities.AuditLog.insert(entry).asEffect()),
        "indexes",
      )
      expect(sent[0]?.input.ReturnConsumedCapacity).toBe("INDEXES")
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        operation: "Entity.insert",
        target: "AuditEntry",
        tables: [TABLE],
        requestsByCommand: { ExecuteStatement: 1 },
        capacityUnits: 3,
        writeCapacityUnits: 3,
        readCapacityUnits: 0,
      })
      expect(reports[0]?.byTable[0]?.globalSecondaryIndexes?.gsi1?.capacityUnits).toBe(1)
    }),
  )

  it.effect("a transaction's array is summed against the table in its statements", () =>
    Effect.gen(function* () {
      const { reports } = yield* reported(
        [{ TableName: TABLE, CapacityUnits: 4, WriteCapacityUnits: 4 }],
        Effect.flatMap(database, (db) =>
          db.entities.Accounts.insert({ accountId: "a", email: "a@x.io" }).asEffect(),
        ),
      )
      expect(reports[0]).toMatchObject({
        operation: "Entity.insert",
        tables: [TABLE],
        requestsByCommand: { ExecuteTransaction: 1 },
        capacityUnits: 4,
        writeCapacityUnits: 4,
      })
    }),
  )

  it.effect(
    "with no capacity returned, as DynamoDB Local answers, the table is the statements'",
    () =>
      Effect.gen(function* () {
        const statement = yield* reported(
          undefined,
          Effect.flatMap(database, (db) => db.entities.AuditLog.insert(entry).asEffect()),
        )
        const transaction = yield* reported(
          undefined,
          Effect.flatMap(database, (db) =>
            db.entities.Accounts.insert({ accountId: "a", email: "a@x.io" }).asEffect(),
          ),
        )
        expect(statement.reports[0]).toMatchObject({
          tables: [TABLE],
          requestsByCommand: { ExecuteStatement: 1 },
          unreportedRequests: 1,
        })
        expect(transaction.reports[0]).toMatchObject({
          tables: [TABLE],
          requestsByCommand: { ExecuteTransaction: 1 },
          unreportedRequests: 1,
        })
      }),
  )

  it.effect("a duplicate counts as a request with no capacity", () =>
    Effect.gen(function* () {
      const { reports, onOperation } = collectReports()
      const { service } = withConsumedCapacity(
        mockDynamoClient(statementFailing(named("DuplicateItemException"))),
      )
      yield* Effect.flatMap(database, (db) => db.entities.AuditLog.insert(entry).asEffect()).pipe(
        Effect.exit,
        Effect.provide(ConsumedCapacity.layer({ onOperation })),
        Effect.provide(withClient(clientLayer(service))),
      )
      expect(reports[0]).toMatchObject({
        operation: "Entity.insert",
        outcome: "failure",
        requests: 1,
        unreportedRequests: 1,
        capacityUnits: 0,
      })
    }),
  )

  it.effect("a SELECT sent through the raw client counts as a read", () =>
    Effect.gen(function* () {
      const { reports } = yield* reported(
        { TableName: TABLE, CapacityUnits: 0.5 },
        Effect.flatMap(Capacity.client, (client) =>
          client.executeStatement({ Statement: `SELECT * FROM "${TABLE}"` }),
        ),
      )
      expect(reports[0]).toMatchObject({
        operation: "DynamoClient.ExecuteStatement",
        tables: [TABLE],
        readCapacityUnits: 0.5,
        writeCapacityUnits: 0,
      })
    }),
  )

  it.effect("a transaction of SELECTs sent through the raw client counts as reads", () =>
    Effect.gen(function* () {
      const { reports } = yield* reported(
        [{ TableName: TABLE, CapacityUnits: 2 }],
        Effect.flatMap(Capacity.client, (client) =>
          client.executeTransaction({
            TransactStatements: [
              { Statement: `SELECT * FROM "${TABLE}" WHERE pk = ?` },
              { Statement: ` select * FROM "${TABLE}" WHERE pk = ?` },
              // DynamoDB takes a SELECT with no space after the keyword.
              { Statement: `SELECT*FROM "${TABLE}" WHERE pk = ?` },
              { Statement: `SELECT"pk"FROM "${TABLE}" WHERE pk = ?` },
            ],
          }),
        ),
      )
      expect(reports[0]).toMatchObject({
        operation: "DynamoClient.ExecuteTransaction",
        tables: [TABLE],
        readCapacityUnits: 2,
        writeCapacityUnits: 0,
      })
    }),
  )

  it.effect("a transaction holding anything but SELECTs, or nothing, counts as writes", () =>
    Effect.gen(function* () {
      // DynamoDB refuses both, and a refused request is still counted.
      for (const statements of [
        [`SELECT * FROM "${TABLE}" WHERE pk = ?`, `DELETE FROM "${TABLE}" WHERE pk = ?`],
        [`UPDATE "${TABLE}" SET a = 1 WHERE pk = ?`, `SELECT * FROM "${TABLE}" WHERE pk = ?`],
        [],
      ]) {
        const { reports } = yield* reported(
          [{ TableName: TABLE, CapacityUnits: 2 }],
          Effect.flatMap(Capacity.client, (client) =>
            client.executeTransaction({
              TransactStatements: statements.map((Statement) => ({ Statement })),
            }),
          ),
        )
        expect(reports[0], statements.join("; ")).toMatchObject({
          readCapacityUnits: 0,
          writeCapacityUnits: 2,
        })
      }
    }),
  )

  it.effect("a statement's table is the one it names, not a keyword in quotes", () =>
    Effect.gen(function* () {
      for (const [statement, table] of [
        [`SELECT "FROM bogus" FROM "${TABLE}" WHERE pk = ?`, TABLE],
        [`SELECT * FROM "${TABLE}" WHERE note = 'INTO bogus'`, TABLE],
        [`UPDATE "${TABLE}" SET note = 'FROM bogus' WHERE pk = ?`, TABLE],
        [`INSERT INTO "${TABLE}" VALUE {'note': 'it''s FROM bogus'}`, TABLE],
        [`DELETE FROM "a ""quoted"" table" WHERE pk = ?`, 'a "quoted" table'],
        [`select * from bare_table where pk = ?`, "bare_table"],
        [`SELECT * FROM bare_table.gsi1 WHERE pk = ?`, "bare_table"],
        [`SELECT * FROM "${TABLE}"."gsi1" WHERE pk = ?`, TABLE],
      ] as const) {
        const { reports } = yield* reported(
          undefined,
          Effect.flatMap(Capacity.client, (client) =>
            client.executeTransaction({ TransactStatements: [{ Statement: statement }] }),
          ),
        )
        expect(reports[0]?.tables, statement).toEqual([table])
        const single = yield* reported(
          undefined,
          Effect.flatMap(Capacity.client, (client) =>
            client.executeStatement({ Statement: statement }),
          ),
        )
        expect(single.reports[0]?.tables, statement).toEqual([table])
      }
    }),
  )
})
