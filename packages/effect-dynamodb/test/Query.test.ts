import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { beforeEach, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import { DynamoError, ValidationError } from "../src/Errors.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"

// ---------------------------------------------------------------------------
// Mock DynamoClient
// ---------------------------------------------------------------------------

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
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeTestQuery = () =>
  Query.make<{ id: string; name: string }>({
    tableName: "TestTable",
    indexName: undefined,
    pkField: "pk",
    pkValue: "$myapp#v1#user#u-1",
    skField: "sk",
    entityTypes: ["User"],
    decoder: (raw) => Effect.succeed({ id: raw.id as string, name: raw.name as string }),
  })

const makeTestQueryNoSk = () =>
  Query.make<{ id: string }>({
    tableName: "TestTable",
    indexName: "gsi1",
    pkField: "gsi1pk",
    pkValue: "$myapp#v1#user#alice@test.com",
    skField: undefined,
    entityTypes: ["User"],
    decoder: (raw) => Effect.succeed({ id: raw.id as string }),
  })

const makeTopLevelScan = () =>
  Query.makeScan<{ id: string; name: string }>({
    tableName: "TestTable",
    indexName: undefined,
    entityTypes: ["User"],
    decoder: (raw) => Effect.succeed({ id: raw.id as string, name: raw.name as string }),
  })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Query", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe("make", () => {
    it("creates a Query with correct state", () => {
      const q = makeTestQuery()
      expect(Query.isQuery(q)).toBe(true)
      expect(q._state.tableName).toBe("TestTable")
      expect(q._state.pkField).toBe("pk")
      expect(q._state.pkValue).toBe("$myapp#v1#user#u-1")
      expect(q._state.skField).toBe("sk")
      expect(q._state.entityTypes).toEqual(["User"])
      expect(q._state.scanForward).toBe(true)
      expect(q._state.limitValue).toBeUndefined()
    })

    it("creates a Query with GSI index", () => {
      const q = makeTestQueryNoSk()
      expect(q._state.indexName).toBe("gsi1")
      expect(q._state.skField).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // isQuery type guard
  // -------------------------------------------------------------------------

  describe("isQuery", () => {
    it("returns true for Query instances", () => {
      expect(Query.isQuery(makeTestQuery())).toBe(true)
    })

    it("returns false for non-Query values", () => {
      expect(Query.isQuery(null)).toBe(false)
      expect(Query.isQuery({})).toBe(false)
      expect(Query.isQuery("string")).toBe(false)
      expect(Query.isQuery(42)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // where combinator
  // -------------------------------------------------------------------------

  describe("where", () => {
    it("adds eq sort key condition (data-last)", () => {
      const q = makeTestQuery().pipe(Query.where({ eq: "some-sk" }))
      expect(q._state.skConditions).toHaveLength(1)
      expect(q._state.skConditions[0]?.condition).toEqual({ eq: "some-sk" })
    })

    it("adds eq sort key condition (data-first)", () => {
      const q = Query.where(makeTestQuery(), { eq: "some-sk" })
      expect(q._state.skConditions).toHaveLength(1)
    })

    it("adds beginsWith condition", () => {
      const q = makeTestQuery().pipe(Query.where({ beginsWith: "prefix" }))
      expect(q._state.skConditions[0]?.condition).toEqual({ beginsWith: "prefix" })
    })

    it("adds between condition", () => {
      const q = makeTestQuery().pipe(Query.where({ between: ["a", "z"] }))
      expect(q._state.skConditions[0]?.condition).toEqual({ between: ["a", "z"] })
    })

    it("adds gte condition", () => {
      const q = makeTestQuery().pipe(Query.where({ gte: "2024-01-01" }))
      expect(q._state.skConditions[0]?.condition).toEqual({ gte: "2024-01-01" })
    })

    it("adds lte condition", () => {
      const q = makeTestQuery().pipe(Query.where({ lte: "2024-12-31" }))
      expect(q._state.skConditions[0]?.condition).toEqual({ lte: "2024-12-31" })
    })

    it("adds gt condition", () => {
      const q = makeTestQuery().pipe(Query.where({ gt: "100" }))
      expect(q._state.skConditions[0]?.condition).toEqual({ gt: "100" })
    })

    it("adds lt condition", () => {
      const q = makeTestQuery().pipe(Query.where({ lt: "100" }))
      expect(q._state.skConditions[0]?.condition).toEqual({ lt: "100" })
    })

    it("is a no-op when skField is undefined", () => {
      const q = makeTestQueryNoSk().pipe(Query.where({ eq: "val" }))
      expect(q._state.skConditions).toHaveLength(0)
    })

    it("last where wins (replaces previous)", () => {
      const q = makeTestQuery().pipe(Query.where({ eq: "first" }), Query.where({ eq: "second" }))
      expect(q._state.skConditions).toHaveLength(1)
      expect(q._state.skConditions[0]?.condition).toEqual({ eq: "second" })
    })

    it("does not mutate the original query", () => {
      const original = makeTestQuery()
      const modified = original.pipe(Query.where({ eq: "val" }))
      expect(original._state.skConditions).toHaveLength(0)
      expect(modified._state.skConditions).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // filter combinator
  // -------------------------------------------------------------------------

  describe("filter", () => {
    it("adds a filter condition (data-last)", () => {
      const q = makeTestQuery().pipe(Query.filter({ status: "active" }))
      expect(q._state.filterConditions).toHaveLength(1)
      expect(q._state.filterConditions[0]).toEqual({ status: "active" })
    })

    it("adds a filter condition (data-first)", () => {
      const q = Query.filter(makeTestQuery(), { status: "active" })
      expect(q._state.filterConditions).toHaveLength(1)
    })

    it("ANDs multiple filters", () => {
      const q = makeTestQuery().pipe(
        Query.filter({ status: "active" }),
        Query.filter({ role: "admin" }),
      )
      expect(q._state.filterConditions).toHaveLength(2)
    })

    it("does not mutate the original query", () => {
      const original = makeTestQuery()
      const modified = original.pipe(Query.filter({ status: "active" }))
      expect(original._state.filterConditions).toHaveLength(0)
      expect(modified._state.filterConditions).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // limit combinator
  // -------------------------------------------------------------------------

  describe("limit", () => {
    it("sets limit (data-last)", () => {
      const q = makeTestQuery().pipe(Query.limit(10))
      expect(q._state.limitValue).toBe(10)
    })

    it("sets limit (data-first)", () => {
      const q = Query.limit(makeTestQuery(), 25)
      expect(q._state.limitValue).toBe(25)
    })

    it("last limit wins", () => {
      const q = makeTestQuery().pipe(Query.limit(10), Query.limit(50))
      expect(q._state.limitValue).toBe(50)
    })

    it("does not mutate the original query", () => {
      const original = makeTestQuery()
      const modified = original.pipe(Query.limit(5))
      expect(original._state.limitValue).toBeUndefined()
      expect(modified._state.limitValue).toBe(5)
    })
  })

  // -------------------------------------------------------------------------
  // reverse combinator
  // -------------------------------------------------------------------------

  describe("reverse", () => {
    it("sets scanForward to false", () => {
      const q = Query.reverse(makeTestQuery())
      expect(q._state.scanForward).toBe(false)
    })

    it("works in pipe", () => {
      const q = makeTestQuery().pipe(Query.reverse)
      expect(q._state.scanForward).toBe(false)
    })

    it("does not mutate the original query", () => {
      const original = makeTestQuery()
      const reversed = Query.reverse(original)
      expect(original._state.scanForward).toBe(true)
      expect(reversed._state.scanForward).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Pipeable composition
  // -------------------------------------------------------------------------

  describe("pipeable composition", () => {
    it("chains multiple combinators", () => {
      const q = makeTestQuery().pipe(
        Query.where({ beginsWith: "prefix" }),
        Query.filter({ status: "active" }),
        Query.limit(20),
        Query.reverse,
      )

      expect(q._state.skConditions).toHaveLength(1)
      expect(q._state.filterConditions).toHaveLength(1)
      expect(q._state.limitValue).toBe(20)
      expect(q._state.scanForward).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // execute terminal
  // -------------------------------------------------------------------------

  describe("execute", () => {
    it.effect("executes a simple query and returns results", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" }),
            toAttributeMap({ id: "u-2", name: "Bob", __edd_e__: "User" }),
          ],
          LastEvaluatedKey: undefined,
        })

        const q = makeTestQuery()
        const results = yield* Query.collect(q)

        expect(results).toHaveLength(2)
        expect(results[0]).toEqual({ id: "u-1", name: "Alice" })
        expect(results[1]).toEqual({ id: "u-2", name: "Bob" })
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("passes correct query parameters to DynamoDB", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })

        const q = makeTestQuery().pipe(
          Query.where({ beginsWith: "prefix" }),
          Query.limit(10),
          Query.reverse,
        )
        yield* Query.collect(q)

        expect(mockQuery).toHaveBeenCalledOnce()
        const call = mockQuery.mock.calls[0]![0]
        expect(call.TableName).toBe("TestTable")
        expect(call.KeyConditionExpression).toContain("#pk = :pk")
        expect(call.KeyConditionExpression).toContain("begins_with(#sk, :sk)")
        expect(call.Limit).toBe(10)
        expect(call.ScanIndexForward).toBe(false)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("includes entity type filter expression", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })

        const q = makeTestQuery()
        yield* Query.collect(q)

        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("#eddE IN (:et0)")
        expect(call.ExpressionAttributeNames["#eddE"]).toBe("__edd_e__")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("passes index name for GSI queries", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })

        const q = makeTestQueryNoSk()
        yield* Query.collect(q)

        const call = mockQuery.mock.calls[0]![0]
        expect(call.IndexName).toBe("gsi1")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("paginates through multiple pages", () =>
      Effect.gen(function* () {
        const lastKey = toAttributeMap({ pk: "cursor" })
        mockQuery
          .mockResolvedValueOnce({
            Items: [toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" })],
            LastEvaluatedKey: lastKey,
          })
          .mockResolvedValueOnce({
            Items: [toAttributeMap({ id: "u-2", name: "Bob", __edd_e__: "User" })],
            LastEvaluatedKey: undefined,
          })

        const q = makeTestQuery()
        const results = yield* Query.collect(q)

        expect(results).toHaveLength(2)
        expect(mockQuery).toHaveBeenCalledTimes(2)
        // Second call should use ExclusiveStartKey
        expect(mockQuery.mock.calls[1]![0].ExclusiveStartKey).toEqual(lastKey)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("returns empty array for no results", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })

        const q = makeTestQuery()
        const results = yield* Query.collect(q)

        expect(results).toEqual([])
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("propagates DynamoError from client", () =>
      Effect.gen(function* () {
        mockQuery.mockRejectedValueOnce(new Error("connection refused"))

        const q = makeTestQuery()
        const error = yield* Query.collect(q).pipe(Effect.flip)

        expect(error._tag).toBe("DynamoError")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("propagates ValidationError from decoder", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" })],
          LastEvaluatedKey: undefined,
        })

        const failingQuery = Query.make<never>({
          tableName: "TestTable",
          indexName: undefined,
          pkField: "pk",
          pkValue: "key",
          skField: "sk",
          entityTypes: ["User"],
          decoder: () =>
            Effect.fail(
              new ValidationError({ entityType: "User", operation: "decode", cause: "bad data" }),
            ),
        })

        const error = yield* Query.collect(failingQuery).pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("includes user filter conditions in query", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })

        const q = makeTestQuery().pipe(
          Query.filter({ status: "active" }),
          Query.filter({ role: "admin" }),
        )
        yield* Query.collect(q)

        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("#eddE IN (:et0)")
        expect(call.FilterExpression).toContain("#f0 = :f0")
        expect(call.FilterExpression).toContain("#f1 = :f1")
        expect(call.ExpressionAttributeNames["#f0"]).toBe("status")
        expect(call.ExpressionAttributeNames["#f1"]).toBe("role")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds contains filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filter({ tags: { contains: "typescript" } }))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("contains(#f0, :f0)")
        expect(call.ExpressionAttributeNames["#f0"]).toBe("tags")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds beginsWith filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filter({ name: { beginsWith: "Al" } }))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("begins_with(#f0, :f0)")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds between filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filter({ age: { between: [18, 65] } }))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("#f0 BETWEEN :f0 AND :f0b")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds gt filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filter({ score: { gt: 90 } }))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("#f0 > :f0")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds gte filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filter({ score: { gte: 90 } }))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("#f0 >= :f0")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds lt filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filter({ score: { lt: 50 } }))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("#f0 < :f0")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds lte filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filter({ score: { lte: 50 } }))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("#f0 <= :f0")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds ne filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filter({ status: { ne: "deleted" } }))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("#f0 <> :f0")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds exists filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filter({ email: { exists: true } }))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("attribute_exists(#f0)")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds notExists filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filter({ deletedAt: { notExists: true } }))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("attribute_not_exists(#f0)")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("mixes equality and operator filters", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filter({ status: "active", score: { gte: 80 } }))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("#f0 = :f0")
        expect(call.FilterExpression).toContain("#f1 >= :f1")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds eq sort key condition", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })

        const q = makeTestQuery().pipe(Query.where({ eq: "exact-value" }))
        yield* Query.collect(q)

        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).toContain("#sk = :sk")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds between sort key condition", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })

        const q = makeTestQuery().pipe(Query.where({ between: ["a", "z"] }))
        yield* Query.collect(q)

        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).toContain("#sk BETWEEN :sk1 AND :sk2")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds gte sort key condition", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })

        const q = makeTestQuery().pipe(Query.where({ gte: "2024-01-01" }))
        yield* Query.collect(q)

        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).toContain("#sk >= :sk")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds lte sort key condition", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })

        const q = makeTestQuery().pipe(Query.where({ lte: "2024-12-31" }))
        yield* Query.collect(q)

        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).toContain("#sk <= :sk")
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  // -------------------------------------------------------------------------
  // paginate terminal
  // -------------------------------------------------------------------------

  describe("paginate", () => {
    it.effect("returns a Stream of page arrays", () =>
      Effect.gen(function* () {
        const lastKey = toAttributeMap({ pk: "cursor" })
        mockQuery
          .mockResolvedValueOnce({
            Items: [toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" })],
            LastEvaluatedKey: lastKey,
          })
          .mockResolvedValueOnce({
            Items: [toAttributeMap({ id: "u-2", name: "Bob", __edd_e__: "User" })],
            LastEvaluatedKey: undefined,
          })

        const q = makeTestQuery()
        const stream = yield* Query.paginate(q)
        const pagesArray = yield* Stream.runCollect(stream)

        expect(pagesArray).toHaveLength(2)
        expect(pagesArray[0]).toEqual([{ id: "u-1", name: "Alice" }])
        expect(pagesArray[1]).toEqual([{ id: "u-2", name: "Bob" }])
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  // -------------------------------------------------------------------------
  // consistentRead combinator
  // -------------------------------------------------------------------------

  describe("consistentRead", () => {
    it("sets consistentRead state to true (data-last)", () => {
      const q = makeTestQuery().pipe(Query.consistentRead())
      expect(q._state.consistentRead).toBe(true)
    })

    it("sets consistentRead state to true (data-first)", () => {
      const q = Query.consistentRead(makeTestQuery())
      expect(q._state.consistentRead).toBe(true)
    })

    it("defaults to false in initial state", () => {
      const q = makeTestQuery()
      expect(q._state.consistentRead).toBe(false)
    })

    it("does not mutate the original query", () => {
      const original = makeTestQuery()
      const modified = original.pipe(Query.consistentRead())
      expect(original._state.consistentRead).toBe(false)
      expect(modified._state.consistentRead).toBe(true)
    })

    it.effect("passes ConsistentRead to DynamoDB query", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" })],
        })

        const q = makeTestQuery().pipe(Query.consistentRead())
        yield* Query.collect(q)

        expect(mockQuery).toHaveBeenCalledOnce()
        const input = mockQuery.mock.calls[0]![0]
        expect(input.ConsistentRead).toBe(true)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("does not pass ConsistentRead when not set", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" })],
        })

        const q = makeTestQuery()
        yield* Query.collect(q)

        expect(mockQuery).toHaveBeenCalledOnce()
        const input = mockQuery.mock.calls[0]![0]
        expect(input.ConsistentRead).toBeUndefined()
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  // -------------------------------------------------------------------------
  // Scan mode (makeScan)
  // -------------------------------------------------------------------------

  describe("scan", () => {
    const makeTestScan = () =>
      Query.makeScan<{ id: string; name: string }>({
        tableName: "TestTable",
        indexName: undefined,
        entityTypes: ["User"],
        decoder: (raw) => Effect.succeed({ id: raw.id as string, name: raw.name as string }),
      })

    it("creates a scan Query with isScan = true", () => {
      const q = makeTestScan()
      expect(Query.isQuery(q)).toBe(true)
      expect(q._state.isScan).toBe(true)
    })

    it.effect("calls client.scan instead of client.query", () =>
      Effect.gen(function* () {
        mockScan.mockResolvedValueOnce({
          Items: [toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" })],
        })

        const q = makeTestScan()
        const results = yield* Query.collect(q)

        expect(mockScan).toHaveBeenCalledOnce()
        expect(mockQuery).not.toHaveBeenCalled()
        expect(results).toHaveLength(1)
        expect(results[0]).toEqual({ id: "u-1", name: "Alice" })
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("scan includes entity type filter", () =>
      Effect.gen(function* () {
        mockScan.mockResolvedValueOnce({
          Items: [toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" })],
        })

        yield* Query.collect(makeTestScan())

        const input = mockScan.mock.calls[0]![0]
        expect(input.FilterExpression).toContain("#eddE IN (:et0)")
        expect(input.ExpressionAttributeNames!["#eddE"]).toBe("__edd_e__")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("scan supports filter combinator", () =>
      Effect.gen(function* () {
        mockScan.mockResolvedValueOnce({
          Items: [toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" })],
        })

        const q = makeTestScan().pipe(Query.filter({ name: "Alice" }))
        yield* Query.collect(q)

        const input = mockScan.mock.calls[0]![0]
        expect(input.FilterExpression).toContain("#f0 = :f0")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("scan supports limit combinator", () =>
      Effect.gen(function* () {
        mockScan.mockResolvedValueOnce({
          Items: [toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" })],
        })

        const q = makeTestScan().pipe(Query.limit(10))
        yield* Query.collect(q)

        const input = mockScan.mock.calls[0]![0]
        expect(input.Limit).toBe(10)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("scan supports consistentRead", () =>
      Effect.gen(function* () {
        mockScan.mockResolvedValueOnce({
          Items: [toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" })],
        })

        const q = makeTestScan().pipe(Query.consistentRead())
        yield* Query.collect(q)

        const input = mockScan.mock.calls[0]![0]
        expect(input.ConsistentRead).toBe(true)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("scan paginates", () =>
      Effect.gen(function* () {
        const lastKey = toAttributeMap({ pk: "cursor" })
        mockScan
          .mockResolvedValueOnce({
            Items: [toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" })],
            LastEvaluatedKey: lastKey,
          })
          .mockResolvedValueOnce({
            Items: [toAttributeMap({ id: "u-2", name: "Bob", __edd_e__: "User" })],
          })

        const results = yield* Query.collect(makeTestScan())
        expect(results).toHaveLength(2)
        expect(mockScan).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  // ---------------------------------------------------------------------------
  // Wave 5: maxPages, ignoreOwnership, count, asParams
  // ---------------------------------------------------------------------------

  describe("maxPages", () => {
    it.effect("stops pagination after N pages", () =>
      Effect.gen(function* () {
        const lastKey = toAttributeMap({ pk: "cursor" })
        mockQuery
          .mockResolvedValueOnce({
            Items: [toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" })],
            LastEvaluatedKey: lastKey,
          })
          .mockResolvedValueOnce({
            Items: [toAttributeMap({ id: "u-2", name: "Bob", __edd_e__: "User" })],
            LastEvaluatedKey: lastKey, // Would have more pages
          })
          .mockResolvedValueOnce({
            Items: [toAttributeMap({ id: "u-3", name: "Carol", __edd_e__: "User" })],
          })

        const results = yield* makeTestQuery().pipe(Query.maxPages(2), Query.collect)
        // Should only fetch 2 pages, not 3
        expect(results).toHaveLength(2)
        expect(mockQuery).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("maxPages(1) fetches exactly one page", () =>
      Effect.gen(function* () {
        const lastKey = toAttributeMap({ pk: "cursor" })
        mockQuery.mockResolvedValueOnce({
          Items: [toAttributeMap({ id: "u-1", name: "Alice", __edd_e__: "User" })],
          LastEvaluatedKey: lastKey,
        })

        const results = yield* makeTestQuery().pipe(Query.maxPages(1), Query.collect)
        expect(results).toHaveLength(1)
        expect(mockQuery).toHaveBeenCalledTimes(1)
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  describe("ignoreOwnership", () => {
    it.effect("skips __edd_e__ filter for queries", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [toAttributeMap({ id: "u-1", name: "Alice" })],
        })

        yield* makeTestQuery().pipe(Query.ignoreOwnership, Query.collect)

        const input = mockQuery.mock.calls[0]![0]
        // Should NOT have __edd_e__ in the filter expression
        expect(input.FilterExpression).toBeUndefined()
        expect(input.ExpressionAttributeNames["#eddE"]).toBeUndefined()
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("skips __edd_e__ filter for scans", () =>
      Effect.gen(function* () {
        mockScan.mockResolvedValueOnce({
          Items: [toAttributeMap({ id: "u-1", name: "Alice" })],
        })

        yield* makeTopLevelScan().pipe(Query.ignoreOwnership, Query.collect)

        const input = mockScan.mock.calls[0]![0]
        expect(input.FilterExpression).toBeUndefined()
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("preserves user filters when ignoreOwnership is set", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [toAttributeMap({ id: "u-1", name: "Alice" })],
        })

        yield* makeTestQuery().pipe(
          Query.ignoreOwnership,
          Query.filter({ name: "Alice" }),
          Query.collect,
        )

        const input = mockQuery.mock.calls[0]![0]
        // Should have user filter but not entity type filter
        expect(input.FilterExpression).toBeDefined()
        expect(input.FilterExpression).not.toContain("__edd_e__")
        expect(input.FilterExpression).toContain("#f0 = :f0")
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  describe("count", () => {
    it.effect("returns count from single page", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Count: 42 })

        const result = yield* makeTestQuery().pipe(Query.count)
        expect(result).toBe(42)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("sums count across multiple pages", () =>
      Effect.gen(function* () {
        const lastKey = toAttributeMap({ pk: "cursor" })
        mockQuery
          .mockResolvedValueOnce({ Count: 10, LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Count: 15 })

        const result = yield* makeTestQuery().pipe(Query.count)
        expect(result).toBe(25)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("respects maxPages", () =>
      Effect.gen(function* () {
        const lastKey = toAttributeMap({ pk: "cursor" })
        mockQuery
          .mockResolvedValueOnce({ Count: 10, LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Count: 15, LastEvaluatedKey: lastKey })
          .mockResolvedValueOnce({ Count: 20 })

        const result = yield* makeTestQuery().pipe(Query.maxPages(2), Query.count)
        // Should only count 2 pages: 10 + 15 = 25
        expect(result).toBe(25)
        expect(mockQuery).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("uses Select: COUNT", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Count: 5 })

        yield* makeTestQuery().pipe(Query.count)

        const input = mockQuery.mock.calls[0]![0]
        expect(input.Select).toBe("COUNT")
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  describe("asParams", () => {
    it.effect("returns query params without executing", () =>
      Effect.gen(function* () {
        const params = yield* makeTestQuery().pipe(
          Query.where({ beginsWith: "prefix" }),
          Query.filter({ name: "Alice" }),
          Query.limit(10),
          Query.asParams,
        )

        expect(params.TableName).toBe("TestTable")
        expect(params.KeyConditionExpression).toBeDefined()
        expect(params.FilterExpression).toBeDefined()
        expect(params.Limit).toBe(10)
        // Should NOT have called DynamoDB
        expect(mockQuery).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("returns scan params", () =>
      Effect.gen(function* () {
        const params = yield* makeTopLevelScan().pipe(Query.filter({ name: "Bob" }), Query.asParams)

        expect(params.TableName).toBe("TestTable")
        expect(params.FilterExpression).toBeDefined()
        // No KeyConditionExpression for scans
        expect(params.KeyConditionExpression).toBeUndefined()
        expect(mockScan).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  // -------------------------------------------------------------------------
  // Query.select — ProjectionExpression
  // -------------------------------------------------------------------------

  describe("select", () => {
    it.effect("passes ProjectionExpression to query", () =>
      Effect.gen(function* () {
        mockQuery.mockReset()
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$app#v1#user#u-1",
              sk: "$app#v1#user",
              __edd_e__: "User",
              name: "Alice",
              email: "alice@example.com",
            }),
          ],
        })

        const query = makeTestQuery()
        const result = yield* query.pipe(Query.select(["name", "email"]), Query.execute)

        expect(mockQuery).toHaveBeenCalledOnce()
        const call = mockQuery.mock.calls[0]![0]
        expect(call.ProjectionExpression).toBe("#proj_name, #proj_email")
        expect(call.ExpressionAttributeNames).toEqual(
          expect.objectContaining({ "#proj_name": "name", "#proj_email": "email" }),
        )

        expect(result.items).toHaveLength(1)
        expect(result.items[0]).toEqual(
          expect.objectContaining({ name: "Alice", email: "alice@example.com" }),
        )
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("passes ProjectionExpression to scan", () =>
      Effect.gen(function* () {
        mockScan.mockResolvedValueOnce({
          Items: [toAttributeMap({ name: "Bob" })],
        })

        const scan = makeTopLevelScan()
        const result = yield* scan.pipe(Query.select(["name"]), Query.execute)

        expect(result.items).toHaveLength(1)
        expect(result.items[0]).toEqual({ name: "Bob" })

        const call = mockScan.mock.calls[0]![0]
        expect(call.ProjectionExpression).toBe("#proj_name")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("includes ProjectionExpression in asParams", () =>
      Effect.gen(function* () {
        const params = yield* makeTestQuery().pipe(Query.select(["name", "age"]), Query.asParams)

        expect(params.ProjectionExpression).toBe("#proj_name, #proj_age")
        expect(params.ExpressionAttributeNames).toEqual(
          expect.objectContaining({ "#proj_name": "name", "#proj_age": "age" }),
        )
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("returns raw records (skips schema decode)", () =>
      Effect.gen(function* () {
        mockQuery.mockReset()
        mockQuery.mockResolvedValueOnce({
          Items: [toAttributeMap({ name: "Charlie", __edd_e__: "User" })],
        })

        const result = yield* makeTestQuery().pipe(Query.select(["name"]), Query.execute)
        // Raw record — not decoded through entity schema
        expect(result.items[0]).toEqual({ name: "Charlie", __edd_e__: "User" })
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })
})
