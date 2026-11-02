/**
 * Guide: Z-order Indexes — effect-dynamodb
 *
 * Demonstrates the Z-order index API as documented in the Z-order guide:
 *   - Declaring a Z-order sort key: `sk.prefix` + `sk.zorder` dimensions
 *   - The binary (`B`) sort key attribute in Table.definition
 *   - `.within()` box queries, with and without the prefix composite
 *   - A three-page `fetch` chain
 *   - `.explain()` and `.onRequest()` to compare strategies
 *   - An update that moves the index entry
 *   - Skip-scan on a composite index (`status`, then `price`)
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/guide-zorder.ts
 */

import { Config, Console, DateTime, Effect, Layer, Option, Schema, Stream } from "effect"

// Import from source (use "effect-dynamodb" when published)
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

// =============================================================================
// Helpers
// =============================================================================

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

const sortedIds = (items: ReadonlyArray<{ readonly listingId: string }>) =>
  items.map((item) => item.listingId).sort()

// =============================================================================
// 1. Pure domain models
// =============================================================================

// #region models
class Listing extends Schema.Class<Listing>("Listing")({
  listingId: Schema.String,
  region: Schema.String,
  agencyId: Schema.String,
  title: Schema.String,
  price: Schema.Number,
  bedrooms: Schema.Number,
  listedAt: DynamoModel.DateString,
}) {}

const RentalStatus = {
  Available: "available",
  Leased: "leased",
  Pending: "pending",
  Withdrawn: "withdrawn",
} as const

class Rental extends Schema.Class<Rental>("Rental")({
  rentalId: Schema.String,
  agencyId: Schema.String,
  status: Schema.Literals(Object.values(RentalStatus)),
  price: Schema.Number,
}) {}
// #endregion

// =============================================================================
// 2. Entities and table
// =============================================================================

// #region zorder-entity
const Listings = Entity.make({
  model: Listing,
  entityType: "Listing",
  primaryKey: {
    pk: { field: "pk", composite: ["listingId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    search: {
      name: "gsi1",
      // Exact-match facets, as for any index: one partition per region.
      pk: { field: "gsi1pk", composite: ["region"] },
      sk: {
        field: "gsi1sk", // a binary (B) attribute
        prefix: ["agencyId"], // exact-match, in front of the address
        zorder: [
          // Declaration order is interleave priority.
          { field: "price", min: 0, max: 5_000_000, step: 1_000 }, // 13 bits
          { field: "bedrooms", min: 0, max: 15 }, // 4 bits
          { field: "listedAt", from: "2024-01-01", unit: "hours", bits: 16 }, // 16 bits
        ],
      },
    },
  },
})
// #endregion

// #region composite-entity
const Rentals = Entity.make({
  model: Rental,
  entityType: "Rental",
  primaryKey: {
    pk: { field: "pk", composite: ["rentalId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    // An ordinary composite sort key: status first, then weekly price.
    byStatus: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["agencyId"] },
      sk: { field: "gsi2sk", composite: ["status", "price"] },
    },
  },
})
// #endregion

const AppSchema = DynamoSchema.make({ name: "guide-zorder", version: 1 })
const MainTable = Table.make({ schema: AppSchema, entities: { Listings, Rentals } })
const tableName = "guide-zorder-table"

// =============================================================================
// 3. Seed data — 240 listings and 60 rentals, derived from their index
// =============================================================================

const AGENCIES = ["ag-1", "ag-2", "ag-3"] as const
const MARCH_1 = Date.UTC(2024, 2, 1)
const HOUR = 3_600_000

const listings = Array.from({ length: 240 }, (_, n) => ({
  listingId: `l-${String(n).padStart(3, "0")}`,
  region: "north",
  agencyId: AGENCIES[n % 3]!,
  title: `Listing ${n}`,
  price: 200_000 + ((n * 37) % 181) * 10_000, // 200,000 to 2,000,000
  bedrooms: 1 + ((n * 5) % 6), // 1 to 6
  listedAt: DateTime.makeUnsafe(MARCH_1 + ((n * 13) % 720) * HOUR), // March 2024
}))

const STATUSES = Object.values(RentalStatus)
const rentals = Array.from({ length: 60 }, (_, n) => ({
  rentalId: `r-${String(n).padStart(3, "0")}`,
  agencyId: "ag-1",
  status: STATUSES[n % STATUSES.length]!,
  price: 300 + ((n * 23) % 50) * 10, // 300 to 790 a week
}))

const inBox = (l: (typeof listings)[number]) =>
  l.price >= 600_000 &&
  l.price <= 900_000 &&
  l.bedrooms >= 3 &&
  DateTime.toEpochMillis(l.listedAt) >= Date.UTC(2024, 2, 10)

// =============================================================================
// 4. Main program
// =============================================================================

// #region program
const program = Effect.gen(function* () {
  const client = yield* DynamoClient
  const db = yield* DynamoClient.make({
    entities: { Listings, Rentals },
    tables: { MainTable },
  })

  // --- Setup ---
  yield* Console.log("=== Setup ===\n")
  // Start clean: drop the table a failed earlier run may have left behind
  yield* db.tables.MainTable.delete().pipe(
    Effect.catchTag("ResourceNotFoundError", () => Effect.void),
  )

  // #region table-definition
  // A Z-order sort key is a binary attribute: Table.definition declares it as "B".
  // (client is the raw DynamoClient service; tableName the physical table name.)
  const definition = Table.definition(MainTable)
  const gsi1sk = definition.AttributeDefinitions.find((a) => a.AttributeName === "gsi1sk")
  // gsi1sk?.AttributeType → "B"

  yield* client.createTable({
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    ...definition,
  })
  // #endregion
  assertEq(gsi1sk?.AttributeType, "B", "gsi1sk is binary")
  yield* Console.log(`Table created (gsi1sk: ${gsi1sk?.AttributeType})`)

  // #region seed
  yield* Batch.write([
    ...listings.map((listing) => Listings.put(listing)),
    ...rentals.map((rental) => Rentals.put(rental)),
  ])
  // #endregion
  yield* Console.log(`Seeded ${listings.length} listings and ${rentals.length} rentals\n`)

  // -------------------------------------------------------------------------
  // Box queries with .within()
  // -------------------------------------------------------------------------
  yield* Console.log("=== .within() ===\n")

  // #region within
  const march10 = DateTime.makeUnsafe("2024-03-10T00:00:00Z")

  // One agency: a box over all three dimensions, read as a few key ranges.
  const agencyMatches = yield* db.entities.Listings.search({ region: "north" })
    .within({
      agencyId: "ag-2",
      price: { between: [600_000, 900_000] },
      bedrooms: { gte: 3 },
      listedAt: { gte: march10 },
    })
    .collect()

  // Every agency: the prefix is skip-scanned, then the same box in each.
  const regionMatches = yield* db.entities.Listings.search({ region: "north" })
    .within({
      price: { between: [600_000, 900_000] },
      bedrooms: { gte: 3 },
      listedAt: { gte: march10 },
    })
    .collect()
  // #endregion
  assertEq(
    sortedIds(agencyMatches),
    sortedIds(listings.filter((l) => l.agencyId === "ag-2" && inBox(l))),
    "agency box",
  )
  assertEq(sortedIds(regionMatches), sortedIds(listings.filter(inBox)), "region box")
  yield* Console.log(`ag-2 box: ${agencyMatches.length} listings`)
  yield* Console.log(`Region box: ${regionMatches.length} listings`)
  yield* Console.log(
    `Agencies in result order: ${[...new Set(regionMatches.map((l) => l.agencyId))].join(", ")}\n`,
  )

  // -------------------------------------------------------------------------
  // Cursors
  // -------------------------------------------------------------------------
  yield* Console.log("=== fetch chain ===\n")

  // #region fetch-chain
  const box = db.entities.Listings.search({ region: "north" })
    .within({ price: { between: [600_000, 900_000] }, bedrooms: { gte: 3 } })
    .limit(8)

  // Each page's cursor resumes the box exactly where that page stopped; the stream
  // ends at the page without one.
  const paged = yield* Stream.paginate(box, (query) =>
    query.fetch().pipe(
      Effect.map((page) =>
        [
          page.items,
          Option.map(Option.fromNullOr(page.cursor), (cursor) => box.startFrom(cursor)),
        ] as const,
      ),
    ),
  ).pipe(Stream.runCollect)
  // #endregion
  const wholeBox = yield* db.entities.Listings.search({ region: "north" })
    .within({ price: { between: [600_000, 900_000] }, bedrooms: { gte: 3 } })
    .collect()
  assertEq(
    paged.map((l) => l.listingId),
    wholeBox.map((l) => l.listingId),
    "fetch chain equals collect",
  )
  yield* Console.log(`Fetched ${paged.length} of ${wholeBox.length} in pages of 8\n`)

  // -------------------------------------------------------------------------
  // explain() and onRequest()
  // -------------------------------------------------------------------------
  yield* Console.log("=== explain / onRequest ===\n")

  // #region explain
  const query = db.entities.Listings.search({ region: "north" }).within({
    agencyId: "ag-2",
    price: { between: [600_000, 750_000] },
    bedrooms: { between: [3, 4] },
  })

  const explained = yield* query.explain()
  // explained.plan          → "jump"
  // explained.reason        → "exact plan over maxRanges"
  // explained.keyConditions → [{ lower: "0x0004…", upper: "0x0004…", exact: false }]
  // explained.filter        → "(price >= 600000) AND (price <= 750000) AND (bedrooms >= 3) AND (bedrooms <= 4)"
  // explained.zorder        → { bits: 33, box: [...], fill: 0.0136, exactRanges: "over-cap" }
  // #endregion
  yield* Console.log(`plan: ${explained.plan} (${explained.reason})`)
  yield* Console.log(`key conditions: ${explained.keyConditions.length}`)
  yield* Console.log(`filter: ${explained.filter}`)
  yield* Console.log(
    `zorder: ${explained.zorder?.bits} bits, fill ${explained.zorder?.fill.toFixed(4)}, exact ranges ${explained.zorder?.exactRanges}`,
  )

  // #region strategies
  // Rows examined (ScannedCount) against items returned, per strategy.
  const measure = (strategy: "naive" | "jump" | "precise") =>
    Effect.gen(function* () {
      const events: Array<Query.QueryRequestEvent> = []
      const items = yield* query
        .zorder({ strategy })
        .onRequest((event) => Effect.sync(() => void events.push(event)))
        .collect()
      const examined = events.reduce((sum, event) => sum + event.scannedCount, 0)
      return { strategy, requests: events.length, examined, returned: items.length }
    })

  const naive = yield* measure("naive")
  const jump = yield* measure("jump")
  const precise = yield* measure("precise")
  // Same listings from each. naive: 1 request, most rows examined; jump: a few
  // requests, fewer rows; precise: one request per planned range, fewest rows.
  // #endregion
  for (const run of [naive, jump, precise]) {
    yield* Console.log(
      `  ${run.strategy}: ${run.requests} requests, ${run.examined} rows examined, ${run.returned} returned`,
    )
  }
  assertEq(jump.returned, naive.returned, "jump returns what naive does")
  assertEq(precise.returned, naive.returned, "precise returns what naive does")
  if (!(precise.examined < jump.examined && jump.examined < naive.examined)) {
    throw new Error("Assertion failed [strategies]: precise < jump < naive in rows examined")
  }
  if (!(naive.requests < jump.requests && jump.requests < precise.requests)) {
    throw new Error("Assertion failed [strategies]: naive < jump < precise in requests")
  }
  yield* Console.log("")

  // -------------------------------------------------------------------------
  // Updates move the entry
  // -------------------------------------------------------------------------
  yield* Console.log("=== update moves the entry ===\n")

  // A listing of agency ag-2 outside the box: priced under 600,000.
  const cheap = listings.find((l) => l.agencyId === "ag-2" && !inBox(l) && l.price < 600_000)!

  // #region update-moves
  // cheap is a listing of agency ag-2 outside the box (priced under 600,000).
  // Every prefix composite and dimension is key material: carry them all,
  // and a change of at least one level moves the entry to a new address.
  yield* db.entities.Listings.update({ listingId: cheap.listingId }).set({
    agencyId: cheap.agencyId,
    price: 750_000,
    bedrooms: 4,
    listedAt: DateTime.makeUnsafe("2024-03-20T09:00:00Z"),
  })

  const nowInBox = yield* db.entities.Listings.search({ region: "north" })
    .within({
      agencyId: "ag-2",
      price: { between: [600_000, 900_000] },
      bedrooms: { gte: 3 },
      listedAt: { gte: march10 },
    })
    .collect()
  // nowInBox includes the updated listing (once the GSI has caught up)
  // #endregion
  assertEq(
    nowInBox.some((l) => l.listingId === cheap.listingId),
    true,
    "the moved listing is in the box",
  )
  yield* Console.log(`${cheap.listingId} moved into the box: ${nowInBox.length} listings now\n`)

  // -------------------------------------------------------------------------
  // Skip-scan on a composite index
  // -------------------------------------------------------------------------
  yield* Console.log("=== skip-scan ===\n")

  // #region skip-scan
  // byStatus sorts by status, then price. A price bound alone skip-scans:
  // one probe finds each status, then only that status's price range is read.
  const affordable = db.entities.Rentals.byStatus({ agencyId: "ag-1" }).within({
    price: { between: [500, 650] },
  })

  const plan = yield* affordable.explain()
  // plan.plan → "skip-scan"
  const rentalsInRange = yield* affordable.collect()

  // maxSkips caps the probes; past it, the rest is read once and checked per row.
  const filtered = yield* db.entities.Rentals.byStatus({ agencyId: "ag-1" })
    .within({ price: { between: [500, 650] } }, { maxSkips: 0 })
    .collect()
  // #endregion
  assertEq(plan.plan, "skip-scan", "skip-scan plan")
  const wantRentals = rentals.filter((r) => r.price >= 500 && r.price <= 650)
  assertEq(
    rentalsInRange.map((r) => r.rentalId).sort(),
    wantRentals.map((r) => r.rentalId).sort(),
    "skip-scan rentals",
  )
  assertEq(
    filtered.map((r) => r.rentalId),
    rentalsInRange.map((r) => r.rentalId),
    "filter plan returns the same rentals",
  )
  yield* Console.log(`plan: ${plan.plan} (${plan.reason})`)
  yield* Console.log(
    `${rentalsInRange.length} rentals between 500 and 650, in order: ${[...new Set(rentalsInRange.map((r) => r.status))].join(", ")}`,
  )

  // --- Cleanup ---
  yield* Console.log("\n=== Cleanup ===\n")
  yield* db.tables.MainTable.delete()
  yield* Console.log("Table deleted.")
})
// #endregion

// =============================================================================
// 5. Provide dependencies and run
// =============================================================================

// #region run
const AppLayer = Layer.mergeAll(
  DynamoClient.layerConfig({
    region: Config.succeed("us-east-1"),
    endpoint: Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
    credentials: Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }),
  }),
  MainTable.layer({ name: tableName }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(() => console.log("\nDone."))
// #endregion
