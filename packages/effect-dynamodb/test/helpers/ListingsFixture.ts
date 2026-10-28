/**
 * Listings in one store's partition, keyed by a composite sort key — the
 * fixture the #171 skip-scan and cursor tests share. A listing's index sort
 * key is `…#status_<status>#price_<price>#listingid_<id>` by default, so a
 * `.within()` bound on `price` leaves `status` as the skip tuple.
 *
 * Rows are composed with the library's own key composer and served by
 * `PartitionMock`, which orders them by UTF-8 bytes as DynamoDB does.
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import { toAttributeMap } from "../../src/Marshaller.js"
import * as Table from "../../src/Table.js"
import { compareBytes, makePartition, type Partition, type Row } from "./PartitionMock.js"

export const STORE = "store-1"

export interface ListingItem {
  readonly storeId: string
  readonly listingId: string
  readonly status: string
  readonly price: number
}

export interface ListingsOptions {
  /** The `status` field's schema (default: a literal union of `statuses`). */
  readonly status?: Schema.Top | undefined
  /** The values `status` takes (default `active`, `pending`, `sold`). */
  readonly statuses?: ReadonlyArray<string> | undefined
  /** The index's sort key composites (default `status`, `price`, `listingId`). */
  readonly sk?: ReadonlyArray<"status" | "price" | "listingId"> | undefined
  /** `gsi` (default): a `byStore` GSI; `primary`: the table's own key. */
  readonly on?: "gsi" | "primary" | undefined
  /** The GSI's key casing (default: the schema's, lowercase). */
  readonly casing?: DynamoSchema.Casing | undefined
  /** `versioned: { retain: true }`: the primary key also holds version snapshots. */
  readonly versioned?: boolean | undefined
}

export interface Listings {
  /** The entity's accessor `.within()` is called on. */
  readonly accessor: "byStore" | "primary"
  readonly skField: string
  /** A typed-client effect: `db.entities.Listings`, untyped. */
  readonly listings: Effect.Effect<any, never, DynamoClient>
  /** Serve `items` (plus `extraRows`) as the store's partition. */
  readonly serve: (
    items: ReadonlyArray<ListingItem>,
    extraRows?: ReadonlyArray<Row>,
  ) => { readonly partition: Partition; readonly layer: Layer.Layer<any> }
  /** The stored row of an item. */
  readonly rowOf: (item: ListingItem) => Row
  /** The index sort key text of an item. */
  readonly skOf: (item: ListingItem) => string
  /**
   * A version snapshot of `item` (`versioned` on the primary key): its
   * composites, under a history-shaped sort key in the same partition.
   */
  readonly historyRowOf: (item: ListingItem, version: number) => Row
  /** `items` in index order (UTF-8 bytes of the sort key), reversed when asked. */
  readonly ordered: (items: ReadonlyArray<ListingItem>, reverse?: boolean) => Array<ListingItem>
}

const encoder = new TextEncoder()

export const makeListings = (options: ListingsOptions = {}): Listings => {
  const schema = DynamoSchema.make({ name: "shop", version: 1 })
  const statuses = options.statuses ?? ["active", "pending", "sold"]
  const sk = options.sk ?? ["status", "price", "listingId"]
  const on = options.on ?? "gsi"
  const Model = Schema.Struct({
    storeId: Schema.String,
    listingId: Schema.String,
    status: (options.status ??
      Schema.Literals(statuses as [string, ...Array<string>])) as Schema.Codec<string>,
    price: Schema.Number,
  })
  const Listings = Entity.make({
    model: Model,
    entityType: "Listing",
    primaryKey:
      on === "primary"
        ? { pk: { field: "pk", composite: ["storeId"] }, sk: { field: "sk", composite: [...sk] } }
        : { pk: { field: "pk", composite: ["listingId"] }, sk: { field: "sk", composite: [] } },
    indexes:
      on === "primary"
        ? {}
        : {
            byStore: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["storeId"] },
              sk: { field: "gsi1sk", composite: [...sk] },
              ...(options.casing === undefined ? {} : { casing: options.casing }),
            },
          },
    ...(options.versioned === true ? { versioned: { retain: true } } : {}),
  } as any) as any
  const MainTable = Table.make({ schema, entities: { Listings } })
  const skField = on === "primary" ? "sk" : "gsi1sk"
  const indexes = (Listings as { readonly indexes: Record<string, KeyComposer.IndexDefinition> })
    .indexes

  const rowOf = (item: ListingItem): Row =>
    toAttributeMap({
      ...item,
      ...KeyComposer.composeAllKeys(schema, "Listing", 1, indexes, Listings._keyForm({ ...item })),
      ...(options.versioned === true ? { version: 1 } : {}),
      __edd_e__: "Listing",
    })
  const skOf = (item: ListingItem) => rowOf(item)[skField]!.S!

  return {
    accessor: on === "primary" ? "primary" : "byStore",
    skField,
    listings: Effect.map(
      DynamoClient.make({ entities: { Listings }, tables: { MainTable } }),
      (db: any) => db.entities.Listings,
    ) as Effect.Effect<any, never, DynamoClient>,
    rowOf,
    skOf,
    historyRowOf: (item, version) => ({
      ...rowOf(item),
      [skField]: {
        S: DynamoSchema.composeVersionKey(schema, "Listing", version, { item: item.listingId }),
      },
      version: { N: String(version) },
    }),
    serve: (items, extraRows = []) => {
      const partition = makePartition({
        rows: [...items.map(rowOf), ...extraRows],
        pkField: on === "primary" ? "pk" : "gsi1pk",
        skField,
        keyFields: on === "primary" ? ["pk", "sk"] : ["gsi1pk", "gsi1sk", "pk", "sk"],
      })
      return {
        partition,
        layer: Layer.merge(partition.layer, MainTable.layer({ name: "listings" })),
      }
    },
    ordered: (items, reverse = false) => {
      const sorted = [...items].sort((a, b) =>
        compareBytes(encoder.encode(skOf(a)), encoder.encode(skOf(b))),
      )
      return reverse ? sorted.reverse() : sorted
    },
  }
}

/** A deterministic PRNG (mulberry32), so a failing seed reproduces. */
export const random = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `count` listings with statuses from `statuses` and prices 0..99, ids unique. */
export const randomListings = (
  seed: number,
  count: number,
  statuses: ReadonlyArray<string> = ["active", "pending", "sold"],
): Array<ListingItem> => {
  const next = random(seed)
  return Array.from({ length: count }, (_, n) => ({
    storeId: STORE,
    listingId: `l-${String(n).padStart(4, "0")}`,
    status: statuses[Math.floor(next() * statuses.length)]!,
    price: Math.floor(next() * 100),
  }))
}

/** A numeric `.within()` bound and the predicate it means. */
export type PriceBound =
  | { readonly eq: number }
  | { readonly between: readonly [number, number] }
  | { readonly gt?: number; readonly gte?: number; readonly lt?: number; readonly lte?: number }

export const inBound = (bound: PriceBound, value: number): boolean => {
  if ("eq" in bound) return value === bound.eq
  if ("between" in bound) return value >= bound.between[0] && value <= bound.between[1]
  return (
    (bound.gt === undefined || value > bound.gt) &&
    (bound.gte === undefined || value >= bound.gte) &&
    (bound.lt === undefined || value < bound.lt) &&
    (bound.lte === undefined || value <= bound.lte)
  )
}

/** A random price bound from `next`. */
export const randomBound = (next: () => number): PriceBound => {
  const a = Math.floor(next() * 100)
  const b = Math.min(99, a + Math.floor(next() * 40))
  switch (Math.floor(next() * 6)) {
    case 0:
      return { eq: a }
    case 1:
      return { between: [a, b] }
    case 2:
      return { gte: a }
    case 3:
      return { lt: b }
    case 4:
      return { gt: a, lte: b }
    default:
      return { gte: a, lt: b }
  }
}
