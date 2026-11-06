/**
 * Z-order queries (#171, design §5, §8.5, §9–§11): `.within()` on a Z-order
 * accessor and the `naive` / `jump` / `precise` / `auto` strategies, against
 * a partition mock that orders `B` sort keys as unsigned bytes and evaluates
 * the `FilterExpression` sent.
 *
 * Every result is checked against the partition read whole and filtered in
 * JavaScript — the brute-force set, in index order.
 *
 * Two fixtures: `Cells`, an 8 × 8 grid (`x`, `y`: 3 bits each, so an address
 * is `x2 y2 x1 y1 x0 y0` and the box `x ∈ [3, 4], y ∈ [2, 3]` is the
 * addresses 14, 15, 36 and 37 of design §10.3), for pinned plans; and the
 * listings of `helpers/ZOrderListings.ts`, for every dimension storage.
 */

import type { QueryCommandInput } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError, ThrottlingError } from "@effect-dynamodb/schema/Errors.js"
import * as ZOrderCurve from "@effect-dynamodb/schema/internal/ZOrderCurve.js"
import { DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type { RangeBound } from "../src/internal/BoundQuery.js"
import * as Cursor from "../src/internal/Cursor.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import { random } from "./helpers/ListingsFixture.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"
import { compareBytes, makePartition, type Partition, type Row } from "./helpers/PartitionMock.js"
import {
  type Accessor,
  CODES,
  capturePuts,
  EPOCH_MS,
  INDEX,
  ids,
  listings,
  randomZListings,
  servePartition,
  storedRows,
  type ZListing,
} from "./helpers/ZOrderListings.js"

// ---------------------------------------------------------------------------
// Cells: an 8 × 8 grid, one row per cell and group
// ---------------------------------------------------------------------------

class Cell extends Schema.Class<Cell>("Cell")({
  cellId: Schema.String,
  grid: Schema.String,
  group: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
}) {}

const xDim = { field: "x", min: 0, max: 7 } as const
const yDim = { field: "y", min: 0, max: 7 } as const

const Cells = Entity.make({
  model: Cell,
  entityType: "Cell",
  primaryKey: {
    pk: { field: "pk", composite: ["cellId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byXY: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["grid"] },
      sk: { field: "gsi1sk", zorder: [xDim, yDim] },
    },
    byGroup: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["grid"] },
      sk: { field: "gsi2sk", prefix: ["group"], zorder: [xDim, yDim] },
    },
  },
})

const CellTable = Table.make({
  schema: DynamoSchema.make({ name: "cells", version: 1 }),
  entities: { Cells },
})
const CellTableLayer = CellTable.layer({ name: "cells-table" })

/** `x2 y2 x1 y1 x0 y0`: the address of a cell. */
const address = (x: number, y: number): number => {
  let z = 0
  for (let bit = 2; bit >= 0; bit--) z = (z << 2) | (((x >> bit) & 1) << 1) | ((y >> bit) & 1)
  return z
}

const cellsOf = (groups: ReadonlyArray<string>): Array<Cell> =>
  groups.flatMap((group) =>
    Array.from({ length: 64 }, (_, n) => {
      const x = n >> 3
      const y = n & 7
      return new Cell({ cellId: `${group}-${x}-${y}`, grid: "g", group, x, y })
    }),
  )

const cellRows = (cells: ReadonlyArray<Cell>): Array<Row> =>
  capturePuts(
    CellTableLayer,
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Cells }, tables: { CellTable } })
      for (const cell of cells) yield* db.entities.Cells.put(cell)
    }),
  )

const CELLS = cellsOf(["a"])
const CELL_ROWS = cellRows(CELLS)
const GROUP_CELLS = cellsOf(["a", "b", "c"])
const GROUP_ROWS = cellRows(GROUP_CELLS)

const cellPartition = (
  rows: ReadonlyArray<Row>,
  index: "byXY" | "byGroup" = "byXY",
): { readonly partition: Partition; readonly layer: Layer.Layer<DynamoClient> } => {
  const [pk, sk] = index === "byXY" ? ["gsi1pk", "gsi1sk"] : ["gsi2pk", "gsi2sk"]
  const partition = makePartition({
    rows,
    pkField: pk,
    skField: sk,
    keyFields: [pk, sk, "pk", "sk"],
    evaluateFilter: true,
  })
  return { partition, layer: partition.layer }
}

/** The typed client's `Cells` over `layer`'s client. */
const withCells = <X, E>(
  layer: Layer.Layer<DynamoClient>,
  body: (cells: CellsClient) => Effect.Effect<X, E>,
): Effect.Effect<X, E> =>
  Effect.flatMap(cellsClient, (cells) => body(cells)).pipe(
    Effect.provide(Layer.merge(layer, CellTableLayer)),
  )

const cellsClient = Effect.map(
  DynamoClient.make({ entities: { Cells }, tables: { CellTable } }),
  (db) => db.entities.Cells,
)
type CellsClient = Effect.Success<typeof cellsClient>

const cellIds = (cells: ReadonlyArray<{ readonly cellId: string }>) =>
  cells.map((cell) => cell.cellId)

/** The box of design §10.3: addresses 14, 15, 36 and 37. */
const BOX_10_3 = { x: { between: [3, 4] }, y: { between: [2, 3] } } as const
/** Three precise ranges: [6, 7], [12, 15], [36, 37]. */
const BOX_3 = { x: { between: [1, 4] }, y: { between: [2, 3] } } as const

const cellsIn = (
  cells: ReadonlyArray<Cell>,
  xs: readonly [number, number],
  ys: readonly [number, number],
) =>
  cells
    .filter((cell) => cell.x >= xs[0] && cell.x <= xs[1] && cell.y >= ys[0] && cell.y <= ys[1])
    .sort(
      (a, b) =>
        (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) ||
        address(a.x, a.y) - address(b.x, b.y),
    )

/** A request's sort key operands, as `explain` shows them. */
const hex = (bytes: Uint8Array | undefined) =>
  bytes === undefined
    ? undefined
    : `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`

const skOperands = (input: QueryCommandInput) => {
  const values = input.ExpressionAttributeValues ?? {}
  const between = /#sk BETWEEN (:\w+) AND (:\w+)/.exec(input.KeyConditionExpression ?? "")
  if (between) return [hex(values[between[1]!]!.B), hex(values[between[2]!]!.B)] as const
  const prefix = /begins_with\(#sk, (:\w+)\)/.exec(input.KeyConditionExpression ?? "")
  if (prefix) return [`begins_with ${hex(values[prefix[1]!]!.B)}`] as const
  // A one-address range.
  const equal = /#sk = (:\w+)/.exec(input.KeyConditionExpression ?? "")
  if (equal) return [hex(values[equal[1]!]!.B), hex(values[equal[1]!]!.B)] as const
  return [] as const
}

const queries = (partition: Partition) => partition.inputs as Array<QueryCommandInput>

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

const ITEMS = randomZListings(171, 600)
const ROWS = storedRows(ITEMS)
const ROW_OF = new Map(ITEMS.map((item, i) => [item.listingId, ROWS[i]!]))

/** `items` in `accessor`'s index order: sort key bytes, then the table key. */
const indexOrder = (
  accessor: Accessor,
  items: ReadonlyArray<ZListing>,
  reverse = false,
): Array<string> => {
  const sk = INDEX[accessor].sk
  const bytes = (item: ZListing) => ROW_OF.get(item.listingId)![sk]!.B!
  const sorted = [...items].sort(
    (a, b) =>
      compareBytes(bytes(a), bytes(b)) ||
      (a.listingId < b.listingId ? -1 : a.listingId > b.listingId ? 1 : 0),
  )
  return (reverse ? sorted.reverse() : sorted).map((item) => item.listingId)
}

type ListingsClient = Effect.Success<typeof listings>

/** Run `body` over `accessor`'s partition of `rows`. */
const over = <X, E>(
  accessor: Accessor,
  body: (listings: ListingsClient, partition: Partition) => Effect.Effect<X, E>,
  rows: ReadonlyArray<Row> = ROWS,
): Effect.Effect<X, E> => {
  const { partition, layer } = servePartition(accessor, rows)
  return Effect.flatMap(listings, (client) => body(client, partition)).pipe(Effect.provide(layer))
}

/** Every page of a `fetch` chain, from the start. */
const fetchAll = <A, E>(query: {
  readonly fetch: () => Effect.Effect<Query.Page<A>, E>
  readonly startFrom: (cursor: string) => { readonly fetch: () => Effect.Effect<Query.Page<A>, E> }
}) =>
  Effect.gen(function* () {
    const pages: Array<Query.Page<A>> = []
    let cursor = Option.none<string>()
    do {
      const page = yield* Option.match(cursor, {
        onNone: () => query,
        onSome: (resume) => query.startFrom(resume),
      }).fetch()
      pages.push(page)
      cursor = page.cursor
      if (pages.length > 2_000) return yield* Effect.die(new Error("the fetch chain did not end"))
    } while (Option.isSome(cursor))
    return pages
  })

/** Record every request event. */
const recorder = () => {
  const events: Array<Query.QueryRequestEvent> = []
  return {
    events,
    observe: (event: Query.QueryRequestEvent) => Effect.sync(() => void events.push(event)),
  }
}

/** A random numeric bound over `[min, max]`, and the predicate it means. */
const randomRange = (
  next: () => number,
  min: number,
  max: number,
): { readonly bound: RangeBound<number>; readonly holds: (value: number) => boolean } => {
  const pick = () => min + Math.floor(next() * (max - min + 1))
  const a = pick()
  const b = Math.min(max, a + Math.floor(next() * ((max - min) / 2 + 1)))
  switch (Math.floor(next() * 6)) {
    case 0:
      return { bound: { eq: a }, holds: (v) => v === a }
    case 1:
      return { bound: { between: [a, b] }, holds: (v) => v >= a && v <= b }
    case 2:
      return { bound: { gt: a, lt: b }, holds: (v) => v > a && v < b }
    case 3:
      return { bound: { gte: a }, holds: (v) => v >= a }
    case 4:
      return { bound: { lt: b }, holds: (v) => v < b }
    default:
      return { bound: { gte: a, lte: b }, holds: (v) => v >= a && v <= b }
  }
}

const STRATEGIES = ["naive", "jump", "precise", "auto"] as const

const inFacets = (prices: readonly [number, number], beds: readonly [number, number]) =>
  ITEMS.filter(
    (l) =>
      l.price >= prices[0] &&
      l.price <= prices[1] &&
      l.bedrooms >= beds[0] &&
      l.bedrooms <= beds[1],
  )

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

describe("Z-order strategies (#171 §5.5)", () => {
  it.effect("naive, jump, precise and auto each return the brute-force set, in index order", () =>
    over("byFacets", (L, partition) =>
      Effect.gen(function* () {
        const boxes = [
          [
            [100, 400],
            [2, 5],
          ],
          [
            [0, 1023],
            [7, 7],
          ],
          [
            [512, 530],
            [0, 15],
          ],
          [
            [3, 900],
            [1, 14],
          ],
        ] as const
        for (const [prices, beds] of boxes) {
          const query = L.byFacets({ region: "north" }).within({
            price: { between: prices },
            bedrooms: { between: beds },
          })
          for (const strategy of STRATEGIES) {
            for (const reverse of [false, true]) {
              partition.clear()
              const q = query.zorder({ strategy })
              const got = yield* (reverse ? q.reverse() : q).collect()
              expect(ids(got).length).toBeGreaterThan(0)
              expect(got.map((l) => l.listingId)).toEqual(
                indexOrder("byFacets", inFacets(prices, beds), reverse),
              )
            }
          }
        }
      }),
    ),
  )

  it.effect("random boxes: every strategy and maxRanges equals brute force", () =>
    over("byFacets", (L) =>
      Effect.gen(function* () {
        const next = random(9_171)
        for (let round = 0; round < 40; round++) {
          const price = randomRange(next, 0, 1023)
          const beds = randomRange(next, 0, 15)
          const strategy = STRATEGIES[Math.floor(next() * STRATEGIES.length)]!
          const maxRanges = [1, 2, 4, 16, 64][Math.floor(next() * 5)]!
          const reverse = next() < 0.5
          const q = L.byFacets({ region: "north" })
            .within({ price: price.bound, bedrooms: beds.bound })
            .zorder({ strategy, maxRanges })
          const got = yield* (reverse ? q.reverse() : q).collect()
          const want = ITEMS.filter((l) => price.holds(l.price) && beds.holds(l.bedrooms))
          expect(got.map((l) => l.listingId)).toEqual(indexOrder("byFacets", want, reverse))
        }
      }),
    ),
  )

  it.effect("auto: precise when the exact plan fits maxRanges, else jump", () =>
    withCells(cellPartition(CELL_ROWS).layer, (cells) =>
      Effect.gen(function* () {
        const query = cells.byXY({ grid: "g" }).within(BOX_10_3)
        const fits = yield* query.explain()
        expect(fits.plan).toBe("precise")
        expect(fits.reason).toBe("exact plan fits maxRanges")
        const over = yield* query.zorder({ maxRanges: 1 }).explain()
        expect(over.plan).toBe("jump")
        expect(over.reason).toBe("exact plan over maxRanges")
        expect(over.zorder?.exactRanges).toBe("over-cap")
        const explicit = yield* query.zorder({ strategy: "naive" }).explain()
        expect([explicit.plan, explicit.reason]).toEqual(["naive", "explicit strategy"])
        // `{}` bounds nothing: the query is the accessor's own.
        const none = yield* cells.byXY({ grid: "g" }).within({}).explain()
        expect(none.plan).toBe("key")
      }),
    ),
  )

  it.effect("an empty box sends nothing — inverted bounds and an empty literals selection", () =>
    Effect.gen(function* () {
      yield* over("byFacets", (L, partition) =>
        Effect.gen(function* () {
          const query = L.byFacets({ region: "north" }).within({ price: { gte: 500, lte: 100 } })
          expect(yield* query.collect()).toEqual([])
          expect(yield* query.count()).toBe(0)
          expect(yield* query.fetch()).toEqual({ items: [], cursor: Option.none() })
          expect(yield* Stream.runCollect(query.paginate())).toEqual([])
          expect((yield* query.explain()).plan).toBe("empty")
          expect(partition.inputs).toEqual([])
        }),
      )
      yield* over("byStatus", (L, partition) =>
        Effect.gen(function* () {
          const query = L.byStatus({ region: "north" }).within({ status: { gt: "withdrawn" } })
          expect(yield* query.collect()).toEqual([])
          expect(partition.inputs).toEqual([])
        }),
      )
    }),
  )
})

// ---------------------------------------------------------------------------
// limit, maxPages and fetch chains
// ---------------------------------------------------------------------------

describe("Z-order limit, maxPages and fetch chains (#171 §9.2, §10.3)", () => {
  const PRICES = [150, 700] as const
  const BEDS = [3, 9] as const
  const want = indexOrder("byFacets", inFacets(PRICES, BEDS))

  it.effect("limit returns the first n in index order; maxPages caps the requests", () =>
    over("byFacets", (L, partition) =>
      Effect.gen(function* () {
        for (const strategy of STRATEGIES) {
          const query = L.byFacets({ region: "north" })
            .within({ price: { between: PRICES }, bedrooms: { between: BEDS } })
            .zorder({ strategy })
          for (const n of [1, 5, 17]) {
            expect(ids(yield* query.limit(n).collect()).length).toBe(n)
            expect((yield* query.limit(n).collect()).map((l) => l.listingId)).toEqual(
              want.slice(0, n),
            )
          }
          partition.clear()
          const capped = yield* query.maxPages(2).collect()
          expect(partition.inputs.length).toBeLessThanOrEqual(2)
          expect(capped.map((l) => l.listingId)).toEqual(want.slice(0, capped.length))
        }
      }),
    ),
  )

  it.effect("a fetch chain equals one collect, for every limit and strategy, both ways", () =>
    over("byFacets", (L) =>
      Effect.gen(function* () {
        for (const strategy of ["naive", "jump", "precise"] as const) {
          for (const reverse of [false, true]) {
            const base = L.byFacets({ region: "north" })
              .within({ price: { between: [400, 520] }, bedrooms: { between: [5, 10] } })
              .zorder({ strategy, maxRanges: 8 })
            const query = reverse ? base.reverse() : base
            const all = (yield* query.collect()).map((l) => l.listingId)
            expect(all.length).toBeGreaterThan(5)
            for (let limit = 1; limit <= all.length + 1; limit++) {
              const pages = yield* fetchAll(query.limit(limit))
              expect(pages.flatMap((page) => page.items).map((l) => l.listingId)).toEqual(all)
              for (const page of pages.slice(0, -1)) expect(page.items.length).toBe(limit)
            }
          }
        }
      }),
    ),
  )

  it.effect("precise: a limit landing exactly on a range end resumes at the next range", () => {
    const { partition, layer } = cellPartition(CELL_ROWS)
    return withCells(layer, (cells) =>
      Effect.gen(function* () {
        const query = cells.byXY({ grid: "g" }).within(BOX_10_3).zorder({ strategy: "precise" })
        const first = yield* query.limit(2).fetch()
        expect(cellIds(first.items)).toEqual(["a-3-2", "a-3-3"])
        // Through the end of [14, 15]: nothing of the next range was read.
        expect(Cursor.decode(Option.getOrThrow(first.cursor))?.a).toEqual(
          Cursor.keyValueToWire(Uint8Array.of(15)),
        )
        partition.clear()
        const rest = yield* fetchAll(query.limit(2).startFrom(Option.getOrThrow(first.cursor)))
        expect(skOperands(queries(partition)[0]!)).toEqual(["0x24", "0x25"])
        expect(cellIds(rest.flatMap((page) => page.items))).toEqual(["a-4-2", "a-4-3"])
      }),
    )
  })

  it.effect("jump: a limit filled before an out-of-box LastEvaluatedKey jumps on resume", () => {
    const { partition, layer } = cellPartition(CELL_ROWS)
    return withCells(layer, (cells) =>
      Effect.gen(function* () {
        // Limit 3 examines 14, 15 and 16: the last evaluated key is out of the box.
        const query = cells
          .byXY({ grid: "g" })
          .within(BOX_10_3)
          .zorder({ strategy: "jump", pageSize: 3 })
        const first = yield* query.limit(2).fetch()
        expect(cellIds(first.items)).toEqual(["a-3-2", "a-3-3"])
        expect(partition.responses[0]).toEqual({ scannedCount: 3, count: 2 })
        partition.clear()
        const rest = yield* fetchAll(query.limit(2).startFrom(Option.getOrThrow(first.cursor)))
        // From the next in-box address after 16: 36.
        expect(skOperands(queries(partition)[0]!)).toEqual(["0x24", "0x25"])
        expect(queries(partition)[0]!.ExclusiveStartKey).toBeUndefined()
        expect(cellIds(rest.flatMap((page) => page.items))).toEqual(["a-4-2", "a-4-3"])
      }),
    )
  })

  it.effect("skip-scan: a limit landing on a tuple's end probes for the next tuple", () => {
    const { partition, layer } = cellPartition(GROUP_ROWS, "byGroup")
    return withCells(layer, (cells) =>
      Effect.gen(function* () {
        const query = cells.byGroup({ grid: "g" }).within(BOX_10_3)
        expect((yield* query.explain()).plan).toBe("skip-scan")
        const all = cellIds(cellsIn(GROUP_CELLS, [3, 4], [2, 3]))
        expect(cellIds(yield* query.collect())).toEqual(all)
        const first = yield* query.limit(4).fetch()
        expect(cellIds(first.items)).toEqual(all.slice(0, 4))
        partition.clear()
        const rest = yield* fetchAll(query.limit(4).startFrom(Option.getOrThrow(first.cursor)))
        // The next request is a probe past the first tuple, never a read of it.
        expect(queries(partition)[0]!.ProjectionExpression).toBe("#sk")
        expect(cellIds(rest.flatMap((page) => page.items))).toEqual(all.slice(4))
      }),
    )
  })

  it.effect("the limit filled by the first window member: later members are read again", () => {
    const { partition, layer } = cellPartition(CELL_ROWS)
    return withCells(layer, (cells) =>
      Effect.gen(function* () {
        const { events, observe } = recorder()
        const query = cells.byXY({ grid: "g" }).within(BOX_3).zorder({ strategy: "precise" })
        expect((yield* query.explain()).keyConditions.map((k) => [k.lower, k.upper])).toEqual([
          ["0x06", "0x07"],
          ["0x0c", "0x0f"],
          ["0x24", "0x25"],
        ])
        // Window 1 reads [6, 7]; window 2 sends [12, 15] and [36, 37] — the
        // first fills the limit, so the second is sent and discarded.
        const first = yield* query.limit(6).onRequest(observe).fetch()
        expect(first.items.length).toBe(6)
        expect(queries(partition).map(skOperands)).toEqual([
          ["0x06", "0x07"],
          ["0x0c", "0x0f"],
          ["0x24", "0x25"],
        ])
        // Every request is reported, the discarded one too: its rows were read.
        expect(
          events.map((event) => [event.request, event.upper, event.accepted, event.discarded]),
        ).toEqual([
          [1, "0x07", 2, false],
          [2, "0x0f", 4, false],
          [3, "0x25", 0, true],
        ])
        expect(events[2]!.scannedCount).toBe(2)
        expect(events.reduce((sum, event) => sum + event.scannedCount, 0)).toBe(
          partition.responses.reduce((sum, response) => sum + response.scannedCount, 0),
        )
        partition.clear()
        const rest = yield* query.limit(6).startFrom(Option.getOrThrow(first.cursor)).fetch()
        expect(queries(partition).map(skOperands)).toEqual([["0x24", "0x25"]])
        expect(cellIds([...first.items, ...rest.items])).toEqual(
          cellIds(cellsIn(CELLS, [1, 4], [2, 3])),
        )
        expect(rest.cursor).toEqual(Option.none())
      }),
    )
  })

  it.effect("cross-plan resume: a precise cursor resumed under maxRanges 1, naive and jump", () => {
    const { partition, layer } = cellPartition(CELL_ROWS)
    return withCells(layer, (cells) =>
      Effect.gen(function* () {
        const query = cells.byXY({ grid: "g" }).within(BOX_10_3)
        const first = yield* query.zorder({ maxRanges: 16 }).limit(2).fetch()
        expect(cellIds(first.items)).toEqual(["a-3-2", "a-3-3"])
        for (const [options, operands] of [
          // [14, 37] clipped at 15: [16, 37] — the rows at 36 and 37 are still read.
          [{ strategy: "precise", maxRanges: 1 }, ["0x10", "0x25"]],
          [{ strategy: "naive" }, ["0x10", "0x25"]],
          // `auto` over the cap is jump: from the next in-box address after 15.
          [{ maxRanges: 1 }, ["0x24", "0x25"]],
        ] as const) {
          partition.clear()
          const rest = yield* query
            .zorder(options)
            .startFrom(Option.getOrThrow(first.cursor))
            .collect()
          expect(skOperands(queries(partition)[0]!)).toEqual(operands)
          expect(cellIds(rest)).toEqual(["a-4-2", "a-4-3"])
        }
      }),
    )
  })

  it.effect("cross-plan resume over random plans returns exactly the remaining rows", () =>
    over("byFacets", (L) =>
      Effect.gen(function* () {
        const next = random(4_242)
        const plan = () => ({
          strategy: STRATEGIES[Math.floor(next() * STRATEGIES.length)]!,
          maxRanges: [1, 3, 16, 64][Math.floor(next() * 4)]!,
        })
        for (let round = 0; round < 60; round++) {
          const price = randomRange(next, 0, 1023)
          const beds = randomRange(next, 0, 15)
          const reverse = next() < 0.5
          const base = L.byFacets({ region: "north" }).within({
            price: price.bound,
            bedrooms: beds.bound,
          })
          const query = reverse ? base.reverse() : base
          const want = indexOrder(
            "byFacets",
            ITEMS.filter((l) => price.holds(l.price) && beds.holds(l.bedrooms)),
            reverse,
          )
          const limit = 1 + Math.floor(next() * Math.max(1, want.length))
          const first = yield* query.zorder(plan()).limit(limit).fetch()
          const rest = Option.isNone(first.cursor)
            ? []
            : yield* query.zorder(plan()).startFrom(first.cursor.value).collect()
          expect([...first.items, ...rest].map((l) => l.listingId)).toEqual(want)
        }
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Windows, streams, throttling and concurrency
// ---------------------------------------------------------------------------

/**
 * A client whose `query` yields mid-request, recording the requests in flight
 * together (`batches`: whether each one stopped with a `LastEvaluatedKey`)
 * and the most in flight at once.
 */
const concurrent = (partition: Partition) => {
  let inFlight = 0
  let peak = 0
  const batches: Array<Array<boolean>> = []
  const layer = mockDynamoClientLayer({
    query: (input) =>
      Effect.gen(function* () {
        if (inFlight === 0) batches.push([])
        const batch = batches[batches.length - 1]!
        inFlight++
        peak = Math.max(peak, inFlight)
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        inFlight--
        const output = yield* partition.query(input)
        batch.push(output.LastEvaluatedKey !== undefined)
        return output
      }),
  })
  return { batches, layer, peak: () => peak }
}

/** 16 cells: every x in [0, 7], y in [1, 2] — 12 precise ranges of one or two rows. */
const WIDE = { x: { between: [0, 7] }, y: { between: [1, 2] } } as const

describe("Z-order windows, streams and throttling (#171 §9.2–§9.5)", () => {
  it.effect(
    "the fetch window grows after single-page ranges and resets on a LastEvaluatedKey",
    () =>
      Effect.gen(function* () {
        const { partition } = cellPartition(CELL_ROWS)
        const grown = concurrent(partition)
        yield* withCells(grown.layer, (cells) =>
          cells.byXY({ grid: "g" }).within(WIDE).zorder({ strategy: "precise" }).limit(100).fetch(),
        )
        // 12 ranges: windows of 1, 2, then 4 (the cap with a limit) until the plan ends.
        expect(grown.batches.map((batch) => batch.length)).toEqual([1, 2, 4, 4, 1])
        // `pageSize(1)`: every read stops at its Limit, so each window is one range.
        const reset = concurrent(partition)
        const page = yield* withCells(reset.layer, (cells) =>
          cells
            .byXY({ grid: "g" })
            .within(WIDE)
            .zorder({ strategy: "precise" })
            .pageSize(1)
            .limit(100)
            .fetch(),
        )
        expect(page.items.length).toBe(16)
        // After a window in which a read stopped at its Limit, one range; else twice as many.
        // (The last range, [43, 43], has no range following it: its windows are 1.)
        const sizes = reset.batches.map((batch) => batch.length)
        const last = reset.batches.length - 3
        for (let i = 1; i < reset.batches.length; i++) {
          const stopped = reset.batches[i - 1]!.some((lek) => lek)
          if (stopped) expect(sizes[i]).toBe(1)
          else if (i < last) expect(sizes[i]).toBe(sizes[i - 1]! * 2)
        }
        expect(sizes).toContain(2)
      }),
  )

  it.effect("a stream reads each range once, and buffers what it read ahead", () => {
    const { partition, layer } = cellPartition(CELL_ROWS)
    return withCells(layer, (cells) =>
      Effect.gen(function* () {
        const { events, observe } = recorder()
        const query = cells.byXY({ grid: "g" }).within(WIDE).zorder({ strategy: "precise" })
        const all = cellIds(yield* query.collect())
        let discarded = 0
        for (const limit of [3, 7, 16, 100]) {
          partition.clear()
          events.length = 0
          const streamed = yield* Stream.runCollect(
            query.limit(limit).onRequest(observe).paginate(),
          )
          expect(cellIds(streamed)).toEqual(all.slice(0, limit))
          // No range is read twice: a read ahead of the head range waits its turn.
          const sent = queries(partition).map((input) =>
            JSON.stringify([skOperands(input), input.ExclusiveStartKey]),
          )
          expect(new Set(sent).size).toBe(sent.length)
          // Every read sent is reported, once; one read ahead and never emitted is discarded.
          expect(events.map((event) => event.request).sort((a, b) => a - b)).toEqual(
            sent.map((_, i) => i + 1),
          )
          expect(events.reduce((sum, event) => sum + event.accepted, 0)).toBe(streamed.length)
          for (const event of events.filter((e) => e.discarded)) expect(event.accepted).toBe(0)
          if (limit >= all.length) expect(events.some((event) => event.discarded)).toBe(false)
          discarded += events.filter((event) => event.discarded).length
        }
        expect(discarded).toBeGreaterThan(0)
        // Without a limit, one range at a time — each read emitted.
        partition.clear()
        events.length = 0
        expect(cellIds(yield* Stream.runCollect(query.onRequest(observe).paginate()))).toEqual(all)
        expect(events.length).toBe(queries(partition).length)
      }),
    )
  })

  /** A client that throttles reads of the range starting at `lower` while `on()` holds. */
  const throttling = (
    partition: Partition,
    lower: string,
    error: () => ThrottlingError | DynamoError,
    on: () => boolean,
  ) =>
    mockDynamoClientLayer({
      query: (input) =>
        skOperands(input)[0] === lower && on() ? Effect.fail(error()) : partition.query(input),
    })

  it.effect("a throttled later range: fetch returns the prefix and a cursor; collect fails", () =>
    Effect.gen(function* () {
      for (const error of [
        () => new ThrottlingError({ operation: "Query", cause: { name: "ThrottlingException" } }),
        () => new DynamoError({ operation: "Query", cause: { name: "RequestLimitExceeded" } }),
      ]) {
        const { partition } = cellPartition(CELL_ROWS)
        let throttled = true
        const layer = throttling(partition, "0x24", error, () => throttled)
        const all = cellIds(cellsIn(CELLS, [1, 4], [2, 3]))
        const query = (cells: CellsClient) =>
          cells.byXY({ grid: "g" }).within(BOX_3).zorder({ strategy: "precise" })
        const first = yield* withCells(layer, (cells) => query(cells).limit(100).fetch())
        expect(cellIds(first.items)).toEqual(all.slice(0, 6))
        throttled = false
        const rest = yield* withCells(layer, (cells) =>
          query(cells).limit(100).startFrom(Option.getOrThrow(first.cursor)).fetch(),
        )
        expect(cellIds([...first.items, ...rest.items])).toEqual(all)
        throttled = true
        const failed = yield* withCells(layer, (cells) => Effect.flip(query(cells).collect()))
        expect(failed._tag).toBe(error()._tag)
      }
    }),
  )

  it.effect("a throttled first range fails fetch", () => {
    const { partition } = cellPartition(CELL_ROWS)
    const layer = throttling(
      partition,
      "0x06",
      () => new ThrottlingError({ operation: "Query", cause: { name: "ThrottlingException" } }),
      () => true,
    )
    return Effect.gen(function* () {
      const failed = yield* withCells(layer, (cells) =>
        Effect.flip(
          cells.byXY({ grid: "g" }).within(BOX_3).zorder({ strategy: "precise" }).limit(9).fetch(),
        ),
      )
      expect(failed._tag).toBe("ThrottlingError")
    })
  })

  it.effect("collect: concurrency 1 and 4 return the same rows in the same order", () =>
    Effect.gen(function* () {
      const { partition } = cellPartition(CELL_ROWS)
      const results: Array<Array<string>> = []
      const peaks: Array<number> = []

      for (const concurrency of [1, 4]) {
        const client = concurrent(partition)
        results.push(
          cellIds(
            yield* withCells(client.layer, (cells) =>
              cells
                .byXY({ grid: "g" })
                .within(WIDE)
                .zorder({ strategy: "precise", concurrency })
                .collect(),
            ),
          ),
        )
        peaks.push(client.peak())
      }
      expect(results[0]).toEqual(results[1])
      expect(results[0]).toEqual(cellIds(cellsIn(CELLS, [0, 7], [1, 2])))
      expect(peaks).toEqual([1, 4])
    }),
  )
})

// ---------------------------------------------------------------------------
// Jump run sizing (§8.5)
// ---------------------------------------------------------------------------

/** Every jump request's Limit follows the run: doubled in the box, reset after a jump. */
const expectRunSizing = (inputs: ReadonlyArray<QueryCommandInput>) => {
  let doubled = 0
  let reset = 0
  expect(inputs[0]!.Limit).toBe(16)
  for (let i = 1; i < inputs.length; i++) {
    const [before, after] = [inputs[i - 1]!, inputs[i]!]
    if (after.ExclusiveStartKey !== undefined) {
      expect(after.Limit).toBe(Math.min(before.Limit! * 2, 1_000))
      doubled++
    } else {
      expect(after.Limit).toBe(16)
      reset++
    }
  }
  return { doubled, reset }
}

describe("Z-order jump run sizing (#171 §8.5)", () => {
  // Gapped: prices in two clusters, so the hull holds long in-box runs and long gaps.
  const GAPPED = randomZListings(77, 800, {
    prices: [
      ...Array.from({ length: 40 }, (_, i) => 200 + i),
      ...Array.from({ length: 40 }, (_, i) => 800 + i),
    ],
  })
  const GAPPED_ROWS = storedRows(GAPPED)
  const bounds = { price: { between: [180, 860] }, bedrooms: { between: [4, 11] } } as const
  const wanted = GAPPED.filter(
    (l) => l.price >= 180 && l.price <= 860 && l.bedrooms >= 4 && l.bedrooms <= 11,
  )

  it.effect("collect: Limits double inside the box and reset after each jump", () =>
    over(
      "byFacets",
      (L, partition) =>
        Effect.gen(function* () {
          const got = yield* L.byFacets({ region: "north" })
            .within(bounds)
            .zorder({ strategy: "jump" })
            .collect()
          expect(ids(got)).toEqual(ids(wanted))
          const { doubled, reset } = expectRunSizing(queries(partition))
          expect(doubled).toBeGreaterThan(0)
          expect(reset).toBeGreaterThan(0)
        }),
      GAPPED_ROWS,
    ),
  )

  it.effect("count: the same run sizing, counted with Select COUNT", () =>
    over(
      "byFacets",
      (L, partition) =>
        Effect.gen(function* () {
          const n = yield* L.byFacets({ region: "north" })
            .within(bounds)
            .zorder({ strategy: "jump" })
            .count()
          expect(n).toBe(wanted.length)
          expect(queries(partition).every((input) => input.Select === "COUNT")).toBe(true)
          const { doubled, reset } = expectRunSizing(queries(partition))
          expect(doubled + reset).toBeGreaterThan(0)
        }),
      GAPPED_ROWS,
    ),
  )

  it.effect("zorder({ pageSize }) wins over pageSize(n), which wins over run sizing", () =>
    over(
      "byFacets",
      (L, partition) =>
        Effect.gen(function* () {
          const query = L.byFacets({ region: "north" }).within(bounds).zorder({ strategy: "jump" })
          for (const [q, limit] of [
            [query.pageSize(9), 9],
            [query.pageSize(9).zorder({ pageSize: 7 }), 7],
          ] as const) {
            partition.clear()
            expect(ids(yield* q.collect())).toEqual(ids(wanted))
            expect(new Set(partition.limits())).toEqual(new Set([limit]))
          }
        }),
      GAPPED_ROWS,
    ),
  )
})

// ---------------------------------------------------------------------------
// Exact bounds (§11)
// ---------------------------------------------------------------------------

describe("Z-order exact bounds (#171 §11)", () => {
  it.effect("a NumberFromString dimension is checked per row and returns the in-box rows", () =>
    over("byText", (L, partition) =>
      Effect.gen(function* () {
        const query = L.byText({ region: "north" }).within({
          priceText: { gte: 95, lt: 610 },
          bedrooms: { lte: 6 },
        })
        const explained = yield* query.explain()
        expect(explained.rowChecks).toEqual(["priceText"])
        expect(explained.filter).toBe("beds <= 6")
        for (const strategy of STRATEGIES) {
          const got = yield* query.zorder({ strategy }).collect()
          expect(got.map((l) => l.listingId)).toEqual(
            indexOrder(
              "byText",
              ITEMS.filter((l) => l.priceText >= 95 && l.priceText < 610 && l.bedrooms <= 6),
            ),
          )
        }
        // The filter never names the stored S attribute: DynamoDB would compare it as text.
        expect(
          queries(partition).every(
            (input) => !Object.values(input.ExpressionAttributeNames ?? {}).includes("priceText"),
          ),
        ).toBe(true)
      }),
    ),
  )

  it.effect("a DateTimeZoned dimension is checked per row as epoch milliseconds", () =>
    over("byOpened", (L) =>
      Effect.gen(function* () {
        const zoned = (ms: number) => DateTime.makeZonedUnsafe(ms, { timeZone: "Asia/Tokyo" })
        const from = zoned(EPOCH_MS + 120 * 3_600_000 + 1_800_000)
        const to = zoned(EPOCH_MS + 610 * 3_600_000)
        const query = L.byOpened({ region: "north" }).within({
          openedAt: { gt: from, lte: to },
          bedrooms: { gte: 2 },
        })
        expect((yield* query.explain()).rowChecks).toEqual(["openedAt"])
        const ms = (l: ZListing) => DateTime.toEpochMillis(l.openedAt)
        const want = ITEMS.filter(
          (l) =>
            ms(l) > DateTime.toEpochMillis(from) &&
            ms(l) <= DateTime.toEpochMillis(to) &&
            l.bedrooms >= 2,
        )
        for (const strategy of STRATEGIES) {
          const got = yield* query.zorder({ strategy }).collect()
          expect(got.map((l) => l.listingId)).toEqual(indexOrder("byOpened", want))
        }
      }),
    ),
  )

  it.effect("DateEpochSeconds: sub-second bounds convert to the stored second exactly", () =>
    over("byListed", (L) =>
      Effect.gen(function* () {
        const seconds = ITEMS.map((l) => Math.floor(DateTime.toEpochMillis(l.listedAt) / 1000))
        const s = seconds[17]!
        const t = seconds[42]!
        const [lo, hi] = s < t ? [s, t] : [t, s]
        const ms = (l: ZListing) => DateTime.toEpochMillis(l.listedAt)
        const at = (second: number, plus: number) => DateTime.makeUnsafe(second * 1000 + plus)
        const cases = [
          [
            { gte: at(lo, 500), lt: at(hi, 500) },
            `(listedAt >= ${lo + 1}) AND (listedAt < ${hi + 1})`,
          ],
          [{ gt: at(lo, 500), lte: at(hi, 500) }, `(listedAt > ${lo}) AND (listedAt <= ${hi})`],
          [{ gte: at(lo, 0), lte: at(hi, 0) }, `(listedAt >= ${lo}) AND (listedAt <= ${hi})`],
        ] as const
        for (const [bound, filter] of cases) {
          const query = L.byListed({ region: "north" }).within({ listedAt: bound })
          expect((yield* query.explain()).filter).toBe(filter)
          const lower = "gte" in bound ? bound.gte : bound.gt
          const upper = "lt" in bound ? bound.lt : bound.lte
          const want = ITEMS.filter(
            (l) =>
              ("gte" in bound
                ? ms(l) >= DateTime.toEpochMillis(lower)
                : ms(l) > DateTime.toEpochMillis(lower)) &&
              ("lt" in bound
                ? ms(l) < DateTime.toEpochMillis(upper)
                : ms(l) <= DateTime.toEpochMillis(upper)),
          )
          expect(want.length).toBeGreaterThan(0)
          expect((yield* query.collect()).map((l) => l.listingId)).toEqual(
            indexOrder("byListed", want),
          )
        }
      }),
    ),
  )

  it.effect(
    "DateEpochSeconds: a window inside one second is planned in whole stored seconds",
    () => {
      // A listing at the whole second T. Its key form and the bounds' floor to the same second.
      const T = EPOCH_MS + 100_000 * 1000
      const s = T / 1000
      const pinned: ZListing = {
        ...ITEMS[0]!,
        listingId: "l-pinned",
        listedAt: DateTime.makeUnsafe(T),
      }
      const all = [...ITEMS, pinned]
      const at = (plus: number) => DateTime.makeUnsafe(T + plus)
      const ms = (l: ZListing) => DateTime.toEpochMillis(l.listedAt)
      const cases = [
        // Holds T: the stored second s.
        [
          { gte: at(0), lt: at(500) },
          (v: number) => v >= T && v < T + 500,
          `(listedAt >= ${s}) AND (listedAt < ${s + 1})`,
        ],
        [
          { gt: at(-500), lte: at(0) },
          (v: number) => v > T - 500 && v <= T,
          `(listedAt > ${s - 1}) AND (listedAt <= ${s})`,
        ],
        // Holds no stored second: nothing is sent.
        [{ gt: at(0), lt: at(1_000) }, (v: number) => v > T && v < T + 1_000, undefined],
        [{ gte: at(500), lte: at(900) }, (v: number) => v >= T + 500 && v <= T + 900, undefined],
      ] as const
      return over(
        "byListed",
        (L, partition) =>
          Effect.gen(function* () {
            for (const [bound, holds, filter] of cases) {
              partition.clear()
              const query = L.byListed({ region: "north" }).within({ listedAt: bound })
              const explained = yield* query.explain()
              const want = all.filter((l) => holds(ms(l))).map((l) => l.listingId)
              const got = (yield* query.collect()).map((l) => l.listingId)
              if (filter === undefined) {
                expect(explained.plan).toBe("empty")
                expect(got).toEqual([])
                expect(partition.inputs).toEqual([])
              } else {
                expect(explained.filter).toBe(filter)
                expect(want).toContain("l-pinned")
                expect([...got].sort()).toEqual([...want].sort())
              }
            }
          }),
        [...ROWS, ...storedRows([pinned])],
      )
    },
  )

  it.effect("literals over 100 members: IN, NOT IN of the complement, else a row check", () =>
    over("byCode", (L) =>
      Effect.gen(function* () {
        const position = (code: string) => CODES.indexOf(code)
        const cases = [
          [{ in: ["c003", "c120", "c249"] }, (i: number) => [3, 120, 249].includes(i), "in"],
          [{ gte: "c010" }, (i: number) => i >= 10, "not-in"],
          [{ between: ["c020", "c139"] }, (i: number) => i >= 20 && i <= 139, "row-check"],
        ] as const
        for (const [bound, holds, kind] of cases) {
          const query = L.byCode({ region: "north" }).within({ code: bound as never })
          const explained = yield* query.explain()
          if (kind === "in") expect(explained.filter).toBe('code IN ("c003", "c120", "c249")')
          if (kind === "not-in")
            expect(explained.filter?.startsWith('NOT (code IN ("c000"')).toBe(true)
          if (kind === "row-check") {
            expect(explained.filter).toBeUndefined()
            expect(explained.rowChecks).toEqual(["code"])
          }
          const want = ITEMS.filter((l) => holds(position(l.code)))
          expect(want.length).toBeGreaterThan(0)
          for (const strategy of STRATEGIES) {
            const got = yield* query.zorder({ strategy }).collect()
            expect(got.map((l) => l.listingId)).toEqual(indexOrder("byCode", want))
          }
        }
      }),
    ),
  )

  it.effect("the exact filter names a renamed field by its stored name", () =>
    over("byFacets", (L, partition) =>
      Effect.gen(function* () {
        const query = L.byFacets({ region: "north" }).within({
          price: { gt: 10, lte: 300 },
          bedrooms: { eq: 4 },
        })
        expect((yield* query.explain()).filter).toBe(
          "(price > 10) AND (price <= 300) AND (beds = 4)",
        )
        const got = yield* query.collect()
        expect(got.map((l) => l.listingId)).toEqual(
          indexOrder(
            "byFacets",
            ITEMS.filter((l) => l.price > 10 && l.price <= 300 && l.bedrooms === 4),
          ),
        )
        const names = Object.values(queries(partition)[0]!.ExpressionAttributeNames ?? {})
        expect(names).toContain("beds")
        expect(names).not.toContain("bedrooms")
        // Never the queried index's key attributes.
        expect(names.filter((name) => name.startsWith("gsi1") && name !== "gsi1pk")).toEqual([
          "gsi1sk",
        ])
        expect(queries(partition)[0]!.FilterExpression).not.toMatch(/#sk/)
      }),
    ),
  )

  it.effect("a hashed prefix value is checked per row: a colliding hash is not a match", () => {
    // Two offices whose 1-byte hashes collide: one key prefix, two values.
    const hashOf = (office: string) => ZOrderCurve.prefixSegment(office, 1)[0]
    const collides = (() => {
      for (let n = 2; n < 10_000; n++) if (hashOf(`o-${n}`) === hashOf("o-1")) return `o-${n}`
      throw new Error("no collision")
    })()
    const items = randomZListings(5, 200).map((item, n) =>
      n % 3 === 0 ? { ...item, agencyId: "ag-1", officeId: n % 2 === 0 ? "o-1" : collides } : item,
    )
    const rows = storedRows(items)
    return over(
      "byAgency",
      (L) =>
        Effect.gen(function* () {
          const query = L.byAgency({ region: "north" }).within({
            agencyId: "ag-1",
            officeId: "o-1",
            price: { lte: 700 },
          })
          const explained = yield* query.explain()
          expect(explained.plan).toBe("precise")
          expect(explained.rowChecks).toEqual(["officeId"])
          const got = yield* query.collect()
          const want = items.filter(
            (l) => l.agencyId === "ag-1" && l.officeId === "o-1" && l.price <= 700,
          )
          expect(want.length).toBeGreaterThan(0)
          expect(ids(got)).toEqual(ids(want))
        }),
      rows,
    )
  })

  it.effect(".select() with a plan borrows the row-checked attribute", () =>
    over("byText", (L, partition) =>
      Effect.gen(function* () {
        const got = yield* L.byText({ region: "north" })
          .within({ priceText: { between: [100, 300] } })
          .select(["listingId", "price"])
          .collect()
        const want = indexOrder(
          "byText",
          ITEMS.filter((l) => l.priceText >= 100 && l.priceText <= 300),
        )
        expect(got.map((l) => l.listingId)).toEqual(want)
        // Borrowed for the check, then stripped: the caller doesn't see it.
        // (The mock applies no projection, so the rest of each row comes back.)
        expect(got.every((item) => !("priceText" in item))).toBe(true)
        const input = queries(partition)[0]!
        const projected = (input.ProjectionExpression ?? "")
          .split(", ")
          .map((name) => input.ExpressionAttributeNames?.[name] ?? name)
        expect(projected).toEqual(expect.arrayContaining(["listingId", "price", "priceText"]))
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// count, explain and onRequest
// ---------------------------------------------------------------------------

describe("Z-order count, explain and onRequest (#171 §3.6, §9.4)", () => {
  it.effect("count equals the brute-force size for every strategy, with and without a limit", () =>
    over("byFacets", (L) =>
      Effect.gen(function* () {
        const want = inFacets([90, 610], [2, 13]).length
        for (const strategy of STRATEGIES) {
          for (const reverse of [false, true]) {
            const base = L.byFacets({ region: "north" })
              .within({ price: { between: [90, 610] }, bedrooms: { between: [2, 13] } })
              .zorder({ strategy })
            const query = reverse ? base.reverse() : base
            expect(yield* query.count()).toBe(want)
            expect(yield* query.limit(7).count()).toBe(7)
            expect(yield* query.limit(want + 5).count()).toBe(want)
          }
        }
      }),
    ),
  )

  it.effect("count with a row check reads the checked attribute, not Select COUNT", () =>
    over("byText", (L, partition) =>
      Effect.gen(function* () {
        const n = yield* L.byText({ region: "north" })
          .within({ priceText: { lte: 400 } })
          .zorder({ strategy: "precise" })
          .count()
        expect(n).toBe(ITEMS.filter((l) => l.priceText <= 400).length)
        expect(queries(partition).every((input) => input.Select !== "COUNT")).toBe(true)
        // Only what the check reads (and what the read is judged by), never the whole item.
        for (const input of queries(partition)) {
          const projected = (input.ProjectionExpression ?? "")
            .split(", ")
            .map((name) => input.ExpressionAttributeNames?.[name] ?? name)
          expect(projected).toContain("priceText")
          expect(projected).not.toContain("listedAt")
        }
      }),
    ),
  )

  it.effect("explain: ranges as hex, the box per dimension, its fill and the exact plan", () =>
    withCells(cellPartition(CELL_ROWS).layer, (cells) =>
      Effect.gen(function* () {
        const explained = yield* cells.byXY({ grid: "g" }).within(BOX_10_3).explain()
        expect(explained).toEqual({
          index: "gsi1",
          plan: "precise",
          reason: "exact plan fits maxRanges",
          keyConditions: [
            { lower: "0x0e", upper: "0x0f", exact: true },
            { lower: "0x24", upper: "0x25", exact: true },
          ],
          filter: "(x >= 3) AND (x <= 4) AND (y >= 2) AND (y <= 3)",
          rowChecks: [],
          sizing: "natural",
          zorder: {
            bits: 6,
            box: [
              { field: "x", bits: 3, levels: [["3", "4"]] },
              { field: "y", bits: 3, levels: [["2", "3"]] },
            ],
            fill: 4 / 24,
            exactRanges: 2,
          },
        })
        const jump = yield* cells
          .byXY({ grid: "g" })
          .within(BOX_10_3)
          .zorder({ strategy: "jump" })
          .explain()
        expect(jump.keyConditions).toEqual([{ lower: "0x0e", upper: "0x25", exact: false }])
      }),
    ),
  )

  it.effect("onRequest reports each read's hex range, Limit and counts", () =>
    withCells(cellPartition(CELL_ROWS).layer, (cells) =>
      Effect.gen(function* () {
        const { events, observe } = recorder()
        yield* cells
          .byXY({ grid: "g" })
          .within(BOX_10_3)
          .zorder({ strategy: "jump", pageSize: 3 })
          .onRequest(observe)
          .collect()
        expect(events).toEqual([
          {
            kind: "read",
            request: 1,
            lower: "0x0e",
            upper: "0x25",
            limit: 3,
            scannedCount: 3,
            count: 2,
            accepted: 2,
            discarded: false,
          },
          {
            kind: "read",
            request: 2,
            lower: "0x24",
            upper: "0x25",
            limit: 3,
            scannedCount: 2,
            count: 2,
            accepted: 2,
            discarded: false,
          },
        ])
      }),
    ),
  )

  it.effect("asParams shows the first range's read", () =>
    withCells(cellPartition(CELL_ROWS).layer, (cells) =>
      Effect.gen(function* () {
        // The bound builder's `Query`, as the untyped surface reaches it.
        const { _query } = cells.byXY({ grid: "g" }).within(BOX_10_3) as unknown as {
          readonly _query: Query.Query<Cell>
        }
        const params = (yield* Query.asParams(_query) as Effect.Effect<
          Record<string, unknown>,
          unknown
        >) as unknown as QueryCommandInput
        expect(skOperands(params)).toEqual(["0x0e", "0x0f"])
      }),
    ),
  )
})
