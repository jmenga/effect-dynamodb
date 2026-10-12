import { it as effectIt } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
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
        _tag: "Entity" as const,
        _configure: () => {},
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
        _tag: "Entity" as const,
        _configure: () => {},
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
        _tag: "Entity" as const,
        _configure: () => {},
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
        _tag: "Entity" as const,
        _configure: () => {},
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
        _tag: "Entity" as const,
        _configure: () => {},
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
        _tag: "Entity" as const,
        _configure: () => {},
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
        _tag: "Entity" as const,
        _configure: () => {},
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
        _tag: "Entity" as const,
        _configure: () => {},
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
        _tag: "Entity" as const,
        _configure: () => {},
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

  // C1: a physical secondary index declared twice with different key schemas
  // used to keep the first declaration silently; the loser's items never
  // appeared in the index.
  describe("secondary index agreement (EDD-9069)", () => {
    const entityWith = (
      entityType: string,
      indexes: Record<
        string,
        {
          readonly index?: string
          readonly pk: { readonly field: string; readonly composite: ReadonlyArray<string> }
          readonly sk: { readonly field: string; readonly composite: ReadonlyArray<string> }
        }
      >,
      primary: { readonly pk: string; readonly sk: string } = { pk: "pk", sk: "sk" },
    ) => ({
      _tag: "Entity" as const,
      entityType,
      _configure: () => {},
      indexes: {
        primary: {
          pk: { field: primary.pk, composite: ["id"] },
          sk: { field: primary.sk, composite: [] },
        },
        ...indexes,
      },
    })

    const aggregateWith = (config: {
      readonly pkField?: string
      readonly collection?: { readonly index: string; readonly sk: string }
      readonly listIndex?: { readonly index: string; readonly pk: string; readonly sk: string }
    }) => ({
      _tag: "Aggregate" as const,
      pkField: config.pkField ?? "pk",
      collection: config.collection
        ? { index: config.collection.index, sk: { field: config.collection.sk } }
        : { index: undefined, sk: undefined },
      listIndex: config.listIndex
        ? {
            index: config.listIndex.index,
            pk: { field: config.listIndex.pk },
            sk: { field: config.listIndex.sk },
          }
        : undefined,
    })

    /** Both `Table.make` and `Table.definition` refuse it; `make` throws first. */
    const expectRefused = (
      members: {
        readonly entities?: Record<string, ReturnType<typeof entityWith>>
        readonly aggregates?: Record<string, ReturnType<typeof aggregateWith>>
      },
      message: RegExp,
    ) => {
      expect(() => Table.make({ schema, ...members })).toThrow(message)
      // `Table.definition` re-validates a table assembled without `make` — as
      // `DynamoClient.make` does when it merges in runtime-registered aggregates.
      const table = {
        ...Table.make({ schema }),
        entities: members.entities ?? {},
        aggregates: members.aggregates ?? {},
      } as unknown as Table.Table
      expect(() => Table.definition(table)).toThrow(message)
    }

    it("refuses two entities declaring one GSI with different sk fields", () => {
      expectRefused(
        {
          entities: {
            Task: entityWith("Task", {
              byProject: {
                index: "gsi1",
                pk: { field: "gsi1pk", composite: ["project"] },
                sk: { field: "gsi1sk", composite: [] },
              },
            }),
            Note: entityWith("Note", {
              byAuthor: {
                index: "gsi1",
                pk: { field: "gsi1pk", composite: ["author"] },
                sk: { field: "gsi2sk", composite: [] },
              },
            }),
          },
        },
        /\[EDD-9069\] Secondary index "gsi1" is declared as a GSI keyed \(gsi1pk, gsi1sk\) by entity "Task" and as a GSI keyed \(gsi1pk, gsi2sk\) by entity "Note"\. One physical index has one key schema/,
      )
    })

    it("refuses an entity GSI against an aggregate list index keyed differently", () => {
      expectRefused(
        {
          entities: {
            Task: entityWith("Task", {
              byProject: {
                index: "gsi1",
                pk: { field: "gsi1pk", composite: ["project"] },
                sk: { field: "gsi1sk", composite: [] },
              },
            }),
          },
          aggregates: {
            Match: aggregateWith({ listIndex: { index: "gsi1", pk: "gsi2pk", sk: "gsi2sk" } }),
          },
        },
        /\[EDD-9069\] Secondary index "gsi1" is declared as a GSI keyed \(gsi1pk, gsi1sk\) by entity "Task" and as a GSI keyed \(gsi2pk, gsi2sk\) by aggregate "Match" \(list index\)/,
      )
    })

    it("refuses an entity GSI against an aggregate collection LSI of the same name", () => {
      // Same key attributes, different classification: the aggregate's
      // collection shares the table's partition key, so it is an LSI.
      expectRefused(
        {
          entities: {
            Task: entityWith("Task", {
              byOwner: {
                index: "lsi1",
                pk: { field: "pk", composite: ["id"] },
                sk: { field: "lsi1sk", composite: [] },
              },
            }),
          },
          aggregates: { Match: aggregateWith({ collection: { index: "lsi1", sk: "lsi1sk" } }) },
        },
        /\[EDD-9069\] Secondary index "lsi1" is declared as a GSI keyed \(pk, lsi1sk\) by entity "Task" and as an LSI keyed \(pk, lsi1sk\) by aggregate "Match" \(collection index\)/,
      )
    })

    it("refuses an auto-generated cascade index against an entity index", () => {
      expectRefused(
        {
          entities: {
            Task: entityWith("Task", {
              byProject: {
                index: "gsi2",
                pk: { field: "gsi2pk", composite: ["project"] },
                sk: { field: "gsi2sk", composite: [] },
              },
            }),
            Selection: entityWith("Selection", {
              _cascade_player: {
                index: "gsi2",
                pk: { field: "playerGsiPk", composite: ["playerId"] },
                sk: { field: "playerGsiSk", composite: ["id"] },
              },
            }),
          },
        },
        /\[EDD-9069\] Secondary index "gsi2" is declared as a GSI keyed \(gsi2pk, gsi2sk\) by entity "Task" and as a GSI keyed \(playerGsiPk, playerGsiSk\) by entity "Selection"/,
      )
    })

    it("a refused Table.make leaves its members bound to their earlier table", () => {
      const configured: Array<string> = []
      const tracked = (
        entityType: string,
        primary?: { readonly pk: string; readonly sk: string },
      ) => ({
        ...entityWith(entityType, {}, primary),
        _configure: () => {
          configured.push(entityType)
        },
      })
      expect(() =>
        Table.make({
          schema,
          entities: { User: tracked("User"), Order: tracked("Order", { pk: "PK", sk: "SK" }) },
        }),
      ).toThrow(/\[EDD-9069\]/)
      expect(configured).toEqual([])
      Table.make({ schema, entities: { User: tracked("User") } })
      expect(configured).toEqual(["User"])
    })

    it("refuses entities that disagree on the primary-key fields", () => {
      expectRefused(
        {
          entities: {
            User: entityWith("User", {}),
            Order: entityWith("Order", {}, { pk: "PK", sk: "SK" }),
          },
        },
        /\[EDD-9069\] The table's primary key is declared as \(pk, sk\) by entity "User" and as \(PK, SK\) by entity "Order"\. One table has one key schema/,
      )
    })

    it("compares only key attributes when an aggregates-only table leaves classification unknown", () => {
      expect(() =>
        Table.make({
          schema,
          aggregates: {
            A: aggregateWith({ collection: { index: "gsi1", sk: "gsi1sk" } }),
            B: aggregateWith({ listIndex: { index: "gsi1", pk: "gsi2pk", sk: "gsi1sk" } }),
          },
        }),
      ).toThrow(/\[EDD-9069\] Secondary index "gsi1" is declared as an index keyed \(pk, gsi1sk\)/)
      // Same keys, unknown vs GSI classification: accepted.
      expect(() =>
        Table.make({
          schema,
          aggregates: {
            A: aggregateWith({ pkField: "gsi1pk", collection: { index: "gsi1", sk: "gsi1sk" } }),
            B: aggregateWith({ listIndex: { index: "gsi1", pk: "gsi1pk", sk: "gsi1sk" } }),
          },
        }),
      ).not.toThrow()
    })

    it("keeps agreeing sharers of one physical index unchanged", () => {
      const table = Table.make({
        schema,
        entities: {
          Task: entityWith("Task", {
            byProject: {
              index: "gsi1",
              pk: { field: "gsi1pk", composite: ["project"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          }),
          Note: entityWith("Note", {
            byAuthor: {
              index: "gsi1",
              pk: { field: "gsi1pk", composite: ["author"] },
              sk: { field: "gsi1sk", composite: ["createdAt"] },
            },
          }),
        },
        aggregates: {
          Match: aggregateWith({
            collection: { index: "lsi1", sk: "lsi1sk" },
            listIndex: { index: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
          }),
        },
      })
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
    })
  })
})
