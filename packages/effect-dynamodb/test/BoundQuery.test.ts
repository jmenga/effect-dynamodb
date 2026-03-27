import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { beforeEach, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import { DynamoError } from "../src/Errors.js"
import { type BoundQueryConfig, BoundQueryImpl } from "../src/internal/BoundQuery.js"
import { createConditionOps } from "../src/internal/Expr.js"
import { createPathBuilder } from "../src/internal/PathBuilder.js"
import * as Query from "../src/Query.js"

// ---------------------------------------------------------------------------
// Test model type
// ---------------------------------------------------------------------------

type TestModel = { id: string; name: string; status: string; count: number }

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
  describeTable: () => Effect.die("not used"),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pathBuilder = createPathBuilder<TestModel>()
const conditionOps = createConditionOps<TestModel>()

const makeTestQuery = () =>
  Query.make<TestModel>({
    tableName: "TestTable",
    indexName: undefined,
    pkField: "pk",
    pkValue: "$myapp#v1#test#t-1",
    skField: "sk",
    entityTypes: ["TestEntity"],
    decoder: (raw) =>
      Effect.succeed({
        id: raw.id as string,
        name: raw.name as string,
        status: raw.status as string,
        count: raw.count as number,
      }),
  })

const makeConfig = (): BoundQueryConfig<TestModel> => ({
  pathBuilder,
  conditionOps,
  provide: <X, E>(eff: Effect.Effect<X, E, any>) =>
    Effect.provide(eff, TestDynamoClient) as Effect.Effect<X, E, never>,
})

/** SK remaining type for tests — represents available SK composites */
type TestSkRemaining = { readonly sk: string }

// Update makeConfig to include skFields
const origMakeConfig = makeConfig
const makeConfigWithSk = (): BoundQueryConfig<TestModel> => ({
  ...origMakeConfig(),
  skFields: ["sk"],
})

const makeBoundQuery = () =>
  new BoundQueryImpl<TestModel, TestSkRemaining, TestModel>(makeTestQuery(), makeConfigWithSk())

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BoundQuery", () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockScan.mockReset()
  })

  // -----------------------------------------------------------------------
  // Immutability
  // -----------------------------------------------------------------------

  describe("immutability", () => {
    it("limit returns a new instance, original unchanged", () => {
      const original = makeBoundQuery()
      const limited = original.limit(10)

      expect(limited).not.toBe(original)
      expect(limited).toBeInstanceOf(BoundQueryImpl)
      // Original query state should not have limitValue set
      expect(original._query._state.limitValue).toBeUndefined()
      // New query state should have limitValue = 10
      expect(limited._query._state.limitValue).toBe(10)
    })

    it("reverse returns a new instance, original unchanged", () => {
      const original = makeBoundQuery()
      const reversed = original.reverse()

      expect(reversed).not.toBe(original)
      expect(original._query._state.scanForward).toBe(true)
      expect(reversed._query._state.scanForward).toBe(false)
    })

    it("filter returns a new instance, original unchanged", () => {
      const original = makeBoundQuery()
      const filtered = original.filter({ status: "active" })

      expect(filtered).not.toBe(original)
      expect(original._query._state.exprFilters).toHaveLength(0)
      expect(filtered._query._state.exprFilters).toHaveLength(1)
    })

    it("chaining multiple combinators preserves independence", () => {
      const original = makeBoundQuery()
      const a = original.limit(5)
      const b = original.limit(10)

      expect(a._query._state.limitValue).toBe(5)
      expect(b._query._state.limitValue).toBe(10)
      expect(original._query._state.limitValue).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // limit
  // -----------------------------------------------------------------------

  describe("limit", () => {
    it("sets the limitValue on the underlying query", () => {
      const bq = makeBoundQuery().limit(25)
      expect(bq._query._state.limitValue).toBe(25)
    })
  })

  // -----------------------------------------------------------------------
  // maxPages
  // -----------------------------------------------------------------------

  describe("maxPages", () => {
    it("sets the maxPagesValue on the underlying query", () => {
      const bq = makeBoundQuery().maxPages(3)
      expect(bq._query._state.maxPagesValue).toBe(3)
    })
  })

  // -----------------------------------------------------------------------
  // reverse
  // -----------------------------------------------------------------------

  describe("reverse", () => {
    it("sets scanForward to false on the underlying query", () => {
      const bq = makeBoundQuery().reverse()
      expect(bq._query._state.scanForward).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // consistentRead
  // -----------------------------------------------------------------------

  describe("consistentRead", () => {
    it("sets consistentRead to true on the underlying query", () => {
      const bq = makeBoundQuery().consistentRead()
      expect(bq._query._state.consistentRead).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // ignoreOwnership
  // -----------------------------------------------------------------------

  describe("ignoreOwnership", () => {
    it("sets ignoreOwnershipFlag to true on the underlying query", () => {
      const bq = makeBoundQuery().ignoreOwnership()
      expect(bq._query._state.ignoreOwnershipFlag).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // startFrom
  // -----------------------------------------------------------------------

  describe("startFrom", () => {
    it("sets exclusiveStartKey on the underlying query", () => {
      const cursor = Buffer.from(JSON.stringify({ pk: { S: "abc" } })).toString("base64")
      const bq = makeBoundQuery().startFrom(cursor)
      expect(bq._query._state.exclusiveStartKey).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // filter (callback)
  // -----------------------------------------------------------------------

  describe("filter (callback)", () => {
    it("adds an Expr filter to the underlying query", () => {
      const bq = makeBoundQuery().filter((t, { eq }) => eq(t.status, "active"))
      expect(bq._query._state.exprFilters).toHaveLength(1)
      expect(bq._query._state.exprFilters[0]!._tag).toBe("eq")
    })
  })

  // -----------------------------------------------------------------------
  // filter (shorthand)
  // -----------------------------------------------------------------------

  describe("filter (shorthand)", () => {
    it("parses shorthand object and adds Expr filter", () => {
      const bq = makeBoundQuery().filter({ status: "active" })
      expect(bq._query._state.exprFilters).toHaveLength(1)
    })

    it("parses multi-field shorthand into AND expression", () => {
      const bq = makeBoundQuery().filter({ status: "active", name: "test" })
      expect(bq._query._state.exprFilters).toHaveLength(1)
      // Multi-field shorthand produces an "and" expression
      expect(bq._query._state.exprFilters[0]!._tag).toBe("and")
    })
  })

  // -----------------------------------------------------------------------
  // select (callback)
  // -----------------------------------------------------------------------

  describe("select (callback)", () => {
    it("compiles paths and sets projection on the underlying query", () => {
      const bq = makeBoundQuery().select((t) => [t.name, t.status])
      expect(bq._query._state.projectionPaths).toBeDefined()
      expect(bq._query._state.projectionPaths).toHaveLength(2)
    })
  })

  // -----------------------------------------------------------------------
  // select (string array)
  // -----------------------------------------------------------------------

  describe("select (string array)", () => {
    it("sets string projection on the underlying query", () => {
      const bq = makeBoundQuery().select(["name", "status"])
      expect(bq._query._state.projection).toBeDefined()
      expect(bq._query._state.projection).toEqual(["name", "status"])
    })
  })

  // -----------------------------------------------------------------------
  // where
  // -----------------------------------------------------------------------

  describe("where", () => {
    it("applies SK condition to the underlying query", () => {
      const bq = makeBoundQuery().where((t, ops) => ops.beginsWith(t.sk, "prefix"))
      expect(bq._query._state.skConditions).toHaveLength(1)
      expect(bq._query._state.skConditions[0]!.condition).toEqual({ beginsWith: "prefix" })
    })

    it("uses composeSkCondition when provided", () => {
      const config: BoundQueryConfig<TestModel> = {
        ...makeConfigWithSk(),
        composeSkCondition: (cond) => {
          if ("beginsWith" in cond) {
            return { beginsWith: `composed#${cond.beginsWith}` }
          }
          return cond
        },
      }
      const bq = new BoundQueryImpl<TestModel, TestSkRemaining, TestModel>(makeTestQuery(), config)
      const result = bq.where((t, ops) => ops.beginsWith(t.sk, "hello"))
      expect(result._query._state.skConditions).toHaveLength(1)
      expect(result._query._state.skConditions[0]!.condition).toEqual({
        beginsWith: "composed#hello",
      })
    })

    it("supports eq condition", () => {
      const bq = makeBoundQuery().where((t, ops) => ops.eq(t.sk, "exact"))
      expect(bq._query._state.skConditions[0]!.condition).toEqual({ eq: "exact" })
    })

    it("supports between condition", () => {
      const bq = makeBoundQuery().where((t, ops) => ops.between(t.sk, "a", "z"))
      expect(bq._query._state.skConditions[0]!.condition).toEqual({ between: ["a", "z"] })
    })

    it("supports gt condition", () => {
      const bq = makeBoundQuery().where((t, ops) => ops.gt(t.sk, "value"))
      expect(bq._query._state.skConditions[0]!.condition).toEqual({ gt: "value" })
    })

    it("supports gte condition", () => {
      const bq = makeBoundQuery().where((t, ops) => ops.gte(t.sk, "value"))
      expect(bq._query._state.skConditions[0]!.condition).toEqual({ gte: "value" })
    })

    it("supports lt condition", () => {
      const bq = makeBoundQuery().where((t, ops) => ops.lt(t.sk, "value"))
      expect(bq._query._state.skConditions[0]!.condition).toEqual({ lt: "value" })
    })

    it("supports lte condition", () => {
      const bq = makeBoundQuery().where((t, ops) => ops.lte(t.sk, "value"))
      expect(bq._query._state.skConditions[0]!.condition).toEqual({ lte: "value" })
    })
  })

  // -----------------------------------------------------------------------
  // collect terminal
  // -----------------------------------------------------------------------

  describe("collect", () => {
    it.effect("calls DynamoClient query and returns decoded items", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            {
              id: { S: "1" },
              name: { S: "Alice" },
              status: { S: "active" },
              count: { N: "5" },
              __edd_e__: { S: "TestEntity" },
            },
          ],
          Count: 1,
        })

        const bq = makeBoundQuery()
        const result = yield* bq.collect()

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual({ id: "1", name: "Alice", status: "active", count: 5 })
        expect(mockQuery).toHaveBeenCalledOnce()
      }),
    )
  })

  // -----------------------------------------------------------------------
  // fetch terminal
  // -----------------------------------------------------------------------

  describe("fetch", () => {
    it.effect("calls DynamoClient query and returns a Page with items and cursor", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            {
              id: { S: "1" },
              name: { S: "Test" },
              status: { S: "active" },
              count: { N: "1" },
              __edd_e__: { S: "TestEntity" },
            },
          ],
          Count: 1,
          LastEvaluatedKey: undefined,
        })

        const bq = makeBoundQuery()
        const page = yield* bq.fetch()

        expect(page.items).toHaveLength(1)
        expect(page.cursor).toBeNull()
        expect(mockQuery).toHaveBeenCalledOnce()
      }),
    )
  })

  // -----------------------------------------------------------------------
  // count terminal
  // -----------------------------------------------------------------------

  describe("count", () => {
    it.effect("calls DynamoClient query with Select COUNT and returns number", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Count: 42,
          Items: undefined,
        })

        const bq = makeBoundQuery()
        const n = yield* bq.count()

        expect(n).toBe(42)
        expect(mockQuery).toHaveBeenCalledOnce()
      }),
    )
  })

  // -----------------------------------------------------------------------
  // paginate terminal
  // -----------------------------------------------------------------------

  describe("paginate", () => {
    it.effect("returns a Stream that paginates through items", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            {
              id: { S: "1" },
              name: { S: "First" },
              status: { S: "active" },
              count: { N: "1" },
              __edd_e__: { S: "TestEntity" },
            },
          ],
          Count: 1,
          LastEvaluatedKey: undefined,
        })

        const bq = makeBoundQuery()
        const stream = bq.paginate()
        const items = yield* Stream.runCollect(stream)

        expect(Array.from(items)).toHaveLength(1)
        expect(Array.from(items)[0]).toEqual({
          id: "1",
          name: "First",
          status: "active",
          count: 1,
        })
      }),
    )
  })

  // -----------------------------------------------------------------------
  // Combinator chaining
  // -----------------------------------------------------------------------

  describe("combinator chaining", () => {
    it("chains limit + reverse + filter correctly", () => {
      const bq = makeBoundQuery().limit(10).reverse().filter({ status: "active" })

      expect(bq._query._state.limitValue).toBe(10)
      expect(bq._query._state.scanForward).toBe(false)
      expect(bq._query._state.exprFilters).toHaveLength(1)
    })

    it("chains where + limit + consistentRead", () => {
      const bq = makeBoundQuery()
        .where((t, ops) => ops.beginsWith(t.sk, "2024"))
        .limit(5)
        .consistentRead()

      expect(bq._query._state.skConditions).toHaveLength(1)
      expect(bq._query._state.limitValue).toBe(5)
      expect(bq._query._state.consistentRead).toBe(true)
    })
  })
})
