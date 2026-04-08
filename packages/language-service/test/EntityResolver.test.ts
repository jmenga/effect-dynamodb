import ts from "typescript"
import { describe, expect, it } from "vitest"
import { resolveCollections, resolveEntities } from "../src/core/EntityResolver"

function parseSource(source: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

describe("EntityResolver", () => {
  describe("resolveEntities", () => {
    it("should resolve a basic entity with primary index", () => {
      const source = `
        import * as DynamoSchema from "effect-dynamodb/DynamoSchema"
        import * as Table from "effect-dynamodb/Table"
        import * as Entity from "effect-dynamodb/Entity"

        const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

        const Users = Entity.make({
          model: User,
          entityType: "User",
          indexes: {
            primary: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
          },
        })

        const MainTable = Table.make({ schema: AppSchema, entities: { Users } })
      `
      const sf = parseSource(source)
      const entities = resolveEntities(ts, sf)

      expect(entities).toHaveLength(1)
      expect(entities[0]!.variableName).toBe("Users")
      expect(entities[0]!.entityType).toBe("User")
      expect(entities[0]!.schema).toEqual({ name: "myapp", version: 1, casing: "lowercase" })
      expect(entities[0]!.indexes.primary).toBeDefined()
      expect(entities[0]!.indexes.primary!.pk).toEqual({ field: "pk", composite: ["userId"] })
      expect(entities[0]!.indexes.primary!.sk).toEqual({ field: "sk", composite: [] })
    })

    it("should resolve entity with GSI indexes", () => {
      const source = `
        const AppSchema = DynamoSchema.make({ name: "crud-demo", version: 1 })

        const Users = Entity.make({
          model: User,
          entityType: "User",
          indexes: {
            primary: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            byRole: {
              index: "gsi1",
              pk: { field: "gsi1pk", composite: ["role"] },
              sk: { field: "gsi1sk", composite: ["userId"] },
            },
          },
          timestamps: true,
          versioned: { retain: true },
        })

        const MainTable = Table.make({ schema: AppSchema, entities: { Users } })
      `
      const sf = parseSource(source)
      const entities = resolveEntities(ts, sf)

      expect(entities).toHaveLength(1)
      const user = entities[0]!
      expect(user.entityType).toBe("User")
      expect(user.indexes.byRole).toBeDefined()
      expect(user.indexes.byRole!.index).toBe("gsi1")
      expect(user.indexes.byRole!.pk).toEqual({ field: "gsi1pk", composite: ["role"] })
      expect(user.indexes.byRole!.sk).toEqual({ field: "gsi1sk", composite: ["userId"] })
      expect(user.timestamps).toBe(true)
      expect(user.versioned).toEqual({ retain: true })
    })

    it("should resolve multiple entities in the same file", () => {
      const source = `
        const AppSchema = DynamoSchema.make({ name: "test", version: 2 })

        const Users = Entity.make({
          model: User,
          entityType: "User",
          indexes: {
            primary: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
          },
        })

        const Tasks = Entity.make({
          model: Task,
          entityType: "Task",
          indexes: {
            primary: {
              pk: { field: "pk", composite: ["taskId"] },
              sk: { field: "sk", composite: [] },
            },
          },
          softDelete: true,
        })

        const MainTable = Table.make({ schema: AppSchema, entities: { Users, Tasks } })
      `
      const sf = parseSource(source)
      const entities = resolveEntities(ts, sf)

      expect(entities).toHaveLength(2)
      expect(entities[0]!.entityType).toBe("User")
      expect(entities[1]!.entityType).toBe("Task")
      expect(entities[1]!.softDelete).toBe(true)
    })

    it("should resolve DynamoSchema with custom casing", () => {
      const source = `
        const AppSchema = DynamoSchema.make({ name: "MyApp", version: 1, casing: "preserve" })

        const Items = Entity.make({
          model: Item,
          entityType: "Item",
          indexes: {
            primary: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
          },
        })

        const MainTable = Table.make({ schema: AppSchema, entities: { Items } })
      `
      const sf = parseSource(source)
      const entities = resolveEntities(ts, sf)

      expect(entities).toHaveLength(1)
      expect(entities[0]!.schema.casing).toBe("preserve")
      expect(entities[0]!.schema.name).toBe("MyApp")
    })

    it("should resolve entity with collection indexes", () => {
      const source = `
        const AppSchema = DynamoSchema.make({ name: "shop", version: 1 })

        const Orders = Entity.make({
          model: Order,
          entityType: "Order",
          indexes: {
            primary: {
              pk: { field: "pk", composite: ["orderId"] },
              sk: { field: "sk", composite: [] },
            },
            byCustomer: {
              index: "gsi1",
              collection: "customerOrders",
              pk: { field: "gsi1pk", composite: ["customerId"] },
              sk: { field: "gsi1sk", composite: ["orderDate"] },
            },
          },
        })

        const MainTable = Table.make({ schema: AppSchema, entities: { Orders } })
      `
      const sf = parseSource(source)
      const entities = resolveEntities(ts, sf)

      expect(entities).toHaveLength(1)
      expect(entities[0]!.indexes.byCustomer!.collection).toBe("customerOrders")
    })

    it("should return empty array when no Entity.make calls exist", () => {
      const source = `
        const x = 42
        const y = "hello"
      `
      const sf = parseSource(source)
      const entities = resolveEntities(ts, sf)

      expect(entities).toHaveLength(0)
    })

    it("should handle entity with softDelete and unique config", () => {
      const source = `
        const AppSchema = DynamoSchema.make({ name: "app", version: 1 })

        const Users = Entity.make({
          model: User,
          entityType: "User",
          indexes: {
            primary: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
          },
          softDelete: { ttl: 86400 },
          unique: { email: { fields: ["email"] } },
        })

        const MainTable = Table.make({ schema: AppSchema, entities: { Users } })
      `
      const sf = parseSource(source)
      const entities = resolveEntities(ts, sf)

      expect(entities).toHaveLength(1)
      expect(entities[0]!.softDelete).toEqual({ ttl: 86400 })
      expect(entities[0]!.unique).toEqual({ email: { fields: ["email"] } })
    })

    it("should resolve entity with primaryKey + GsiConfig indexes", () => {
      const source = `
        const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

        const Tasks = Entity.make({
          model: Task,
          entityType: "Task",
          primaryKey: {
            pk: { field: "pk", composite: ["taskId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byProject: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["projectId"] },
              sk: { field: "gsi1sk", composite: ["status"] },
              collection: "projectTasks",
            },
            byStatus: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["status"] },
              sk: { field: "gsi2sk", composite: ["taskId"] },
            },
          },
          timestamps: true,
        })

        const MainTable = Table.make({ schema: AppSchema, entities: { Tasks } })
      `
      const sf = parseSource(source)
      const entities = resolveEntities(ts, sf)

      expect(entities).toHaveLength(1)
      const task = entities[0]!
      expect(task.entityType).toBe("Task")

      // Primary key resolved from primaryKey config
      expect(task.indexes.primary).toBeDefined()
      expect(task.indexes.primary!.pk).toEqual({ field: "pk", composite: ["taskId"] })

      // GSI indexes resolved from GsiConfig format
      expect(task.indexes.byProject).toBeDefined()
      expect(task.indexes.byProject!.index).toBe("gsi1")
      expect(task.indexes.byProject!.pk).toEqual({ field: "gsi1pk", composite: ["projectId"] })
      expect(task.indexes.byProject!.sk).toEqual({ field: "gsi1sk", composite: ["status"] })
      expect(task.indexes.byProject!.collection).toBe("projectTasks")
      expect(task.indexes.byProject!.type).toBe("isolated")

      expect(task.indexes.byStatus).toBeDefined()
      expect(task.indexes.byStatus!.index).toBe("gsi2")
      expect(task.indexes.byStatus!.pk).toEqual({ field: "gsi2pk", composite: ["status"] })
      expect(task.indexes.byStatus!.sk).toEqual({ field: "gsi2sk", composite: ["taskId"] })
      expect(task.indexes.byStatus!.collection).toBeUndefined()
    })

    it("should resolve entity with primaryKey (v2 API)", () => {
      const source = `
        const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

        const Users = Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
        })

        const MainTable = Table.make({ schema: AppSchema, entities: { Users } })
      `
      const sf = parseSource(source)
      const entities = resolveEntities(ts, sf)

      expect(entities).toHaveLength(1)
      expect(entities[0]!.variableName).toBe("Users")
      expect(entities[0]!.entityType).toBe("User")
      expect(entities[0]!.indexes.primary).toBeDefined()
      expect(entities[0]!.indexes.primary!.pk).toEqual({
        field: "pk",
        composite: ["userId"],
      })
    })
  })

  describe("resolveCollections", () => {
    it("should resolve a basic collection", () => {
      const source = `
        const Assignments = Collections.make({ name: "assignments",
          index: { name: "gsi3", pk: "gsi3pk", sk: "gsi3sk" },
          composite: ["employee"],
          members: {
            Employees: Collections.member(Employees, []),
            Tasks: Collections.member(Tasks, ["project", "task"]),
          },
        })
      `
      const sf = parseSource(source)
      const collections = resolveCollections(ts, sf)

      expect(collections).toHaveLength(1)
      expect(collections[0]!.variableName).toBe("Assignments")
      expect(collections[0]!.collectionName).toBe("assignments")
      expect(collections[0]!.index).toBe("gsi3")
      expect(collections[0]!.type).toBe("clustered")
      expect(collections[0]!.pk).toEqual({
        field: "gsi3pk",
        composite: ["employee"],
      })
      expect(collections[0]!.sk).toEqual({ field: "gsi3sk" })
      expect(Object.keys(collections[0]!.members)).toEqual(["Employees", "Tasks"])
      expect(collections[0]!.members.Employees).toEqual({
        entityVariableName: "Employees",
        sk: { composite: [] },
      })
      expect(collections[0]!.members.Tasks).toEqual({
        entityVariableName: "Tasks",
        sk: { composite: ["project", "task"] },
      })
    })

    it("should resolve isolated collection type", () => {
      const source = `
        const ManagerView = Collections.make({ name: "managerView",
          type: "isolated",
          index: { name: "gsi2", pk: "gsi2pk", sk: "gsi2sk" },
          composite: ["manager"],
          members: {
            Employees: Collections.member(Employees, []),
          },
        })
      `
      const sf = parseSource(source)
      const collections = resolveCollections(ts, sf)

      expect(collections).toHaveLength(1)
      expect(collections[0]!.type).toBe("isolated")
    })

    it("should resolve single-member collection", () => {
      const source = `
        const TasksByProject = Collections.make({ name: "tasksByProject",
          index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
          composite: ["project"],
          members: {
            Tasks: Collections.member(Tasks, ["employee", "task"]),
          },
        })
      `
      const sf = parseSource(source)
      const collections = resolveCollections(ts, sf)

      expect(collections).toHaveLength(1)
      expect(collections[0]!.collectionName).toBe("tasksByProject")
      expect(Object.keys(collections[0]!.members)).toEqual(["Tasks"])
    })
  })
})
