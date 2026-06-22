import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// In-memory DynamoClient — put stores the item, get reads it back. Lets us
// assert the generated id flows through key composition, the stored item, and
// the decoded record in a single pass without DynamoDB Local.
// ---------------------------------------------------------------------------

interface Store {
  readonly items: Map<string, Record<string, unknown>>
}

const keyOf = (key: Record<string, { S?: string }>): string =>
  `${key.pk?.S ?? ""}|${key.sk?.S ?? ""}`

const makeInMemoryClient = (store: Store) =>
  Layer.succeed(DynamoClient, {
    putItem: (input) =>
      Effect.sync(() => {
        const item = fromAttributeMap(input.Item as never)
        store.items.set(keyOf(input.Item as never), item)
        return {} as never
      }),
    getItem: (input) =>
      Effect.sync(() => {
        const item = store.items.get(keyOf(input.Key as never))
        return (item ? { Item: toAttributeMap(item) } : {}) as never
      }),
    query: (input) =>
      Effect.sync(() => {
        // Naive PK match scan — sufficient for the by-primary / by-GSI assertions.
        const pkValue = Object.values(input.ExpressionAttributeValues ?? {})[0] as
          | { S?: string }
          | undefined
        const indexName = input.IndexName
        const items = [...store.items.values()].filter((it) => {
          if (indexName) {
            // GSI query — match the gsi1pk attribute value.
            return it.gsi1pk === pkValue?.S
          }
          return it.pk === pkValue?.S
        })
        return { Items: items.map((it) => toAttributeMap(it)), Count: items.length } as never
      }),
    deleteItem: () => Effect.die("not used"),
    updateItem: () => Effect.die("not used"),
    batchGetItem: () => Effect.die("not used"),
    batchWriteItem: () => Effect.die("not used"),
    transactGetItems: () => Effect.die("not used"),
    // Apply each Put to the store — exercises the unique-constraint + retain
    // put paths (which route through transactWriteItems).
    transactWriteItems: (input) =>
      Effect.sync(() => {
        for (const op of input.TransactItems ?? []) {
          const put = (op as { Put?: { Item: never } }).Put
          if (put?.Item) {
            const item = fromAttributeMap(put.Item)
            store.items.set(keyOf(put.Item), item)
          }
        }
        return {} as never
      }),
    createTable: () => Effect.die("not used"),
    deleteTable: () => Effect.die("not used"),
    describeTable: () => Effect.die("not used"),
    scan: () => Effect.die("not used"),
  })

const AppSchema = DynamoSchema.make({ name: "genid", version: 1 })

// A v4-format UUID assertion schema — uses Schema.isUUID per the issue.
const UUIDv4 = Schema.String.check(Schema.isUUID(4))
const UUIDAny = Schema.String.check(Schema.isUUID())

const decodesAsUUID = (schema: typeof UUIDv4, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  )

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class Order extends Schema.Class<Order>("Order")({
  id: Schema.String,
  customer: Schema.String,
  total: Schema.Number,
}) {}

const Orders = Entity.make({
  model: Order,
  entityType: "Order",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
  // `id` participates in the primary key and is auto-generated.
  generatedId: { field: "id" },
})

const OrdersTable = Table.make({ schema: AppSchema, entities: { Orders } })

// Entity whose generated id ALSO composes into a GSI (by-customer lookup keeps
// the id as the GSI sort-key composite).
class Invoice extends Schema.Class<Invoice>("Invoice")({
  invoiceId: Schema.String,
  customer: Schema.String,
  amount: Schema.Number,
}) {}

const Invoices = Entity.make({
  model: Invoice,
  entityType: "Invoice",
  primaryKey: {
    pk: { field: "pk", composite: ["invoiceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byCustomer: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["customer"] },
      sk: { field: "gsi1sk", composite: ["invoiceId"] },
    },
  },
  generatedId: { field: "invoiceId", version: "v7" },
})

const InvoicesTable = Table.make({ schema: AppSchema, entities: { Invoices } })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Entity.make({ generatedId }) — make()-time validation (EDD-9008)", () => {
  it("throws EDD-9008 when field is absent from the model", () => {
    expect(() =>
      Entity.make({
        model: Order,
        entityType: "Order",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        // @ts-expect-error — "missing" is not a model field
        generatedId: { field: "missing" },
      }),
    ).toThrow(/EDD-9008.*does not name a model field/)
  })

  it("throws EDD-9008 when field does not participate in the primary key", () => {
    expect(() =>
      Entity.make({
        model: Order,
        entityType: "Order",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        // `customer` is a model field but not a PK/SK composite
        generatedId: { field: "customer" },
      }),
    ).toThrow(/EDD-9008.*must participate in the\s+primary key/)
  })

  it("accepts a field that participates in the primary key", () => {
    expect(() =>
      Entity.make({
        model: Order,
        entityType: "Order",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        generatedId: { field: "id" },
      }),
    ).not.toThrow()
  })
})

describe("Entity.make({ generatedId }) — schema optionality", () => {
  it("makes the generated-id field optional in inputSchema, required in recordSchema", () => {
    // inputSchema.Type must allow omitting `id`.
    const decodeInput = Schema.decodeUnknownEffect(Orders.inputSchema as Schema.Codec<any>)
    const okWithoutId = Effect.runSync(
      decodeInput({ customer: "acme", total: 10 }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      ),
    )
    expect(okWithoutId).toBe(true)

    // recordSchema requires `id`.
    const decodeRecord = Schema.decodeUnknownEffect(
      Orders.schemas.recordSchema as Schema.Codec<any>,
    )
    const recordMissingId = Effect.runSync(
      decodeRecord({ customer: "acme", total: 10 }).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      ),
    )
    expect(recordMissingId).toBe(false)
  })
})

describe("Entity.make({ generatedId }) — runtime injection (R = never via bundled Crypto)", () => {
  it.effect("auto-fills the id when omitted and flows into pk/sk + record", () => {
    const store: Store = { items: new Map() }
    const ClientLayer = makeInMemoryClient(store)
    const TableLayer = OrdersTable.layer({ name: "orders-table" })
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Orders }, tables: { Orders: OrdersTable } })
      // NOTE: no `id` supplied — and no manual Crypto layer provided.
      const created = yield* db.entities.Orders.put({ customer: "acme", total: 42 })

      expect(created.customer).toBe("acme")
      expect(typeof created.id).toBe("string")
      const isUuid = yield* decodesAsUUID(UUIDv4, created.id)
      expect(isUuid).toBe(true)

      // The id composed into the primary key (stored pk = $genid#v1#order#<id>).
      const stored = [...store.items.values()][0]!
      expect(typeof stored.pk).toBe("string")
      expect(stored.pk as string).toContain((created.id as string).toLowerCase())

      // Queryable by primary key.
      const fetched = yield* db.entities.Orders.get({ id: created.id })
      expect(fetched.id).toBe(created.id)
      expect(fetched.total).toBe(42)
    }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
  })

  it.effect("respects a caller-supplied id (never overwrites)", () => {
    const store: Store = { items: new Map() }
    const ClientLayer = makeInMemoryClient(store)
    const TableLayer = OrdersTable.layer({ name: "orders-table" })
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Orders }, tables: { Orders: OrdersTable } })
      const created = yield* db.entities.Orders.put({
        id: "explicit-123",
        customer: "acme",
        total: 7,
      })
      expect(created.id).toBe("explicit-123")
    }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
  })

  it.effect("v7 option produces a valid UUID and composes into the GSI", () => {
    const store: Store = { items: new Map() }
    const ClientLayer = makeInMemoryClient(store)
    const TableLayer = InvoicesTable.layer({ name: "invoices-table" })
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Invoices },
        tables: { Invoices: InvoicesTable },
      })
      const created = yield* db.entities.Invoices.put({ customer: "globex", amount: 99 })

      const isUuidV7 = yield* decodesAsUUID(UUIDAny, created.invoiceId)
      expect(isUuidV7).toBe(true)

      // The generated id composed into the GSI sort-key (gsi1sk) — proving it
      // flows into GSI composites it participates in. (A real GSI-query
      // round-trip is exercised in the connected suite.)
      const stored = [...store.items.values()][0]!
      expect(typeof stored.gsi1sk).toBe("string")
      expect(stored.gsi1sk as string).toContain((created.invoiceId as string).toLowerCase())
    }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
  })

  it.effect("create auto-fills the id (delegates through put)", () => {
    const store: Store = { items: new Map() }
    const ClientLayer = makeInMemoryClient(store)
    const TableLayer = OrdersTable.layer({ name: "orders-table" })
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Orders }, tables: { Orders: OrdersTable } })
      const created = yield* db.entities.Orders.create({ customer: "initech", total: 3 })
      const isUuid = yield* decodesAsUUID(UUIDv4, created.id)
      expect(isUuid).toBe(true)
    }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
  })

  it.effect("interacts with versioned retain (transact put path)", () => {
    class Doc extends Schema.Class<Doc>("Doc")({
      docId: Schema.String,
      title: Schema.String,
    }) {}
    const Docs = Entity.make({
      model: Doc,
      entityType: "Doc",
      primaryKey: {
        pk: { field: "pk", composite: ["docId"] },
        sk: { field: "sk", composite: [] },
      },
      generatedId: { field: "docId" },
      versioned: { retain: true },
      timestamps: true,
    })
    const DocsTable = Table.make({ schema: AppSchema, entities: { Docs } })
    const store: Store = { items: new Map() }
    const ClientLayer = makeInMemoryClient(store)
    const TableLayer = DocsTable.layer({ name: "docs-table" })
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Docs }, tables: { Docs: DocsTable } })
      const created = yield* db.entities.Docs.put({ title: "Hello" })
      const isUuid = yield* decodesAsUUID(UUIDv4, created.docId)
      expect(isUuid).toBe(true)
      // Version 1 written + a retain snapshot (two items in the store).
      expect(store.items.size).toBeGreaterThanOrEqual(2)
    }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
  })

  it.effect("interacts with unique constraints (transact put path) + immutable field", () => {
    class Account extends Schema.Class<Account>("Account")({
      accountId: Schema.String,
      email: Schema.String,
      tenant: Schema.String,
    }) {}
    const AccountModel = DynamoModel.configure(Account, { tenant: { immutable: true } })
    const Accounts = Entity.make({
      model: AccountModel,
      entityType: "Account",
      primaryKey: {
        pk: { field: "pk", composite: ["accountId"] },
        sk: { field: "sk", composite: [] },
      },
      generatedId: { field: "accountId" },
      unique: { email: ["email"] },
    })
    const AccountsTable = Table.make({ schema: AppSchema, entities: { Accounts } })
    const store: Store = { items: new Map() }
    const ClientLayer = makeInMemoryClient(store)
    const TableLayer = AccountsTable.layer({ name: "accounts-table" })
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Accounts },
        tables: { Accounts: AccountsTable },
      })
      const created = yield* db.entities.Accounts.put({
        email: "a@b.com",
        tenant: "t-1",
      })
      const isUuid = yield* decodesAsUUID(UUIDv4, created.accountId)
      expect(isUuid).toBe(true)
      expect(created.tenant).toBe("t-1")
      // Main item + email sentinel.
      expect(store.items.size).toBeGreaterThanOrEqual(2)
    }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
  })

  it.effect("a caller-supplied crypto override is respected", () => {
    const store: Store = { items: new Map() }
    const ClientLayer = makeInMemoryClient(store)
    const TableLayer = OrdersTable.layer({ name: "orders-table" })
    // Deterministic Crypto: all-zero bytes → fixed UUID. Proves the override
    // path in DynamoClient.make({ crypto }) is honored.
    const fixedCrypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size),
      digest: (_algorithm, data) => Effect.succeed(data),
    })
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Orders },
        tables: { Orders: OrdersTable },
        crypto: fixedCrypto,
      })
      const created = yield* db.entities.Orders.put({ customer: "acme", total: 1 })
      // v4 layout with all-zero random bytes: version nibble 4, variant bits 8.
      expect(created.id).toBe("00000000-0000-4000-8000-000000000000")
    }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
  })
})
