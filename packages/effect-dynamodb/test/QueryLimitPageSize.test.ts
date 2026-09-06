/**
 * `limit` vs `pageSize` (issue #105).
 *
 * - `limit(n)`    — return at most n items. A contract on RESULTS.
 * - `pageSize(n)` — fetch in batches of n (DynamoDB `Limit`). A contract on
 *                   ROUND TRIPS.
 * - `maxPages(n)` — unchanged hard stop on the number of requests.
 *
 * The matrix below is the specification: every terminal (`collect`, `execute`,
 * `paginate`, `count`) against `limit` alone, `pageSize` alone and both
 * together, each with and without a `FilterExpression`.
 */

import { describe, expect, it } from "@effect/vitest"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Stream } from "effect"
import { beforeEach, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import { createConditionOps } from "../src/internal/Expr.js"
import { createPathBuilder } from "../src/internal/PathBuilder.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"

const ops = createConditionOps<any>()
const pb = createPathBuilder<any>()

const mockQuery = vi.fn()
const mockScan = vi.fn()

const TestDynamoClient = Layer.succeed(DynamoClient, {
  query: (input) =>
    Effect.tryPromise({
      try: () => mockQuery(input),
      catch: (e) => new DynamoError({ operation: "Query", cause: e }),
    }),
  scan: (input) =>
    Effect.tryPromise({
      try: () => mockScan(input),
      catch: (e) => new DynamoError({ operation: "Scan", cause: e }),
    }),
  putItem: () => Effect.die("not used"),
  getItem: () => Effect.die("not used"),
  deleteItem: () => Effect.die("not used"),
  updateItem: () => Effect.die("not used"),
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  transactWriteItems: () => Effect.die("not used"),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
} as any)

const PK = "$myapp#v1#user#u-1"

const keyedQuery = () =>
  Query.make<{ id: string }>({
    tableName: "TestTable",
    indexName: undefined,
    pkField: "pk",
    pkValue: PK,
    skField: "sk",
    entityTypes: ["User"],
    decoder: (raw) => Effect.succeed({ id: raw.id as string }),
    keyFields: ["pk", "sk"],
  })

const keyedScan = () =>
  Query.makeScan<{ id: string }>({
    tableName: "TestTable",
    indexName: undefined,
    entityTypes: ["User"],
    decoder: (raw) => Effect.succeed({ id: raw.id as string }),
    keyFields: ["pk", "sk"],
  })

/** `count` items, each carrying the table key so cursors can be rebuilt. */
const items = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) =>
    toAttributeMap({
      pk: PK,
      sk: `item#${from + i}`,
      id: `u-${from + i}`,
      __edd_e__: "User",
    }),
  )

const lastKey = toAttributeMap({ pk: PK, sk: "cursor" })

const decodeCursor = (cursor: string | null) => JSON.parse(atob(cursor!))

const ids = (xs: ReadonlyArray<{ id: string }>) => xs.map((x) => x.id)

const activeFilter = Query.filterExpr(ops.eq(pb.status, "active"))

describe("Query — limit vs pageSize", () => {
  beforeEach(() => {
    // `reset`, not `clear`: several cases deliberately stop before consuming
    // every queued response, and a leftover `mockResolvedValueOnce` would
    // silently answer the next test's first request.
    vi.resetAllMocks()
  })

  // -------------------------------------------------------------------------
  // collect
  // -------------------------------------------------------------------------

  describe("collect", () => {
    it.effect("limit truncates the result set", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: items(1, 3), LastEvaluatedKey: lastKey })

        const result = yield* keyedQuery().pipe(Query.limit(3), Query.collect)

        expect(ids(result)).toEqual(["u-1", "u-2", "u-3"])
        // Unfiltered, every examined row is an accepted row, so the outstanding
        // budget can be handed to DynamoDB directly.
        expect(mockQuery).toHaveBeenCalledTimes(1)
        expect(mockQuery.mock.calls[0]![0].Limit).toBe(3)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("limit accumulates across requests until n items", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: items(1, 2), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(3, 2), LastEvaluatedKey: lastKey })

        const result = yield* keyedQuery().pipe(Query.limit(3), Query.collect)

        expect(ids(result)).toEqual(["u-1", "u-2", "u-3"])
        expect(mockQuery).toHaveBeenCalledTimes(2)
        // The second request only asks for the outstanding item.
        expect(mockQuery.mock.calls[1]![0].Limit).toBe(1)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("pageSize sets DynamoDB Limit and does NOT bound the result", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: items(1, 3), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(4, 2), LastEvaluatedKey: undefined })

        const result = yield* keyedQuery().pipe(Query.pageSize(3), Query.collect)

        expect(result).toHaveLength(5)
        expect(mockQuery).toHaveBeenCalledTimes(2)
        expect(mockQuery.mock.calls[0]![0].Limit).toBe(3)
        expect(mockQuery.mock.calls[1]![0].Limit).toBe(3)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("pageSize + limit compose — batches of pageSize, up to limit", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: items(1, 2), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(3, 2), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(5, 2), LastEvaluatedKey: lastKey })

        const result = yield* keyedQuery().pipe(Query.pageSize(2), Query.limit(5), Query.collect)

        expect(result).toHaveLength(5)
        expect(mockQuery).toHaveBeenCalledTimes(3)
        expect(mockQuery.mock.calls[0]![0].Limit).toBe(2)
        expect(mockQuery.mock.calls[1]![0].Limit).toBe(2)
        // One item outstanding — never asks for more than it needs.
        expect(mockQuery.mock.calls[2]![0].Limit).toBe(1)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("no limit reads to the end of the key range", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: items(1, 2), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(3, 2), LastEvaluatedKey: undefined })

        const result = yield* keyedQuery().pipe(Query.collect)

        expect(result).toHaveLength(4)
        expect(mockQuery.mock.calls[0]![0].Limit).toBeUndefined()
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("under a filter, limit is never handed to DynamoDB", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: items(1, 3), LastEvaluatedKey: undefined })

        const result = yield* keyedQuery().pipe(activeFilter, Query.limit(3), Query.collect)

        expect(result).toHaveLength(3)
        // `Limit` bounds rows EXAMINED and the filter runs after it, so the
        // limit cannot be expressed as `Limit` — the request is unbounded.
        expect(mockQuery.mock.calls[0]![0].Limit).toBeUndefined()
        expect(mockQuery.mock.calls[0]![0].FilterExpression).toBeDefined()
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("under a filter, pageSize still sizes each request", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: items(1, 1), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(2, 1), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(3, 1), LastEvaluatedKey: lastKey })

        const result = yield* keyedQuery().pipe(
          activeFilter,
          Query.pageSize(10),
          Query.limit(3),
          Query.collect,
        )

        expect(result).toHaveLength(3)
        expect(mockQuery).toHaveBeenCalledTimes(3)
        // Full pageSize each time — the outstanding budget counts accepted
        // rows, which says nothing about how many rows to examine.
        for (const call of mockQuery.mock.calls) expect(call[0].Limit).toBe(10)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("keeps going when a whole page is rejected by the filter", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(1, 2), LastEvaluatedKey: undefined })

        const result = yield* keyedQuery().pipe(activeFilter, Query.limit(2), Query.collect)

        expect(ids(result)).toEqual(["u-1", "u-2"])
        expect(mockQuery).toHaveBeenCalledTimes(3)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("stops at the end of the key range when limit cannot be filled", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: items(1, 1), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(2, 1), LastEvaluatedKey: undefined })

        const result = yield* keyedQuery().pipe(activeFilter, Query.limit(10), Query.collect)

        expect(result).toHaveLength(2)
        expect(mockQuery).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("maxPages still caps the round trips", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: items(1, 1), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(2, 1), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(3, 1), LastEvaluatedKey: lastKey })

        const result = yield* keyedQuery().pipe(
          activeFilter,
          Query.limit(10),
          Query.maxPages(2),
          Query.collect,
        )

        expect(result).toHaveLength(2)
        expect(mockQuery).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("limit(0) returns nothing without a request", () =>
      Effect.gen(function* () {
        const result = yield* keyedQuery().pipe(Query.limit(0), Query.collect)

        expect(result).toEqual([])
        expect(mockQuery).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  // -------------------------------------------------------------------------
  // fetch (Query.execute)
  // -------------------------------------------------------------------------

  describe("fetch", () => {
    it.effect("no limit is still exactly one request", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: items(1, 4), LastEvaluatedKey: lastKey })

        const page = yield* keyedQuery().pipe(Query.execute)

        expect(page.items).toHaveLength(4)
        expect(mockQuery).toHaveBeenCalledTimes(1)
        expect(decodeCursor(page.cursor)).toEqual(lastKey)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("pageSize sizes the single request", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: items(1, 3), LastEvaluatedKey: lastKey })

        const page = yield* keyedQuery().pipe(Query.pageSize(3), Query.execute)

        expect(page.items).toHaveLength(3)
        expect(mockQuery).toHaveBeenCalledTimes(1)
        expect(mockQuery.mock.calls[0]![0].Limit).toBe(3)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("limit accumulates across requests to fill the page", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: items(1, 1), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(2, 2), LastEvaluatedKey: lastKey })

        const page = yield* keyedQuery().pipe(activeFilter, Query.limit(3), Query.execute)

        expect(ids(page.items)).toEqual(["u-1", "u-2", "u-3"])
        expect(mockQuery).toHaveBeenCalledTimes(2)
        expect(decodeCursor(page.cursor)).toEqual(lastKey)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("over-read rebuilds the cursor from the last item returned", () =>
      Effect.gen(function* () {
        // A filtered request cannot be sized, so it accepts 5 items when only 3
        // were asked for. The surplus is discarded — the raw LastEvaluatedKey
        // points past it and would skip those items on the next page.
        mockQuery.mockResolvedValueOnce({ Items: items(1, 5), LastEvaluatedKey: lastKey })

        const page = yield* keyedQuery().pipe(activeFilter, Query.limit(3), Query.execute)

        expect(ids(page.items)).toEqual(["u-1", "u-2", "u-3"])
        expect(decodeCursor(page.cursor)).toEqual(toAttributeMap({ pk: PK, sk: "item#3" }))
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("over-read on the final page still yields a resumable cursor", () =>
      Effect.gen(function* () {
        // No LastEvaluatedKey at all — the key shape comes from `keyFields`.
        mockQuery.mockResolvedValueOnce({ Items: items(1, 5), LastEvaluatedKey: undefined })

        const page = yield* keyedQuery().pipe(activeFilter, Query.limit(2), Query.execute)

        expect(ids(page.items)).toEqual(["u-1", "u-2"])
        expect(decodeCursor(page.cursor)).toEqual(toAttributeMap({ pk: PK, sk: "item#2" }))
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("cursor is null only when genuinely exhausted", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: items(1, 2), LastEvaluatedKey: undefined })

        const page = yield* keyedQuery().pipe(Query.limit(5), Query.execute)

        expect(page.items).toHaveLength(2)
        expect(page.cursor).toBeNull()
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("a rebuilt cursor resumes after what the caller saw", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: items(1, 5), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(4, 2), LastEvaluatedKey: undefined })

        const first = yield* keyedQuery().pipe(activeFilter, Query.limit(3), Query.execute)
        const second = yield* keyedQuery().pipe(
          activeFilter,
          Query.limit(3),
          Query.startFrom(first.cursor!),
          Query.execute,
        )

        expect(ids(second.items)).toEqual(["u-4", "u-5"])
        expect(mockQuery.mock.calls[1]![0].ExclusiveStartKey).toEqual(
          toAttributeMap({ pk: PK, sk: "item#3" }),
        )
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("over-read under a projection borrows key fields, then strips them", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({ pk: PK, sk: "item#1", id: "u-1" }),
            toAttributeMap({ pk: PK, sk: "item#2", id: "u-2" }),
            toAttributeMap({ pk: PK, sk: "item#3", id: "u-3" }),
          ],
          LastEvaluatedKey: undefined,
        })

        const page = yield* keyedQuery().pipe(
          activeFilter,
          Query.select(["id"]),
          Query.limit(2),
          Query.execute,
        )

        // The caller sees exactly what it selected...
        expect(page.items).toEqual([{ id: "u-1" }, { id: "u-2" }])
        // ...while the request also asked for the key attributes, so the
        // truncated page still has an accurate cursor.
        expect(mockQuery.mock.calls[0]![0].ProjectionExpression).toContain("#proj_pk")
        expect(decodeCursor(page.cursor)).toEqual(toAttributeMap({ pk: PK, sk: "item#2" }))
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  // -------------------------------------------------------------------------
  // paginate
  // -------------------------------------------------------------------------

  describe("paginate", () => {
    it.effect("limit(3) yields at most 3 items in total", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: items(1, 2), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(3, 2), LastEvaluatedKey: lastKey })

        const stream = yield* keyedQuery().pipe(Query.limit(3), Query.paginate)
        const pages = yield* Stream.runCollect(stream)

        expect(pages.flat()).toHaveLength(3)
        expect(mockQuery).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("pageSize(2) streams every item in pages of 2", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: items(1, 2), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(3, 2), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(5, 1), LastEvaluatedKey: undefined })

        const stream = yield* keyedQuery().pipe(Query.pageSize(2), Query.paginate)
        const pages = yield* Stream.runCollect(stream)

        expect(pages.map((page) => page.length)).toEqual([2, 2, 1])
        expect(pages.flat()).toHaveLength(5)
        for (const call of mockQuery.mock.calls) expect(call[0].Limit).toBe(2)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("under a filter, limit(2) stops the stream at 2 items", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(1, 3), LastEvaluatedKey: lastKey })

        const stream = yield* keyedQuery().pipe(activeFilter, Query.limit(2), Query.paginate)
        const pages = yield* Stream.runCollect(stream)

        expect(ids(pages.flat())).toEqual(["u-1", "u-2"])
        expect(mockQuery).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("the returned stream is re-runnable", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({ Items: items(1, 2), LastEvaluatedKey: undefined })

        const stream = yield* keyedQuery().pipe(Query.limit(2), Query.paginate)
        const first = yield* Stream.runCollect(stream)
        const second = yield* Stream.runCollect(stream)

        expect(first.flat()).toHaveLength(2)
        expect(second.flat()).toHaveLength(2)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("limit(0) yields an empty stream without a request", () =>
      Effect.gen(function* () {
        const stream = yield* keyedQuery().pipe(Query.limit(0), Query.paginate)
        const pages = yield* Stream.runCollect(stream)

        expect(pages.flat()).toEqual([])
        expect(mockQuery).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  // -------------------------------------------------------------------------
  // count
  // -------------------------------------------------------------------------

  describe("count", () => {
    it.effect("limit caps the count and stops early", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Count: 4, LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Count: 10, LastEvaluatedKey: lastKey })

        const total = yield* keyedQuery().pipe(activeFilter, Query.limit(6), Query.count)

        // 14 matched, but the caller asked for at most 6 — the same number
        // `.collect()` would have returned for the same query.
        expect(total).toBe(6)
        expect(mockQuery).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("limit(1) is a cheap existence check", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Count: 1, LastEvaluatedKey: lastKey })

        const total = yield* keyedQuery().pipe(Query.limit(1), Query.count)

        expect(total).toBe(1)
        expect(mockQuery).toHaveBeenCalledTimes(1)
        expect(mockQuery.mock.calls[0]![0].Limit).toBe(1)
        expect(mockQuery.mock.calls[0]![0].Select).toBe("COUNT")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("a limit that cannot be filled returns what matched", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Count: 2, LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Count: 1, LastEvaluatedKey: undefined })

        const total = yield* keyedQuery().pipe(activeFilter, Query.limit(10), Query.count)

        expect(total).toBe(3)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("pageSize sizes each COUNT request", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Count: 5, LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Count: 5, LastEvaluatedKey: undefined })

        const total = yield* keyedQuery().pipe(Query.pageSize(5), Query.count)

        expect(total).toBe(10)
        for (const call of mockQuery.mock.calls) expect(call[0].Limit).toBe(5)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("no limit counts every matching item", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({ Count: 10, LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Count: 15, LastEvaluatedKey: undefined })

        const total = yield* keyedQuery().pipe(Query.count)

        expect(total).toBe(25)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("limit(0) is 0 without a request", () =>
      Effect.gen(function* () {
        const total = yield* keyedQuery().pipe(Query.limit(0), Query.count)

        expect(total).toBe(0)
        expect(mockQuery).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  // -------------------------------------------------------------------------
  // scan mode
  // -------------------------------------------------------------------------

  describe("scan", () => {
    it.effect("limit truncates while pageSize sizes the request", () =>
      Effect.gen(function* () {
        mockScan
          .mockResolvedValueOnce({ Items: items(1, 2), LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Items: items(3, 2), LastEvaluatedKey: lastKey })

        const result = yield* keyedScan().pipe(Query.pageSize(2), Query.limit(3), Query.collect)

        expect(ids(result)).toEqual(["u-1", "u-2", "u-3"])
        expect(mockScan).toHaveBeenCalledTimes(2)
        expect(mockScan.mock.calls[0]![0].Limit).toBe(2)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("limit alone truncates a single over-reading scan", () =>
      Effect.gen(function* () {
        mockScan.mockResolvedValueOnce({ Items: items(1, 8), LastEvaluatedKey: undefined })

        const result = yield* keyedScan().pipe(activeFilter, Query.limit(3), Query.collect)

        expect(result).toHaveLength(3)
        expect(mockScan).toHaveBeenCalledTimes(1)
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  // -------------------------------------------------------------------------
  // combinator plumbing
  // -------------------------------------------------------------------------

  describe("combinators", () => {
    it("pageSize is immutable and last-wins", () => {
      const original = keyedQuery()
      const sized = original.pipe(Query.pageSize(10), Query.pageSize(25))

      expect(original._state.pageSizeValue).toBeUndefined()
      expect(sized._state.pageSizeValue).toBe(25)
      expect(sized._state.limitValue).toBeUndefined()
    })

    it("pageSize supports data-first application", () => {
      expect(Query.pageSize(keyedQuery(), 12)._state.pageSizeValue).toBe(12)
    })

    it("limit and pageSize are independent state", () => {
      const q = keyedQuery().pipe(Query.pageSize(50), Query.limit(120))

      expect(q._state.pageSizeValue).toBe(50)
      expect(q._state.limitValue).toBe(120)
    })

    it.effect("asParams reports the first request's Limit", () =>
      Effect.gen(function* () {
        const withPageSize = yield* keyedQuery().pipe(Query.pageSize(25), Query.asParams)
        expect(withPageSize.Limit).toBe(25)

        // Unfiltered, a limit is expressible as `Limit`...
        const withLimit = yield* keyedQuery().pipe(Query.limit(7), Query.asParams)
        expect(withLimit.Limit).toBe(7)

        // ...but under a filter it is not.
        const filtered = yield* keyedQuery().pipe(activeFilter, Query.limit(7), Query.asParams)
        expect(filtered.Limit).toBeUndefined()
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })
})
