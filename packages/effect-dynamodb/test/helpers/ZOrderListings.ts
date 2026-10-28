/**
 * Listings in one region's partition, under Z-order sort keys (#171) — the
 * fixture the Z-order query, binary skip-scan and capacity tests share.
 *
 * Every index's partition key is `region`; the sort keys interleave small
 * dimensions so a box covers a handful of addresses and brute force over the
 * whole partition stays cheap:
 *
 * | Accessor    | Sort key                                                        |
 * |-------------|-----------------------------------------------------------------|
 * | `byFacets`  | `price` (int 0..1023, 10 bits), `bedrooms` (int 0..15, 4 bits)  |
 * | `byAgency`  | prefix `agencyId`, `officeId` (hash: 1 byte); `price`, `bedrooms` |
 * | `byStatus`  | `status` (literals), `price`                                    |
 * | `byText`    | `priceText` (`NumberFromString`: stored `S`), `bedrooms`        |
 * | `byListed`  | `listedAt` (`DateEpochSeconds`, seconds), `bedrooms`            |
 * | `byOpened`  | `openedAt` (`DateTimeZoned`, hours), `bedrooms`                 |
 * | `byCode`    | `code` (250 literals), `bedrooms`                               |
 *
 * `bedrooms` is stored as `beds` (a renamed field), so a filter that names it
 * must name the stored attribute.
 *
 * Rows are the items as `put` writes them — captured from the entity's own
 * `PutItem` — and served by `PartitionMock`, which orders `B` keys by their
 * bytes and evaluates the `FilterExpression` sent.
 */

import type { AttributeValue, PutItemCommandOutput } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import { ZOrder } from "../../src/index.js"
import * as Table from "../../src/Table.js"
import { random } from "./ListingsFixture.js"
import { mockDynamoClientLayer, mockOutput } from "./MockDynamoClient.js"
import { makePartition, type Partition, type PartitionOptions, type Row } from "./PartitionMock.js"

export const REGION = "north"
export const STATUSES = ["draft", "live", "sold", "withdrawn"] as const
export const CODES = Array.from({ length: 250 }, (_, i) => `c${String(i).padStart(3, "0")}`)
export const AGENCIES = ["ag-1", "ag-2", "ag-3"] as const
export const OFFICES = ["o-1", "o-2", "o-3", "o-4"] as const
/** 2024-01-01T00:00:00Z: where every date dimension starts. */
export const EPOCH_MS = Date.UTC(2024, 0, 1)

const Model = Schema.Struct({
  listingId: Schema.String,
  region: Schema.String,
  agencyId: Schema.String,
  officeId: Schema.String,
  price: Schema.Number,
  bedrooms: Schema.Number,
  status: Schema.Literals(STATUSES),
  code: Schema.Literals(CODES as unknown as readonly [string, ...Array<string>]),
  priceText: Schema.NumberFromString,
  listedAt: DynamoModel.DateEpochSeconds,
  openedAt: DynamoModel.DateTimeZoned,
})
const Configured = DynamoModel.configure(Model, { bedrooms: { field: "beds" } })

export type ZListing = typeof Model.Type

const price = ZOrder.int("price", { min: 0, max: 1023 })
const bedrooms = ZOrder.int("bedrooms", { min: 0, max: 15 })

export const Listings = Entity.make({
  model: Configured,
  entityType: "Listing",
  primaryKey: {
    pk: { field: "pk", composite: ["listingId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byFacets: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["region"] },
      sk: { field: "gsi1sk", zorder: [price, bedrooms] },
    },
    byAgency: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["region"] },
      sk: {
        field: "gsi2sk",
        prefix: ["agencyId", { field: "officeId", hash: 1 }],
        zorder: [price, bedrooms],
      },
    },
    byStatus: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["region"] },
      sk: { field: "gsi3sk", zorder: [ZOrder.literals("status", STATUSES), price] },
    },
    byText: {
      name: "gsi4",
      pk: { field: "gsi4pk", composite: ["region"] },
      sk: { field: "gsi4sk", zorder: [ZOrder.int("priceText", { min: 0, max: 1023 }), bedrooms] },
    },
    byListed: {
      name: "gsi5",
      pk: { field: "gsi5pk", composite: ["region"] },
      sk: {
        field: "gsi5sk",
        zorder: [
          ZOrder.dateTime("listedAt", { from: "2024-01-01", unit: "seconds", bits: 20 }),
          bedrooms,
        ],
      },
    },
    byOpened: {
      name: "gsi6",
      pk: { field: "gsi6pk", composite: ["region"] },
      sk: {
        field: "gsi6sk",
        zorder: [
          ZOrder.dateTime("openedAt", { from: "2024-01-01", unit: "hours", bits: 10 }),
          bedrooms,
        ],
      },
    },
    byCode: {
      name: "gsi7",
      pk: { field: "gsi7pk", composite: ["region"] },
      sk: { field: "gsi7sk", zorder: [ZOrder.literals("code", CODES), bedrooms] },
    },
  },
})

export const AppSchema = DynamoSchema.make({ name: "zorder-query", version: 1 })
export const MainTable = Table.make({ schema: AppSchema, entities: { Listings } })
export const TableLayer = MainTable.layer({ name: "zorder-query-table" })

/** The GSI key attributes of each accessor. */
export const INDEX = {
  byFacets: { pk: "gsi1pk", sk: "gsi1sk" },
  byAgency: { pk: "gsi2pk", sk: "gsi2sk" },
  byStatus: { pk: "gsi3pk", sk: "gsi3sk" },
  byText: { pk: "gsi4pk", sk: "gsi4sk" },
  byListed: { pk: "gsi5pk", sk: "gsi5sk" },
  byOpened: { pk: "gsi6pk", sk: "gsi6sk" },
  byCode: { pk: "gsi7pk", sk: "gsi7sk" },
} as const
export type Accessor = keyof typeof INDEX

/** `count` listings in {@link REGION}, ids unique, every field drawn from `seed`. */
export const randomZListings = (
  seed: number,
  count: number,
  shape: {
    /** Prices drawn from these (default: 0..1023). */
    readonly prices?: ReadonlyArray<number> | undefined
  } = {},
): Array<ZListing> => {
  const next = random(seed)
  const pick = <T>(values: ReadonlyArray<T>): T => values[Math.floor(next() * values.length)]!
  return Array.from({ length: count }, (_, n) => {
    const p = shape.prices === undefined ? Math.floor(next() * 1024) : pick(shape.prices)
    const offsetHours = Math.floor(next() * 1000)
    return {
      listingId: `l-${String(n).padStart(5, "0")}`,
      region: REGION,
      agencyId: pick(AGENCIES),
      officeId: pick(OFFICES),
      price: p,
      bedrooms: Math.floor(next() * 16),
      status: pick(STATUSES),
      code: pick(CODES) as ZListing["code"],
      priceText: Math.floor(next() * 1024),
      listedAt: DateTime.makeUnsafe(EPOCH_MS + Math.floor(next() * 1_000_000) * 1000),
      openedAt: DateTime.makeZonedUnsafe(EPOCH_MS + offsetHours * 3_600_000, {
        timeZone: next() < 0.5 ? "Australia/Sydney" : "America/New_York",
      }),
    }
  })
}

/**
 * The rows `program`'s puts write, in order — each captured from the entity's
 * own `PutItem`, so every key is composed as a real write composes it.
 */
export const capturePuts = <E, R>(
  tableLayer: Layer.Layer<Exclude<R, DynamoClient>>,
  program: Effect.Effect<unknown, E, R>,
): Array<Row> => {
  const rows: Array<Row> = []
  const capture = mockDynamoClientLayer({
    putItem: (input) =>
      Effect.sync(() => {
        rows.push(input.Item as Record<string, AttributeValue>)
        return mockOutput<PutItemCommandOutput>({})
      }),
  })
  Effect.runSync(
    program.pipe(Effect.provide(Layer.merge(capture, tableLayer))) as Effect.Effect<unknown, E>,
  )
  return rows
}

/** The rows `put` writes for `items`, in order. */
export const storedRows = (items: ReadonlyArray<ZListing>): Array<Row> =>
  capturePuts(
    TableLayer,
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Listings }, tables: { MainTable } })
      for (const item of items) yield* db.entities.Listings.put(item)
    }),
  )

/** Serve `rows` as the partition of `accessor`'s index, evaluating the filter sent. */
export const servePartition = (
  accessor: Accessor,
  rows: ReadonlyArray<Row>,
  options: Partial<PartitionOptions> = {},
): {
  readonly partition: Partition
  readonly layer: Layer.Layer<DynamoClient | Table.TableConfig>
} => {
  const index = INDEX[accessor]
  const partition = makePartition({
    rows: rows.filter((row) => row[index.sk] !== undefined),
    pkField: index.pk,
    skField: index.sk,
    keyFields: [index.pk, index.sk, "pk", "sk"],
    evaluateFilter: true,
    ...options,
  })
  return { partition, layer: Layer.merge(partition.layer, TableLayer) }
}

/** The typed client's `Listings`, for a test's effect. */
export const listings = Effect.map(
  DynamoClient.make({ entities: { Listings }, tables: { MainTable } }),
  (db) => db.entities.Listings,
)

/** Listing ids, sorted: results compared as sets. */
export const ids = (items: ReadonlyArray<{ readonly listingId: string }>): Array<string> =>
  items.map((item) => item.listingId).sort()
