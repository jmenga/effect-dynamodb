import ts from "typescript"
import { describe, expect, it } from "vitest"
import { isZOrderHalf, resolveCollections, resolveEntities } from "../src/core/EntityResolver"

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

    it("should resolve DynamoSchema with escapeKeys off, and leave it off the default", () => {
      const resolve = (options: string) => {
        const source = `
          const AppSchema = DynamoSchema.make({ name: "MyApp", version: 1${options} })

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
        return resolveEntities(ts, parseSource(source))[0]!.schema
      }
      expect(resolve(", escapeKeys: false").escapeKeys).toBe(false)
      expect(resolve(", escapeKeys: true").escapeKeys).toBeUndefined()
      expect(resolve("").escapeKeys).toBeUndefined()
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

  describe("Z-order sort keys (#171)", () => {
    const resolveSearch = (sk: string, preamble = "") => {
      const source = `
        ${preamble}
        const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })

        const Listings = Entity.make({
          model: Listing,
          entityType: "Listing",
          primaryKey: {
            pk: { field: "pk", composite: ["listingId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            search: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["region"] },
              sk: ${sk},
            },
          },
        })

        const MainTable = Table.make({ schema: AppSchema, entities: { Listings } })
      `
      return resolveEntities(ts, parseSource(source))[0]?.indexes.search
    }

    it("derives composite from prefix composites, then dimensions, and marks the half", () => {
      const search = resolveSearch(`{
        field: "gsi2sk",
        prefix: ["agencyId", { field: "officeId", hash: 8 }],
        zorder: [
          { field: "price", min: 0, max: 5_000_000, step: 1_000 },
          { field: "bedrooms", min: 0, max: 15 },
          { field: "listedAt", from: "2024-01-01", unit: "hours", bits: 16 },
        ],
      }`)
      expect(search).toBeDefined()
      expect(search!.sk).toEqual({
        field: "gsi2sk",
        composite: ["agencyId", "officeId", "price", "bedrooms", "listedAt"],
        zorder: {
          prefix: ["agencyId", "officeId"],
          dimensions: ["price", "bedrooms", "listedAt"],
        },
      })
      expect(isZOrderHalf(search!.sk)).toBe(true)
      expect(isZOrderHalf(search!.pk)).toBe(false)
    })

    it("resolves a Z-order key without a prefix", () => {
      const search = resolveSearch(
        `{ field: "gsi2sk", zorder: [{ field: "price", min: 0, max: 9 }] }`,
      )
      expect(search!.sk.composite).toEqual(["price"])
      expect(search!.sk.zorder).toEqual({ prefix: [], dimensions: ["price"] })
    })

    it("follows dimensions, lists and prefix parts declared in the file", () => {
      const search = resolveSearch(
        `{ field: "gsi2sk", prefix: [agency, { field: office, hash: 2 }], zorder: facets }`,
        `
        const price = { field: "price", min: 0, max: 9 }
        const facets = [price, { field: "bedrooms", min: 0, max: 15 }] as const
        const agency = "agencyId"
        const office = "officeId"
        `,
      )
      expect(search!.sk).toEqual({
        field: "gsi2sk",
        composite: ["agencyId", "officeId", "price", "bedrooms"],
        zorder: { prefix: ["agencyId", "officeId"], dimensions: ["price", "bedrooms"] },
      })
    })

    it("keeps a Z-order half it can't read whole, marked unresolved", () => {
      // Built by a helper and no checker to type it: the index stays, its parts unknown.
      const built = resolveSearch(`{ field: "gsi2sk", zorder: makeFacets() }`)
      expect(built!.sk).toEqual({
        field: "gsi2sk",
        composite: [],
        zorder: { prefix: [], dimensions: [], unresolved: true },
      })
      expect(isZOrderHalf(built!.sk)).toBe(true)
      const partly = resolveSearch(
        `{ field: "gsi2sk", prefix: [agency], zorder: [{ field: "price", min: 0, max: 9 }, beds] }`,
      )
      expect(partly!.sk.zorder).toEqual({ prefix: [], dimensions: ["price"], unresolved: true })
      expect(partly!.sk.composite).toEqual(["price"])
    })

    it("reads a bare name and a dimension in the same list", () => {
      const search = resolveSearch(
        `{ field: "gsi2sk", zorder: ["status", { field: "price", min: 0, max: 9 }, status2] }`,
        `const status2 = "furnished"`,
      )
      expect(search!.sk.zorder).toEqual({
        prefix: [],
        dimensions: ["status", "price", "furnished"],
      })
    })

    it("reads an entry's field from its type across files", () => {
      // A real checker: the entries come from helpers in another module.
      const files: Record<string, string> = {
        "/virtual/dims.ts": `
          type Range<F extends string> = { readonly field: F; readonly min: number; readonly max: number }
          const range = <F extends string>(field: F): Range<F> => ({ field, min: 0, max: 9 })
          export const makePrice = () => range("price")
          export const price = makePrice()
          export const status = "status" as const
          export const facets = [range("bedrooms"), range("listedAt"), status] as const
          export const makeFacets = () => [price, range("bedrooms")] as const
        `,
        "/virtual/entity.ts": `
          import { facets, makeFacets, price } from "./dims"
          declare const Entity: any, Table: any, DynamoSchema: any, Listing: any
          const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
          const Listings = Entity.make({
            model: Listing,
            entityType: "Listing",
            primaryKey: {
              pk: { field: "pk", composite: ["listingId"] },
              sk: { field: "sk", composite: [] },
            },
            indexes: {
              byPrice: { name: "gsi1", pk: { field: "gsi1pk", composite: ["region"] }, sk: { field: "gsi1sk", zorder: [price] } },
              byFacets: { name: "gsi2", pk: { field: "gsi2pk", composite: ["region"] }, sk: { field: "gsi2sk", zorder: facets } },
              byBuilt: { name: "gsi3", pk: { field: "gsi3pk", composite: ["region"] }, sk: { field: "gsi3sk", zorder: makeFacets() } },
            },
          })
          const MainTable = Table.make({ schema: AppSchema, entities: { Listings } })
        `,
      }
      const options: ts.CompilerOptions = {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      }
      const host = ts.createCompilerHost(options)
      const getSourceFile = host.getSourceFile
      host.getSourceFile = (name, version, ...rest) =>
        files[name] === undefined
          ? getSourceFile(name, version, ...rest)
          : ts.createSourceFile(name, files[name]!, version, true)
      host.fileExists = (name) => files[name] !== undefined || ts.sys.fileExists(name)
      host.readFile = (name) => files[name] ?? ts.sys.readFile(name)
      host.directoryExists = (dir) => dir === "/virtual" || ts.sys.directoryExists(dir)
      const program = ts.createProgram(Object.keys(files), options, host)
      const [listings] = resolveEntities(ts, program.getSourceFile("/virtual/entity.ts")!, program)
      expect(listings!.indexes.byPrice!.sk.zorder).toEqual({ prefix: [], dimensions: ["price"] })
      expect(listings!.indexes.byFacets!.sk.zorder).toEqual({
        prefix: [],
        dimensions: ["bedrooms", "listedAt", "status"],
      })
      expect(listings!.indexes.byBuilt!.sk.zorder).toEqual({
        prefix: [],
        dimensions: ["price", "bedrooms"],
      })
    })

    it("leaves a string half unmarked", () => {
      const search = resolveSearch(`{ field: "gsi2sk", composite: ["price"] }`)
      expect(search!.sk).toEqual({ field: "gsi2sk", composite: ["price"] })
      expect(isZOrderHalf(search!.sk)).toBe(false)
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

  describe("shards (#183)", () => {
    const resolve = (shards: string) => {
      const source = `
        const Devices = Entity.make({
          model: Device,
          entityType: "Device",
          primaryKey: { pk: { field: "pk", composite: ["channel"] }, sk: { field: "sk", composite: ["deviceId"] } },
          indexes: {
            byTenant: {
              name: "gsi5",
              pk: { field: "gsi5pk", composite: ["tenantId"] },
              sk: { field: "gsi5sk", composite: ["groupId"] },
              shards: ${shards},
            },
          },
        })
        const MainTable = Table.make({ schema: DynamoSchema.make({ name: "fleet", version: 1 }), entities: { Devices } })
      `
      return resolveEntities(ts, parseSource(source))[0]!.indexes.byTenant!.shards
    }

    it("parses the shorthand", () => {
      expect(resolve("20")).toEqual({ count: 20, by: [], previous: undefined })
    })

    it("parses the object form", () => {
      expect(resolve('{ count: 20, by: ["groupId"], previous: 4 }')).toEqual({
        count: 20,
        by: ["groupId"],
        previous: 4,
      })
    })

    it("a count that isn't a literal stays unknown", () => {
      expect(resolve("SHARDS")).toEqual({ count: undefined, by: [], previous: undefined })
    })
  })
})
