import { describe, expect, it } from "@effect/vitest"
import { DynamoError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Stream } from "effect"
import { beforeEach, vi } from "vitest"
import { createConditionOps } from "../src/internal/Expr.js"
import { createPathBuilder } from "../src/internal/PathBuilder.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

/**
 * Attribute shape the filter/condition expressions in this file are written
 * against. `Query` itself is generic over the decoded result type, but the
 * expression builders are generic over the *model*, so they need a concrete
 * model to produce typed paths.
 */
interface TestModel {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly status: string
  readonly role: string
  readonly age: number
  readonly score: number
  readonly tags: ReadonlyArray<string>
  readonly deletedAt?: string
}

const ops = createConditionOps<TestModel>()
const pb = createPathBuilder<TestModel>()

// ---------------------------------------------------------------------------
// Mock DynamoClient
// ---------------------------------------------------------------------------

const mockQuery = vi.fn()
const mockScan = vi.fn()

const TestDynamoClient = mockDynamoClientLayer({
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
      const q = makeTestQuery().pipe(Query.filterExpr(ops.eq(pb.status, "active")))
      expect(q._state.exprFilters).toHaveLength(1)
    })

    it("adds a filter condition (data-first)", () => {
      const q = Query.filterExpr(makeTestQuery(), ops.eq(pb.status, "active"))
      expect(q._state.exprFilters).toHaveLength(1)
    })

    it("ANDs multiple filters", () => {
      const q = makeTestQuery().pipe(
        Query.filterExpr(ops.eq(pb.status, "active")),
        Query.filterExpr(ops.eq(pb.role, "admin")),
      )
      expect(q._state.exprFilters).toHaveLength(2)
    })

    it("does not mutate the original query", () => {
      const original = makeTestQuery()
      const modified = original.pipe(Query.filterExpr(ops.eq(pb.status, "active")))
      expect(original._state.exprFilters).toHaveLength(0)
      expect(modified._state.exprFilters).toHaveLength(1)
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
        Query.filterExpr(ops.eq(pb.status, "active")),
        Query.limit(20),
        Query.reverse,
      )

      expect(q._state.skConditions).toHaveLength(1)
      expect(q._state.exprFilters).toHaveLength(1)
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
          Query.filterExpr(ops.and(ops.eq(pb.status, "active"), ops.eq(pb.role, "admin"))),
        )
        yield* Query.collect(q)

        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("#eddE IN (:et0)")
        expect(call.FilterExpression).toContain("=")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("status")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("role")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds contains filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filterExpr(ops.contains(pb.tags, "typescript")))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("contains(")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("tags")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds beginsWith filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filterExpr(ops.beginsWith(pb.name, "Al")))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("begins_with(")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("name")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds between filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filterExpr(ops.between(pb.age, 18, 65)))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("BETWEEN")
        expect(call.FilterExpression).toContain("AND")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("age")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds gt filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filterExpr(ops.gt(pb.score, 90)))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain(">")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("score")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds gte filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filterExpr(ops.gte(pb.score, 90)))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain(">=")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("score")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds lt filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filterExpr(ops.lt(pb.score, 50)))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("<")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("score")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds lte filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filterExpr(ops.lte(pb.score, 50)))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("<=")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("score")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds ne filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filterExpr(ops.ne(pb.status, "deleted")))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("<>")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("status")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds exists filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filterExpr(ops.exists(pb.email)))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("attribute_exists(")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("email")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("builds notExists filter", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(Query.filterExpr(ops.notExists(pb.deletedAt)))
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("attribute_not_exists(")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("deletedAt")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("mixes equality and operator filters", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
        const q = makeTestQuery().pipe(
          Query.filterExpr(ops.and(ops.eq(pb.status, "active"), ops.gte(pb.score, 80))),
        )
        yield* Query.collect(q)
        const call = mockQuery.mock.calls[0]![0]
        expect(call.FilterExpression).toContain("=")
        expect(call.FilterExpression).toContain(">=")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("status")
        expect(Object.values(call.ExpressionAttributeNames)).toContain("score")
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

        const q = makeTestScan().pipe(Query.filterExpr(ops.eq(pb.name, "Alice")))
        yield* Query.collect(q)

        const input = mockScan.mock.calls[0]![0]
        expect(input.FilterExpression).toContain("=")
        expect(Object.values(input.ExpressionAttributeNames)).toContain("name")
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
          Query.filterExpr(ops.eq(pb.name, "Alice")),
          Query.collect,
        )

        const input = mockQuery.mock.calls[0]![0]
        // Should have user filter but not entity type filter
        expect(input.FilterExpression).toBeDefined()
        expect(input.FilterExpression).not.toContain("__edd_e__")
        expect(input.FilterExpression).toContain("=")
        expect(Object.values(input.ExpressionAttributeNames)).toContain("name")
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
          Query.filterExpr(ops.eq(pb.name, "Alice")),
          Query.pageSize(10),
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
        const params = yield* makeTopLevelScan().pipe(
          Query.filterExpr(ops.eq(pb.name, "Bob")),
          Query.asParams,
        )

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

// ---------------------------------------------------------------------------
// filterBy — client-side predicate inside the accumulate loop (#122)
// ---------------------------------------------------------------------------
//
// `limit` is a contract on RESULTS: the loop accumulates until `n` items are
// accepted and rebuilds the cursor from the last accepted item. Only
// `FilterExpression` could take part in that, so a predicate DynamoDB cannot
// express (case-insensitive matching being the standard case — there is no
// `lower()`) had to be applied after `execute`, which returns a short page AND
// a cursor pointing past items the caller never saw.

describe("filterBy (#122)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** Rows named `n-0` … `n-(count-1)`; even indices are "kept" by the predicate. */
  const rows = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) =>
      toAttributeMap({ pk: "p", sk: `s-${from + i}`, id: `${from + i}`, name: `n-${from + i}` }),
    )

  const isEven = (item: { id: string }) => Number(item.id) % 2 === 0

  describe("combinator", () => {
    it("registers a predicate without mutating the original", () => {
      const original = makeTestQuery()
      const filtered = original.pipe(Query.filterBy(isEven))
      expect(original._state.predicates).toHaveLength(0)
      expect(filtered._state.predicates).toHaveLength(1)
    })

    it("ANDs multiple predicates", () => {
      const q = makeTestQuery().pipe(
        Query.filterBy(isEven),
        Query.filterBy((i: { id: string }) => Number(i.id) > 2),
      )
      expect(q._state.predicates).toHaveLength(2)
    })
  })

  describe("limit fills the page with ACCEPTED items", () => {
    it("keeps asking until the budget is met, not until the rows run out", () =>
      Effect.gen(function* () {
        // 6 rows examined, 3 accepted — a post-execute filter would return 3
        // where the caller asked for 3 only by luck; here it is the contract.
        mockQuery.mockResolvedValueOnce({ Items: rows(0, 6), Count: 6 })

        const page = yield* makeTestQuery().pipe(
          Query.filterBy(isEven),
          Query.limit(3),
          Query.execute,
        )

        expect(page.items.map((i) => i.id)).toEqual(["0", "2", "4"])
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))

    it("spans requests when one page cannot fill the budget", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({
            Items: rows(0, 4),
            Count: 4,
            LastEvaluatedKey: toAttributeMap({ pk: "p", sk: "s-3" }),
          })
          .mockResolvedValueOnce({ Items: rows(4, 4), Count: 4 })

        const page = yield* makeTestQuery().pipe(
          Query.filterBy(isEven),
          Query.limit(3),
          Query.execute,
        )

        expect(page.items.map((i) => i.id)).toEqual(["0", "2", "4"])
        expect(mockQuery).toHaveBeenCalledTimes(2)
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))

    it("does not push `Limit` — the predicate rejects rows after they are examined", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: rows(0, 6), Count: 6 })

        yield* makeTestQuery().pipe(Query.filterBy(isEven), Query.limit(3), Query.execute)

        // Without this, DynamoDB would examine 3 rows and the predicate could
        // accept as few as 0 of them.
        expect(mockQuery.mock.calls[0]![0].Limit).toBeUndefined()
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))

    it("still honours pageSize as the round-trip budget", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: rows(0, 6), Count: 6 })

        yield* makeTestQuery().pipe(
          Query.filterBy(isEven),
          Query.pageSize(50),
          Query.limit(3),
          Query.execute,
        )

        expect(mockQuery.mock.calls[0]![0].Limit).toBe(50)
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))
  })

  describe("the cursor resumes after the last item KEPT", () => {
    it("rebuilds from the last ACCEPTED row, not the last examined one", () =>
      Effect.gen(function* () {
        // Rows 0..5, evens accepted, budget 2 → accepted 0 and 2, stopping at
        // row index 2. Resuming from row 5 (LastEvaluatedKey) or from row 3
        // (the next examined row) would both skip row 4, which the next page
        // still owes the caller.
        mockQuery.mockResolvedValueOnce({
          Items: rows(0, 6),
          Count: 6,
          LastEvaluatedKey: toAttributeMap({ pk: "p", sk: "s-5" }),
        })

        const page = yield* makeTestQuery().pipe(
          Query.filterBy(isEven),
          Query.limit(2),
          Query.execute,
        )

        expect(page.items.map((i) => i.id)).toEqual(["0", "2"])
        expect(page.cursor).not.toBeNull()
        const resume = JSON.parse(atob(page.cursor!))
        expect(resume.sk.S).toBe("s-2")
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))

    it("paging with that cursor returns the next accepted items, none skipped", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: rows(0, 6),
          Count: 6,
          LastEvaluatedKey: toAttributeMap({ pk: "p", sk: "s-5" }),
        })

        const first = yield* makeTestQuery().pipe(
          Query.filterBy(isEven),
          Query.limit(2),
          Query.execute,
        )

        // The mock replays from the cursor position — rows 3..5.
        mockQuery.mockResolvedValueOnce({ Items: rows(3, 3), Count: 3 })

        const second = yield* makeTestQuery().pipe(
          Query.filterBy(isEven),
          Query.limit(2),
          Query.startFrom(first.cursor!),
          Query.execute,
        )

        expect(second.items.map((i) => i.id)).toEqual(["4"])
        expect(mockQuery.mock.calls[1]![0].ExclusiveStartKey.sk.S).toBe("s-2")
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))

    it("a page that ends exactly on the last row keeps LastEvaluatedKey", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: rows(0, 3),
          Count: 3,
          LastEvaluatedKey: toAttributeMap({ pk: "p", sk: "s-2" }),
        })

        const page = yield* makeTestQuery().pipe(
          Query.filterBy(isEven),
          Query.limit(2),
          Query.execute,
        )

        expect(page.items.map((i) => i.id)).toEqual(["0", "2"])
        const resume = JSON.parse(atob(page.cursor!))
        expect(resume.sk.S).toBe("s-2")
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))
  })

  describe("the other terminals apply it too", () => {
    it("collect", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: rows(0, 6), Count: 6 })

        const items = yield* makeTestQuery().pipe(Query.filterBy(isEven), Query.collect)

        expect(items.map((i) => i.id)).toEqual(["0", "2", "4"])
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))

    it("paginate", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: rows(0, 6), Count: 6 })

        const stream = yield* makeTestQuery().pipe(Query.filterBy(isEven), Query.paginate)
        const pages = yield* Stream.runCollect(stream)

        expect(pages.flat().map((i) => i.id)).toEqual(["0", "2", "4"])
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))

    it("paginate respects limit across pages", () =>
      Effect.gen(function* () {
        mockQuery
          .mockResolvedValueOnce({
            Items: rows(0, 4),
            Count: 4,
            LastEvaluatedKey: toAttributeMap({ pk: "p", sk: "s-3" }),
          })
          .mockResolvedValueOnce({ Items: rows(4, 4), Count: 4 })

        const stream = yield* makeTestQuery().pipe(
          Query.filterBy(isEven),
          Query.limit(3),
          Query.paginate,
        )
        const pages = yield* Stream.runCollect(stream)

        expect(pages.flat().map((i) => i.id)).toEqual(["0", "2", "4"])
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))

    // `Select: "COUNT"` returns no items, so there is nothing to run the
    // predicate against — counting server-side would report every row the key
    // condition matched and silently ignore the predicate. Read and count the
    // accepted rows instead: it costs more, but the alternative is a wrong number.
    it("count reads rows rather than reporting an unfiltered COUNT", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: rows(0, 6), Count: 6 })

        const n = yield* makeTestQuery().pipe(Query.filterBy(isEven), Query.count)

        expect(n).toBe(3)
        expect(mockQuery.mock.calls[0]![0].Select).toBeUndefined()
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))

    it("count without a predicate still uses Select: COUNT", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Count: 6 })

        const n = yield* makeTestQuery().pipe(Query.count)

        expect(n).toBe(6)
        expect(mockQuery.mock.calls[0]![0].Select).toBe("COUNT")
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))
  })

  // A projection returns only the attributes it names, and the predicate is an
  // opaque closure whose reads the library cannot see — so it cannot borrow the
  // fields the way `cursorProjectionFields` borrows key attributes. The
  // combination has no correct reading to pick on the caller's behalf.
  describe("a projection and a predicate cannot both be active (EDD-9054)", () => {
    it("select() after filterBy()", () => {
      expect(() => makeTestQuery().pipe(Query.filterBy(isEven), Query.select(["name"]))).toThrow(
        /EDD-9054/,
      )
    })

    it("selectPaths() after filterBy()", () => {
      expect(() =>
        makeTestQuery().pipe(Query.filterBy(isEven), Query.selectPaths([["name"]])),
      ).toThrow(/EDD-9054/)
    })

    it("filterBy() after select()", () => {
      expect(() =>
        makeTestQuery().pipe(
          Query.select(["name"]),
          Query.filterBy((r: any) => r.name === "x"),
        ),
      ).toThrow(/EDD-9054/)
    })

    it("either alone is fine", () => {
      expect(() => makeTestQuery().pipe(Query.select(["name"]))).not.toThrow()
      expect(() => makeTestQuery().pipe(Query.filterBy(isEven))).not.toThrow()
    })
  })

  describe("no predicate leaves every existing path byte-identical", () => {
    it("still pushes `Limit` when nothing filters", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({ Items: rows(0, 3), Count: 3 })

        yield* makeTestQuery().pipe(Query.limit(3), Query.execute)

        expect(mockQuery.mock.calls[0]![0].Limit).toBe(3)
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))

    it("still rebuilds the cursor on an over-read", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: rows(0, 5),
          Count: 5,
          LastEvaluatedKey: toAttributeMap({ pk: "p", sk: "s-4" }),
        })

        const page = yield* makeTestQuery().pipe(Query.limit(2), Query.execute)

        expect(page.items.map((i) => i.id)).toEqual(["0", "1"])
        expect(JSON.parse(atob(page.cursor!)).sk.S).toBe("s-1")
      }).pipe(Effect.provide(TestDynamoClient), Effect.runPromise))
  })
})
