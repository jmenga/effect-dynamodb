import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { DynamoError } from "../src/Errors.js"
import {
  compileExpr,
  createConditionOps,
  isExpr,
  parseShorthand,
  parseSimpleShorthand,
} from "../src/internal/Expr.js"
import { createPathBuilder, isPath } from "../src/internal/PathBuilder.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

const withConfig = <E extends { _configure: Function }>(entity: E): E => {
  entity._configure(AppSchema, MainTable.Tag)
  return entity
}

class Team extends Schema.Class<Team>("Team")({
  id: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["active", "inactive", "archived"]),
  wins: Schema.Number,
  losses: Schema.Number,
  address: Schema.Struct({
    city: Schema.String,
    state: Schema.String,
    zip: Schema.String,
  }),
  roster: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      position: Schema.String,
      number: Schema.Number,
    }),
  ),
  tags: Schema.Array(Schema.String),
  metadata: Schema.optional(
    Schema.Struct({
      founded: Schema.Number,
      conference: Schema.String,
    }),
  ),
}) {}

const TeamModel = DynamoModel.configure(Team, {
  id: { identifier: true },
})

const Teams = withConfig(
  Entity.make({
    model: TeamModel,
    entityType: "Team",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byStatus: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["status"] },
        sk: { field: "gsi1sk", composite: [] },
      },
    },
    timestamps: true,
    versioned: true,
  }),
)

// ---------------------------------------------------------------------------
// PathBuilder tests
// ---------------------------------------------------------------------------

describe("PathBuilder", () => {
  it("creates paths for top-level attributes", () => {
    const builder = createPathBuilder<{ name: string; age: number }>()
    const path = builder.name
    expect(isPath(path)).toBe(true)
    expect(path.segments).toEqual(["name"])
  })

  it("creates paths for nested attributes", () => {
    const builder = createPathBuilder<{ address: { city: string; zip: string } }>()
    const path = builder.address.city
    expect(isPath(path)).toBe(true)
    expect(path.segments).toEqual(["address", "city"])
  })

  it("creates paths for array elements", () => {
    const builder = createPathBuilder<{ items: Array<{ name: string }> }>()
    const path = builder.items.at(0).name
    expect(path.segments).toEqual(["items", 0, "name"])
  })

  it("creates size operands", () => {
    const builder = createPathBuilder<{ tags: Array<string> }>()
    const sizeOp = builder.tags.size()
    expect(sizeOp._tag).toBe("size")
    expect(sizeOp.segments).toEqual(["tags"])
  })
})

// ---------------------------------------------------------------------------
// Expr ADT tests
// ---------------------------------------------------------------------------

describe("Expr", () => {
  describe("isExpr", () => {
    it("identifies Expr nodes", () => {
      const ops = createConditionOps<{ status: string }>()
      const builder = createPathBuilder<{ status: string }>()
      const expr = ops.eq(builder.status, "active")
      expect(isExpr(expr)).toBe(true)
    })

    it("rejects non-Expr values", () => {
      expect(isExpr(null)).toBe(false)
      expect(isExpr({})).toBe(false)
      expect(isExpr("hello")).toBe(false)
    })
  })

  describe("compileExpr", () => {
    it("compiles eq comparison", () => {
      const ops = createConditionOps<{ status: string }>()
      const builder = createPathBuilder<{ status: string }>()
      const result = compileExpr(ops.eq(builder.status, "active"))
      expect(result.expression).toContain("=")
      expect(Object.keys(result.names).length).toBe(1)
      expect(Object.keys(result.values).length).toBe(1)
      // Verify the name maps to "status"
      const nameKey = Object.keys(result.names)[0]!
      expect(result.names[nameKey]).toBe("status")
    })

    it("compiles ne comparison", () => {
      const ops = createConditionOps<{ status: string }>()
      const builder = createPathBuilder<{ status: string }>()
      const result = compileExpr(ops.ne(builder.status, "archived"))
      expect(result.expression).toContain("<>")
    })

    it("compiles between", () => {
      const ops = createConditionOps<{ age: number }>()
      const builder = createPathBuilder<{ age: number }>()
      const result = compileExpr(ops.between(builder.age, 18, 65))
      expect(result.expression).toContain("BETWEEN")
      expect(result.expression).toContain("AND")
    })

    it("compiles isIn", () => {
      const ops = createConditionOps<{ role: string }>()
      const builder = createPathBuilder<{ role: string }>()
      const result = compileExpr(ops.isIn(builder.role, ["admin", "manager"]))
      expect(result.expression).toContain("IN")
    })

    it("compiles exists", () => {
      const ops = createConditionOps<{ email: string }>()
      const builder = createPathBuilder<{ email: string }>()
      const result = compileExpr(ops.exists(builder.email))
      expect(result.expression).toContain("attribute_exists")
    })

    it("compiles notExists", () => {
      const ops = createConditionOps<{ email: string }>()
      const builder = createPathBuilder<{ email: string }>()
      const result = compileExpr(ops.notExists(builder.email))
      expect(result.expression).toContain("attribute_not_exists")
    })

    it("compiles beginsWith", () => {
      const ops = createConditionOps<{ name: string }>()
      const builder = createPathBuilder<{ name: string }>()
      const result = compileExpr(ops.beginsWith(builder.name, "Jo"))
      expect(result.expression).toContain("begins_with")
    })

    it("compiles contains", () => {
      const ops = createConditionOps<{ tags: Array<string> }>()
      const builder = createPathBuilder<{ tags: Array<string> }>()
      const result = compileExpr(ops.contains(builder.tags, "important"))
      expect(result.expression).toContain("contains")
    })

    it("compiles AND composition", () => {
      const ops = createConditionOps<{ status: string; role: string }>()
      const builder = createPathBuilder<{ status: string; role: string }>()
      const result = compileExpr(
        ops.and(ops.eq(builder.status, "active"), ops.eq(builder.role, "admin")),
      )
      expect(result.expression).toContain("AND")
    })

    it("compiles OR composition", () => {
      const ops = createConditionOps<{ status: string }>()
      const builder = createPathBuilder<{ status: string }>()
      const result = compileExpr(
        ops.or(ops.eq(builder.status, "active"), ops.eq(builder.status, "pending")),
      )
      expect(result.expression).toContain("OR")
    })

    it("compiles NOT", () => {
      const ops = createConditionOps<{ status: string }>()
      const builder = createPathBuilder<{ status: string }>()
      const result = compileExpr(ops.not(ops.eq(builder.status, "archived")))
      expect(result.expression).toContain("NOT")
    })

    it("compiles nested paths", () => {
      const ops = createConditionOps<{ address: { city: string } }>()
      const builder = createPathBuilder<{ address: { city: string } }>()
      const result = compileExpr(ops.eq(builder.address.city, "NYC"))
      // Should contain dot notation for nested path
      const nameValues = Object.values(result.names)
      expect(nameValues).toContain("address")
      expect(nameValues).toContain("city")
    })

    it("compiles array index paths", () => {
      const ops = createConditionOps<{ items: Array<{ name: string }> }>()
      const builder = createPathBuilder<{ items: Array<{ name: string }> }>()
      const result = compileExpr(ops.eq(builder.items.at(0).name, "first"))
      expect(result.expression).toContain("[0]")
    })

    it("compiles size operand", () => {
      const ops = createConditionOps<{ tags: Array<string> }>()
      const builder = createPathBuilder<{ tags: Array<string> }>()
      const result = compileExpr(ops.gt(builder.tags.size(), 5))
      expect(result.expression).toContain("size(")
    })

    it("compiles path-to-path comparison", () => {
      const ops = createConditionOps<{ wins: number; losses: number }>()
      const builder = createPathBuilder<{ wins: number; losses: number }>()
      const result = compileExpr(ops.gt(builder.wins, builder.losses as any))
      // Both sides should be path references (no value placeholders)
      const numValues = Object.keys(result.values).length
      const numNames = Object.keys(result.names).length
      expect(numNames).toBe(2)
      expect(numValues).toBe(0)
    })

    it("compiles attributeType", () => {
      const ops = createConditionOps<{ data: unknown }>()
      const builder = createPathBuilder<{ data: unknown }>()
      const result = compileExpr(ops.attributeType(builder.data, "S"))
      expect(result.expression).toContain("attribute_type")
    })

    it("applies resolveDbName to path segments", () => {
      const ops = createConditionOps<{ userName: string }>()
      const builder = createPathBuilder<{ userName: string }>()
      const result = compileExpr(ops.eq(builder.userName, "test"), (name) =>
        name === "userName" ? "user_name" : name,
      )
      const nameValues = Object.values(result.names)
      expect(nameValues).toContain("user_name")
    })
  })

  describe("parseShorthand", () => {
    it("parses eq conditions", () => {
      const expr = parseShorthand({ eq: { status: "active" } })
      expect(isExpr(expr)).toBe(true)
      const result = compileExpr(expr)
      expect(result.expression).toContain("=")
    })

    it("parses multiple conditions (ANDed)", () => {
      const expr = parseShorthand({
        eq: { status: "active" },
        gt: { wins: 10 },
      })
      const result = compileExpr(expr)
      expect(result.expression).toContain("AND")
    })

    it("parses attributeExists", () => {
      const expr = parseShorthand({ attributeExists: "email" })
      const result = compileExpr(expr)
      expect(result.expression).toContain("attribute_exists")
    })

    it("parses between", () => {
      const expr = parseShorthand({ between: { age: [18, 65] } })
      const result = compileExpr(expr)
      expect(result.expression).toContain("BETWEEN")
    })
  })

  describe("parseSimpleShorthand", () => {
    it("parses simple equality object", () => {
      const expr = parseSimpleShorthand({ status: "active", role: "admin" })
      const result = compileExpr(expr)
      expect(result.expression).toContain("AND")
      expect(result.expression).toContain("=")
    })

    it("handles empty object", () => {
      const expr = parseSimpleShorthand({})
      expect(isExpr(expr)).toBe(true)
    })

    it("handles single field", () => {
      const expr = parseSimpleShorthand({ status: "active" })
      const result = compileExpr(expr)
      expect(result.expression).toContain("=")
    })
  })
})

// ---------------------------------------------------------------------------
// Entity condition/filter/select combinator tests
// ---------------------------------------------------------------------------

const mockPutItem = vi.fn()
const mockGetItem = vi.fn()
const mockDeleteItem = vi.fn()
const mockUpdateItem = vi.fn()
const mockQuery = vi.fn()
const mockScan = vi.fn()
const mockTransactWriteItems = vi.fn()
const mockBatchWriteItem = vi.fn()
const mockBatchGetItem = vi.fn()

const TestDynamoClient = Layer.succeed(DynamoClient, {
  putItem: (input) =>
    Effect.tryPromise({
      try: () => mockPutItem(input),
      catch: (e) => new DynamoError({ operation: "PutItem", cause: e }),
    }),
  getItem: (input) =>
    Effect.tryPromise({
      try: () => mockGetItem(input),
      catch: (e) => new DynamoError({ operation: "GetItem", cause: e }),
    }),
  deleteItem: (input) =>
    Effect.tryPromise({
      try: () => mockDeleteItem(input),
      catch: (e) => new DynamoError({ operation: "DeleteItem", cause: e }),
    }),
  updateItem: (input) =>
    Effect.tryPromise({
      try: () => mockUpdateItem(input),
      catch: (e) => new DynamoError({ operation: "UpdateItem", cause: e }),
    }),
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
  transactWriteItems: (input) =>
    Effect.tryPromise({
      try: () => mockTransactWriteItems(input),
      catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
    }),
  transactGetItems: (_input) =>
    Effect.tryPromise({
      try: () => ({}),
      catch: (e) => new DynamoError({ operation: "TransactGetItems", cause: e }),
    }),
  batchWriteItem: (input) =>
    Effect.tryPromise({
      try: () => mockBatchWriteItem(input),
      catch: (e) => new DynamoError({ operation: "BatchWriteItem", cause: e }),
    }),
  batchGetItem: (input) =>
    Effect.tryPromise({
      try: () => mockBatchGetItem(input),
      catch: (e) => new DynamoError({ operation: "BatchGetItem", cause: e }),
    }),
  createTable: (_input) =>
    Effect.tryPromise({
      try: () => ({}),
      catch: (e) => new DynamoError({ operation: "CreateTable", cause: e }),
    }),
  deleteTable: (_input) =>
    Effect.tryPromise({
      try: () => ({}),
      catch: (e) => new DynamoError({ operation: "DeleteTable", cause: e }),
    }),
  describeTable: (_input) =>
    Effect.tryPromise({
      try: () => ({}),
      catch: (e) => new DynamoError({ operation: "DescribeTable", cause: e }),
    }),
} as any)

const TestLayer = Layer.merge(
  TestDynamoClient,
  Layer.succeed(MainTable.Tag, { name: "test-table" }),
)

describe("Entity.condition", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it.effect("callback condition on put generates ConditionExpression", () =>
    Effect.gen(function* () {
      mockPutItem.mockResolvedValue({})

      const op = Teams.put({
        id: "t1",
        name: "Team A",
        status: "active",
        wins: 0,
        losses: 0,
        address: { city: "NYC", state: "NY", zip: "10001" },
        roster: [],
        tags: [],
      })

      // Apply callback condition
      const conditioned = op.pipe(Teams.condition((t, { eq }) => eq(t.status, "active")))

      yield* conditioned

      expect(mockPutItem).toHaveBeenCalledTimes(1)
      const input = mockPutItem.mock.calls[0][0]
      expect(input.ConditionExpression).toBeDefined()
      expect(input.ConditionExpression).toContain("=")
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("shorthand condition on put generates ConditionExpression", () =>
    Effect.gen(function* () {
      mockPutItem.mockResolvedValue({})

      const op = Teams.put({
        id: "t2",
        name: "Team B",
        status: "active",
        wins: 0,
        losses: 0,
        address: { city: "LA", state: "CA", zip: "90001" },
        roster: [],
        tags: [],
      })

      const conditioned = op.pipe(Teams.condition({ status: "active" }))
      yield* conditioned

      expect(mockPutItem).toHaveBeenCalledTimes(1)
      const input = mockPutItem.mock.calls[0][0]
      expect(input.ConditionExpression).toBeDefined()
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("callback condition on update generates ConditionExpression", () =>
    Effect.gen(function* () {
      mockUpdateItem.mockResolvedValue({
        Attributes: toAttributeMap({
          id: "t1",
          name: "Updated",
          status: "active",
          wins: 0,
          losses: 0,
          address: { city: "NYC", state: "NY", zip: "10001" },
          roster: [],
          tags: [],
          __edd_e__: "Team",
          pk: "$myapp#v1#team#t1",
          sk: "$myapp#v1#team",
        }),
      })

      const op = Teams.update({ id: "t1" }).pipe(
        Entity.set({ name: "Updated" }),
        Teams.condition((t, { eq }) => eq(t.status, "active")),
      )

      yield* op

      expect(mockUpdateItem).toHaveBeenCalledTimes(1)
      const input = mockUpdateItem.mock.calls[0][0]
      expect(input.ConditionExpression).toBeDefined()
    }).pipe(Effect.provide(TestLayer)),
  )
})

describe("Entity.filter", () => {
  it("callback filter produces Query combinator", () => {
    const filterComb = Teams.filter((t, { gt }) => gt(t.wins, 10))
    expect(typeof filterComb).toBe("function")

    // Apply to a scan query
    const query = Teams.scan()
    const filtered = filterComb(query)
    expect(filtered._state.exprFilters.length).toBe(1)
  })

  it("shorthand filter produces Query combinator", () => {
    const filterComb = Teams.filter({ status: "active" })
    const query = Teams.scan()
    const filtered = filterComb(query)
    expect(filtered._state.exprFilters.length).toBe(1)
  })
})

describe("Entity.select", () => {
  it("callback select produces Query combinator with projectionPaths", () => {
    const selectComb = Teams.select((t) => [t.name, t.address.city])
    expect(typeof selectComb).toBe("function")

    const query = Teams.scan()
    const projected = selectComb(query)
    expect(projected._state.projectionPaths).toBeDefined()
    expect(projected._state.projectionPaths!.length).toBe(2)
    expect(projected._state.projectionPaths![0]).toEqual(["name"])
    expect(projected._state.projectionPaths![1]).toEqual(["address", "city"])
  })

  it("string array select produces Query combinator with projection", () => {
    const selectComb = Teams.select(["name", "status"])
    const query = Teams.scan()
    const projected = selectComb(query)
    expect(projected._state.projection).toEqual(["name", "status"])
  })
})

describe("Flattened query accessors", () => {
  it("entity has flattened accessors matching query namespace", () => {
    // byStatus should exist directly on the entity
    expect(typeof (Teams as any).byStatus).toBe("function")
    // Should produce the same Query as Teams.query.byStatus
    const q1 = Teams.query.byStatus({ status: "active" })
    const q2 = (Teams as any).byStatus({ status: "active" })
    // Both should produce Query objects
    expect(q1._state.pkValue).toBe(q2._state.pkValue)
  })
})

describe("Query.filterExpr", () => {
  it("adds expr filter to query state", () => {
    const ops = createConditionOps<{ wins: number }>()
    const builder = createPathBuilder<{ wins: number }>()
    const expr = ops.gt(builder.wins, 10)

    const query = Teams.scan()
    const filtered = Query.filterExpr(query, expr)
    expect(filtered._state.exprFilters.length).toBe(1)
  })

  it("supports data-last (pipeable) style", () => {
    const ops = createConditionOps<{ wins: number }>()
    const builder = createPathBuilder<{ wins: number }>()
    const expr = ops.gt(builder.wins, 10)

    const filtered = Teams.scan().pipe(Query.filterExpr(expr))
    expect(filtered._state.exprFilters.length).toBe(1)
  })
})

describe("Query.selectPaths", () => {
  it("adds projection paths to query state", () => {
    const query = Teams.scan()
    const projected = Query.selectPaths(query, [["name"], ["address", "city"]])
    expect(projected._state.projectionPaths).toEqual([["name"], ["address", "city"]])
  })
})
