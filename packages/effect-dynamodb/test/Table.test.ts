import { it as effectIt } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Table from "../src/Table.js"

describe("Table", () => {
  const schema = DynamoSchema.make({ name: "myapp", version: 1 })

  describe("make", () => {
    it("creates a table with schema reference", () => {
      const table = Table.make({ schema })
      expect(table.schema).toBe(schema)
    })

    it("provides a Tag for runtime config", () => {
      const table = Table.make({ schema })
      expect(table.Tag).toBeDefined()
    })

    it("provides layer and layerConfig functions", () => {
      const table = Table.make({ schema })
      expect(typeof table.layer).toBe("function")
      expect(typeof table.layerConfig).toBe("function")
    })
  })

  describe("layer", () => {
    effectIt.effect("provides table name via layer", () => {
      const table = Table.make({ schema })
      return Effect.gen(function* () {
        const config = yield* table.Tag
        expect(config.name).toBe("my-test-table")
      }).pipe(Effect.provide(table.layer({ name: "my-test-table" })))
    })
  })

  // Test that two different Table.make() calls produce independent Tags
  describe("isolation", () => {
    effectIt.effect("different tables have independent configs", () => {
      const tableA = Table.make({ schema })
      const tableB = Table.make({ schema })

      return Effect.gen(function* () {
        const configA = yield* tableA.Tag
        const configB = yield* tableB.Tag
        expect(configA.name).toBe("table-a")
        expect(configB.name).toBe("table-b")
      }).pipe(
        Effect.provide(
          Layer.mergeAll(tableA.layer({ name: "table-a" }), tableB.layer({ name: "table-b" })),
        ),
      )
    })
  })

  describe("definition", () => {
    it("derives KeySchema and AttributeDefinitions from entities", () => {
      const table = Table.make({ schema })
      const entity = {
        indexes: {
          primary: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
        },
      }
      const result = Table.definition(table, [entity])
      expect(result.KeySchema).toEqual([
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ])
      expect(result.AttributeDefinitions).toEqual([
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ])
      expect(result.GlobalSecondaryIndexes).toBeUndefined()
    })

    it("collects GSIs from non-primary indexes", () => {
      const table = Table.make({ schema })
      const entity = {
        indexes: {
          primary: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          byEmail: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["email"] },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
      }
      const result = Table.definition(table, [entity])
      expect(result.GlobalSecondaryIndexes).toEqual([
        {
          IndexName: "gsi1",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ])
      expect(result.AttributeDefinitions).toHaveLength(4)
    })

    it("merges indexes from multiple entities", () => {
      const table = Table.make({ schema })
      const userEntity = {
        indexes: {
          primary: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          byTenant: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["tenantId"] },
            sk: { field: "gsi1sk", composite: ["createdAt"] },
          },
        },
      }
      const orderEntity = {
        indexes: {
          primary: {
            pk: { field: "pk", composite: ["orderId"] },
            sk: { field: "sk", composite: [] },
          },
          byTenant: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["tenantId"] },
            sk: { field: "gsi1sk", composite: ["orderDate"] },
          },
          byStatus: {
            index: "gsi2",
            pk: { field: "gsi2pk", composite: ["status"] },
            sk: { field: "gsi2sk", composite: [] },
          },
        },
      }
      const result = Table.definition(table, [userEntity, orderEntity])
      expect(result.GlobalSecondaryIndexes).toHaveLength(2)
      expect(result.AttributeDefinitions).toHaveLength(6)
    })

    it("throws for empty members array", () => {
      const table = Table.make({ schema })
      expect(() => Table.definition(table, [])).toThrow(
        "Table.definition requires at least one entity or aggregate",
      )
    })

    it("includes aggregate collection GSI", () => {
      const table = Table.make({ schema })
      const entity = {
        indexes: {
          primary: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
        },
      }
      const aggregate = {
        _tag: "Aggregate" as const,
        pkField: "pk",
        collection: { index: "gsi2", sk: { field: "gsi2sk" } },
        listIndex: undefined,
      }
      const result = Table.definition(table, [entity, aggregate])

      expect(result.GlobalSecondaryIndexes).toEqual([
        {
          IndexName: "gsi2",
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "gsi2sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ])
      // pk, sk, gsi2sk
      expect(result.AttributeDefinitions).toHaveLength(3)
    })

    it("includes aggregate list GSI alongside collection GSI", () => {
      const table = Table.make({ schema })
      const entity = {
        indexes: {
          primary: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
          byGender: {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["gender"] },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
      }
      const aggregate = {
        _tag: "Aggregate" as const,
        pkField: "pk",
        collection: { index: "gsi2", sk: { field: "gsi2sk" } },
        listIndex: {
          index: "gsi1",
          pk: { field: "gsi1pk" },
          sk: { field: "gsi1sk" },
        },
      }
      const result = Table.definition(table, [entity, aggregate])

      // gsi1 from entity, gsi2 from aggregate collection — no duplicates
      expect(result.GlobalSecondaryIndexes).toHaveLength(2)
      expect(result.GlobalSecondaryIndexes!.map((g) => g.IndexName)).toEqual(["gsi1", "gsi2"])
      // pk, sk, gsi1pk, gsi1sk, gsi2sk
      expect(result.AttributeDefinitions).toHaveLength(5)
    })

    it("includes aggregate list GSI when entity does not define it", () => {
      const table = Table.make({ schema })
      const entity = {
        indexes: {
          primary: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
        },
      }
      const aggregate = {
        _tag: "Aggregate" as const,
        pkField: "pk",
        collection: { index: "gsi2", sk: { field: "gsi2sk" } },
        listIndex: {
          index: "gsi1",
          pk: { field: "gsi1pk" },
          sk: { field: "gsi1sk" },
        },
      }
      const result = Table.definition(table, [entity, aggregate])

      // Both GSIs present
      expect(result.GlobalSecondaryIndexes).toHaveLength(2)
      expect(result.GlobalSecondaryIndexes!.map((g) => g.IndexName)).toEqual(["gsi1", "gsi2"])
      // pk, sk, gsi1pk, gsi1sk, gsi2sk
      expect(result.AttributeDefinitions).toHaveLength(5)
    })
  })
})
