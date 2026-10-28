/**
 * Z-order sort keys (#171) through the entity write paths and the accessor.
 *
 * A Z-order GSI sort key is stored as a binary (`B`) attribute: the prefix
 * segments followed by the interleaved address. These tests pin the wire form
 * of every write that composes it — put, update, transactional and batch
 * puts, soft-delete and restore — the `[EDD-9092]` refusal of a value a
 * dimension can't place (a `ValidationError`, never a defect), and the
 * accessor's partition-key-only key condition, its `[EDD-9093]` refusals and
 * a `v2` cursor over a binary `LastEvaluatedKey`. Policy-aware update
 * semantics (canonical shapes 7 and 8) live in `IndexPolicyV3.test.ts`.
 */

import type {
  AttributeValue,
  BatchWriteItemCommandInput,
  BatchWriteItemCommandOutput,
  GetItemCommandOutput,
  PutItemCommandInput,
  PutItemCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
  TransactWriteItemsCommandInput,
  TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { DateTime, Effect, Layer, Schema } from "effect"
import * as Batch from "../src/Batch.js"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { ZOrder } from "../src/index.js"
import * as Cursor from "../src/internal/Cursor.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { mockDynamoClient, mockOutput } from "./helpers/MockDynamoClient.js"

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

class Listing extends Schema.Class<Listing>("Listing")({
  listingId: Schema.String,
  region: Schema.String,
  agencyId: Schema.String,
  officeId: Schema.String,
  price: Schema.Number,
  bedrooms: Schema.Number,
  // Optional: a listing without it is left out of the Z-order indexes.
  listedAt: Schema.optional(DynamoModel.DateString),
  // A plain string under a `literals` dimension: a value outside the list is
  // valid for the model but has no level ([EDD-9092] at write time).
  status: Schema.String,
}) {}

const AppSchema = DynamoSchema.make({ name: "zorder-entity", version: 1 })

const facets = [
  ZOrder.int("price", { min: 0, max: 5_000_000, step: 1_000 }),
  ZOrder.int("bedrooms", { min: 0, max: 15 }),
  ZOrder.dateTime("listedAt", { from: "2024-01-01", unit: "hours", bits: 16 }),
] as const

const Listings = Entity.make({
  model: Listing,
  entityType: "Listing",
  primaryKey: {
    pk: { field: "pk", composite: ["listingId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byFacets: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["region"] },
      sk: { field: "gsi1sk", zorder: facets },
    },
    byAgency: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["region"] },
      sk: { field: "gsi2sk", prefix: ["agencyId", { field: "officeId", hash: 8 }], zorder: facets },
    },
    byStatus: {
      name: "gsi4",
      pk: { field: "gsi4pk", composite: ["region"] },
      sk: {
        field: "gsi4sk",
        zorder: [ZOrder.literals("status", ["draft", "live"]), facets[0]],
      },
    },
    // A string-composed GSI beside them, for contrast.
    byOffice: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["agencyId"] },
      sk: { field: "gsi3sk", composite: ["officeId"] },
    },
  },
  softDelete: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { Listings } })
const TableLayer = MainTable.layer({ name: "zorder-entity-table" })

const listing = {
  listingId: "l-1",
  region: "North",
  agencyId: "AG-1",
  officeId: "Office-9",
  price: 250_000,
  bedrooms: 3,
  listedAt: DateTime.makeUnsafe("2024-01-02T00:00:00.000Z"),
  status: "live",
}
/** `listing` in key form — what the composer reads. */
const keyForm = { ...listing, listedAt: "2024-01-02T00:00:00.000Z" }
/** price level 250 (13 bits), bedrooms 3 (4), listedAt hour 24 (16), interleaved. */
const FACETS_BYTES = Uint8Array.of(0x00, 0x02, 0x45, 0x54, 0x68)

const zSk = (index: KeyComposer.IndexDefinition, record: Record<string, unknown>) =>
  KeyComposer.composeZOrderSk(AppSchema, index, record)

/** The stored row of `listing`, every key composed. */
const storedRow = (): Record<string, AttributeValue> => {
  const keys = KeyComposer.composeAllKeys(AppSchema, "Listing", 1, Listings.indexes, keyForm)
  const row: Record<string, AttributeValue> = {
    listingId: { S: "l-1" },
    region: { S: "North" },
    agencyId: { S: "AG-1" },
    officeId: { S: "Office-9" },
    price: { N: "250000" },
    bedrooms: { N: "3" },
    listedAt: { S: "2024-01-02T00:00:00.000Z" },
    status: { S: "live" },
    __edd_e__: { S: "Listing" },
  }
  for (const [field, value] of Object.entries(keys)) {
    row[field] = typeof value === "string" ? { S: value } : { B: value }
  }
  return row
}

type Capture = {
  put?: PutItemCommandInput
  transact?: TransactWriteItemsCommandInput | undefined
  batch?: BatchWriteItemCommandInput
  queries: Array<QueryCommandInput>
}

const makeClient = (
  capture: Capture,
  overrides: Partial<DynamoClientService> = {},
): DynamoClientService =>
  mockDynamoClient({
    putItem: (input) => {
      capture.put = input
      return Effect.succeed(mockOutput<PutItemCommandOutput>({}))
    },
    getItem: () => Effect.succeed(mockOutput<GetItemCommandOutput>({ Item: storedRow() })),
    updateItem: () => Effect.die("updateItem must not be reached"),
    transactWriteItems: (input) => {
      capture.transact = input
      return Effect.succeed(mockOutput<TransactWriteItemsCommandOutput>({}))
    },
    batchWriteItem: (input) => {
      capture.batch = input
      return Effect.succeed(mockOutput<BatchWriteItemCommandOutput>({}))
    },
    ...overrides,
  })

const run = <A, E>(
  f: (db: Effect.Success<typeof client>) => Effect.Effect<A, E, DynamoClient | Table.TableConfig>,
  capture: Capture,
  overrides?: Partial<DynamoClientService>,
) =>
  Effect.gen(function* () {
    const db = yield* client
    return yield* f(db)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Layer.succeed(DynamoClient, makeClient(capture, overrides)), TableLayer),
    ),
  )

const client = DynamoClient.make({ entities: { Listings }, tables: { MainTable } })

/** The `[EDD-9092]` refusal, as the write paths raise it. */
const expectZOrderValueError = (error: unknown, operation: string, field: string) => {
  const e = error as { _tag: string; operation: string; entityType: string; cause: unknown }
  expect(e._tag).toBe("ValidationError")
  expect(e.entityType).toBe("Listing")
  expect(e.operation).toBe(operation)
  const cause = e.cause as { _tag: string; field: string; message: string }
  expect(cause._tag).toBe("ZOrderValueError")
  expect(cause.field).toBe(field)
  expect(cause.message).toContain("[EDD-9092]")
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

describe("Z-order sort keys — writes (#171)", () => {
  it.effect("put stores each Z-order sort key as a B attribute beside the string keys", () =>
    Effect.gen(function* () {
      const capture: Capture = { queries: [] }
      yield* run((db) => db.entities.Listings.put(listing).asEffect(), capture)
      const item = capture.put!.Item!
      expect(item.gsi1sk).toEqual({ B: FACETS_BYTES })
      expect(item.gsi1sk!.B).toBeInstanceOf(Uint8Array)
      expect(item.gsi2sk).toEqual({ B: zSk(Listings.indexes.byAgency, keyForm) })
      // literals "live" is level 1 of 1 bit, price level 250 of 13: 14 bits, 2 bytes.
      expect(item.gsi4sk).toEqual({ B: zSk(Listings.indexes.byStatus, keyForm) })
      expect(item.gsi4sk!.B!.length).toBe(2)
      expect(item.gsi1pk).toEqual({
        S: KeyComposer.composePk(AppSchema, "Listing", Listings.indexes.byFacets, keyForm),
      })
      expect(item.gsi3sk).toEqual({ S: "$zorder-entity#v1#listing#officeid_office-9" })
    }),
  )

  it.effect("put without a dimension leaves the item out of the Z-order indexes using it", () =>
    Effect.gen(function* () {
      const capture: Capture = { queries: [] }
      const { listedAt: _, ...withoutListedAt } = listing
      yield* run((db) => db.entities.Listings.put(withoutListedAt).asEffect(), capture)
      const item = capture.put!.Item!
      for (const field of ["gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk"]) {
        expect(item).not.toHaveProperty(field)
      }
      // byStatus doesn't use listedAt; byOffice is string-composed.
      expect(item.gsi4sk).toBeDefined()
      expect(item.gsi3sk).toBeDefined()
    }),
  )

  it.effect("[EDD-9092] put of a value a dimension can't place fails with ValidationError", () =>
    Effect.gen(function* () {
      const capture: Capture = { queries: [] }
      const nan = yield* run(
        (db) => Effect.flip(db.entities.Listings.put({ ...listing, price: Number.NaN }).asEffect()),
        capture,
      )
      expectZOrderValueError(nan, "put", "price")
      const archived = yield* run(
        (db) =>
          Effect.flip(db.entities.Listings.put({ ...listing, status: "archived" }).asEffect()),
        capture,
      )
      expectZOrderValueError(archived, "put", "status")
      expect(capture.put).toBeUndefined()
    }),
  )

  it.effect("[EDD-9092] update fails with ValidationError before writing", () =>
    Effect.gen(function* () {
      const capture: Capture = { queries: [] }
      const error = yield* run(
        (db) =>
          Effect.flip(
            db.entities.Listings.update({ listingId: "l-1" })
              .set({ status: "archived", price: 250_000 })
              .asEffect(),
          ),
        capture,
      )
      // The mock's updateItem dies: reaching it would fail the test as a defect.
      expectZOrderValueError(error, "update", "status")
    }),
  )

  it.effect("[EDD-9092] a transactional put fails with ValidationError, nothing sent", () =>
    Effect.gen(function* () {
      const capture: Capture = { queries: [] }
      const error = yield* run(
        () =>
          Effect.flip(
            Transaction.transactWrite([Listings.put({ ...listing, status: "archived" })]),
          ),
        capture,
      )
      expectZOrderValueError(error, "transactWrite.put", "status")
      expect(capture.transact).toBeUndefined()
    }),
  )

  it.effect("[EDD-9092] a transactional update fails with ValidationError, nothing sent", () =>
    Effect.gen(function* () {
      const capture: Capture = { queries: [] }
      const error = yield* run(
        () =>
          Effect.flip(
            Transaction.transactWrite([
              Listings.update({ listingId: "l-1" }).pipe(
                Entity.set({ status: "archived", price: 250_000 }),
              ),
            ]),
          ),
        capture,
      )
      expectZOrderValueError(error, "update", "status")
      expect(capture.transact).toBeUndefined()
    }),
  )

  it.effect("[EDD-9092] a batch put fails with ValidationError, nothing sent", () =>
    Effect.gen(function* () {
      const capture: Capture = { queries: [] }
      const error = yield* run(
        () => Effect.flip(Batch.write([Listings.put({ ...listing, status: "archived" })])),
        capture,
      )
      expectZOrderValueError(error, "batchWrite.put", "status")
      expect(capture.batch).toBeUndefined()
    }),
  )

  it.effect("a transactional put writes the B attribute", () =>
    Effect.gen(function* () {
      const capture: Capture = { queries: [] }
      yield* run(() => Transaction.transactWrite([Listings.put(listing)]), capture)
      const item = capture.transact!.TransactItems![0]!.Put!.Item!
      expect(item.gsi1sk).toEqual({ B: FACETS_BYTES })
    }),
  )

  it.effect("soft delete strips the B keys; restore recomposes them", () =>
    Effect.gen(function* () {
      const capture: Capture = { queries: [] }
      yield* run((db) => db.entities.Listings.delete({ listingId: "l-1" }).asEffect(), capture)
      const tombstone = capture.transact!.TransactItems!.find((item) => item.Put)!.Put!.Item!
      expect(tombstone.deletedAt).toBeDefined()
      for (const field of ["gsi1pk", "gsi1sk", "gsi2sk", "gsi3sk", "gsi4sk"]) {
        expect(tombstone).not.toHaveProperty(field)
      }

      capture.transact = undefined
      yield* run((db) => db.entities.Listings.restore({ listingId: "l-1" }), capture, {
        query: (input) => {
          capture.queries.push(input)
          return Effect.succeed(mockOutput<QueryCommandOutput>({ Items: [tombstone] }))
        },
      })
      const restored = capture.transact!.TransactItems!.find((item) => item.Put)!.Put!.Item!
      expect(restored.sk).toEqual({ S: "$zorder-entity#v1#listing" })
      expect(restored.gsi1sk).toEqual({ B: FACETS_BYTES })
      expect(restored.gsi2sk).toEqual({ B: zSk(Listings.indexes.byAgency, keyForm) })
      expect(restored.gsi4sk).toEqual({ B: zSk(Listings.indexes.byStatus, keyForm) })
      expect(restored).not.toHaveProperty("deletedAt")
    }),
  )
})

// ---------------------------------------------------------------------------
// Accessor
// ---------------------------------------------------------------------------

describe("Z-order sort keys — the accessor (#171)", () => {
  const page = (
    capture: Capture,
    lastEvaluatedKey?: Record<string, AttributeValue>,
  ): Partial<DynamoClientService> => ({
    query: (input) => {
      capture.queries.push(input)
      return Effect.succeed(
        mockOutput<QueryCommandOutput>({
          Items: [storedRow()],
          Count: 1,
          ScannedCount: 1,
          ...(lastEvaluatedKey !== undefined && { LastEvaluatedKey: lastEvaluatedKey }),
        }),
      )
    },
  })

  it.effect("queries the GSI by its partition key alone", () =>
    Effect.gen(function* () {
      const capture: Capture = { queries: [] }
      const items = yield* run(
        (db) => db.entities.Listings.byAgency({ region: "North" }).collect(),
        capture,
        page(capture),
      )
      expect(items.map((item) => item.listingId)).toEqual(["l-1"])
      const input = capture.queries[0]!
      expect(input.IndexName).toBe("gsi2")
      expect(Object.values(input.ExpressionAttributeNames ?? {})).not.toContain("gsi2sk")
      expect(input.KeyConditionExpression).not.toMatch(/begins_with|BETWEEN|[<>]/)
    }),
  )

  it.effect("[EDD-9093] a prefix composite, a dimension or .where() is refused", () =>
    Effect.gen(function* () {
      const db = yield* run((db) => Effect.succeed(db), { queries: [] })
      const byFacets = db.entities.Listings.byFacets as (composites: object) => unknown
      const byAgency = db.entities.Listings.byAgency as (composites: object) => unknown
      expect(() => byFacets({ region: "North", price: 250_000 })).toThrow(
        /\[EDD-9093\] Index "byFacets" of entity "Listing" has a Z-order sort key, so "price"/,
      )
      expect(() => byAgency({ region: "North", agencyId: "AG-1" })).toThrow(/\[EDD-9093\]/)
      // `.where()` is absent from the type; reached anyway, it is refused.
      const query = db.entities.Listings.byFacets({ region: "North" }) as unknown as {
        where: (f: (t: any, ops: any) => unknown) => unknown
      }
      expect(() => query.where((t, { gte }) => gte(t.price, 1))).toThrow(
        /\[EDD-9093\] \.where\(\) on index "byFacets"/,
      )
    }),
  )

  it.effect("a binary LastEvaluatedKey round-trips through a v2 cursor", () =>
    Effect.gen(function* () {
      const capture: Capture = { queries: [] }
      const row = storedRow()
      const lastEvaluatedKey = {
        pk: row.pk!,
        sk: row.sk!,
        gsi1pk: row.gsi1pk!,
        gsi1sk: row.gsi1sk!,
      }
      const cursor = yield* run(
        (db) =>
          Effect.gen(function* () {
            const first = yield* db.entities.Listings.byFacets({ region: "North" }).limit(1).fetch()
            yield* db.entities.Listings.byFacets({ region: "North" })
              .startFrom(first.cursor!)
              .limit(1)
              .fetch()
            return first.cursor
          }),
        capture,
        page(capture, lastEvaluatedKey),
      )
      // `B` has no legacy form: the cursor is v2, its bytes as base64.
      expect(cursor).toMatch(/^v2\./)
      expect(Cursor.decode(cursor!)?.k?.gsi1sk).toEqual({ B: Cursor.toBase64(FACETS_BYTES) })
      const resumed = capture.queries[1]!.ExclusiveStartKey!
      expect(resumed.gsi1sk).toEqual({ B: FACETS_BYTES })
      expect(resumed.gsi1sk!.B).toBeInstanceOf(Uint8Array)
      expect(resumed.gsi1pk).toEqual(lastEvaluatedKey.gsi1pk)
    }),
  )
})

// ---------------------------------------------------------------------------
// Definition-level surfaces
// ---------------------------------------------------------------------------

describe("Z-order sort keys — the entity definition (#171)", () => {
  it("[EDD-9093] the legacy query namespace takes the partition key composites only", () => {
    const query = Listings.query.byFacets!({ region: "North" })
    expect(query._state.skConditions).toEqual([])
    const legacy = Listings.query.byAgency as (composites: object) => unknown
    expect(() => legacy({ region: "North", agencyId: "AG-1" })).toThrow(
      /\[EDD-9093\] Entity "Listing" query "byAgency": "agencyId" feeds the Z-order sort key/,
    )
  })

  it("[EDD-9090] a Z-order index can't be injected as a collection index", () => {
    expect(() => Listings._injectIndex("byFacetsCollection", Listings.indexes.byFacets)).toThrow(
      /\[EDD-9090\]/,
    )
  })
})
