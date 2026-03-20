/**
 * Shopping Mall Directory Example — Single Entity with Multiple Access Patterns
 *
 * Adapted from the ElectroDB Shopping Mall example:
 * https://electrodb.dev/en/examples/shopping-mall/
 *
 * Demonstrates effect-dynamodb patterns:
 * - Single entity (MallStore) with 3 indexes (primary + 2 GSIs)
 * - Composite primary key with 2 PK composites and 2 SK composites
 * - GSI queries for finding stores in a mall or building
 * - Date range queries on lease end dates via GSI2
 * - CRUD operations with composite keys
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/shopping-mall.ts
 */

import { Console, Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as KeyComposer from "../src/KeyComposer.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

// =============================================================================
// 1. Pure domain model — no DynamoDB concepts
// =============================================================================

const StoreCategory = {
  FoodCoffee: "food/coffee",
  FoodMeal: "food/meal",
  Clothing: "clothing",
  Electronics: "electronics",
  Department: "department",
  Misc: "misc",
} as const
const StoreCategorySchema = Schema.Literals(Object.values(StoreCategory))

class MallStore extends Schema.Class<MallStore>("MallStore")({
  cityId: Schema.String,
  mallId: Schema.String,
  storeId: Schema.String,
  buildingId: Schema.String,
  unitId: Schema.String,
  category: StoreCategorySchema,
  leaseEndDate: Schema.String,
  rent: Schema.String,
  discount: Schema.String.pipe(Schema.withDecodingDefaultKey(() => "0.00")),
  deposit: Schema.optional(Schema.Number),
}) {}

// =============================================================================
// 2. Schema
// =============================================================================

const MallSchema = DynamoSchema.make({ name: "mall", version: 1 })

// =============================================================================
// 3. Entity definition — 1 entity, 2 GSIs
//
// Primary `stores`:  pk=[cityId, mallId], sk=[buildingId, storeId]
// GSI1 `units`:      pk=[mallId],         sk=[buildingId, unitId]
// GSI2 `leases`:     pk=[storeId],        sk=[leaseEndDate]
// =============================================================================

const MallStores = Entity.make({
  model: MallStore,
  entityType: "MallStore",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["cityId", "mallId"] },
      sk: { field: "sk", composite: ["buildingId", "storeId"] },
    },
    units: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["mallId"] },
      sk: { field: "gsi1sk", composite: ["buildingId", "unitId"] },
    },
    leases: {
      index: "gsi2",
      pk: { field: "gsi2pk", composite: ["storeId"] },
      sk: { field: "gsi2sk", composite: ["leaseEndDate"] },
    },
  },
  timestamps: true,
})

// =============================================================================
// 4. Table definition — declare entities as members
// =============================================================================

const MallTable = Table.make({ schema: MallSchema, entities: { MallStores } })

// =============================================================================
// 5. Seed data
// =============================================================================

const stores = {
  // Mall: EastPointe — Building A
  starCoffee: {
    cityId: "atlanta",
    mallId: "eastpointe",
    storeId: "star-coffee",
    buildingId: "bldg-a",
    unitId: "a-101",
    category: "food/coffee" as const,
    leaseEndDate: "2025-03-31",
    rent: "3500.00",
    discount: "0.00",
    deposit: 7000,
  },
  burgerBarn: {
    cityId: "atlanta",
    mallId: "eastpointe",
    storeId: "burger-barn",
    buildingId: "bldg-a",
    unitId: "a-102",
    category: "food/meal" as const,
    leaseEndDate: "2025-06-30",
    rent: "4200.00",
    discount: "200.00",
    deposit: 8400,
  },
  // Mall: EastPointe — Building B
  techZone: {
    cityId: "atlanta",
    mallId: "eastpointe",
    storeId: "tech-zone",
    buildingId: "bldg-b",
    unitId: "b-201",
    category: "electronics" as const,
    leaseEndDate: "2025-09-30",
    rent: "5500.00",
    discount: "0.00",
    deposit: 11000,
  },
  trendyThreads: {
    cityId: "atlanta",
    mallId: "eastpointe",
    storeId: "trendy-threads",
    buildingId: "bldg-b",
    unitId: "b-202",
    category: "clothing" as const,
    leaseEndDate: "2025-12-31",
    rent: "4800.00",
    discount: "500.00",
  },
  // Mall: WestGate (different mall, same city)
  megaMart: {
    cityId: "atlanta",
    mallId: "westgate",
    storeId: "mega-mart",
    buildingId: "bldg-c",
    unitId: "c-301",
    category: "department" as const,
    leaseEndDate: "2025-06-15",
    rent: "8000.00",
    discount: "0.00",
    deposit: 16000,
  },
  giftsGalore: {
    cityId: "atlanta",
    mallId: "westgate",
    storeId: "gifts-galore",
    buildingId: "bldg-c",
    unitId: "c-302",
    category: "misc" as const,
    leaseEndDate: "2025-03-15",
    rent: "2800.00",
    discount: "0.00",
  },
}

// =============================================================================
// 6. Helpers
// =============================================================================

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

// =============================================================================
// 7. Main program — 6 access patterns with assertions
// =============================================================================

const program = Effect.gen(function* () {
  const db = yield* DynamoClient.make(MallTable)

  // --- Setup: create table ---
  yield* db.createTable()

  // --- Seed data ---
  for (const store of Object.values(stores)) {
    yield* db.MallStores.put(store)
  }

  // -------------------------------------------------------------------------
  // Pattern 1: Get specific store by city/mall/building/store (primary key)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 1: Get Specific Store (primary key)")

  const coffee = yield* db.MallStores.get({
    cityId: "atlanta",
    mallId: "eastpointe",
    buildingId: "bldg-a",
    storeId: "star-coffee",
  })
  assertEq(coffee.storeId, "star-coffee", "get storeId")
  assertEq(coffee.category, "food/coffee", "get category")
  assertEq(coffee.rent, "3500.00", "get rent")
  assertEq(coffee.unitId, "a-101", "get unitId")
  assertEq(coffee.deposit, 7000, "get deposit")
  yield* Console.log("  Get star-coffee by primary key — OK")

  // -------------------------------------------------------------------------
  // Pattern 2: Find all stores in a mall (GSI1 — units index)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 2: All Stores in a Mall (gsi1)")

  const eastpointeStores = yield* db.MallStores.collect(
    MallStores.query.units({ mallId: "eastpointe" }),
  )
  assertEq(eastpointeStores.length, 4, "eastpointe has 4 stores")
  const eastpointeIds = eastpointeStores.map((s) => s.storeId).sort()
  assertEq(
    eastpointeIds,
    ["burger-barn", "star-coffee", "tech-zone", "trendy-threads"],
    "eastpointe store IDs",
  )

  const westgateStores = yield* db.MallStores.collect(
    MallStores.query.units({ mallId: "westgate" }),
  )
  assertEq(westgateStores.length, 2, "westgate has 2 stores")
  const westgateIds = westgateStores.map((s) => s.storeId).sort()
  assertEq(westgateIds, ["gifts-galore", "mega-mart"], "westgate store IDs")
  yield* Console.log("  Eastpointe (4), WestGate (2) — OK")

  // -------------------------------------------------------------------------
  // Pattern 3: Find stores in a specific building (GSI1 with SK prefix)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 3: Stores in a Building (gsi1 + beginsWith)")

  const unitsIndex = MallStores.indexes.units
  const bldgAPrefix = KeyComposer.composeSortKeyPrefix(MallSchema, "MallStore", 1, unitsIndex, {
    buildingId: "bldg-a",
  })

  const bldgAStores = yield* db.MallStores.collect(
    MallStores.query.units({ mallId: "eastpointe" }).pipe(Query.where({ beginsWith: bldgAPrefix })),
  )
  assertEq(bldgAStores.length, 2, "bldg-a has 2 stores")
  const bldgAIds = bldgAStores.map((s) => s.storeId).sort()
  assertEq(bldgAIds, ["burger-barn", "star-coffee"], "bldg-a store IDs")

  const bldgBPrefix = KeyComposer.composeSortKeyPrefix(MallSchema, "MallStore", 1, unitsIndex, {
    buildingId: "bldg-b",
  })

  const bldgBStores = yield* db.MallStores.collect(
    MallStores.query.units({ mallId: "eastpointe" }).pipe(Query.where({ beginsWith: bldgBPrefix })),
  )
  assertEq(bldgBStores.length, 2, "bldg-b has 2 stores")
  const bldgBIds = bldgBStores.map((s) => s.storeId).sort()
  assertEq(bldgBIds, ["tech-zone", "trendy-threads"], "bldg-b store IDs")
  yield* Console.log("  Bldg-A (2), Bldg-B (2) — OK")

  // -------------------------------------------------------------------------
  // Pattern 4: Lease renewals by store with date range (GSI2)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 4: Lease Renewals by Date Range (gsi2)")

  // All leases for burger-barn
  const burgerLeases = yield* db.MallStores.collect(
    MallStores.query.leases({ storeId: "burger-barn" }),
  )
  assertEq(burgerLeases.length, 1, "burger-barn has 1 lease record")
  assertEq(burgerLeases[0]!.leaseEndDate, "2025-06-30", "burger-barn lease end date")

  // Find stores with leases expiring in Q1 2025 (Jan-Mar) using between on star-coffee
  const leasesIndex = MallStores.indexes.leases
  const q1Lo = KeyComposer.composeSortKeyPrefix(MallSchema, "MallStore", 1, leasesIndex, {
    leaseEndDate: "2025-01-01",
  })
  const q1Hi = KeyComposer.composeSortKeyPrefix(MallSchema, "MallStore", 1, leasesIndex, {
    leaseEndDate: "2025-03-31",
  })

  const starCoffeeQ1 = yield* db.MallStores.collect(
    MallStores.query
      .leases({ storeId: "star-coffee" })
      .pipe(Query.where({ between: [q1Lo, q1Hi] })),
  )
  assertEq(starCoffeeQ1.length, 1, "star-coffee has 1 lease in Q1 2025")
  assertEq(starCoffeeQ1[0]!.leaseEndDate, "2025-03-31", "star-coffee Q1 lease date")

  // Check tech-zone lease (Q3 2025) does NOT appear in Q1 range
  const techZoneQ1 = yield* db.MallStores.collect(
    MallStores.query.leases({ storeId: "tech-zone" }).pipe(Query.where({ between: [q1Lo, q1Hi] })),
  )
  assertEq(techZoneQ1.length, 0, "tech-zone has no leases in Q1 2025")

  // tech-zone lease in Q3 2025
  const q3Lo = KeyComposer.composeSortKeyPrefix(MallSchema, "MallStore", 1, leasesIndex, {
    leaseEndDate: "2025-07-01",
  })
  const q3Hi = KeyComposer.composeSortKeyPrefix(MallSchema, "MallStore", 1, leasesIndex, {
    leaseEndDate: "2025-09-30",
  })

  const techZoneQ3 = yield* db.MallStores.collect(
    MallStores.query.leases({ storeId: "tech-zone" }).pipe(Query.where({ between: [q3Lo, q3Hi] })),
  )
  assertEq(techZoneQ3.length, 1, "tech-zone has 1 lease in Q3 2025")
  assertEq(techZoneQ3[0]!.leaseEndDate, "2025-09-30", "tech-zone Q3 lease date")
  yield* Console.log("  Q1 star-coffee (1), Q1 tech-zone (0), Q3 tech-zone (1) — OK")

  // -------------------------------------------------------------------------
  // Pattern 5: Update store (rent change)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 5: Update Store Rent")

  const updated = yield* db.MallStores.update(
    {
      cityId: "atlanta",
      mallId: "eastpointe",
      buildingId: "bldg-a",
      storeId: "star-coffee",
    },
    Entity.set({
      rent: "4000.00",
      discount: "100.00",
    }),
  )
  assertEq(updated.rent, "4000.00", "updated rent")
  assertEq(updated.discount, "100.00", "updated discount")
  assertEq(updated.storeId, "star-coffee", "update preserves storeId")
  assertEq(updated.category, "food/coffee", "update preserves category")

  // Verify via get
  const refetched = yield* db.MallStores.get({
    cityId: "atlanta",
    mallId: "eastpointe",
    buildingId: "bldg-a",
    storeId: "star-coffee",
  })
  assertEq(refetched.rent, "4000.00", "refetched updated rent")
  assertEq(refetched.discount, "100.00", "refetched updated discount")
  yield* Console.log("  Rent 3500 -> 4000, discount 0 -> 100 — OK")

  // -------------------------------------------------------------------------
  // Pattern 6: Delete store
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 6: Delete Store")

  yield* db.MallStores.delete({
    cityId: "atlanta",
    mallId: "westgate",
    buildingId: "bldg-c",
    storeId: "gifts-galore",
  })

  const deleted = yield* db.MallStores.get({
    cityId: "atlanta",
    mallId: "westgate",
    buildingId: "bldg-c",
    storeId: "gifts-galore",
  }).pipe(
    Effect.map(() => false),
    Effect.catchTag("ItemNotFound", () => Effect.succeed(true)),
  )
  assert(deleted, "delete removes gifts-galore")

  // Verify westgate now has 1 store
  const westgateAfter = yield* db.MallStores.collect(MallStores.query.units({ mallId: "westgate" }))
  assertEq(westgateAfter.length, 1, "westgate has 1 store after delete")
  assertEq(westgateAfter[0]!.storeId, "mega-mart", "remaining westgate store is mega-mart")
  yield* Console.log("  Delete gifts-galore, westgate now has 1 store — OK")

  // --- Cleanup ---
  yield* db.deleteTable
  yield* Console.log("\nAll 6 patterns passed.")
})

// =============================================================================
// 8. Provide dependencies and run
// =============================================================================

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  MallTable.layer({ name: "mall-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)

export { program, MallTable, MallStores, MallStore, MallSchema }
