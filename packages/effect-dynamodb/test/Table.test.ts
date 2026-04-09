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
      const entity = {
        indexes: {
          primary: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
        },
      }
      const table = Table.make({ schema, entities: { entity } })
      const result = Table.definition(table)
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
      const table = Table.make({ schema, entities: { entity } })
      const result = Table.definition(table)
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
      const table = Table.make({ schema, entities: { userEntity, orderEntity } })
      const result = Table.definition(table)
      expect(result.GlobalSecondaryIndexes).toHaveLength(2)
      expect(result.AttributeDefinitions).toHaveLength(6)
    })

    it("throws for empty members array", () => {
      const table = Table.make({ schema })
      expect(() => Table.definition(table)).toThrow(
        "Table.definition requires at least one entity or aggregate",
      )
    })

    it("includes aggregate collection as LSI when its PK matches the table primary PK", () => {
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
        collection: { index: "lsi1", sk: { field: "lsi1sk" } },
        listIndex: undefined,
      }
      const table = Table.make({
        schema,
        entities: { entity },
        aggregates: { aggregate },
      })
      const result = Table.definition(table)

      // Collection index is auto-detected as an LSI because its PK (pk) equals
      // the table's primary PK (pk). DynamoDB LSIs share the base table's HASH key.
      expect(result.LocalSecondaryIndexes).toEqual([
        {
          IndexName: "lsi1",
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "lsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ])
      // No GSI entry for lsi1
      expect(result.GlobalSecondaryIndexes).toBeUndefined()
      // pk, sk, lsi1sk
      expect(result.AttributeDefinitions).toHaveLength(3)
      expect(result.AttributeDefinitions.map((a) => a.AttributeName)).toEqual([
        "lsi1sk",
        "pk",
        "sk",
      ])
    })

    it("emits aggregate collection as a GSI when its PK does NOT match the table primary PK", () => {
      // Preserves legacy behaviour for aggregates whose collection uses a
      // distinct PK attribute — those cannot be LSIs per DynamoDB rules.
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
        pkField: "gsi2pk",
        collection: { index: "gsi2", sk: { field: "gsi2sk" } },
        listIndex: undefined,
      }
      const table = Table.make({
        schema,
        entities: { entity },
        aggregates: { aggregate },
      })
      const result = Table.definition(table)

      expect(result.GlobalSecondaryIndexes).toEqual([
        {
          IndexName: "gsi2",
          KeySchema: [
            { AttributeName: "gsi2pk", KeyType: "HASH" },
            { AttributeName: "gsi2sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ])
      expect(result.LocalSecondaryIndexes).toBeUndefined()
      // pk, sk, gsi2pk, gsi2sk
      expect(result.AttributeDefinitions).toHaveLength(4)
    })

    it("emits collection as LSI and list index as GSI simultaneously", () => {
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
        // Collection shares base pk -> LSI
        collection: { index: "lsi1", sk: { field: "lsi1sk" } },
        // List index has its own PK -> GSI
        listIndex: {
          index: "gsi1",
          pk: { field: "gsi1pk" },
          sk: { field: "gsi1sk" },
        },
      }
      const table = Table.make({
        schema,
        entities: { entity },
        aggregates: { aggregate },
      })
      const result = Table.definition(table)

      expect(result.GlobalSecondaryIndexes).toHaveLength(1)
      expect(result.GlobalSecondaryIndexes!.map((g) => g.IndexName)).toEqual(["gsi1"])
      expect(result.LocalSecondaryIndexes).toHaveLength(1)
      expect(result.LocalSecondaryIndexes!.map((g) => g.IndexName)).toEqual(["lsi1"])
      // pk, sk, gsi1pk, gsi1sk, lsi1sk
      expect(result.AttributeDefinitions).toHaveLength(5)
    })

    it("emits list GSI when no entity defines it", () => {
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
        collection: { index: "lsi1", sk: { field: "lsi1sk" } },
        listIndex: {
          index: "gsi1",
          pk: { field: "gsi1pk" },
          sk: { field: "gsi1sk" },
        },
      }
      const table = Table.make({
        schema,
        entities: { entity },
        aggregates: { aggregate },
      })
      const result = Table.definition(table)

      expect(result.GlobalSecondaryIndexes).toHaveLength(1)
      expect(result.GlobalSecondaryIndexes!.map((g) => g.IndexName)).toEqual(["gsi1"])
      expect(result.LocalSecondaryIndexes).toHaveLength(1)
      expect(result.LocalSecondaryIndexes!.map((g) => g.IndexName)).toEqual(["lsi1"])
      // pk, sk, gsi1pk, gsi1sk, lsi1sk
      expect(result.AttributeDefinitions).toHaveLength(5)
    })

    it("produces a CreateTable-shaped input for a cricket-style LSI aggregate", () => {
      // Round-trip test: build a synthetic table the way DynamoClient.ts does
      // for `db.tables.*.create()` and assert the output is shaped like what
      // DynamoDB CreateTable would accept.
      const rootEntity = {
        entityType: "MatchItem",
        indexes: {
          primary: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
        },
      }
      const matchAggregate = {
        _tag: "Aggregate" as const,
        name: "Match",
        pkField: "pk",
        collection: { index: "lsi1", sk: { field: "lsi1sk" } },
        listIndex: undefined,
      }
      // Simulate the synthetic Table assembled inside DynamoClient.make()
      const table = Table.make({
        schema,
        entities: { MatchItem: rootEntity },
        aggregates: { Match: matchAggregate },
      })
      const def = Table.definition(table)

      // KeySchema — base table HASH/RANGE
      expect(def.KeySchema).toEqual([
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ])

      // AttributeDefinitions — all referenced key attributes as String
      expect(def.AttributeDefinitions).toEqual([
        { AttributeName: "lsi1sk", AttributeType: "S" },
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ])

      // LocalSecondaryIndexes — lsi1 with base pk + lsi1sk, projected ALL
      expect(def.LocalSecondaryIndexes).toEqual([
        {
          IndexName: "lsi1",
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "lsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ])

      // No GSIs expected
      expect(def.GlobalSecondaryIndexes).toBeUndefined()

      // Shape sanity: building a CreateTable input with these fields + a
      // TableName should be valid for DynamoDB's CreateTableCommand.
      const createInput = {
        TableName: "cricket-test",
        BillingMode: "PAY_PER_REQUEST" as const,
        ...def,
      }
      expect(createInput.TableName).toBe("cricket-test")
      expect(createInput.KeySchema[0]!.AttributeName).toBe("pk")
      expect(createInput.LocalSecondaryIndexes).toHaveLength(1)
      expect(createInput.LocalSecondaryIndexes![0]!.IndexName).toBe("lsi1")
      // The LSI HASH attribute MUST match the base table's HASH key
      expect(createInput.LocalSecondaryIndexes![0]!.KeySchema[0]!.AttributeName).toBe(
        createInput.KeySchema[0]!.AttributeName,
      )
    })
  })
})
