/**
 * Upload-ledger roots (#179, design §6.2): which library operations open the
 * ledger their uploads settle in, observed from inside every request a mock
 * client receives.
 *
 * - The writes of an offloading entity (put / create / upsert / update /
 *   patch / delete / deleteIfExists / append) each run in a root of their
 *   own; a non-offloading entity's run in none.
 * - `Batch.write`, `Transaction.transactWrite` (planning and send in one
 *   ledger), aggregate create / update / delete, `EventStream.append` /
 *   `writeSnapshot`, `commandHandler` (read, decide and append in one ledger)
 *   and each projection row's read-fold-write are roots.
 * - An operation inside a root joins it; a client bound inside one root never
 *   pins it (`Capacity.detachContext`), and a forked `Capacity.detached`
 *   fiber runs outside it.
 *
 * The writes here carry no offloaded value, so nothing uploads and nothing
 * settles (`Entity.offload.test.ts` covers entity uploads). A store is in the
 * layer because binding an offloading entity requires one (`EDD-9115`).
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import { BlobStore } from "../src/BlobStore.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as BlobLedger from "../src/internal/BlobLedger.js"
import * as Capacity from "../src/internal/Capacity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { InMemoryClient, resetStore } from "./helpers/InMemoryTables.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Offloading requires escaped key text (design §11.10).
const AppSchema = DynamoSchema.make({ name: "roots", version: 1, escapeKeys: true })

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  title: Schema.String,
  scan: Schema.optional(Schema.Uint8Array),
  notes: Schema.optional(Schema.Struct({ text: Schema.String })),
}) {}

const offloaded = {
  scan: { storedAs: DynamoModel.External({ contentType: "application/pdf" }) },
  notes: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 1_024 } }) },
} as const

const docKey = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const

const Docs = Entity.make({
  model: DynamoModel.configure(Doc, offloaded),
  entityType: "Doc",
  primaryKey: docKey,
})

const PlainDocs = Entity.make({ model: Doc, entityType: "PlainDoc", primaryKey: docKey })

class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Schema.String,
  at: Schema.Number,
  value: Schema.Number,
  raw: Schema.optional(Schema.Uint8Array),
}) {}

const Readings = Entity.make({
  model: DynamoModel.configure(Reading, {
    raw: { storedAs: DynamoModel.External() },
  }),
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["sensorId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      sensorId: Schema.String,
      at: Schema.Number,
      value: Schema.Number,
    }),
  },
})

class Venue extends Schema.Class<Venue>("Venue")({
  venueId: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}

class Match extends Schema.Class<Match>("Match")({
  matchId: Schema.String,
  name: Schema.String,
  venue: Venue,
}) {}

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Docs, PlainDocs, Readings },
})

const Matches = Aggregate.make(Match, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["matchId"] },
  collection: { name: "match" },
  root: { entityType: "MatchItem" },
  edges: { venue: Aggregate.one("venue", { entityType: "MatchVenue" }) },
})

class Opened extends Schema.TaggedClass<Opened>()("Opened", { amount: Schema.Number }) {}

const EventsTable = Table.make({ schema: AppSchema, entities: {} })

const Accounts = EventStore.makeStream({
  table: EventsTable,
  streamName: "Account",
  events: [Opened],
  streamId: { composite: ["accountId"] },
  snapshot: { schema: Schema.Struct({ balance: Schema.Number }) },
})

const Balance = Schema.Struct({
  accountId: Schema.String,
  balance: Schema.Number,
  version: Schema.Number,
})
const Balances = Entity.make({
  model: Balance,
  entityType: "Balance",
  primaryKey: { pk: { field: "pk", composite: ["accountId"] }, sk: { field: "sk", composite: [] } },
})
const ReadTable = Table.make({ schema: AppSchema, entities: { Balances } })

const BalanceProjection = EventStore.projection({
  stream: Accounts,
  readModel: Balances,
  key: (id) => ({ accountId: id.accountId }),
  initial: (id) => ({ accountId: id.accountId, balance: 0, version: 0 }),
  evolve: (state, event) =>
    Effect.succeed({ ...state, balance: state.balance + event.data.amount }),
  checkpoint: "version",
})

// ---------------------------------------------------------------------------
// The spying client
// ---------------------------------------------------------------------------

interface Seen {
  readonly command: string
  readonly ledger: BlobLedger.Ledger | undefined
}

const seen: Array<Seen> = []

const METHODS = {
  getItem: "GetItem",
  putItem: "PutItem",
  updateItem: "UpdateItem",
  deleteItem: "DeleteItem",
  query: "Query",
  transactWriteItems: "TransactWriteItems",
  batchWriteItem: "BatchWriteItem",
} as const satisfies Partial<Record<keyof DynamoClientService, string>>

/** Records the ledger each request runs in, then answers as the in-memory tables do. */
const SpyClient = Layer.effect(
  DynamoClient,
  Effect.map(Effect.service(DynamoClient), (inner): DynamoClientService => {
    const spied: Record<string, unknown> = { ...inner }
    for (const [method, command] of Object.entries(METHODS)) {
      spied[method] = (input: unknown) =>
        Effect.flatMap(BlobLedger.current, (ledger) => {
          seen.push({ command, ledger })
          if (method === "batchWriteItem") return Effect.succeed({ UnprocessedItems: {} })
          return (inner as unknown as Record<string, (i: unknown) => Effect.Effect<unknown>>)[
            method
          ]!(input)
        })
    }
    return spied as unknown as DynamoClientService
  }),
).pipe(Layer.provide(InMemoryClient))

const TestLayer = Layer.mergeAll(
  SpyClient,
  BlobStore.layerMemory(),
  MainTable.layer({ name: "main" }),
  EventsTable.layer({ name: "events" }),
  ReadTable.layer({ name: "read" }),
)

beforeEach(() => {
  resetStore()
  seen.length = 0
})

const commands = () => seen.map((s) => s.command)

/** The one ledger every request since the last call ran in (none may run outside it). */
const oneLedger = (): BlobLedger.Ledger => {
  const ledgers = new Set(seen.map((s) => s.ledger))
  expect(ledgers.size).toBe(1)
  const [ledger] = ledgers
  expect(ledger).toBeDefined()
  seen.length = 0
  return ledger!
}

const noLedger = () => {
  expect(seen.length).toBeGreaterThan(0)
  expect(seen.every((s) => s.ledger === undefined)).toBe(true)
  seen.length = 0
}

const writes = ["PutItem", "UpdateItem", "DeleteItem", "TransactWriteItems", "BatchWriteItem"]

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

describe("ledger roots — entities", () => {
  it.effect("each write of an offloading entity is a root of its own; its reads are not", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Docs }, tables: { MainTable } })
      const roots: Array<BlobLedger.Ledger> = []
      const root = () => {
        // Every request of the write — including a read it makes — in one ledger.
        expect(seen.some((s) => writes.includes(s.command))).toBe(true)
        roots.push(oneLedger())
      }

      yield* db.entities.Docs.put({ docId: "d-1", title: "one" })
      root()
      yield* db.entities.Docs.create({ docId: "d-2", title: "two" })
      root()
      yield* db.entities.Docs.upsert({ docId: "d-3", title: "three" })
      root()
      yield* db.entities.Docs.update({ docId: "d-1" }).set({ title: "uno" })
      root()
      yield* db.entities.Docs.patch({ docId: "d-1" }).set({ title: "eins" })
      root()
      yield* db.entities.Docs.delete({ docId: "d-2" })
      root()
      yield* db.entities.Docs.deleteIfExists({ docId: "d-3" })
      root()
      expect(new Set(roots).size).toBe(roots.length)
      // A closed ledger: settled at the root's exit.
      expect(roots.every((ledger) => ledger.closed)).toBe(true)

      yield* db.entities.Docs.get({ docId: "d-1" })
      noLedger()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("the unbound op terminals are roots too", () =>
    Effect.gen(function* () {
      yield* Docs.put({ docId: "d-1", title: "one" })
      oneLedger()
      yield* Docs.update({ docId: "d-1" }).pipe(Entity.set({ title: "uno" }))
      oneLedger()
      yield* Docs.delete({ docId: "d-1" })
      oneLedger()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a time-series append of an offloading entity is a root", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Readings }, tables: { MainTable } })
      yield* db.entities.Readings.append({ sensorId: "s-1", at: 1, value: 10 })
      expect(commands()).toContain("TransactWriteItems")
      oneLedger()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a non-offloading entity's writes open no ledger", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { PlainDocs }, tables: { MainTable } })
      yield* db.entities.PlainDocs.put({ docId: "p-1", title: "one" })
      yield* db.entities.PlainDocs.update({ docId: "p-1" }).set({ title: "uno" })
      yield* db.entities.PlainDocs.delete({ docId: "p-1" })
      noLedger()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("an operation inside a root joins it", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Docs, PlainDocs }, tables: { MainTable } })
      const outer = yield* BlobLedger.root(
        Effect.gen(function* () {
          yield* db.entities.Docs.put({ docId: "d-1", title: "one" })
          yield* db.entities.PlainDocs.put({ docId: "p-1", title: "one" })
          return yield* BlobLedger.current
        }),
      )
      expect(oneLedger()).toBe(outer)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a client bound inside a root does not pin it", () =>
    Effect.gen(function* () {
      const [db, first] = yield* BlobLedger.root(
        Effect.gen(function* () {
          const client = yield* DynamoClient.make({ entities: { Docs }, tables: { MainTable } })
          return [client, yield* BlobLedger.current] as const
        }),
      )
      expect(first?.closed).toBe(true)
      const second = yield* BlobLedger.root(
        Effect.andThen(
          db.entities.Docs.put({ docId: "d-1", title: "one" }).asEffect(),
          BlobLedger.current,
        ),
      )
      expect(second).not.toBe(first)
      expect(oneLedger()).toBe(second)
      // Outside any root, the bound op opens its own.
      yield* db.entities.Docs.put({ docId: "d-2", title: "two" })
      const own = oneLedger()
      expect(own).not.toBe(first)
      expect(own).not.toBe(second)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("Capacity.detached runs outside the ledger", () =>
    Effect.gen(function* () {
      const inside = yield* BlobLedger.root(
        Effect.all([BlobLedger.current, Capacity.detached(BlobLedger.current)]),
      )
      expect(inside[0]).toBeDefined()
      expect(inside[1]).toBeUndefined()
    }),
  )
})

// ---------------------------------------------------------------------------
// Batch, Transaction, Aggregate
// ---------------------------------------------------------------------------

describe("ledger roots — batches, transactions and aggregates", () => {
  it.effect("Batch.write is a root", () =>
    Effect.gen(function* () {
      yield* Batch.write([
        PlainDocs.put({ docId: "p-1", title: "one" }),
        PlainDocs.delete({ docId: "p-2" }),
      ])
      expect(commands()).toEqual(["BatchWriteItem"])
      oneLedger()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("Transaction.transactWrite plans and sends in one ledger", () =>
    Effect.gen(function* () {
      yield* PlainDocs.put({ docId: "p-1", title: "one" })
      seen.length = 0
      yield* Transaction.transactWrite([
        PlainDocs.put({ docId: "p-2", title: "two" }),
        PlainDocs.update({ docId: "p-1" }).pipe(Entity.set({ title: "uno" })),
      ])
      expect(commands()).toContain("TransactWriteItems")
      oneLedger()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("aggregate create, update and delete are roots", () =>
    Effect.gen(function* () {
      const venue = new Venue({ venueId: "v-1", name: "Ground" })
      yield* Matches.create({ matchId: "m-1", name: "Final", venue } as never)
      expect(commands()).toContain("TransactWriteItems")
      const created = oneLedger()
      yield* Matches.update({ matchId: "m-1" }, ({ state }) => ({ ...state, name: "Grand Final" }))
      const updated = oneLedger()
      yield* Matches.delete({ matchId: "m-1" })
      const deleted = oneLedger()
      expect(new Set([created, updated, deleted]).size).toBe(3)
      // A read is not a root.
      yield* Matches.get({ matchId: "m-1" }).pipe(Effect.ignore)
      noLedger()
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// EventStore
// ---------------------------------------------------------------------------

describe("ledger roots — event streams and projections", () => {
  it.effect("EventStream.append and writeSnapshot are roots; reads are not", () =>
    Effect.gen(function* () {
      yield* Accounts.append({ accountId: "a-1" }, [new Opened({ amount: 5 })], 0)
      const append = oneLedger()
      yield* Accounts.writeSnapshot({ accountId: "a-1" }, { balance: 5 }, 1)
      const snapshot = oneLedger()
      expect(snapshot).not.toBe(append)
      yield* Accounts.read({ accountId: "a-1" })
      noLedger()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a bound stream's append is a root", () =>
    Effect.gen(function* () {
      const bound = yield* EventStore.bind(Accounts)
      yield* bound.append({ accountId: "a-1" }, [new Opened({ amount: 5 })], 0)
      oneLedger()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("commandHandler loads, decides and appends in one ledger", () =>
    Effect.gen(function* () {
      const handle = EventStore.commandHandler(
        {
          initialState: { balance: 0 },
          decide: (command: { readonly amount: number }) =>
            Effect.succeed([new Opened({ amount: command.amount })]),
          evolve: (state: { readonly balance: number }, event: Opened) => ({
            balance: state.balance + event.amount,
          }),
        },
        Accounts,
      )
      yield* handle({ accountId: "a-1" }, { amount: 3 })
      expect(commands()).toContain("Query")
      oneLedger()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("each projection row's read-fold-write is a root", () =>
    Effect.gen(function* () {
      yield* Accounts.append({ accountId: "a-1" }, [new Opened({ amount: 5 })], 0)
      yield* Accounts.append({ accountId: "a-2" }, [new Opened({ amount: 7 })], 0)
      const events = [
        ...(yield* Accounts.read({ accountId: "a-1" })),
        ...(yield* Accounts.read({ accountId: "a-2" })),
      ]
      seen.length = 0
      yield* BalanceProjection.applyBatch(events)
      // Each row: its read and its write in a ledger of its own.
      const rows = seen.filter((s) => s.command === "PutItem" || s.command === "GetItem")
      expect(rows.filter((s) => s.command === "PutItem")).toHaveLength(2)
      const ledgers = new Set(rows.map((s) => s.ledger))
      expect(ledgers.size).toBe(2)
      expect([...ledgers].every((ledger) => ledger !== undefined)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )
})
