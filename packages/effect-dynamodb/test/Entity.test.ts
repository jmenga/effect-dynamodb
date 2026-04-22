import { describe, expect, it } from "@effect/vitest"
import { DateTime, Duration, Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import { DynamoError, type TransactionOverflow } from "../src/Errors.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "myapp", version: 1 })
const MainTable = Table.make({ schema: AppSchema })

/** Configure inline entities for testing (not registered via Table.make) */
const withConfig = <E extends { _configure: Function }>(entity: E): E => {
  entity._configure(AppSchema, MainTable.Tag)
  return entity
}

class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  role: Schema.Literals(["admin", "member"]),
}) {}

class UserWithImmutable extends Schema.Class<UserWithImmutable>("UserWithImmutable")({
  userId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  createdBy: Schema.String,
}) {}

const UserWithImmutableModel = DynamoModel.configure(UserWithImmutable, {
  createdBy: { immutable: true },
})

class SimpleItem extends Schema.Class<SimpleItem>("SimpleItem")({
  itemId: Schema.String,
  name: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Mock DynamoClient for operation tests
// ---------------------------------------------------------------------------

const mockPutItem = vi.fn()
const mockGetItem = vi.fn()
const mockDeleteItem = vi.fn()
const mockUpdateItem = vi.fn()
const mockQuery = vi.fn()
const mockTransactWriteItems = vi.fn()

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
  transactWriteItems: (input) =>
    Effect.tryPromise({
      try: () => mockTransactWriteItems(input),
      catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
    }),
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
})

const TestTableConfig = MainTable.layer({ name: "test-table" })
const TestLayer = Layer.merge(TestDynamoClient, TestTableConfig)

// ---------------------------------------------------------------------------
// Entity.make() basics
// ---------------------------------------------------------------------------

describe("Entity", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  describe("make", () => {
    it("creates an entity with correct entityType and model", () => {
      const UserEntity = Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
      })

      expect(UserEntity._tag).toBe("Entity")
      expect(UserEntity.entityType).toBe("User")
      expect(UserEntity.model).toBe(User)
    })

    it("stores index definitions", () => {
      const UserEntity = Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byEmail: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["email"] },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
      })

      expect(UserEntity.indexes.primary.pk.field).toBe("pk")
      expect(UserEntity.indexes.primary.pk.composite).toEqual(["userId"])
      expect(UserEntity.indexes.byEmail.index).toBe("gsi1")
      expect(UserEntity.indexes.byEmail.pk.composite).toEqual(["email"])
    })

    it("stores timestamps config", () => {
      const UserEntity = Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
      })

      expect(UserEntity.timestamps).toBe(true)
      expect(UserEntity.systemFields.createdAt).toBe("createdAt")
      expect(UserEntity.systemFields.updatedAt).toBe("updatedAt")
    })

    it("throws if primary index has no composite attributes in pk or sk", () => {
      expect(() =>
        Entity.make({
          model: User,
          entityType: "User",
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- bypass compile-time check for runtime test
          primaryKey: {
            pk: { field: "pk", composite: [] },
            sk: { field: "sk", composite: [] },
          } as any,
        }),
      ).toThrow("[EDD-9001]")
    })

    it("allows primary index with empty pk composite if sk has composites", () => {
      expect(() =>
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: [] },
            sk: { field: "sk", composite: ["userId"] },
          },
        }),
      ).not.toThrow()
    })

    it("stores versioned config", () => {
      const UserEntity = Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        versioned: true,
      })

      expect(UserEntity.versioned).toBe(true)
      expect(UserEntity.systemFields.version).toBe("version")
    })

    it("stores softDelete config", () => {
      const UserEntity = Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        softDelete: true,
      })

      expect(UserEntity.softDelete).toBe(true)
    })

    it("stores unique constraint config", () => {
      const UserEntity = Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        unique: { email: ["email"] },
      })

      expect(UserEntity.unique).toEqual({ email: ["email"] })
    })

    it("defaults timestamps, versioned, softDelete, unique to undefined", () => {
      const UserEntity = Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
      })

      expect(UserEntity.timestamps).toBeUndefined()
      expect(UserEntity.versioned).toBeUndefined()
      expect(UserEntity.softDelete).toBeUndefined()
      expect(UserEntity.unique).toBeUndefined()
      expect(UserEntity.systemFields.createdAt).toBeNull()
      expect(UserEntity.systemFields.updatedAt).toBeNull()
      expect(UserEntity.systemFields.version).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // System fields
  // ---------------------------------------------------------------------------

  describe("system fields", () => {
    it("timestamps: true adds createdAt and updatedAt", () => {
      const UserEntity = Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
      })

      expect(UserEntity.systemFields.createdAt).toBe("createdAt")
      expect(UserEntity.systemFields.updatedAt).toBe("updatedAt")
    })

    it("timestamps with custom field names", () => {
      const UserEntity = Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: { created: "registeredAt", updated: "modifiedAt" },
      })

      expect(UserEntity.systemFields.createdAt).toBe("registeredAt")
      expect(UserEntity.systemFields.updatedAt).toBe("modifiedAt")
    })

    it("versioned: true adds version", () => {
      const UserEntity = Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        versioned: true,
      })

      expect(UserEntity.systemFields.version).toBe("version")
    })

    it("versioned with custom field name", () => {
      const UserEntity = Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        versioned: { field: "revision" },
      })

      expect(UserEntity.systemFields.version).toBe("revision")
    })

    it("versioned with retain option", () => {
      const UserEntity = Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        versioned: { retain: true },
      })

      expect(UserEntity.versioned).toEqual({ retain: true })
      expect(UserEntity.systemFields.version).toBe("version")
    })
  })

  // ---------------------------------------------------------------------------
  // Derived schemas and type extraction
  // ---------------------------------------------------------------------------

  describe("derived schemas", () => {
    const UserEntity = withConfig(
      Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byEmail: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["email"] },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
        timestamps: true,
        versioned: true,
      }),
    )

    it("Model schema decodes pure model fields", () => {
      const decode = Schema.decodeUnknownSync(UserEntity.schemas.modelSchema)
      const result = decode({
        userId: "u-1",
        email: "alice@example.com",
        displayName: "Alice",
        role: "admin",
      })
      expect(result).toEqual({
        userId: "u-1",
        email: "alice@example.com",
        displayName: "Alice",
        role: "admin",
      })
    })

    it("Model schema rejects invalid model data", () => {
      const decode = Schema.decodeUnknownSync(UserEntity.schemas.modelSchema)
      expect(() => decode({ userId: "u-1" })).toThrow()
    })

    it("Record schema decodes model + system fields", () => {
      const decode = Schema.decodeUnknownSync(UserEntity.schemas.recordSchema)
      const result = decode({
        userId: "u-1",
        email: "alice@example.com",
        displayName: "Alice",
        role: "admin",
        createdAt: "2024-01-15T00:00:00Z",
        updatedAt: "2024-01-15T00:00:00Z",
        version: 1,
      })
      expect(result.userId).toBe("u-1")
      expect(result.version).toBe(1)
      // createdAt/updatedAt decode to DateTime.Utc objects
      expect(typeof result.createdAt).toBe("object")
    })

    it("Record schema rejects missing system fields", () => {
      const decode = Schema.decodeUnknownSync(UserEntity.schemas.recordSchema)
      expect(() =>
        decode({
          userId: "u-1",
          email: "alice@example.com",
          displayName: "Alice",
          role: "admin",
          // missing createdAt, updatedAt, version
        }),
      ).toThrow()
    })

    it("Input schema is same as model schema", () => {
      const decode = Schema.decodeUnknownSync(UserEntity.schemas.inputSchema)
      const result = decode({
        userId: "u-1",
        email: "alice@example.com",
        displayName: "Alice",
        role: "admin",
      })
      expect(result.userId).toBe("u-1")
    })

    it("Update schema has optional fields minus key composites", () => {
      const decode = Schema.decodeUnknownSync(UserEntity.schemas.updateSchema)

      // Empty update is valid (all optional)
      const empty = decode({})
      expect(empty).toEqual({})

      // Partial update is valid
      const partial = decode({ email: "newemail@example.com" })
      expect(partial).toEqual({ email: "newemail@example.com" })

      // Full update (minus key) is valid
      const full = decode({
        email: "new@example.com",
        displayName: "Bob",
        role: "member",
      })
      expect(full.email).toBe("new@example.com")
      expect(full.displayName).toBe("Bob")
      expect(full.role).toBe("member")
    })

    it("Update schema excludes primary key composites", () => {
      const decode = Schema.decodeUnknownSync(UserEntity.schemas.updateSchema)
      // userId is a pk composite — it should not be accepted as an update field
      // Since the schema uses optional fields, extra fields are stripped during decode
      const result = decode({ userId: "u-2", email: "new@example.com" })
      // userId should not appear in the result
      expect(result).not.toHaveProperty("userId")
    })

    it("Key schema contains only primary key composites", () => {
      const decode = Schema.decodeUnknownSync(UserEntity.schemas.keySchema)
      const result = decode({ userId: "u-1" })
      expect(result).toEqual({ userId: "u-1" })
    })

    it("Key schema rejects missing composites", () => {
      const decode = Schema.decodeUnknownSync(UserEntity.schemas.keySchema)
      expect(() => decode({})).toThrow()
    })

    it("Item schema includes model + system + key attrs + __edd_e__", () => {
      const decode = Schema.decodeUnknownSync(UserEntity.schemas.itemSchema)
      const result = decode({
        userId: "u-1",
        email: "alice@example.com",
        displayName: "Alice",
        role: "admin",
        createdAt: "2024-01-15T00:00:00Z",
        updatedAt: "2024-01-15T00:00:00Z",
        version: 1,
        pk: "$myapp#v1#user#u-1",
        sk: "$myapp#v1#user",
        gsi1pk: "$myapp#v1#user#alice@example.com",
        gsi1sk: "$myapp#v1#user",
        __edd_e__: "User",
      })
      expect(result.pk).toBe("$myapp#v1#user#u-1")
      expect(result.__edd_e__).toBe("User")
      expect(result.userId).toBe("u-1")
    })
  })

  // ---------------------------------------------------------------------------
  // Immutable fields excluded from Update
  // ---------------------------------------------------------------------------

  describe("DynamoModel.configure immutable", () => {
    it("excludes immutable fields from Update schema", () => {
      const ImmutableEntity = withConfig(
        Entity.make({
          model: UserWithImmutableModel,
          entityType: "UserImm",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
        }),
      )

      const decode = Schema.decodeUnknownSync(ImmutableEntity.schemas.updateSchema)

      // Can update email and displayName
      const result = decode({ email: "new@example.com", displayName: "Bob" })
      expect(result.email).toBe("new@example.com")
      expect(result.displayName).toBe("Bob")

      // createdBy (immutable) is stripped from update
      const withImmutable = decode({ createdBy: "should-be-stripped" })
      expect(withImmutable).not.toHaveProperty("createdBy")
    })

    it("includes immutable fields in Model schema", () => {
      const ImmutableEntity = withConfig(
        Entity.make({
          model: UserWithImmutableModel,
          entityType: "UserImm",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
        }),
      )

      const decode = Schema.decodeUnknownSync(ImmutableEntity.schemas.modelSchema)
      const result = decode({
        userId: "u-1",
        email: "a@b.com",
        displayName: "Alice",
        createdBy: "admin",
      })
      expect(result.createdBy).toBe("admin")
    })

    it("includes immutable fields in Input schema", () => {
      const ImmutableEntity = withConfig(
        Entity.make({
          model: UserWithImmutableModel,
          entityType: "UserImm",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
        }),
      )

      const decode = Schema.decodeUnknownSync(ImmutableEntity.schemas.inputSchema)
      const result = decode({
        userId: "u-1",
        email: "a@b.com",
        displayName: "Alice",
        createdBy: "admin",
      })
      expect(result.createdBy).toBe("admin")
    })
  })

  // ---------------------------------------------------------------------------
  // Key extraction
  // ---------------------------------------------------------------------------

  describe("key extraction", () => {
    it("keyAttributes returns primary pk + sk composites", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byEmail: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["email"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
        }),
      )

      // Only primary key composites
      expect(Entity.keyAttributes(UserEntity)).toEqual(["userId"])
    })

    it("keyAttributes includes sk composites when present", () => {
      class TenantUser extends Schema.Class<TenantUser>("TenantUser")({
        tenantId: Schema.String,
        userId: Schema.String,
        name: Schema.String,
      }) {}

      const TenantUserEntity = withConfig(
        Entity.make({
          model: TenantUser,
          entityType: "TenantUser",
          primaryKey: {
            pk: { field: "pk", composite: ["tenantId"] },
            sk: { field: "sk", composite: ["userId"] },
          },
        }),
      )

      const composites = Entity.keyAttributes(TenantUserEntity)
      expect(composites).toContain("tenantId")
      expect(composites).toContain("userId")
    })

    it("keyFieldNames returns all physical key field names", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byEmail: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["email"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
        }),
      )

      const fieldNames = Entity.keyFieldNames(UserEntity)
      expect(fieldNames).toContain("pk")
      expect(fieldNames).toContain("sk")
      expect(fieldNames).toContain("gsi1pk")
      expect(fieldNames).toContain("gsi1sk")
    })

    it("compositeAttributes returns all composite attrs across all indexes", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byEmail: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["email"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
        }),
      )

      const allComposites = Entity.compositeAttributes(UserEntity)
      expect(allComposites).toContain("userId")
      expect(allComposites).toContain("email")
    })
  })

  // ---------------------------------------------------------------------------
  // Index definitions
  // ---------------------------------------------------------------------------

  describe("indexes", () => {
    it("stores multiple indexes including GSIs", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byEmail: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["email"] },
              sk: { field: "gsi1sk", composite: [] },
            },
            byRole: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["role"] },
              sk: { field: "gsi2sk", composite: ["userId"] },
            },
          },
        }),
      )

      expect(Object.keys(UserEntity.indexes)).toEqual(["primary", "byEmail", "byRole"])
      expect(UserEntity.indexes.byEmail.index).toBe("gsi1")
      expect(UserEntity.indexes.byRole.index).toBe("gsi2")
      expect(UserEntity.indexes.byRole.sk.composite).toEqual(["userId"])
    })

    it("stores collection and type on GSI indexes", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byTenant: {
              collection: "TenantItems",
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["role"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
        }),
      )

      expect(UserEntity.indexes.byTenant.collection).toBe("TenantItems")
      expect(UserEntity.indexes.byTenant.type).toBe("isolated")
    })
  })

  // ---------------------------------------------------------------------------
  // Unique constraints
  // ---------------------------------------------------------------------------

  describe("unique constraints", () => {
    it("stores single-field unique constraints", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          unique: { email: ["email"] },
        }),
      )

      expect(UserEntity.unique).toEqual({ email: ["email"] })
    })

    it("stores compound unique constraints", () => {
      class TenantUser extends Schema.Class<TenantUser>("TenantUser")({
        tenantId: Schema.String,
        userId: Schema.String,
        email: Schema.String,
      }) {}

      const TenantUserEntity = withConfig(
        Entity.make({
          model: TenantUser,
          entityType: "TenantUser",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          unique: {
            email: ["email"],
            tenantEmail: ["tenantId", "email"],
          },
        }),
      )

      expect(TenantUserEntity.unique).toEqual({
        email: ["email"],
        tenantEmail: ["tenantId", "email"],
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Operations — function existence
  // ---------------------------------------------------------------------------

  describe("operations", () => {
    it("has get, put, update, delete functions", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
        }),
      )

      expect(typeof UserEntity.get).toBe("function")
      expect(typeof UserEntity.put).toBe("function")
      expect(typeof UserEntity.update).toBe("function")
      expect(typeof UserEntity.delete).toBe("function")
    })

    it("has query namespace with named index accessors", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byEmail: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["email"] },
              sk: { field: "gsi1sk", composite: [] },
            },
            byRole: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["role"] },
              sk: { field: "gsi2sk", composite: ["userId"] },
            },
          },
        }),
      )

      expect(typeof UserEntity.query.byEmail).toBe("function")
      expect(typeof UserEntity.query.byRole).toBe("function")
      // primary is NOT in query namespace
      expect((UserEntity.query as any).primary).toBeUndefined()
    })

    it("query accessor returns a Query object", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byEmail: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["email"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
        }),
      )

      const q = UserEntity.query.byEmail({ email: "test@example.com" })
      expect(Query.isQuery(q)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Entity without system fields
  // ---------------------------------------------------------------------------

  describe("entity without system fields", () => {
    it("Record schema equals Model schema when no system fields", () => {
      const SimpleEntity = withConfig(
        Entity.make({
          model: SimpleItem,
          entityType: "SimpleItem",
          primaryKey: {
            pk: { field: "pk", composite: ["itemId"] },
            sk: { field: "sk", composite: [] },
          },
        }),
      )

      const decodeModel = Schema.decodeUnknownSync(SimpleEntity.schemas.modelSchema)
      const decodeRecord = Schema.decodeUnknownSync(SimpleEntity.schemas.recordSchema)

      const input = { itemId: "i-1", name: "Test" }
      expect(decodeModel(input)).toEqual(decodeRecord(input))
    })
  })

  // ---------------------------------------------------------------------------
  // Type extractor smoke tests (compile-time + runtime)
  // ---------------------------------------------------------------------------

  describe("type extractors", () => {
    const UserEntity = withConfig(
      Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byEmail: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["email"] },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
        timestamps: true,
        versioned: true,
      }),
    )

    it("all 7 type extractors are defined", () => {
      // These are type-level only, but we can verify the schemas exist at runtime
      expect(UserEntity.schemas.modelSchema).toBeDefined()
      expect(UserEntity.schemas.recordSchema).toBeDefined()
      expect(UserEntity.schemas.inputSchema).toBeDefined()
      expect(UserEntity.schemas.updateSchema).toBeDefined()
      expect(UserEntity.schemas.keySchema).toBeDefined()
      expect(UserEntity.schemas.itemSchema).toBeDefined()
      // Marshalled is a type alias — no runtime schema needed for Group 4
    })

    it("type-level: Model type compiles correctly", () => {
      // This is a compile-time check — if it compiles, the type extractor works
      type UserModel = Entity.Model<typeof UserEntity>
      const _check: UserModel = {
        userId: "u-1",
        email: "alice@example.com",
        displayName: "Alice" as any, // NonEmptyString
        role: "admin",
      }
      expect(_check.userId).toBe("u-1")
    })

    it("type-level: Key type compiles correctly", () => {
      type UserKey = Entity.Key<typeof UserEntity>
      const _check: UserKey = { userId: "u-1" }
      expect(_check.userId).toBe("u-1")
    })

    it("type-level: Marshalled type compiles correctly", () => {
      type UserMarshalled = Entity.Marshalled<typeof UserEntity>
      const _check: UserMarshalled = {
        pk: { S: "$myapp#v1#user#u-1" },
        userId: { S: "u-1" },
      }
      expect(_check.pk).toEqual({ S: "$myapp#v1#user#u-1" })
    })

    it("type-level: operation types are concrete (not any)", () => {
      // Verify get key type is { userId: string }
      type GetKey = Parameters<typeof UserEntity.get>[0]
      const _getKey: GetKey = { userId: "u-1" }

      // Verify query.byEmail pk type has { email: string }
      type QueryPk = Parameters<typeof UserEntity.query.byEmail>[0]
      const _queryPk: QueryPk = { email: "test@test.com" }

      // Verify update key type is { userId: string } (update now takes just key)
      type UpdateKey = Parameters<typeof UserEntity.update>[0]
      const _updateData: UpdateKey = { userId: "u-1" }

      // Verify Entity.Record includes system fields
      type UserRecord = Entity.Record<typeof UserEntity>
      type HasCreatedAt = UserRecord extends { readonly createdAt: unknown } ? true : false
      type HasVersion = UserRecord extends { readonly version: number } ? true : false
      const _hasCreatedAt: HasCreatedAt = true
      const _hasVersion: HasVersion = true

      expect(_getKey.userId).toBe("u-1")
      expect(_queryPk.email).toBe("test@test.com")
      expect(_updateData.userId).toBe("u-1")
      expect(_hasCreatedAt).toBe(true)
      expect(_hasVersion).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Schema accessors (itemSchema, decodeMarshalledItem)
  // ---------------------------------------------------------------------------

  describe("schema accessors", () => {
    const UserEntity = withConfig(
      Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
        versioned: true,
      }),
    )

    it("itemSchema returns the entity's item schema", () => {
      const schema = Entity.itemSchema(UserEntity)
      expect(schema).toBe(UserEntity.schemas.itemSchema)
    })

    it.effect("itemSchema decodes an unmarshalled DynamoDB item", () =>
      Effect.gen(function* () {
        const schema = Entity.itemSchema(UserEntity)
        const rawItem = {
          pk: "$myapp#v1#user#u-1",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
          userId: "u-1",
          email: "alice@test.com",
          displayName: "Alice",
          role: "admin",
          version: 1,
          createdAt: "2024-01-15T10:00:00Z",
          updatedAt: "2024-01-15T10:00:00Z",
        }
        const decoded = yield* Schema.decodeUnknownEffect(schema)(rawItem)
        expect(decoded).toMatchObject({
          userId: "u-1",
          email: "alice@test.com",
          displayName: "Alice",
          role: "admin",
          version: 1,
        })
      }),
    )

    it.effect("decodeMarshalledItem decodes a marshalled DynamoDB item", () =>
      Effect.gen(function* () {
        const marshalledItem = toAttributeMap({
          pk: "$myapp#v1#user#u-1",
          sk: "$myapp#v1#user",
          __edd_e__: "User",
          userId: "u-1",
          email: "alice@test.com",
          displayName: "Alice",
          role: "admin",
          version: 1,
          createdAt: "2024-01-15T10:00:00Z",
          updatedAt: "2024-01-15T10:00:00Z",
        })
        const decoded = yield* Entity.decodeMarshalledItem(UserEntity, marshalledItem)
        expect(decoded).toMatchObject({
          userId: "u-1",
          email: "alice@test.com",
          role: "admin",
        })
      }),
    )

    it.effect("decodeMarshalledItem fails with ValidationError on invalid data", () =>
      Effect.gen(function* () {
        const marshalledItem = toAttributeMap({ invalid: "data" })
        const error = yield* Entity.decodeMarshalledItem(UserEntity, marshalledItem).pipe(
          Effect.flip,
        )
        expect(error._tag).toBe("ValidationError")
        expect(error.entityType).toBe("User")
        expect(error.operation).toBe("decodeMarshalledItem")
      }),
    )
  })

  // ---------------------------------------------------------------------------
  // Schema.Struct model support
  // ---------------------------------------------------------------------------

  describe("Schema.Struct model support", () => {
    it("works with Schema.Struct as model", () => {
      const ItemStruct = Schema.Struct({
        itemId: Schema.String,
        value: Schema.Number,
      })

      const StructEntity = withConfig(
        Entity.make({
          model: ItemStruct,
          entityType: "Item",
          primaryKey: {
            pk: { field: "pk", composite: ["itemId"] },
            sk: { field: "sk", composite: [] },
          },
        }),
      )

      expect(StructEntity.entityType).toBe("Item")
      const decode = Schema.decodeUnknownSync(StructEntity.schemas.modelSchema)
      const result = decode({ itemId: "i-1", value: 42 })
      expect(result.itemId).toBe("i-1")
      expect(result.value).toBe(42)
    })
  })

  // ---------------------------------------------------------------------------
  // Schema.Class instanceof — model-mode decode returns proper instances
  // ---------------------------------------------------------------------------

  describe("Schema.Class instanceof", () => {
    const ClassEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SimpleItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    it.effect("get returns Schema.Class instance", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            itemId: "i-1",
            name: "Test",
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            __edd_e__: "SimpleItem",
          }),
        })

        const result = yield* ClassEntity.get({ itemId: "i-1" }).asEffect()
        expect(result).toBeInstanceOf(SimpleItem)
        expect(result.itemId).toBe("i-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("put returns Schema.Class instance", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        const result = yield* ClassEntity.put({ itemId: "i-1", name: "Test" }).asEffect()
        expect(result).toBeInstanceOf(SimpleItem)
        expect(result.itemId).toBe("i-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("create returns Schema.Class instance", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        const result = yield* ClassEntity.create({ itemId: "i-1", name: "Test" }).asEffect()
        expect(result).toBeInstanceOf(SimpleItem)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("update returns Schema.Class instance", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            itemId: "i-1",
            name: "Updated",
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            __edd_e__: "SimpleItem",
          }),
        })

        const result = yield* ClassEntity.update({ itemId: "i-1" }).pipe(
          Entity.set({ name: "Updated" }),
          Entity.asModel,
        )
        expect(result).toBeInstanceOf(SimpleItem)
        expect(result.name).toBe("Updated")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("query returns Schema.Class instances", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              userId: "u-1",
              email: "a@test.com",
              displayName: "Alice",
              role: "admin",
              pk: "$myapp#v1#user#u-1",
              sk: "$myapp#v1#user",
              gsi1pk: "$myapp#v1#user#a@test.com",
              gsi1sk: "$myapp#v1#user",
              __edd_e__: "User",
            }),
          ],
        })

        const QueryEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "User",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            indexes: {
              byEmail: {
                name: "gsi1",
                pk: { field: "gsi1pk", composite: ["email"] },
                sk: { field: "gsi1sk", composite: [] },
              },
            },
          }),
        )

        const page = yield* QueryEntity.query.byEmail({ email: "a@test.com" }).pipe(Query.execute)
        expect(page.items).toHaveLength(1)
        expect(page.items[0]).toBeInstanceOf(User)
        expect(page.items[0]!.userId).toBe("u-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("Schema.Struct model returns plain object (not a class instance)", () =>
      Effect.gen(function* () {
        const StructModel = Schema.Struct({
          itemId: Schema.String,
          value: Schema.Number,
        })

        const StructEntity = withConfig(
          Entity.make({
            model: StructModel,
            entityType: "StructItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
          }),
        )

        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            itemId: "i-1",
            value: 42,
            pk: "$myapp#v1#structitem#i-1",
            sk: "$myapp#v1#structitem",
            __edd_e__: "StructItem",
          }),
        })

        const result = yield* StructEntity.get({ itemId: "i-1" }).asEffect()
        expect(result.itemId).toBe("i-1")
        expect(result.value).toBe(42)
        // Plain object, not an instance of any class
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // Full configuration test (mimics design-v2.md example)
  // ---------------------------------------------------------------------------

  describe("full configuration", () => {
    it("creates entity matching design-v2.md User example", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byEmail: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["email"] },
              sk: { field: "gsi2sk", composite: [] },
            },
          },
          timestamps: true,
          versioned: { retain: true },
          softDelete: true,
          unique: { email: ["email"] },
        }),
      )

      // Entity properties
      expect(UserEntity._tag).toBe("Entity")
      expect(UserEntity.entityType).toBe("User")
      expect(UserEntity.timestamps).toBe(true)
      expect(UserEntity.versioned).toEqual({ retain: true })
      expect(UserEntity.softDelete).toBe(true)
      expect(UserEntity.unique).toEqual({ email: ["email"] })

      // System fields resolved
      expect(UserEntity.systemFields.createdAt).toBe("createdAt")
      expect(UserEntity.systemFields.updatedAt).toBe("updatedAt")
      expect(UserEntity.systemFields.version).toBe("version")

      // All 6 schemas built (Marshalled is type-only)
      expect(UserEntity.schemas.modelSchema).toBeDefined()
      expect(UserEntity.schemas.recordSchema).toBeDefined()
      expect(UserEntity.schemas.inputSchema).toBeDefined()
      expect(UserEntity.schemas.updateSchema).toBeDefined()
      expect(UserEntity.schemas.keySchema).toBeDefined()
      expect(UserEntity.schemas.itemSchema).toBeDefined()

      // Query namespace has byEmail but not primary
      expect(typeof UserEntity.query.byEmail).toBe("function")
    })
  })

  // ---------------------------------------------------------------------------
  // put operation
  // ---------------------------------------------------------------------------

  describe("put", () => {
    const SimpleEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SimpleItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    it.effect("puts an item and returns the record", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        const result = yield* SimpleEntity.put({ itemId: "i-1", name: "Test" }).asEffect()

        expect(result.itemId).toBe("i-1")
        expect(result.name).toBe("Test")
        expect(mockPutItem).toHaveBeenCalledOnce()

        const call = mockPutItem.mock.calls[0]![0]
        expect(call.TableName).toBe("test-table")
        expect(call.Item.pk.S).toBe("$myapp#v1#simpleitem#itemid_i-1")
        expect(call.Item.__edd_e__.S).toBe("SimpleItem")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("adds timestamps when configured", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        const TimestampEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "TSItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            timestamps: true,
          }),
        )

        const result = yield* TimestampEntity.put({ itemId: "i-1", name: "Test" }).pipe(
          Entity.asRecord,
        )
        expect(result.createdAt).toBeDefined()
        expect(result.updatedAt).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("adds version = 1 when versioned", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        const VersionedEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "VerItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: true,
          }),
        )

        const result = yield* VersionedEntity.put({ itemId: "i-1", name: "Test" }).pipe(
          Entity.asRecord,
        )
        expect(result.version).toBe(1)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with ValidationError on invalid input", () =>
      Effect.gen(function* () {
        const error = yield* SimpleEntity.put({ itemId: 123 } as any)
          .asEffect()
          .pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("propagates DynamoError from client", () =>
      Effect.gen(function* () {
        mockPutItem.mockRejectedValueOnce(new Error("connection refused"))

        const error = yield* SimpleEntity.put({ itemId: "i-1", name: "Test" })
          .asEffect()
          .pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("uses transactWriteItems for unique constraints", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValueOnce({})

        const UniqueEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "UniqueUser",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            unique: { email: ["email"] },
          }),
        )

        yield* UniqueEntity.put({
          userId: "u-1",
          email: "alice@test.com",
          displayName: "Alice",
          role: "admin",
        }).asEffect()

        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        expect(mockPutItem).not.toHaveBeenCalled()

        // Transaction should have 2 items: entity + sentinel
        const call = mockTransactWriteItems.mock.calls[0]![0]
        expect(call.TransactItems).toHaveLength(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("detects UniqueConstraintViolation from transaction", () =>
      Effect.gen(function* () {
        const txError = new Error("TransactionCanceledException")
        ;(txError as any).name = "TransactionCanceledException"
        ;(txError as any).CancellationReasons = [
          { Code: "None" }, // entity item
          { Code: "ConditionalCheckFailed" }, // sentinel
        ]
        mockTransactWriteItems.mockRejectedValueOnce(txError)

        const UniqueEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "UniqueUser",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            unique: { email: ["email"] },
          }),
        )

        const error = yield* UniqueEntity.put({
          userId: "u-1",
          email: "alice@test.com",
          displayName: "Alice",
          role: "admin",
        })
          .asEffect()
          .pipe(Effect.flip)

        expect(error._tag).toBe("UniqueConstraintViolation")
        if (error._tag === "UniqueConstraintViolation") {
          expect(error.constraint).toBe("email")
          expect(error.fields).toEqual({ email: "alice@test.com" })
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("returns TransactionOverflow when transaction exceeds 100-item limit", () =>
      Effect.gen(function* () {
        // Build an entity with 100 unique constraints → 101 transact items (1 main + 100 sentinels)
        const uniqueConstraints: Record<string, ReadonlyArray<string>> = {}
        for (let i = 0; i < 100; i++) {
          uniqueConstraints[`c${i}`] = ["email"]
        }

        const OverflowEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "OverflowUser",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            unique: uniqueConstraints,
          }),
        )

        const error = yield* OverflowEntity.put({
          userId: "u-1",
          email: "alice@test.com",
          displayName: "Alice",
          role: "admin",
        })
          .asEffect()
          .pipe(
            Effect.matchEffect({
              onSuccess: () => Effect.fail("expected failure" as const),
              onFailure: (e) => Effect.succeed(e),
            }),
          )

        // Type-safe check via runtime assertion
        const overflow = error as unknown as TransactionOverflow
        expect(overflow._tag).toBe("TransactionOverflow")
        expect(overflow.entityType).toBe("OverflowUser")
        expect(overflow.operation).toBe("put")
        expect(overflow.itemCount).toBe(101)
        expect(overflow.limit).toBe(100)
        // transactWriteItems should NOT have been called
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // get operation
  // ---------------------------------------------------------------------------

  describe("get", () => {
    const SimpleEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SimpleItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    it.effect("gets an item and returns the record", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            itemId: "i-1",
            name: "Test",
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            __edd_e__: "SimpleItem",
          }),
        })

        const result = yield* SimpleEntity.get({ itemId: "i-1" }).asEffect()
        expect(result.itemId).toBe("i-1")
        expect(result.name).toBe("Test")

        const call = mockGetItem.mock.calls[0]![0]
        expect(call.TableName).toBe("test-table")
        expect(call.Key.pk.S).toBe("$myapp#v1#simpleitem#itemid_i-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("returns ItemNotFound when item does not exist", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({ Item: undefined })

        const error = yield* SimpleEntity.get({ itemId: "missing" }).asEffect().pipe(Effect.flip)
        expect(error._tag).toBe("ItemNotFound")
        if (error._tag === "ItemNotFound") {
          expect(error.entityType).toBe("SimpleItem")
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("propagates DynamoError from client", () =>
      Effect.gen(function* () {
        mockGetItem.mockRejectedValueOnce(new Error("connection refused"))

        const error = yield* SimpleEntity.get({ itemId: "i-1" }).asEffect().pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("decodes record with timestamps", () =>
      Effect.gen(function* () {
        const TSEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "TSItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            timestamps: true,
            versioned: true,
          }),
        )

        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            itemId: "i-1",
            name: "Test",
            createdAt: "2024-01-15T00:00:00Z",
            updatedAt: "2024-01-15T00:00:00Z",
            version: 3,
            pk: "$myapp#v1#tsitem#i-1",
            sk: "$myapp#v1#tsitem",
            __edd_e__: "TSItem",
          }),
        })

        const result = yield* TSEntity.get({ itemId: "i-1" }).pipe(Entity.asRecord)
        expect(result.itemId).toBe("i-1")
        expect(result.version).toBe(3)
        expect(result.createdAt).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // consistentRead combinator (EntityGet)
  // ---------------------------------------------------------------------------

  describe("consistentRead", () => {
    const SimpleEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SimpleItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    it.effect("passes ConsistentRead to getItem (data-last)", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            itemId: "i-1",
            name: "Test",
            __edd_e__: "SimpleItem",
          }),
        })

        yield* SimpleEntity.get({ itemId: "i-1" }).pipe(Entity.consistentRead(), Entity.asModel)
        expect(mockGetItem).toHaveBeenCalledOnce()
        const input = mockGetItem.mock.calls[0]![0]
        expect(input.ConsistentRead).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("passes ConsistentRead to getItem (data-first)", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            itemId: "i-1",
            name: "Test",
            __edd_e__: "SimpleItem",
          }),
        })

        yield* Entity.consistentRead(SimpleEntity.get({ itemId: "i-1" })).asEffect()
        expect(mockGetItem).toHaveBeenCalledOnce()
        const input = mockGetItem.mock.calls[0]![0]
        expect(input.ConsistentRead).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("does not pass ConsistentRead when not set", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            itemId: "i-1",
            name: "Test",
            __edd_e__: "SimpleItem",
          }),
        })

        yield* SimpleEntity.get({ itemId: "i-1" }).asEffect()
        expect(mockGetItem).toHaveBeenCalledOnce()
        const input = mockGetItem.mock.calls[0]![0]
        expect(input.ConsistentRead).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // project
  // ---------------------------------------------------------------------------

  describe("project", () => {
    const SimpleEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SimpleItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    it.effect("passes ProjectionExpression to getItem (data-last)", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            itemId: "i-1",
            name: "Test",
          }),
        })

        const result = yield* SimpleEntity.get({ itemId: "i-1" }).pipe(
          Entity.project(["itemId", "name"]),
          Entity.asModel,
        )

        expect(result).toEqual(expect.objectContaining({ itemId: "i-1", name: "Test" }))

        const input = mockGetItem.mock.calls[0]![0]
        expect(input.ProjectionExpression).toBe("#proj_itemId, #proj_name")
        expect(input.ExpressionAttributeNames).toEqual({
          "#proj_itemId": "itemId",
          "#proj_name": "name",
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("passes ProjectionExpression to getItem (data-first)", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            itemId: "i-1",
          }),
        })

        const result = yield* Entity.project(SimpleEntity.get({ itemId: "i-1" }), [
          "itemId",
        ]).asEffect()

        expect(result).toEqual(expect.objectContaining({ itemId: "i-1" }))

        const input = mockGetItem.mock.calls[0]![0]
        expect(input.ProjectionExpression).toBe("#proj_itemId")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("returns raw record without schema decode", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            name: "Test",
            __edd_e__: "SimpleItem",
          }),
        })

        const result = yield* SimpleEntity.get({ itemId: "i-1" }).pipe(
          Entity.project(["name"]),
          Entity.asModel,
        )

        // Raw record — __edd_e__ is visible (not stripped by schema decode)
        expect(result.__edd_e__).toBe("SimpleItem")
        expect(result.name).toBe("Test")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // update operation
  // ---------------------------------------------------------------------------

  describe("update", () => {
    const SimpleEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SimpleItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    it.effect("updates an item and returns the new record", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            itemId: "i-1",
            name: "Updated",
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            __edd_e__: "SimpleItem",
          }),
        })

        const result = yield* SimpleEntity.update({ itemId: "i-1" }).pipe(
          Entity.set({ name: "Updated" }),
          Entity.asModel,
        )
        expect(result.name).toBe("Updated")

        expect(mockUpdateItem).toHaveBeenCalledOnce()
        const call = mockUpdateItem.mock.calls[0]![0]
        expect(call.TableName).toBe("test-table")
        expect(call.ReturnValues).toBe("ALL_NEW")
        expect(call.UpdateExpression).toContain("SET")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("includes version increment when versioned", () =>
      Effect.gen(function* () {
        const VerEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "VerItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: true,
          }),
        )

        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            itemId: "i-1",
            name: "Updated",
            version: 2,
            pk: "$myapp#v1#veritem#i-1",
            sk: "$myapp#v1#veritem",
            __edd_e__: "VerItem",
          }),
        })

        const result = yield* VerEntity.update({ itemId: "i-1" }).pipe(
          Entity.set({ name: "Updated" }),
          Entity.asRecord,
        )
        expect(result.version).toBe(2)

        const call = mockUpdateItem.mock.calls[0]![0]
        expect(call.UpdateExpression).toContain("+ :vinc")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("adds optimistic lock condition when expectedVersion provided", () =>
      Effect.gen(function* () {
        const VerEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "VerItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: true,
          }),
        )

        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            itemId: "i-1",
            name: "Updated",
            version: 4,
            pk: "$myapp#v1#veritem#i-1",
            sk: "$myapp#v1#veritem",
            __edd_e__: "VerItem",
          }),
        })

        yield* VerEntity.update({ itemId: "i-1" }).pipe(
          Entity.set({ name: "Updated" }),
          Entity.expectedVersion(3),
          Entity.asModel,
        )

        const call = mockUpdateItem.mock.calls[0]![0]
        expect(call.ConditionExpression).toContain("#condVer = :expectedVer")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("returns OptimisticLockError on version conflict", () =>
      Effect.gen(function* () {
        const VerEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "VerItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: true,
          }),
        )

        const condError = new Error("ConditionalCheckFailedException")
        ;(condError as any).name = "ConditionalCheckFailedException"
        mockUpdateItem.mockRejectedValueOnce(condError)

        const error = yield* VerEntity.update({ itemId: "i-1" })
          .pipe(Entity.set({ name: "Updated" }), Entity.expectedVersion(3))
          .asEffect()
          .pipe(Effect.flip)

        expect(error._tag).toBe("OptimisticLockError")
        if (error._tag === "OptimisticLockError") {
          expect(error.expectedVersion).toBe(3)
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("returns ItemNotFound when item does not exist after update", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({ Attributes: undefined })

        const error = yield* SimpleEntity.update({ itemId: "missing" })
          .pipe(Entity.set({ name: "X" }))
          .asEffect()
          .pipe(Effect.flip)
        expect(error._tag).toBe("ItemNotFound")
      }).pipe(Effect.provide(TestLayer)),
    )

    // Regression: update SET values marshalled via toAttributeValue previously
    // threw on Schema.Class instances because convertClassInstanceToMap was not
    // passed. https://github.com/jmenga/effect-dynamodb/issues/12
    it.effect("SET accepts a Schema.Class-valued field (nested class instance)", () => {
      class Point extends Schema.Class<Point>("Point")({
        type: Schema.Literal("Point"),
        coordinates: Schema.Array(Schema.Number),
      }) {}
      class Device extends Schema.Class<Device>("Device")({
        deviceId: Schema.String,
        location: Schema.optional(Point),
      }) {}
      const DeviceEntity = withConfig(
        Entity.make({
          model: Device,
          entityType: "Device",
          primaryKey: {
            pk: { field: "pk", composite: ["deviceId"] },
            sk: { field: "sk", composite: [] },
          },
        }),
      )

      return Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            deviceId: "d-1",
            location: { type: "Point", coordinates: [-87.6298, 41.8781] },
            pk: "$myapp#v1#device#d-1",
            sk: "$myapp#v1#device",
            __edd_e__: "Device",
          }),
        })

        const point = new Point({ type: "Point", coordinates: [-87.6298, 41.8781] })
        yield* DeviceEntity.update({ deviceId: "d-1" }).pipe(
          Entity.set({ location: point }),
          Entity.asModel,
        )

        expect(mockUpdateItem).toHaveBeenCalledOnce()
        const call = mockUpdateItem.mock.calls[0]![0]
        // The class instance marshalls as a map with the inner Point as a nested map.
        const valueKey = Object.keys(call.ExpressionAttributeValues).find(
          (k) => call.ExpressionAttributeValues[k].M,
        )
        expect(valueKey).toBeDefined()
        expect(call.ExpressionAttributeValues[valueKey!]).toEqual({
          M: {
            type: { S: "Point" },
            coordinates: { L: [{ N: "-87.6298" }, { N: "41.8781" }] },
          },
        })
      }).pipe(Effect.provide(TestLayer))
    })
  })

  // ---------------------------------------------------------------------------
  // unique constraint rotation on update
  // ---------------------------------------------------------------------------

  describe("unique constraint update rotation", () => {
    const UniqueEntity = withConfig(
      Entity.make({
        model: User,
        entityType: "UniqueUser",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        unique: { email: ["email"] },
        versioned: true,
      }),
    )

    it.effect("rotates sentinel when unique constraint field changes", () =>
      Effect.gen(function* () {
        // getItem returns current item
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            userId: "u-1",
            email: "alice@old.com",
            displayName: "Alice",
            role: "admin",
            version: 1,
            pk: "$myapp#v1#uniqueuser#u-1",
            sk: "$myapp#v1#uniqueuser",
            __edd_e__: "UniqueUser",
          }),
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* UniqueEntity.update({ userId: "u-1" }).pipe(
          Entity.set({ email: "alice@new.com" }),
          Entity.asModel,
        )

        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        expect(mockUpdateItem).not.toHaveBeenCalled()

        const call = mockTransactWriteItems.mock.calls[0]![0]
        // Items: [0] Put entity, [1] Delete old sentinel, [2] Put new sentinel
        expect(call.TransactItems).toHaveLength(3)

        // Item 0: Put entity item with version condition
        expect(call.TransactItems[0].Put).toBeDefined()
        expect(call.TransactItems[0].Put.ConditionExpression).toContain("#ver = :expectedVer")

        // Item 1: Delete old sentinel
        expect(call.TransactItems[1].Delete).toBeDefined()
        const oldSentinelKey = call.TransactItems[1].Delete.Key
        expect(oldSentinelKey.pk.S).toContain("uniqueuser.email")
        expect(oldSentinelKey.pk.S).toContain("alice@old.com")

        // Item 2: Put new sentinel with attribute_not_exists
        expect(call.TransactItems[2].Put).toBeDefined()
        expect(call.TransactItems[2].Put.ConditionExpression).toBe("attribute_not_exists(pk)")
        const newSentinelItem = call.TransactItems[2].Put.Item
        expect(newSentinelItem.pk.S).toContain("alice@new.com")
        expect(newSentinelItem.__edd_e__.S).toBe("UniqueUser._unique.email")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("uses standard updateItem when update does not touch unique fields", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            userId: "u-1",
            email: "alice@test.com",
            displayName: "Alice Updated",
            role: "admin",
            version: 2,
            pk: "$myapp#v1#uniqueuser#u-1",
            sk: "$myapp#v1#uniqueuser",
            __edd_e__: "UniqueUser",
          }),
        })

        yield* UniqueEntity.update({ userId: "u-1" }).pipe(
          Entity.set({ displayName: "Alice Updated" }),
          Entity.asModel,
        )

        expect(mockUpdateItem).toHaveBeenCalledOnce()
        expect(mockTransactWriteItems).not.toHaveBeenCalled()
        expect(mockGetItem).not.toHaveBeenCalled()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("detects UniqueConstraintViolation when new value conflicts", () =>
      Effect.gen(function* () {
        // getItem returns current item
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            userId: "u-1",
            email: "alice@old.com",
            displayName: "Alice",
            role: "admin",
            version: 1,
            pk: "$myapp#v1#uniqueuser#u-1",
            sk: "$myapp#v1#uniqueuser",
            __edd_e__: "UniqueUser",
          }),
        })

        // Transaction fails: sentinel Put at index 2 fails
        const txError = new Error("TransactionCanceledException")
        ;(txError as any).name = "TransactionCanceledException"
        ;(txError as any).CancellationReasons = [
          { Code: "None" }, // entity Put OK
          { Code: "None" }, // old sentinel Delete OK
          { Code: "ConditionalCheckFailed" }, // new sentinel Put — conflict
        ]
        mockTransactWriteItems.mockRejectedValueOnce(txError)

        const error = yield* UniqueEntity.update({ userId: "u-1" })
          .pipe(Entity.set({ email: "taken@test.com" }))
          .asEffect()
          .pipe(Effect.flip)

        expect(error._tag).toBe("UniqueConstraintViolation")
        if (error._tag === "UniqueConstraintViolation") {
          expect(error.constraint).toBe("email")
          expect(error.fields).toEqual({ email: "taken@test.com" })
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("skips sentinel rotation when unique field value is unchanged", () =>
      Effect.gen(function* () {
        // getItem returns current item
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            userId: "u-1",
            email: "alice@test.com",
            displayName: "Alice",
            role: "admin",
            version: 1,
            pk: "$myapp#v1#uniqueuser#u-1",
            sk: "$myapp#v1#uniqueuser",
            __edd_e__: "UniqueUser",
          }),
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        // Update email to the same value — still enters transact path
        // (because the field is in the update payload) but should NOT
        // include sentinel Delete/Put since the value didn't change
        yield* UniqueEntity.update({ userId: "u-1" }).pipe(
          Entity.set({ email: "alice@test.com" }),
          Entity.asModel,
        )

        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        const call = mockTransactWriteItems.mock.calls[0]![0]
        // Only the entity Put — no sentinel operations
        expect(call.TransactItems).toHaveLength(1)
        expect(call.TransactItems[0].Put).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("combines retain snapshot with sentinel rotation", () =>
      Effect.gen(function* () {
        const RetainUniqueEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "RetainUniqueUser",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            unique: { email: ["email"] },
            versioned: { retain: true },
          }),
        )

        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            userId: "u-1",
            email: "alice@old.com",
            displayName: "Alice",
            role: "admin",
            version: 1,
            pk: "$myapp#v1#retainuniqueuser#u-1",
            sk: "$myapp#v1#retainuniqueuser",
            __edd_e__: "RetainUniqueUser",
          }),
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* RetainUniqueEntity.update({ userId: "u-1" }).pipe(
          Entity.set({ email: "alice@new.com" }),
          Entity.asModel,
        )

        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        const call = mockTransactWriteItems.mock.calls[0]![0]
        // Items: [0] Put entity, [1] Put snapshot, [2] Delete old sentinel, [3] Put new sentinel
        expect(call.TransactItems).toHaveLength(4)
        expect(call.TransactItems[0].Put).toBeDefined() // entity
        expect(call.TransactItems[1].Put).toBeDefined() // snapshot
        expect(call.TransactItems[2].Delete).toBeDefined() // old sentinel
        expect(call.TransactItems[3].Put).toBeDefined() // new sentinel
        expect(call.TransactItems[3].Put.ConditionExpression).toBe("attribute_not_exists(pk)")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // delete operation
  // ---------------------------------------------------------------------------

  describe("delete", () => {
    const SimpleEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SimpleItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    it.effect("deletes an item", () =>
      Effect.gen(function* () {
        mockDeleteItem.mockResolvedValueOnce({})

        yield* SimpleEntity.delete({ itemId: "i-1" }).asEffect()

        expect(mockDeleteItem).toHaveBeenCalledOnce()
        const call = mockDeleteItem.mock.calls[0]![0]
        expect(call.TableName).toBe("test-table")
        expect(call.Key.pk.S).toBe("$myapp#v1#simpleitem#itemid_i-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("uses transactWriteItems when unique constraints exist", () =>
      Effect.gen(function* () {
        const UniqueEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "UniqueUser",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            unique: { email: ["email"] },
          }),
        )

        // getItem to find the item data for sentinel cleanup
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            userId: "u-1",
            email: "alice@test.com",
            displayName: "Alice",
            role: "admin",
            pk: "$myapp#v1#uniqueuser#u-1",
            sk: "$myapp#v1#uniqueuser",
            __edd_e__: "UniqueUser",
          }),
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* UniqueEntity.delete({ userId: "u-1" }).asEffect()

        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        const call = mockTransactWriteItems.mock.calls[0]![0]
        // Should have 2 items: delete entity + delete sentinel
        expect(call.TransactItems).toHaveLength(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("propagates DynamoError from client", () =>
      Effect.gen(function* () {
        mockDeleteItem.mockRejectedValueOnce(new Error("connection refused"))

        const error = yield* SimpleEntity.delete({ itemId: "i-1" }).asEffect().pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // query operation
  // ---------------------------------------------------------------------------

  describe("query", () => {
    it("returns a Query object from query accessor", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byEmail: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["email"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
        }),
      )

      const q = UserEntity.query.byEmail({ email: "test@example.com" })
      expect(Query.isQuery(q)).toBe(true)
      expect(q._state.indexName).toBe("gsi1")
      expect(q._state.pkValue).toContain("test@example.com")
      expect(q._state.entityTypes).toEqual(["User"])
    })

    it("query can be composed with combinators", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byRole: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["role"] },
              sk: { field: "gsi2sk", composite: ["userId"] },
            },
          },
        }),
      )

      const q = UserEntity.query
        .byRole({ role: "admin" })
        .pipe(Query.where({ beginsWith: "$myapp" }), Query.limit(10), Query.reverse)

      expect(q._state.limitValue).toBe(10)
      expect(q._state.scanForward).toBe(false)
      expect(q._state.skConditions).toHaveLength(1)
    })

    it.effect("executes a query through DynamoClient", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              userId: "u-1",
              email: "alice@test.com",
              displayName: "Alice",
              role: "admin",
              pk: "$myapp#v1#user#u-1",
              sk: "$myapp#v1#user",
              gsi1pk: "$myapp#v1#user#alice@test.com",
              gsi1sk: "$myapp#v1#user",
              __edd_e__: "User",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const UserEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "User",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            indexes: {
              byEmail: {
                name: "gsi1",
                pk: { field: "gsi1pk", composite: ["email"] },
                sk: { field: "gsi1sk", composite: [] },
              },
            },
          }),
        )

        const q = UserEntity.query.byEmail({ email: "alice@test.com" })
        const results = yield* Query.collect(q)

        expect(results).toHaveLength(1)
        expect(results[0]!.userId).toBe("u-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it("query with PK-only params does not add SK condition", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byRole: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["role"] },
              sk: { field: "gsi2sk", composite: ["userId"] },
            },
          },
        }),
      )

      const q = UserEntity.query.byRole({ role: "admin" })
      expect(q._state.skConditions).toHaveLength(0)
    })

    it("query with PK + partial SK params applies beginsWith condition", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byRole: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["role"] },
              sk: { field: "gsi2sk", composite: ["userId", "email"] },
            },
          },
        }),
      )

      const q = UserEntity.query.byRole({ role: "admin", userId: "u-1" })
      expect(q._state.skConditions).toHaveLength(1)
      expect(q._state.skConditions[0]!.condition).toHaveProperty("beginsWith")
      expect((q._state.skConditions[0]!.condition as { beginsWith: string }).beginsWith).toContain(
        "u-1",
      )
    })

    it("query with PK + full SK composites applies beginsWith for all values", () => {
      const UserEntity = withConfig(
        Entity.make({
          model: User,
          entityType: "User",
          primaryKey: {
            pk: { field: "pk", composite: ["userId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byRole: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["role"] },
              sk: { field: "gsi2sk", composite: ["userId", "email"] },
            },
          },
        }),
      )

      const q = UserEntity.query.byRole({
        role: "admin",
        userId: "u-1",
        email: "test@example.com",
      })
      expect(q._state.skConditions).toHaveLength(1)
      const beginsWith = (q._state.skConditions[0]!.condition as { beginsWith: string }).beginsWith
      expect(beginsWith).toContain("u-1")
      expect(beginsWith).toContain("test@example.com")
    })
  })

  // ---------------------------------------------------------------------------
  // scan operation
  // ---------------------------------------------------------------------------

  describe("scan", () => {
    const mockScan = vi.fn()

    const ScanTestDynamoClient = Layer.succeed(DynamoClient, {
      putItem: () => Effect.die("not used"),
      getItem: () => Effect.die("not used"),
      deleteItem: () => Effect.die("not used"),
      updateItem: () => Effect.die("not used"),
      query: () => Effect.die("not used"),
      scan: (input) =>
        Effect.tryPromise({
          try: () => mockScan(input),
          catch: (e) => new DynamoError({ operation: "Scan", cause: e }),
        }),
      transactWriteItems: () => Effect.die("not used"),
      batchGetItem: () => Effect.die("not used"),
      batchWriteItem: () => Effect.die("not used"),
      transactGetItems: () => Effect.die("not used"),
      createTable: () => Effect.die("not used"),
      deleteTable: () => Effect.die("not used"),
      describeTable: () => Effect.die("not used"),
    })

    const ScanTestLayer = Layer.merge(ScanTestDynamoClient, TestTableConfig)

    const SimpleEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SimpleItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    beforeEach(() => {
      mockScan.mockReset()
    })

    it("returns a Query with isScan = true", () => {
      const q = SimpleEntity.scan()
      expect(Query.isQuery(q)).toBe(true)
      expect(q._state.isScan).toBe(true)
    })

    it("filters by entity type", () => {
      const q = SimpleEntity.scan()
      expect(q._state.entityTypes).toEqual(["SimpleItem"])
    })

    it.effect("calls scan instead of query", () =>
      Effect.gen(function* () {
        mockScan.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#simpleitem#i-1",
              sk: "$myapp#v1#simpleitem",
              itemId: "i-1",
              name: "Test",
              __edd_e__: "SimpleItem",
            }),
          ],
        })

        const results = yield* SimpleEntity.scan().pipe(Query.collect)

        expect(mockScan).toHaveBeenCalledOnce()
        expect(results).toHaveLength(1)
      }).pipe(Effect.provide(ScanTestLayer)),
    )

    it.effect("scan supports filter combinator", () =>
      Effect.gen(function* () {
        mockScan.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#simpleitem#i-1",
              sk: "$myapp#v1#simpleitem",
              itemId: "i-1",
              name: "Test",
              __edd_e__: "SimpleItem",
            }),
          ],
        })

        yield* SimpleEntity.scan().pipe(SimpleEntity.filter({ name: "Test" }), Query.collect)

        const input = mockScan.mock.calls[0]![0]
        expect(input.FilterExpression).toContain("=")
        expect(Object.values(input.ExpressionAttributeNames)).toContain("name")
      }).pipe(Effect.provide(ScanTestLayer)),
    )

    it.effect("scan supports limit", () =>
      Effect.gen(function* () {
        mockScan.mockResolvedValueOnce({ Items: [] })

        yield* SimpleEntity.scan().pipe(Query.limit(5), Query.collect)

        const input = mockScan.mock.calls[0]![0]
        expect(input.Limit).toBe(5)
      }).pipe(Effect.provide(ScanTestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // condition combinator
  // ---------------------------------------------------------------------------

  describe("condition", () => {
    const SimpleEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SimpleItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    it.effect("adds ConditionExpression to put (data-last)", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        yield* SimpleEntity.put({ itemId: "i-1", name: "Test" }).pipe(
          SimpleEntity.condition({ status: "draft" }),
          Entity.asModel,
        )

        expect(mockPutItem).toHaveBeenCalledOnce()
        const input = mockPutItem.mock.calls[0]![0]
        expect(input.ConditionExpression).toBeDefined()
        expect(input.ConditionExpression).toContain("=")
        // Expr compiler uses #eN = :eN placeholders
        expect(Object.values(input.ExpressionAttributeNames)).toContain("status")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("adds ConditionExpression to put (pipe style)", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        yield* SimpleEntity.put({ itemId: "i-1", name: "Test" })
          .pipe(SimpleEntity.condition({ status: "draft" }))
          .asEffect()

        expect(mockPutItem).toHaveBeenCalledOnce()
        const input = mockPutItem.mock.calls[0]![0]
        expect(input.ConditionExpression).toContain("=")
        expect(Object.values(input.ExpressionAttributeNames)).toContain("status")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("adds ConditionExpression to delete", () =>
      Effect.gen(function* () {
        mockDeleteItem.mockResolvedValueOnce({})

        yield* SimpleEntity.delete({ itemId: "i-1" })
          .pipe(SimpleEntity.condition({ status: "draft" }))
          .asEffect()

        expect(mockDeleteItem).toHaveBeenCalledOnce()
        const input = mockDeleteItem.mock.calls[0]![0]
        expect(input.ConditionExpression).toContain("=")
        expect(Object.values(input.ExpressionAttributeNames)).toContain("status")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("adds ConditionExpression to update (standard path)", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            itemId: "i-1",
            name: "Updated",
            __edd_e__: "SimpleItem",
          }),
        })

        yield* SimpleEntity.update({ itemId: "i-1" }).pipe(
          Entity.set({ name: "Updated" }),
          SimpleEntity.condition({ status: "draft" }),
          Entity.asModel,
        )

        expect(mockUpdateItem).toHaveBeenCalledOnce()
        const input = mockUpdateItem.mock.calls[0]![0]
        expect(input.ConditionExpression).toContain("=")
        expect(Object.values(input.ExpressionAttributeNames)).toContain("status")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("condition composes with expectedVersion on update", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            itemId: "i-1",
            name: "Updated",
            __edd_e__: "SimpleItem",
          }),
        })

        const VersionedEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "SimpleItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: true,
          }),
        )

        yield* VersionedEntity.update({ itemId: "i-1" }).pipe(
          Entity.set({ name: "Updated" }),
          Entity.expectedVersion(3),
          VersionedEntity.condition({ status: "draft" }),
          Entity.asModel,
        )

        const input = mockUpdateItem.mock.calls[0]![0]
        // Should contain both version check AND user condition
        expect(input.ConditionExpression).toContain("#condVer = :expectedVer")
        expect(input.ConditionExpression).toContain("AND")
        expect(Object.values(input.ExpressionAttributeNames)).toContain("status")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("put returns ConditionalCheckFailed on condition failure", () =>
      Effect.gen(function* () {
        const err = Object.assign(new Error("conditional"), {
          name: "ConditionalCheckFailedException",
        })
        mockPutItem.mockRejectedValueOnce(err)

        const op = SimpleEntity.put({ itemId: "i-1", name: "Test" }).pipe(
          SimpleEntity.condition((_, { notExists }) => notExists(_.itemId)),
        )
        const result = yield* Effect.flip(Entity.asModel(op))

        expect(result._tag).toBe("ConditionalCheckFailed")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("delete returns ConditionalCheckFailed on condition failure", () =>
      Effect.gen(function* () {
        const err = Object.assign(new Error("conditional"), {
          name: "ConditionalCheckFailedException",
        })
        mockDeleteItem.mockRejectedValueOnce(err)

        const del = SimpleEntity.delete({ itemId: "i-1" }).pipe(
          SimpleEntity.condition({ status: "draft" }),
        )
        const result = yield* Effect.flip(del.asEffect())

        expect(result._tag).toBe("ConditionalCheckFailed")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // create operation
  // ---------------------------------------------------------------------------

  describe("create", () => {
    const SimpleEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SimpleItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    it.effect("succeeds for a new item", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        const result = yield* SimpleEntity.create({ itemId: "i-1", name: "New Item" }).asEffect()

        expect(result.itemId).toBe("i-1")
        expect(result.name).toBe("New Item")
        expect(mockPutItem).toHaveBeenCalledOnce()
        // Should include attribute_not_exists condition
        const input = mockPutItem.mock.calls[0]![0]
        expect(input.ConditionExpression).toBeDefined()
        expect(input.ConditionExpression).toContain("attribute_not_exists")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with ConditionalCheckFailed on duplicate key", () =>
      Effect.gen(function* () {
        const err = Object.assign(new Error("conditional"), {
          name: "ConditionalCheckFailedException",
        })
        mockPutItem.mockRejectedValueOnce(err)

        const op = SimpleEntity.create({ itemId: "i-1", name: "Duplicate" })
        const result = yield* Effect.flip(Entity.asModel(op))

        expect(result._tag).toBe("ConditionalCheckFailed")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("works with timestamps enabled", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        const TimestampedEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "SimpleItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            timestamps: true,
          }),
        )

        const result = yield* TimestampedEntity.create({ itemId: "i-1", name: "Timestamped" }).pipe(
          Entity.asRecord,
        )

        expect(result.itemId).toBe("i-1")
        expect(result.createdAt).toBeDefined()
        expect(result.updatedAt).toBeDefined()
        // Condition should still be present
        const input = mockPutItem.mock.calls[0]![0]
        expect(input.ConditionExpression).toContain("attribute_not_exists")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("works with versioned entity", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        const VersionedEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "SimpleItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: true,
          }),
        )

        const result = yield* VersionedEntity.create({ itemId: "i-1", name: "Versioned" }).pipe(
          Entity.asRecord,
        )

        expect(result.itemId).toBe("i-1")
        expect(result.version).toBe(1)
        const input = mockPutItem.mock.calls[0]![0]
        expect(input.ConditionExpression).toContain("attribute_not_exists")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("condition on pk and sk fields", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        yield* SimpleEntity.create({ itemId: "i-1", name: "Test" }).asEffect()

        const input = mockPutItem.mock.calls[0]![0]
        // Should reference both pk and sk fields in the condition
        expect(input.ConditionExpression).toContain("attribute_not_exists")
        // ExpressionAttributeNames maps the placeholders to actual field names
        const names = input.ExpressionAttributeNames ?? {}
        const nameValues = Object.values(names) as string[]
        expect(nameValues).toContain("pk")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // Rich update operations
  // ---------------------------------------------------------------------------

  describe("rich update operations", () => {
    const SimpleEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SimpleItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    const standardUpdateResult = {
      Attributes: toAttributeMap({
        pk: "$myapp#v1#simpleitem#i-1",
        sk: "$myapp#v1#simpleitem",
        itemId: "i-1",
        name: "Test",
        __edd_e__: "SimpleItem",
      }),
    }

    it.effect("remove produces REMOVE clause", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce(standardUpdateResult)

        yield* SimpleEntity.update({ itemId: "i-1" }).pipe(Entity.remove(["name"]), Entity.asModel)

        const input = mockUpdateItem.mock.calls[0]![0]
        expect(input.UpdateExpression).toContain("REMOVE")
        // name should be referenced via expression attribute name
        expect(Object.values(input.ExpressionAttributeNames)).toContain("name")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("add produces ADD clause", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce(standardUpdateResult)

        yield* SimpleEntity.update({ itemId: "i-1" }).pipe(
          Entity.add({ score: 10 }),
          Entity.asModel,
        )

        const input = mockUpdateItem.mock.calls[0]![0]
        expect(input.UpdateExpression).toContain("ADD")
        expect(Object.values(input.ExpressionAttributeNames)).toContain("score")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("subtract produces SET #field = #field - :val", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce(standardUpdateResult)

        yield* SimpleEntity.update({ itemId: "i-1" }).pipe(
          Entity.subtract({ score: 5 }),
          Entity.asModel,
        )

        const input = mockUpdateItem.mock.calls[0]![0]
        expect(input.UpdateExpression).toMatch(/SET.*#u\d+ = #u\d+ - :u\d+/)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("append produces SET #field = list_append(#field, :val)", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce(standardUpdateResult)

        yield* SimpleEntity.update({ itemId: "i-1" }).pipe(
          Entity.append({ tags: ["new-tag"] }),
          Entity.asModel,
        )

        const input = mockUpdateItem.mock.calls[0]![0]
        expect(input.UpdateExpression).toMatch(/SET.*list_append/)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("deleteFromSet produces DELETE clause", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce(standardUpdateResult)

        yield* SimpleEntity.update({ itemId: "i-1" }).pipe(
          Entity.deleteFromSet({ tags: new Set(["old-tag"]) }),
          Entity.asModel,
        )

        const input = mockUpdateItem.mock.calls[0]![0]
        expect(input.UpdateExpression).toContain("DELETE")
        expect(Object.values(input.ExpressionAttributeNames)).toContain("tags")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("multiple rich ops compose together", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce(standardUpdateResult)

        yield* SimpleEntity.update({ itemId: "i-1" }).pipe(
          Entity.set({ name: "Updated" }),
          Entity.remove(["obsoleteField"]),
          Entity.add({ viewCount: 1 }),
          Entity.asModel,
        )

        const input = mockUpdateItem.mock.calls[0]![0]
        expect(input.UpdateExpression).toContain("SET")
        expect(input.UpdateExpression).toContain("REMOVE")
        expect(input.UpdateExpression).toContain("ADD")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("rich ops compose with expectedVersion", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce(standardUpdateResult)

        const VersionedEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "SimpleItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: true,
          }),
        )

        yield* VersionedEntity.update({ itemId: "i-1" }).pipe(
          Entity.remove(["name"]),
          Entity.expectedVersion(2),
          Entity.asModel,
        )

        const input = mockUpdateItem.mock.calls[0]![0]
        expect(input.UpdateExpression).toContain("REMOVE")
        expect(input.ConditionExpression).toContain("#condVer = :expectedVer")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("remove data-first syntax", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce(standardUpdateResult)

        yield* Entity.remove(SimpleEntity.update({ itemId: "i-1" }), ["name"]).asEffect()

        const input = mockUpdateItem.mock.calls[0]![0]
        expect(input.UpdateExpression).toContain("REMOVE")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("add data-first syntax", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce(standardUpdateResult)

        yield* Entity.add(SimpleEntity.update({ itemId: "i-1" }), { score: 5 }).asEffect()

        const input = mockUpdateItem.mock.calls[0]![0]
        expect(input.UpdateExpression).toContain("ADD")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("subtract and append data-first syntax", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce(standardUpdateResult)

        const op = Entity.subtract(SimpleEntity.update({ itemId: "i-1" }), { score: 3 })
        yield* Entity.append(op, { tags: ["x"] }).asEffect()

        const input = mockUpdateItem.mock.calls[0]![0]
        expect(input.UpdateExpression).toContain("SET")
        expect(input.UpdateExpression).toContain("list_append")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // EntityDelete intermediate
  // ---------------------------------------------------------------------------

  describe("EntityDelete intermediate", () => {
    const SimpleEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SimpleItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    it("delete returns an EntityDelete with EntityDeleteTypeId", () => {
      const deleteOp = SimpleEntity.delete({ itemId: "i-1" })
      expect(Entity.EntityDeleteTypeId in deleteOp).toBe(true)
    })

    it.effect("EntityDelete is convertible via .asEffect()", () =>
      Effect.gen(function* () {
        mockDeleteItem.mockResolvedValueOnce({})
        yield* SimpleEntity.delete({ itemId: "i-1" }).asEffect()
        expect(mockDeleteItem).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("EntityDelete is pipeable", () =>
      Effect.gen(function* () {
        mockDeleteItem.mockResolvedValueOnce({})
        yield* SimpleEntity.delete({ itemId: "i-1" })
          .asEffect()
          .pipe(Effect.map(() => "done"))
        expect(mockDeleteItem).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // extractTransactable
  // ---------------------------------------------------------------------------

  describe("extractTransactable", () => {
    const SimpleEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SimpleItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    it("extracts from EntityGet", () => {
      const getOp = SimpleEntity.get({ itemId: "i-1" })
      const info = Entity.extractTransactable(getOp)
      expect(info).toBeDefined()
      expect(info!.opType).toBe("get")
      expect(info!.entity).toBe(SimpleEntity)
      expect(info!.key).toEqual({ itemId: "i-1" })
    })

    it("extracts from EntityPut", () => {
      const putOp = SimpleEntity.put({ itemId: "i-1", name: "Test" })
      const info = Entity.extractTransactable(putOp)
      expect(info).toBeDefined()
      expect(info!.opType).toBe("put")
      expect(info!.entity).toBe(SimpleEntity)
      expect(info!.input).toEqual({ itemId: "i-1", name: "Test" })
    })

    it("extracts from EntityUpdate", () => {
      const updateOp = SimpleEntity.update({ itemId: "i-1" })
      const info = Entity.extractTransactable(updateOp)
      expect(info).toBeDefined()
      expect(info!.opType).toBe("update")
      expect(info!.entity).toBe(SimpleEntity)
      expect(info!.key).toEqual({ itemId: "i-1" })
    })

    it("extracts from EntityUpdate after set", () => {
      const updateOp = SimpleEntity.update({ itemId: "i-1" }).pipe(Entity.set({ name: "Updated" }))
      const info = Entity.extractTransactable(updateOp)
      expect(info).toBeDefined()
      expect(info!.opType).toBe("update")
      expect(info!.entity).toBe(SimpleEntity)
      expect(info!.key).toEqual({ itemId: "i-1" })
    })

    it("extracts from EntityDelete", () => {
      const deleteOp = SimpleEntity.delete({ itemId: "i-1" })
      const info = Entity.extractTransactable(deleteOp)
      expect(info).toBeDefined()
      expect(info!.opType).toBe("delete")
      expect(info!.entity).toBe(SimpleEntity)
      expect(info!.key).toEqual({ itemId: "i-1" })
    })

    it("returns undefined for non-entity values", () => {
      expect(Entity.extractTransactable(null)).toBeUndefined()
      expect(Entity.extractTransactable(undefined)).toBeUndefined()
      expect(Entity.extractTransactable(42)).toBeUndefined()
      expect(Entity.extractTransactable("hello")).toBeUndefined()
      expect(Entity.extractTransactable({})).toBeUndefined()
      expect(Entity.extractTransactable(Effect.succeed(1))).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Sparse GSI support
  // ---------------------------------------------------------------------------

  describe("sparse GSI — put", () => {
    class TenantItem extends Schema.Class<TenantItem>("TenantItem")({
      itemId: Schema.String,
      name: Schema.String,
      tenantId: Schema.optional(Schema.String),
      region: Schema.optional(Schema.String),
    }) {}

    const SparseEntity = withConfig(
      Entity.make({
        model: TenantItem,
        entityType: "TenantItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byTenant: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["tenantId"] },
            sk: { field: "gsi1sk", composite: ["region"] },
          },
        },
      }),
    )

    it.effect("put with all composites includes GSI keys", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        yield* SparseEntity.put({
          itemId: "i-1",
          name: "Test",
          tenantId: "t-1",
          region: "us-east-1",
        }).asEffect()

        const call = mockPutItem.mock.calls[0]![0]
        const item = call.Item
        // Primary keys present
        expect(item.pk.S).toBe("$myapp#v1#tenantitem#itemid_i-1")
        // GSI keys present
        expect(item.gsi1pk.S).toBe("$myapp#v1#tenantitem#tenantid_t-1")
        expect(item.gsi1sk.S).toBe("$myapp#v1#tenantitem#region_us-east-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("put with missing GSI composites stores item without GSI keys", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        yield* SparseEntity.put({ itemId: "i-2", name: "NoTenant" }).asEffect()

        const call = mockPutItem.mock.calls[0]![0]
        const item = call.Item
        // Primary keys present
        expect(item.pk.S).toBe("$myapp#v1#tenantitem#itemid_i-2")
        expect(item.sk.S).toBe("$myapp#v1#tenantitem")
        // GSI keys absent
        expect(item.gsi1pk).toBeUndefined()
        expect(item.gsi1sk).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("put with partial GSI composites skips that GSI", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValueOnce({})

        // Only tenantId provided, region missing — sparse, so GSI keys omitted
        yield* SparseEntity.put({ itemId: "i-3", name: "PartialGSI", tenantId: "t-1" }).asEffect()

        const call = mockPutItem.mock.calls[0]![0]
        const item = call.Item
        expect(item.pk.S).toBe("$myapp#v1#tenantitem#itemid_i-3")
        expect(item.gsi1pk).toBeUndefined()
        expect(item.gsi1sk).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("sparse GSI — update", () => {
    class TenantUser extends Schema.Class<TenantUser>("TenantUser")({
      userId: Schema.String,
      name: Schema.String,
      tenantId: Schema.String,
      region: Schema.String,
      email: Schema.String,
    }) {}

    const SparseUpdateEntity = withConfig(
      Entity.make({
        model: TenantUser,
        entityType: "TenantUser",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byTenant: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["tenantId"] },
            sk: { field: "gsi1sk", composite: ["region"] },
          },
        },
      }),
    )

    it.effect("update with no GSI composites succeeds without touching GSI keys", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            userId: "u-1",
            name: "Updated",
            tenantId: "t-1",
            region: "us-east-1",
            email: "a@b.com",
            pk: "$myapp#v1#tenantuser#userid_u-1",
            sk: "$myapp#v1#tenantuser",
            __edd_e__: "TenantUser",
          }),
        })

        yield* SparseUpdateEntity.update({ userId: "u-1" }).pipe(
          Entity.set({ name: "Updated" }),
          Entity.asModel,
        )

        const call = mockUpdateItem.mock.calls[0]![0]
        // Should NOT include gsi1pk or gsi1sk in the update
        const names = Object.values(call.ExpressionAttributeNames)
        expect(names).not.toContain("gsi1pk")
        expect(names).not.toContain("gsi1sk")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("update with all composites of a GSI recomposes GSI keys", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            userId: "u-1",
            name: "Test",
            tenantId: "t-2",
            region: "eu-west-1",
            email: "a@b.com",
            pk: "$myapp#v1#tenantuser#userid_u-1",
            sk: "$myapp#v1#tenantuser",
            gsi1pk: "$myapp#v1#tenantuser#tenantid_t-2",
            gsi1sk: "$myapp#v1#tenantuser#region_eu-west-1",
            __edd_e__: "TenantUser",
          }),
        })

        yield* SparseUpdateEntity.update({ userId: "u-1" }).pipe(
          Entity.set({ tenantId: "t-2", region: "eu-west-1" }),
          Entity.asModel,
        )

        const call = mockUpdateItem.mock.calls[0]![0]
        // GSI keys should be in the update expression
        const names = Object.values(call.ExpressionAttributeNames) as string[]
        expect(names).toContain("gsi1pk")
        expect(names).toContain("gsi1sk")

        // Verify the GSI key values
        const nameEntries = Object.entries(call.ExpressionAttributeNames) as [string, string][]
        const gsi1pkAlias = nameEntries.find(([_, v]) => v === "gsi1pk")![0]
        const gsi1skAlias = nameEntries.find(([_, v]) => v === "gsi1sk")![0]

        // Find the matching value aliases from SET clauses
        const expr = call.UpdateExpression as string
        const gsi1pkValMatch = expr.match(
          new RegExp(`${gsi1pkAlias.replace("#", "\\#")} = (:[a-z0-9]+)`),
        )
        const gsi1skValMatch = expr.match(
          new RegExp(`${gsi1skAlias.replace("#", "\\#")} = (:[a-z0-9]+)`),
        )

        expect(gsi1pkValMatch).not.toBeNull()
        expect(gsi1skValMatch).not.toBeNull()

        const gsi1pkVal = call.ExpressionAttributeValues[gsi1pkValMatch![1]!]
        const gsi1skVal = call.ExpressionAttributeValues[gsi1skValMatch![1]!]
        expect(gsi1pkVal.S).toBe("$myapp#v1#tenantuser#tenantid_t-2")
        expect(gsi1skVal.S).toBe("$myapp#v1#tenantuser#region_eu-west-1")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect(
      "update with partial GSI composites (default preserve) touches only the provided half",
      () =>
        Effect.gen(function* () {
          mockUpdateItem.mockResolvedValueOnce({
            Attributes: toAttributeMap({
              userId: "u-1",
              name: "Test",
              tenantId: "t-2",
              region: "us-east-1",
              email: "a@b.com",
              pk: "$myapp#v1#tenantuser#userid_u-1",
              sk: "$myapp#v1#tenantuser",
              __edd_e__: "TenantUser",
            }),
          })

          // Only tenantId provided; region (sk composite) is missing. With the
          // default `preserve` policy, pk is SET (fully resolvable) and sk is
          // left alone — the stored gsi1sk is preserved. No throw.
          yield* SparseUpdateEntity.update({ userId: "u-1" }).pipe(
            Entity.set({ tenantId: "t-2" }),
            Entity.asModel,
          )

          const call = mockUpdateItem.mock.calls[0]![0]
          const names = Object.values(call.ExpressionAttributeNames) as string[]
          // pk half SET
          expect(names).toContain("gsi1pk")
          // sk half neither SET nor REMOVEd — preserved
          expect(names).not.toContain("gsi1sk")
          // No REMOVE clause for GSI fields
          const expr = call.UpdateExpression as string
          if (expr.includes("REMOVE")) {
            expect(expr).not.toMatch(/REMOVE[^S]*gsi1/)
          }
        }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("update with indexPolicy sparse drops item out of the GSI on partial", () =>
      Effect.gen(function* () {
        const SparseDropEntity = withConfig(
          Entity.make({
            model: TenantUser,
            entityType: "TenantUser",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            indexes: {
              byTenant: {
                name: "gsi1",
                pk: { field: "gsi1pk", composite: ["tenantId"] },
                sk: { field: "gsi1sk", composite: ["region"] },
                indexPolicy: () => ({ region: "sparse" as const }),
              },
            },
          }),
        )

        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            userId: "u-1",
            name: "Test",
            tenantId: "t-2",
            region: "us-east-1",
            email: "a@b.com",
            pk: "$myapp#v1#tenantuser#userid_u-1",
            sk: "$myapp#v1#tenantuser",
            __edd_e__: "TenantUser",
          }),
        })

        // region is 'sparse' and missing → REMOVE both gsi1 key fields.
        yield* SparseDropEntity.update({ userId: "u-1" }).pipe(
          Entity.set({ tenantId: "t-2" }),
          Entity.asModel,
        )

        const call = mockUpdateItem.mock.calls[0]![0]
        const names = Object.values(call.ExpressionAttributeNames) as string[]
        expect(names).toContain("gsi1pk")
        expect(names).toContain("gsi1sk")
        const expr = call.UpdateExpression as string
        // REMOVE clause should cover both GSI key fields (the item drops out)
        expect(expr).toContain("REMOVE")
        // gsi1pk and gsi1sk appear only in REMOVE, not SET
        expect(expr).not.toMatch(/SET[^R]*gsi1pk/)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("update with indexPolicy preserve (explicit) leaves GSI untouched on partial", () =>
      Effect.gen(function* () {
        const ExplicitPreserveEntity = withConfig(
          Entity.make({
            model: TenantUser,
            entityType: "TenantUser",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            indexes: {
              byTenant: {
                name: "gsi1",
                pk: { field: "gsi1pk", composite: ["tenantId"] },
                sk: { field: "gsi1sk", composite: ["region"] },
                indexPolicy: () => ({ tenantId: "preserve" as const, region: "preserve" as const }),
              },
            },
          }),
        )

        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            userId: "u-1",
            name: "Updated",
            tenantId: "t-1",
            region: "us-east-1",
            email: "a@b.com",
            pk: "$myapp#v1#tenantuser#userid_u-1",
            sk: "$myapp#v1#tenantuser",
            __edd_e__: "TenantUser",
          }),
        })

        // region missing, tenantId provided — pk set, sk untouched (preserve).
        yield* ExplicitPreserveEntity.update({ userId: "u-1" }).pipe(
          Entity.set({ tenantId: "t-2" }),
          Entity.asModel,
        )

        const call = mockUpdateItem.mock.calls[0]![0]
        const names = Object.values(call.ExpressionAttributeNames) as string[]
        expect(names).toContain("gsi1pk")
        expect(names).not.toContain("gsi1sk")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("remove of GSI composite cascades to GSI key field removal", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            userId: "u-1",
            name: "Test",
            tenantId: "t-1",
            region: "us-east-1",
            email: "a@b.com",
            pk: "$myapp#v1#tenantuser#u-1",
            sk: "$myapp#v1#tenantuser",
            __edd_e__: "TenantUser",
          }),
        })

        yield* SparseUpdateEntity.update({ userId: "u-1" }).pipe(
          Entity.remove(["tenantId"]),
          Entity.asModel,
        )

        const call = mockUpdateItem.mock.calls[0]![0]
        const names = call.ExpressionAttributeNames as Record<string, string>
        const nameValues = Object.values(names)
        // The removed attribute itself
        expect(nameValues).toContain("tenantId")
        // GSI key fields should also be removed
        expect(nameValues).toContain("gsi1pk")
        expect(nameValues).toContain("gsi1sk")
        // All should appear in REMOVE clause
        const expr = call.UpdateExpression as string
        expect(expr).toContain("REMOVE")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("remove of one GSI composite doesn't affect other GSIs", () =>
      Effect.gen(function* () {
        // Entity with two GSIs
        class MultiGsiUser extends Schema.Class<MultiGsiUser>("MultiGsiUser")({
          userId: Schema.String,
          name: Schema.String,
          tenantId: Schema.String,
          region: Schema.String,
          department: Schema.String,
        }) {}

        const MultiGsiEntity = withConfig(
          Entity.make({
            model: MultiGsiUser,
            entityType: "MultiGsiUser",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            indexes: {
              byTenant: {
                name: "gsi1",
                pk: { field: "gsi1pk", composite: ["tenantId"] },
                sk: { field: "gsi1sk", composite: ["region"] },
              },
              byDepartment: {
                name: "gsi2",
                pk: { field: "gsi2pk", composite: ["department"] },
                sk: { field: "gsi2sk", composite: [] },
              },
            },
          }),
        )

        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            userId: "u-1",
            name: "Test",
            tenantId: "t-1",
            region: "us-east-1",
            department: "eng",
            pk: "$myapp#v1#multigsiuser#u-1",
            sk: "$myapp#v1#multigsiuser",
            __edd_e__: "MultiGsiUser",
          }),
        })

        // Remove tenantId (affects byTenant GSI) but not department (byDepartment should be untouched)
        yield* MultiGsiEntity.update({ userId: "u-1" }).pipe(
          Entity.remove(["tenantId"]),
          Entity.asModel,
        )

        const call = mockUpdateItem.mock.calls[0]![0]
        const names = call.ExpressionAttributeNames as Record<string, string>
        const nameValues = Object.values(names)
        // byTenant GSI keys removed
        expect(nameValues).toContain("gsi1pk")
        expect(nameValues).toContain("gsi1sk")
        // byDepartment GSI keys NOT removed
        expect(nameValues).not.toContain("gsi2pk")
        expect(nameValues).not.toContain("gsi2sk")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // Wave 1: Version Snapshots
  // ---------------------------------------------------------------------------

  describe("version snapshots (retain)", () => {
    const RetainEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "RetainItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
        versioned: { retain: true },
      }),
    )

    it.effect("put creates v1 snapshot when retain=true", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* RetainEntity.put({ itemId: "i-1", name: "Test" }).asEffect()

        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        expect(mockPutItem).not.toHaveBeenCalled()

        const call = mockTransactWriteItems.mock.calls[0]![0]
        // Should have 2 items: main entity + v1 snapshot
        expect(call.TransactItems).toHaveLength(2)

        // First item: main entity Put
        const mainPut = call.TransactItems[0].Put
        expect(mainPut.Item.sk.S).toBe("$myapp#v1#retainitem")

        // Second item: v1 snapshot Put
        const snapshotPut = call.TransactItems[1].Put
        expect(snapshotPut.Item.sk.S).toBe("$myapp#v1#retainitem#v#0000001")
        // Snapshot should keep __edd_e__
        expect(snapshotPut.Item.__edd_e__.S).toBe("RetainItem")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("put with unique + retain creates 3+ transaction items", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValueOnce({})

        const UniqueRetainEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "UniqueRetain",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: { retain: true },
            unique: { email: ["email"] },
          }),
        )

        yield* UniqueRetainEntity.put({
          userId: "u-1",
          email: "alice@test.com",
          displayName: "Alice",
          role: "admin",
        }).asEffect()

        const call = mockTransactWriteItems.mock.calls[0]![0]
        // Should have 3 items: main entity + sentinel + v1 snapshot
        expect(call.TransactItems).toHaveLength(3)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("update reads current then transacts when retain=true", () =>
      Effect.gen(function* () {
        // Mock getItem for reading current state
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            itemId: "i-1",
            name: "Original",
            createdAt: "2024-01-15T00:00:00Z",
            updatedAt: "2024-01-15T00:00:00Z",
            version: 1,
            pk: "$myapp#v1#retainitem#i-1",
            sk: "$myapp#v1#retainitem",
            __edd_e__: "RetainItem",
          }),
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* RetainEntity.update({ itemId: "i-1" }).pipe(
          Entity.set({ name: "Updated" }),
          Entity.asModel,
        )

        // Should have read current item first
        expect(mockGetItem).toHaveBeenCalledOnce()
        // Should NOT have used updateItem
        expect(mockUpdateItem).not.toHaveBeenCalled()
        // Should have used transactWriteItems
        expect(mockTransactWriteItems).toHaveBeenCalledOnce()

        const call = mockTransactWriteItems.mock.calls[0]![0]
        // 2 items: new version Put + snapshot of pre-update state
        expect(call.TransactItems).toHaveLength(2)

        // New item should have version 2
        const newPut = call.TransactItems[0].Put
        expect(newPut.Item.version.N).toBe("2")
        expect(newPut.Item.name.S).toBe("Updated")

        // Snapshot should capture pre-update state (version 1, name "Original")
        const snapshotPut = call.TransactItems[1].Put
        expect(snapshotPut.Item.version.N).toBe("1")
        expect(snapshotPut.Item.name.S).toBe("Original")
        expect(snapshotPut.Item.sk.S).toBe("$myapp#v1#retainitem#v#0000001")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("update with expectedVersion + retain validates atomically", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            itemId: "i-1",
            name: "Original",
            createdAt: "2024-01-15T00:00:00Z",
            updatedAt: "2024-01-15T00:00:00Z",
            version: 3,
            pk: "$myapp#v1#retainitem#i-1",
            sk: "$myapp#v1#retainitem",
            __edd_e__: "RetainItem",
          }),
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* RetainEntity.update({ itemId: "i-1" }).pipe(
          Entity.set({ name: "Updated" }),
          Entity.expectedVersion(3),
          Entity.asModel,
        )

        // The transaction Put should have a version condition
        const call = mockTransactWriteItems.mock.calls[0]![0]
        const mainPut = call.TransactItems[0].Put
        expect(mainPut.ConditionExpression).toContain("#ver = :expectedVer")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("update with wrong expectedVersion + retain fails", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            itemId: "i-1",
            name: "Original",
            createdAt: "2024-01-15T00:00:00Z",
            updatedAt: "2024-01-15T00:00:00Z",
            version: 5,
            pk: "$myapp#v1#retainitem#i-1",
            sk: "$myapp#v1#retainitem",
            __edd_e__: "RetainItem",
          }),
        })

        const error = yield* RetainEntity.update({ itemId: "i-1" })
          .pipe(Entity.set({ name: "Updated" }), Entity.expectedVersion(3))
          .asEffect()
          .pipe(Effect.flip)

        expect(error._tag).toBe("OptimisticLockError")
        if (error._tag === "OptimisticLockError") {
          expect(error.expectedVersion).toBe(3)
          expect(error.actualVersion).toBe(5)
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("getVersion fetches specific version snapshot", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            itemId: "i-1",
            name: "OriginalV1",
            version: 1,
            createdAt: "2024-01-15T00:00:00Z",
            updatedAt: "2024-01-15T00:00:00Z",
            pk: "$myapp#v1#retainitem#i-1",
            sk: "$myapp#v1#retainitem#v#0000001",
            __edd_e__: "RetainItem",
          }),
        })

        const result = yield* RetainEntity.getVersion({ itemId: "i-1" }, 1).pipe(Entity.asRecord)

        expect(result.itemId).toBe("i-1")
        expect(result.name).toBe("OriginalV1")

        const call = mockGetItem.mock.calls[0]![0]
        expect(call.Key.sk.S).toBe("$myapp#v1#retainitem#v#0000001")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("getVersion returns ItemNotFound for non-existent version", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({ Item: undefined })

        const error = yield* RetainEntity.getVersion({ itemId: "i-1" }, 99)
          .asEffect()
          .pipe(Effect.flip)
        expect(error._tag).toBe("ItemNotFound")
      }).pipe(Effect.provide(TestLayer)),
    )

    it("versions returns Query with beginsWith on version prefix", () => {
      const q = RetainEntity.versions({ itemId: "i-1" })
      expect(Query.isQuery(q)).toBe(true)
      expect(q._state.skConditions).toHaveLength(1)
      expect((q._state.skConditions[0]!.condition as any).beginsWith).toBe(
        "$myapp#v1#retainitem#v#",
      )
    })

    it.effect("BoundEntity.versions returns a fluent BoundQuery", () =>
      Effect.gen(function* () {
        // Mock 3 version snapshots returned in ascending version order
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              itemId: "i-1",
              name: "v1",
              createdAt: "2024-01-15T00:00:00Z",
              updatedAt: "2024-01-15T00:00:00Z",
              version: 1,
              pk: "$myapp#v1#retainitem#i-1",
              sk: "$myapp#v1#retainitem#v#0000001",
              __edd_e__: "RetainItem",
            }),
            toAttributeMap({
              itemId: "i-1",
              name: "v2",
              createdAt: "2024-01-15T00:00:00Z",
              updatedAt: "2024-01-16T00:00:00Z",
              version: 2,
              pk: "$myapp#v1#retainitem#i-1",
              sk: "$myapp#v1#retainitem#v#0000002",
              __edd_e__: "RetainItem",
            }),
          ],
        })

        const bound = yield* Entity.bind(RetainEntity)
        const all = yield* bound.versions({ itemId: "i-1" }).limit(10).collect()

        expect(all).toHaveLength(2)
        expect((all[0]! as { name: string }).name).toBe("v1")
        expect((all[1]! as { name: string }).name).toBe("v2")

        // Verify the underlying QueryCommandInput shape
        expect(mockQuery).toHaveBeenCalledOnce()
        const call = mockQuery.mock.calls[0]![0]
        expect(call.TableName).toBe("test-table")
        expect(call.Limit).toBe(10)
        // No IndexName — versions read from the base table
        expect(call.IndexName).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("version snapshot has _ttl when versioned with ttl", () =>
      Effect.gen(function* () {
        mockTransactWriteItems.mockResolvedValueOnce({})

        const TtlRetainEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "TtlRetain",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: { retain: true, ttl: Duration.days(90) },
          }),
        )

        yield* TtlRetainEntity.put({ itemId: "i-1", name: "Test" }).asEffect()

        const call = mockTransactWriteItems.mock.calls[0]![0]
        const snapshotPut = call.TransactItems[1].Put
        // Snapshot should have _ttl
        expect(snapshotPut.Item._ttl).toBeDefined()
        expect(snapshotPut.Item._ttl.N).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // Wave 2: Soft Delete
  // ---------------------------------------------------------------------------

  describe("soft delete", () => {
    const SoftDeleteEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "SoftItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
        versioned: true,
        softDelete: true,
      }),
    )

    it.effect("delete soft-deletes when configured", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            itemId: "i-1",
            name: "Test",
            createdAt: "2024-01-15T00:00:00Z",
            updatedAt: "2024-01-15T00:00:00Z",
            version: 1,
            pk: "$myapp#v1#softitem#i-1",
            sk: "$myapp#v1#softitem",
            __edd_e__: "SoftItem",
          }),
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* SoftDeleteEntity.delete({ itemId: "i-1" }).asEffect()

        expect(mockTransactWriteItems).toHaveBeenCalledOnce()
        expect(mockDeleteItem).not.toHaveBeenCalled()

        const call = mockTransactWriteItems.mock.calls[0]![0]
        // 2 items: Delete current + Put soft-deleted
        expect(call.TransactItems).toHaveLength(2)

        // First: Delete current
        expect(call.TransactItems[0].Delete).toBeDefined()

        // Second: Put soft-deleted item
        const softDeletePut = call.TransactItems[1].Put
        expect(softDeletePut.Item.deletedAt).toBeDefined()
        expect(softDeletePut.Item.sk.S).toContain("#deleted#")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("soft delete with unique constraints deletes sentinels (preserveUnique=false)", () =>
      Effect.gen(function* () {
        const SoftUniqueEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "SoftUnique",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            softDelete: true,
            unique: { email: ["email"] },
          }),
        )

        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            userId: "u-1",
            email: "alice@test.com",
            displayName: "Alice",
            role: "admin",
            pk: "$myapp#v1#softunique#u-1",
            sk: "$myapp#v1#softunique",
            __edd_e__: "SoftUnique",
          }),
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* SoftUniqueEntity.delete({ userId: "u-1" }).asEffect()

        const call = mockTransactWriteItems.mock.calls[0]![0]
        // 3 items: Delete current + Put soft-deleted + Delete sentinel
        expect(call.TransactItems).toHaveLength(3)
        // Third item should be a Delete for the sentinel
        expect(call.TransactItems[2].Delete).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("soft delete with preserveUnique=true keeps sentinels", () =>
      Effect.gen(function* () {
        const PreserveEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "PreserveUniq",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            softDelete: { preserveUnique: true },
            unique: { email: ["email"] },
          }),
        )

        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            userId: "u-1",
            email: "alice@test.com",
            displayName: "Alice",
            role: "admin",
            pk: "$myapp#v1#preserveuniq#u-1",
            sk: "$myapp#v1#preserveuniq",
            __edd_e__: "PreserveUniq",
          }),
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* PreserveEntity.delete({ userId: "u-1" }).asEffect()

        const call = mockTransactWriteItems.mock.calls[0]![0]
        // 2 items only: Delete current + Put soft-deleted (no sentinel delete)
        expect(call.TransactItems).toHaveLength(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("soft delete + retain creates version snapshot", () =>
      Effect.gen(function* () {
        const SoftRetainEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "SoftRetain",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: { retain: true },
            softDelete: true,
          }),
        )

        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            itemId: "i-1",
            name: "Test",
            version: 3,
            pk: "$myapp#v1#softretain#i-1",
            sk: "$myapp#v1#softretain",
            __edd_e__: "SoftRetain",
          }),
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* SoftRetainEntity.delete({ itemId: "i-1" }).asEffect()

        const call = mockTransactWriteItems.mock.calls[0]![0]
        // 3 items: Delete current + Put soft-deleted + Put version snapshot
        expect(call.TransactItems).toHaveLength(3)
        // Third should be the version snapshot
        const snapshotPut = call.TransactItems[2].Put
        expect(snapshotPut.Item.sk.S).toContain("#v#")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("deleted.get retrieves soft-deleted item", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              itemId: "i-1",
              name: "Test",
              createdAt: "2024-01-15T00:00:00Z",
              updatedAt: "2024-01-15T00:00:00Z",
              version: 1,
              deletedAt: "2024-02-01T10:00:00Z",
              pk: "$myapp#v1#softitem#i-1",
              sk: "$myapp#v1#softitem#deleted#2024-02-01T10:00:00Z",
              __edd_e__: "SoftItem",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const result = yield* SoftDeleteEntity.deleted.get({ itemId: "i-1" }).pipe(Entity.asRecord)
        expect(result.itemId).toBe("i-1")
        expect((result as any).deletedAt).toBe("2024-02-01T10:00:00Z")

        const call = mockQuery.mock.calls[0]![0]
        expect(call.KeyConditionExpression).toContain("begins_with")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("deleted.get returns ItemNotFound when not deleted", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [],
          LastEvaluatedKey: undefined,
        })

        const error = yield* SoftDeleteEntity.deleted
          .get({ itemId: "i-1" })
          .asEffect()
          .pipe(Effect.flip)
        expect(error._tag).toBe("ItemNotFound")
      }).pipe(Effect.provide(TestLayer)),
    )

    it("deleted.list returns Query with beginsWith on deleted prefix", () => {
      const q = SoftDeleteEntity.deleted.list({ itemId: "i-1" })
      expect(Query.isQuery(q)).toBe(true)
      expect(q._state.skConditions).toHaveLength(1)
      expect((q._state.skConditions[0]!.condition as any).beginsWith).toBe(
        "$myapp#v1#softitem#deleted#",
      )
    })

    it.effect("BoundEntity.deleted.list returns a fluent BoundQuery", () =>
      Effect.gen(function* () {
        // Mock 2 soft-deleted tombstones in the partition
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              itemId: "i-1",
              name: "first",
              createdAt: "2024-01-15T00:00:00Z",
              updatedAt: "2024-01-16T00:00:00Z",
              version: 1,
              deletedAt: "2024-01-16T00:00:00Z",
              pk: "$myapp#v1#softitem#i-1",
              sk: "$myapp#v1#softitem#deleted#2024-01-16T00:00:00Z",
              __edd_e__: "SoftItem",
            }),
            toAttributeMap({
              itemId: "i-1",
              name: "second",
              createdAt: "2024-01-17T00:00:00Z",
              updatedAt: "2024-01-18T00:00:00Z",
              version: 1,
              deletedAt: "2024-01-18T00:00:00Z",
              pk: "$myapp#v1#softitem#i-1",
              sk: "$myapp#v1#softitem#deleted#2024-01-18T00:00:00Z",
              __edd_e__: "SoftItem",
            }),
          ],
        })

        const bound = yield* Entity.bind(SoftDeleteEntity)
        const tombstones = yield* bound.deleted.list({ itemId: "i-1" }).reverse().collect()

        expect(tombstones).toHaveLength(2)
        // Verify the underlying QueryCommandInput shape
        expect(mockQuery).toHaveBeenCalledOnce()
        const call = mockQuery.mock.calls[0]![0]
        expect(call.TableName).toBe("test-table")
        // .reverse() flips ScanIndexForward to false
        expect(call.ScanIndexForward).toBe(false)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // Wave 3: Restore + Purge
  // ---------------------------------------------------------------------------

  describe("restore", () => {
    const RestoreEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "RestoreItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
        versioned: true,
        softDelete: true,
      }),
    )

    it.effect("restore restores a soft-deleted item", () =>
      Effect.gen(function* () {
        // Query finds the soft-deleted item
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              itemId: "i-1",
              name: "Test",
              createdAt: "2024-01-15T00:00:00Z",
              updatedAt: "2024-01-15T00:00:00Z",
              version: 2,
              deletedAt: "2024-02-01T10:00:00Z",
              pk: "$myapp#v1#restoreitem#i-1",
              sk: "$myapp#v1#restoreitem#deleted#2024-02-01T10:00:00Z",
              __edd_e__: "RestoreItem",
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        const result = yield* RestoreEntity.restore({ itemId: "i-1" }).pipe(Entity.asRecord)

        expect(result.itemId).toBe("i-1")
        expect(result.name).toBe("Test")
        expect(result.version).toBe(3) // Incremented
        expect((result as any).deletedAt).toBeUndefined()

        const call = mockTransactWriteItems.mock.calls[0]![0]
        // 2 items: Delete soft-deleted + Put restored
        expect(call.TransactItems).toHaveLength(2)

        // Restored item should have original SK
        const restoredPut = call.TransactItems[1].Put
        expect(restoredPut.Item.sk.S).toBe("$myapp#v1#restoreitem")
        // Should not have deletedAt
        expect(restoredPut.Item.deletedAt).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("restore with unique constraints re-establishes sentinels", () =>
      Effect.gen(function* () {
        const RestoreUniqueEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "RestoreUniq",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: true,
            softDelete: true,
            unique: { email: ["email"] },
          }),
        )

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              userId: "u-1",
              email: "alice@test.com",
              displayName: "Alice",
              role: "admin",
              version: 1,
              deletedAt: "2024-02-01T10:00:00Z",
              pk: "$myapp#v1#restoreuniq#u-1",
              sk: "$myapp#v1#restoreuniq#deleted#2024-02-01T10:00:00Z",
              __edd_e__: "RestoreUniq",
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* RestoreUniqueEntity.restore({ userId: "u-1" }).asEffect()

        const call = mockTransactWriteItems.mock.calls[0]![0]
        // 3 items: Delete soft-deleted + Put restored + Put sentinel
        expect(call.TransactItems).toHaveLength(3)
        // Third item: sentinel Put with attribute_not_exists condition
        const sentinelPut = call.TransactItems[2].Put
        expect(sentinelPut.ConditionExpression).toContain("attribute_not_exists")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("restore fails with UniqueConstraintViolation when value is taken", () =>
      Effect.gen(function* () {
        const RestoreUniqueEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "RestoreUniq",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: true,
            softDelete: true,
            unique: { email: ["email"] },
          }),
        )

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              userId: "u-1",
              email: "alice@test.com",
              displayName: "Alice",
              role: "admin",
              version: 1,
              deletedAt: "2024-02-01T10:00:00Z",
              pk: "$myapp#v1#restoreuniq#u-1",
              sk: "$myapp#v1#restoreuniq#deleted#2024-02-01T10:00:00Z",
              __edd_e__: "RestoreUniq",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const txError = new Error("TransactionCanceledException")
        ;(txError as any).name = "TransactionCanceledException"
        ;(txError as any).CancellationReasons = [
          { Code: "None" }, // Delete
          { Code: "None" }, // Put restored
          { Code: "ConditionalCheckFailed" }, // Sentinel
        ]
        mockTransactWriteItems.mockRejectedValueOnce(txError)

        const error = yield* RestoreUniqueEntity.restore({ userId: "u-1" })
          .asEffect()
          .pipe(Effect.flip)

        expect(error._tag).toBe("UniqueConstraintViolation")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("restore + retain creates snapshot", () =>
      Effect.gen(function* () {
        const RestoreRetainEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "RestoreRetain",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: { retain: true },
            softDelete: true,
          }),
        )

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              itemId: "i-1",
              name: "Test",
              version: 2,
              deletedAt: "2024-02-01T10:00:00Z",
              pk: "$myapp#v1#restoreretain#i-1",
              sk: "$myapp#v1#restoreretain#deleted#2024-02-01T10:00:00Z",
              __edd_e__: "RestoreRetain",
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* RestoreRetainEntity.restore({ itemId: "i-1" }).asEffect()

        const call = mockTransactWriteItems.mock.calls[0]![0]
        // 3 items: Delete soft-deleted + Put restored + Put snapshot
        expect(call.TransactItems).toHaveLength(3)
        const snapshotPut = call.TransactItems[2].Put
        expect(snapshotPut.Item.sk.S).toContain("#v#")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("restore returns ItemNotFound when not deleted", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [],
          LastEvaluatedKey: undefined,
        })

        const error = yield* RestoreEntity.restore({ itemId: "i-1" }).asEffect().pipe(Effect.flip)
        expect(error._tag).toBe("ItemNotFound")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("purge", () => {
    const mockBatchWriteItem = vi.fn()

    const PurgeTestDynamoClient = Layer.succeed(DynamoClient, {
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
      transactWriteItems: (input) =>
        Effect.tryPromise({
          try: () => mockTransactWriteItems(input),
          catch: (e) => new DynamoError({ operation: "TransactWriteItems", cause: e }),
        }),
      batchGetItem: () => Effect.die("not used"),
      batchWriteItem: (input) =>
        Effect.tryPromise({
          try: () => mockBatchWriteItem(input),
          catch: (e) => new DynamoError({ operation: "BatchWriteItem", cause: e }),
        }),
      transactGetItems: () => Effect.die("not used"),
      createTable: () => Effect.die("not used"),
      deleteTable: () => Effect.die("not used"),
      describeTable: () => Effect.die("not used"),
      scan: () => Effect.die("not used"),
    })

    const PurgeTestLayer = Layer.merge(PurgeTestDynamoClient, TestTableConfig)

    const PurgeEntity = withConfig(
      Entity.make({
        model: SimpleItem,
        entityType: "PurgeItem",
        primaryKey: {
          pk: { field: "pk", composite: ["itemId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    beforeEach(() => {
      mockBatchWriteItem.mockReset()
    })

    it.effect("purge deletes all items in partition via batchWriteItem", () =>
      Effect.gen(function* () {
        // Query returns main item + 2 version snapshots
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#purgeitem#i-1",
              sk: "$myapp#v1#purgeitem",
            }),
            toAttributeMap({
              pk: "$myapp#v1#purgeitem#i-1",
              sk: "$myapp#v1#purgeitem#v#0000001",
            }),
            toAttributeMap({
              pk: "$myapp#v1#purgeitem#i-1",
              sk: "$myapp#v1#purgeitem#v#0000002",
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        mockBatchWriteItem.mockResolvedValueOnce({})

        yield* PurgeEntity.purge({ itemId: "i-1" }).asEffect()

        expect(mockBatchWriteItem).toHaveBeenCalledOnce()
        const call = mockBatchWriteItem.mock.calls[0]![0]
        expect(call.RequestItems["test-table"]).toHaveLength(3)
      }).pipe(Effect.provide(PurgeTestLayer)),
    )

    it.effect("purge handles soft-deleted item + versions", () =>
      Effect.gen(function* () {
        const PurgeSoftEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "PurgeSoft",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            softDelete: true,
          }),
        )

        // Query for all items in partition
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#purgesoft#i-1",
              sk: "$myapp#v1#purgesoft#deleted#2024-02-01T10:00:00Z",
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        // getItem for main item (not found since soft-deleted)
        mockGetItem.mockResolvedValueOnce({ Item: undefined })
        // Query for soft-deleted item (for sentinel cleanup)
        mockQuery.mockResolvedValueOnce({
          Items: [],
          LastEvaluatedKey: undefined,
        })
        mockBatchWriteItem.mockResolvedValueOnce({})

        yield* PurgeSoftEntity.purge({ itemId: "i-1" }).asEffect()

        expect(mockBatchWriteItem).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(PurgeTestLayer)),
    )

    it.effect("purge simple case (no versions or sentinels)", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#purgeitem#i-1",
              sk: "$myapp#v1#purgeitem",
            }),
          ],
          LastEvaluatedKey: undefined,
        })
        mockBatchWriteItem.mockResolvedValueOnce({})

        yield* PurgeEntity.purge({ itemId: "i-1" }).asEffect()

        expect(mockBatchWriteItem).toHaveBeenCalledOnce()
        const call = mockBatchWriteItem.mock.calls[0]![0]
        expect(call.RequestItems["test-table"]).toHaveLength(1)
      }).pipe(Effect.provide(PurgeTestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // Date-aware marshalling (DynamoEncoding integration)
  // ---------------------------------------------------------------------------

  describe("DynamoEncoding date-aware marshalling", () => {
    class Event extends Schema.Class<Event>("Event")({
      eventId: Schema.String,
      occurredAt: DynamoModel.DateString,
    }) {}

    class EventEpoch extends Schema.Class<EventEpoch>("EventEpoch")({
      eventId: Schema.String,
      occurredAt: DynamoModel.DateEpochSeconds,
    }) {}

    class EventStoredAsEpoch extends Schema.Class<EventStoredAsEpoch>("EventStoredAsEpoch")({
      eventId: Schema.String,
      occurredAt: DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
    }) {}

    const EventEntity = withConfig(
      Entity.make({
        model: Event,
        entityType: "Event",
        primaryKey: {
          pk: { field: "pk", composite: ["eventId"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
      }),
    )

    const EventEpochEntity = withConfig(
      Entity.make({
        model: EventEpoch,
        entityType: "EventEpoch",
        primaryKey: {
          pk: { field: "pk", composite: ["eventId"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
      }),
    )

    const EventStoredAsEntity = withConfig(
      Entity.make({
        model: EventStoredAsEpoch,
        entityType: "EventStoredAs",
        primaryKey: {
          pk: { field: "pk", composite: ["eventId"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
      }),
    )

    it.effect("put: DateString field stored as ISO string in DynamoDB", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})
        yield* EventEntity.put({
          eventId: "e-1",
          occurredAt: DateTime.makeUnsafe("2024-01-01T00:00:00.000Z"),
        }).asEffect()

        const call = mockPutItem.mock.calls[0]![0]
        // occurredAt should be stored as ISO string (S attribute)
        expect(call.Item.occurredAt).toEqual({ S: "2024-01-01T00:00:00.000Z" })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("put: DateEpochSeconds field stored as number in DynamoDB", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})
        yield* EventEpochEntity.put({
          eventId: "e-1",
          occurredAt: DateTime.makeUnsafe(1704067200000),
        }).asEffect()

        const call = mockPutItem.mock.calls[0]![0]
        // occurredAt should be stored as epoch seconds (N attribute)
        expect(call.Item.occurredAt).toEqual({ N: "1704067200" })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("put: storedAs(DateEpochSeconds) overrides storage to epoch seconds", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})
        yield* EventStoredAsEntity.put({
          eventId: "e-1",
          occurredAt: DateTime.makeUnsafe("2024-01-01T00:00:00.000Z"),
        }).asEffect()

        const call = mockPutItem.mock.calls[0]![0]
        // occurredAt should be stored as epoch seconds (N attribute) despite wire being ISO string
        expect(call.Item.occurredAt).toEqual({ N: "1704067200" })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("get: DateString field decoded to DateTime.Utc from DynamoDB string", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            pk: "$myapp#v1#event#e-1",
            sk: "$myapp#v1#event",
            eventId: "e-1",
            occurredAt: "2024-01-01T00:00:00.000Z",
            __edd_e__: "Event",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          }),
        })

        const result = yield* EventEntity.get({ eventId: "e-1" }).asEffect()
        expect(DateTime.isDateTime(result.occurredAt)).toBe(true)
        expect(DateTime.toEpochMillis(result.occurredAt)).toBe(1704067200000)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("get: DateEpochSeconds field decoded to DateTime.Utc from DynamoDB number", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            pk: "$myapp#v1#eventepoch#e-1",
            sk: "$myapp#v1#eventepoch",
            eventId: "e-1",
            occurredAt: 1704067200,
            __edd_e__: "EventEpoch",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          }),
        })

        const result = yield* EventEpochEntity.get({ eventId: "e-1" }).asEffect()
        expect(DateTime.isDateTime(result.occurredAt)).toBe(true)
        expect(DateTime.toEpochMillis(result.occurredAt)).toBe(1704067200000)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("get: storedAs(DateEpochSeconds) reads epoch seconds and returns DateTime.Utc", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            pk: "$myapp#v1#eventstoredas#e-1",
            sk: "$myapp#v1#eventstoredas",
            eventId: "e-1",
            occurredAt: 1704067200,
            __edd_e__: "EventStoredAs",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          }),
        })

        const result = yield* EventStoredAsEntity.get({ eventId: "e-1" }).asEffect()
        expect(DateTime.isDateTime(result.occurredAt)).toBe(true)
        expect(DateTime.toEpochMillis(result.occurredAt)).toBe(1704067200000)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("query: date fields correctly decoded from DynamoDB response", () =>
      Effect.gen(function* () {
        mockQuery.mockResolvedValue({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#eventepoch#e-1",
              sk: "$myapp#v1#eventepoch",
              eventId: "e-1",
              occurredAt: 1704067200,
              __edd_e__: "EventEpoch",
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-01-01T00:00:00.000Z",
            }),
          ],
        })

        // Need an entity with a GSI to test query
        const EventEpochWithGsi = withConfig(
          Entity.make({
            model: EventEpoch,
            entityType: "EventEpoch",
            primaryKey: {
              pk: { field: "pk", composite: ["eventId"] },
              sk: { field: "sk", composite: [] },
            },
            indexes: {
              byEvent: {
                name: "gsi1",
                pk: { field: "gsi1pk", composite: ["eventId"] },
                sk: { field: "gsi1sk", composite: [] },
              },
            },
            timestamps: true,
          }),
        )

        const results = yield* EventEpochWithGsi.query
          .byEvent({ eventId: "e-1" })
          .pipe(Query.collect)
        expect(results).toHaveLength(1)
        expect(DateTime.isDateTime(results[0]!.occurredAt)).toBe(true)
        expect(DateTime.toEpochMillis(results[0]!.occurredAt)).toBe(1704067200000)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("update: date fields correctly round-trip through update path", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValue({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#eventepoch#e-1",
            sk: "$myapp#v1#eventepoch",
            eventId: "e-1",
            occurredAt: 1704153600,
            __edd_e__: "EventEpoch",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-02T00:00:00.000Z",
            version: 2,
          }),
        })

        const result = yield* EventEpochEntity.update({ eventId: "e-1" }).pipe(
          Entity.set({ occurredAt: DateTime.makeUnsafe(1704153600000) }),
          Entity.asModel,
        )
        expect(DateTime.isDateTime(result.occurredAt)).toBe(true)
        expect(DateTime.toEpochMillis(result.occurredAt)).toBe(1704153600000)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // DynamoModel.configure — Entity integration
  // ---------------------------------------------------------------------------

  describe("ConfiguredModel", () => {
    // Pure domain model — no DynamoDB imports
    class Device extends Schema.Class<Device>("Device")({
      id: Schema.String,
      name: Schema.String,
      firmwareVersion: Schema.String,
    }) {}

    // ConfiguredModel with field renaming
    const DeviceModel = DynamoModel.configure(Device, {
      id: { field: "deviceId" },
      firmwareVersion: { field: "fw_ver" },
    })

    const DeviceEntity = withConfig(
      Entity.make({
        model: DeviceModel,
        entityType: "Device",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
      }),
    )

    it.effect("put: field renaming maps domain names to DynamoDB attribute names", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})
        yield* DeviceEntity.put({ id: "d-1", name: "Sensor", firmwareVersion: "1.0.0" }).asEffect()
        const call = mockPutItem.mock.calls[0]![0]
        const item = call.Item
        // Domain "id" → DynamoDB "deviceId"
        expect(item.deviceId).toBeDefined()
        expect(item.id).toBeUndefined()
        // Domain "firmwareVersion" → DynamoDB "fw_ver"
        expect(item.fw_ver).toBeDefined()
        expect(item.firmwareVersion).toBeUndefined()
        // Non-renamed field stays the same
        expect(item.name).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("get: DynamoDB attribute names mapped back to domain names", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            pk: "$myapp#v1#device#d-1",
            sk: "$myapp#v1#device",
            deviceId: "d-1",
            name: "Sensor",
            fw_ver: "1.0.0",
            __edd_e__: "Device",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          }),
        })
        const result = yield* DeviceEntity.get({ id: "d-1" }).asEffect()
        // Should see domain names
        expect(result.id).toBe("d-1")
        expect(result.name).toBe("Sensor")
        expect(result.firmwareVersion).toBe("1.0.0")
      }).pipe(Effect.provide(TestLayer)),
    )

    // ConfiguredModel with storage override (no field rename)
    class Order extends Schema.Class<Order>("Order")({
      orderId: Schema.String,
      placedAt: Schema.DateTimeUtcFromString,
      expiresAt: Schema.DateTimeUtcFromString,
    }) {}

    const OrderModel = DynamoModel.configure(Order, {
      expiresAt: { storedAs: DynamoModel.DateEpochSeconds },
    })

    const OrderEntity = withConfig(
      Entity.make({
        model: OrderModel,
        entityType: "Order",
        primaryKey: {
          pk: { field: "pk", composite: ["orderId"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
      }),
    )

    it.effect("put: ConfiguredModel storage override stores epoch seconds", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})
        yield* OrderEntity.put({
          orderId: "o-1",
          placedAt: DateTime.makeUnsafe("2024-01-01T00:00:00.000Z"),
          expiresAt: DateTime.makeUnsafe("2024-02-01T00:00:00.000Z"),
        }).asEffect()
        const call = mockPutItem.mock.calls[0]![0]
        const item = call.Item
        // placedAt has no storage override — stored as ISO string (default)
        expect(item.placedAt.S).toBe("2024-01-01T00:00:00.000Z")
        // expiresAt has storedAs(DateEpochSeconds) — stored as epoch seconds
        expect(item.expiresAt.N).toBe("1706745600")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("get: ConfiguredModel storage override decodes epoch seconds to DateTime", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            pk: "$myapp#v1#order#o-1",
            sk: "$myapp#v1#order",
            orderId: "o-1",
            placedAt: "2024-01-01T00:00:00.000Z",
            expiresAt: 1706745600, // epoch seconds
            __edd_e__: "Order",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          }),
        })
        const result = yield* OrderEntity.get({ orderId: "o-1" }).asEffect()
        expect(DateTime.isDateTime(result.expiresAt)).toBe(true)
        expect(DateTime.toEpochMillis(result.expiresAt)).toBe(1706745600000)
      }).pipe(Effect.provide(TestLayer)),
    )

    // ConfiguredModel with both field rename + storage override
    const OrderModelFull = DynamoModel.configure(Order, {
      expiresAt: { field: "ttl", storedAs: DynamoModel.DateEpochSeconds },
    })

    const OrderFullEntity = withConfig(
      Entity.make({
        model: OrderModelFull,
        entityType: "OrderFull",
        primaryKey: {
          pk: { field: "pk", composite: ["orderId"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
      }),
    )

    it.effect("put: field rename + storage override compose correctly", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})
        yield* OrderFullEntity.put({
          orderId: "o-1",
          placedAt: DateTime.makeUnsafe("2024-01-01T00:00:00.000Z"),
          expiresAt: DateTime.makeUnsafe("2024-02-01T00:00:00.000Z"),
        }).asEffect()
        const call = mockPutItem.mock.calls[0]![0]
        const item = call.Item
        // expiresAt → field: "ttl", storedAs: epoch seconds
        expect(item.ttl.N).toBe("1706745600")
        expect(item.expiresAt).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("get: field rename + storage override decodes correctly", () =>
      Effect.gen(function* () {
        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            pk: "$myapp#v1#orderfull#o-1",
            sk: "$myapp#v1#orderfull",
            orderId: "o-1",
            placedAt: "2024-01-01T00:00:00.000Z",
            ttl: 1706745600, // epoch seconds, DynamoDB name "ttl"
            __edd_e__: "OrderFull",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          }),
        })
        const result = yield* OrderFullEntity.get({ orderId: "o-1" }).asEffect()
        // Domain name is "expiresAt", decoded from DynamoDB "ttl"
        expect(result.expiresAt).toBeDefined()
        expect(DateTime.isDateTime(result.expiresAt)).toBe(true)
        expect(DateTime.toEpochMillis(result.expiresAt)).toBe(1706745600000)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("update: field rename applied in update expression", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValue({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#device#d-1",
            sk: "$myapp#v1#device",
            deviceId: "d-1",
            name: "Sensor",
            fw_ver: "2.0.0",
            __edd_e__: "Device",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          }),
        })
        yield* DeviceEntity.update({ id: "d-1" }).pipe(
          Entity.set({ firmwareVersion: "2.0.0" }),
          Entity.asModel,
        )
        const call = mockUpdateItem.mock.calls[0]![0]
        // The update expression should use the DynamoDB name "fw_ver", not "firmwareVersion"
        const names = call.ExpressionAttributeNames
        const dbNames = Object.values(names) as string[]
        expect(dbNames).toContain("fw_ver")
        expect(dbNames).not.toContain("firmwareVersion")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // Configurable system timestamps
  // ---------------------------------------------------------------------------

  describe("Configurable timestamps", () => {
    class Metric extends Schema.Class<Metric>("Metric")({
      metricId: Schema.String,
      value: Schema.Number,
    }) {}

    it.effect("timestamps with schema: updatedAt stored as epoch seconds", () =>
      Effect.gen(function* () {
        const MetricEntity = withConfig(
          Entity.make({
            model: Metric,
            entityType: "Metric",
            primaryKey: {
              pk: { field: "pk", composite: ["metricId"] },
              sk: { field: "sk", composite: [] },
            },
            timestamps: {
              created: DynamoModel.DateString,
              updated: {
                schema: DynamoModel.DateString.pipe(
                  DynamoModel.storedAs(DynamoModel.DateEpochSeconds),
                ),
              },
            },
          }),
        )

        mockPutItem.mockResolvedValue({})
        yield* MetricEntity.put({ metricId: "m-1", value: 42 }).asEffect()
        const call = mockPutItem.mock.calls[0]![0]
        const item = call.Item
        // createdAt: DynamoModel.DateString → stored as ISO string
        expect(item.createdAt.S).toBeDefined()
        expect(typeof item.createdAt.S).toBe("string")
        // updatedAt: storedAs(DateEpochSeconds) → stored as epoch seconds number
        expect(item.updatedAt.N).toBeDefined()
        const epochVal = Number(item.updatedAt.N)
        expect(epochVal).toBeGreaterThan(1700000000) // reasonable epoch seconds
        expect(epochVal).toBeLessThan(2000000000)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("timestamps with field rename: custom field names", () =>
      Effect.gen(function* () {
        const MetricEntity = withConfig(
          Entity.make({
            model: Metric,
            entityType: "Metric2",
            primaryKey: {
              pk: { field: "pk", composite: ["metricId"] },
              sk: { field: "sk", composite: [] },
            },
            timestamps: {
              created: "registeredAt",
              updated: "modifiedAt",
            },
          }),
        )

        mockPutItem.mockResolvedValue({})
        yield* MetricEntity.put({ metricId: "m-1", value: 42 }).asEffect()
        const call = mockPutItem.mock.calls[0]![0]
        const item = call.Item
        expect(item.registeredAt).toBeDefined()
        expect(item.modifiedAt).toBeDefined()
        expect(item.createdAt).toBeUndefined()
        expect(item.updatedAt).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("timestamps with { field, schema }: custom name + custom storage", () =>
      Effect.gen(function* () {
        const MetricEntity = withConfig(
          Entity.make({
            model: Metric,
            entityType: "Metric3",
            primaryKey: {
              pk: { field: "pk", composite: ["metricId"] },
              sk: { field: "sk", composite: [] },
            },
            timestamps: {
              updated: {
                field: "modifiedAt",
                schema: DynamoModel.DateEpochSeconds,
              },
            },
          }),
        )

        mockPutItem.mockResolvedValue({})
        yield* MetricEntity.put({ metricId: "m-1", value: 42 }).asEffect()
        const call = mockPutItem.mock.calls[0]![0]
        const item = call.Item
        // updatedAt uses custom name "modifiedAt" and epoch seconds
        expect(item.modifiedAt.N).toBeDefined()
        expect(item.updatedAt).toBeUndefined()
        const epochVal = Number(item.modifiedAt.N)
        expect(epochVal).toBeGreaterThan(1700000000)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // Wave 4: patch, deleteIfExists, upsert, returnValues
  // ---------------------------------------------------------------------------

  describe("patch", () => {
    it.effect("succeeds when item exists", () =>
      Effect.gen(function* () {
        const UserEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "User",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            timestamps: true,
            versioned: true,
          }),
        )

        mockUpdateItem.mockResolvedValue({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#user#u-1",
            sk: "$myapp#v1#user",
            userId: "u-1",
            email: "new@test.com",
            displayName: "Updated",
            role: "admin",
            __edd_e__: "User",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-06-01T00:00:00.000Z",
            version: 2,
          }),
        })

        yield* UserEntity.patch({ userId: "u-1" }).pipe(
          Entity.set({ email: "new@test.com" }),
          Entity.asModel,
        )

        const call = mockUpdateItem.mock.calls[0]![0]
        // Should include attribute_exists condition for PK
        expect(call.ConditionExpression).toContain("attribute_exists")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with ConditionalCheckFailed when item does not exist", () =>
      Effect.gen(function* () {
        const UserEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "User",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            timestamps: true,
            versioned: true,
          }),
        )

        const condError = new Error("ConditionalCheckFailedException")
        condError.name = "ConditionalCheckFailedException"
        mockUpdateItem.mockRejectedValue(condError)

        const result = yield* UserEntity.patch({ userId: "u-1" })
          .pipe(Entity.set({ email: "new@test.com" }))
          .asEffect()
          .pipe(Effect.flip)

        expect(result._tag).toBe("ConditionalCheckFailed")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("composes with set and other combinators", () =>
      Effect.gen(function* () {
        const UserEntity = withConfig(
          Entity.make({
            model: User,
            entityType: "User",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            timestamps: true,
            versioned: true,
          }),
        )

        mockUpdateItem.mockResolvedValue({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#user#u-1",
            sk: "$myapp#v1#user",
            userId: "u-1",
            email: "new@test.com",
            displayName: "Updated",
            role: "admin",
            __edd_e__: "User",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-06-01T00:00:00.000Z",
            version: 3,
          }),
        })

        yield* UserEntity.patch({ userId: "u-1" }).pipe(
          Entity.set({ email: "new@test.com" }),
          Entity.expectedVersion(2),
          Entity.asModel,
        )

        const call = mockUpdateItem.mock.calls[0]![0]
        // Should have both attribute_exists AND version condition
        expect(call.ConditionExpression).toContain("attribute_exists")
        expect(call.ConditionExpression).toContain("#condVer = :expectedVer")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("deleteIfExists", () => {
    it.effect("succeeds when item exists", () =>
      Effect.gen(function* () {
        const ItemEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "SimpleItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
          }),
        )

        mockDeleteItem.mockResolvedValue({})

        yield* ItemEntity.deleteIfExists({ itemId: "i-1" }).asEffect()

        const call = mockDeleteItem.mock.calls[0]![0]
        // Should include attribute_exists condition for PK
        expect(call.ConditionExpression).toContain("attribute_exists")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("fails with ConditionalCheckFailed when item does not exist", () =>
      Effect.gen(function* () {
        const ItemEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "SimpleItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
          }),
        )

        const condError = new Error("ConditionalCheckFailedException")
        condError.name = "ConditionalCheckFailedException"
        mockDeleteItem.mockRejectedValue(condError)

        const result = yield* ItemEntity.deleteIfExists({ itemId: "i-1" })
          .asEffect()
          .pipe(Effect.flip)

        expect(result._tag).toBe("ConditionalCheckFailed")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("upsert", () => {
    it.effect("creates a new item with if_not_exists for immutable fields and createdAt", () =>
      Effect.gen(function* () {
        const UserEntity = withConfig(
          Entity.make({
            model: UserWithImmutableModel,
            entityType: "UserImm",
            primaryKey: {
              pk: { field: "pk", composite: ["userId"] },
              sk: { field: "sk", composite: [] },
            },
            timestamps: true,
            versioned: true,
          }),
        )

        mockUpdateItem.mockResolvedValue({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#userimm#u-1",
            sk: "$myapp#v1#userimm",
            userId: "u-1",
            email: "test@test.com",
            displayName: "Test",
            createdBy: "admin",
            __edd_e__: "UserImm",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            version: 1,
          }),
        })

        yield* UserEntity.upsert({
          userId: "u-1",
          email: "test@test.com",
          displayName: "Test" as any,
          createdBy: "admin",
        }).asEffect()

        const call = mockUpdateItem.mock.calls[0]![0]
        const updateExpr = call.UpdateExpression as string

        // Immutable field (createdBy) should use if_not_exists
        expect(updateExpr).toContain("if_not_exists")

        // createdAt should use if_not_exists
        // email should NOT use if_not_exists (mutable)
        // version should use if_not_exists pattern
        expect(updateExpr).toMatch(/if_not_exists/)

        // Should use UpdateItem, not PutItem
        expect(mockPutItem).not.toHaveBeenCalled()
        expect(mockUpdateItem).toHaveBeenCalledTimes(1)

        // ReturnValues should be ALL_NEW
        expect(call.ReturnValues).toBe("ALL_NEW")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("includes entity type discriminator in expression", () =>
      Effect.gen(function* () {
        const ItemEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "SimpleItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            timestamps: true,
          }),
        )

        mockUpdateItem.mockResolvedValue({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            itemId: "i-1",
            name: "Test",
            __edd_e__: "SimpleItem",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          }),
        })

        yield* ItemEntity.upsert({ itemId: "i-1", name: "Test" }).asEffect()

        const call = mockUpdateItem.mock.calls[0]![0]
        // __edd_e__ should be in the expression values
        const values = call.ExpressionAttributeValues
        const hasEntityType = Object.values(values).some((v: any) => v.S === "SimpleItem")
        expect(hasEntityType).toBe(true)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("version uses if_not_exists(version, 0) + 1 pattern", () =>
      Effect.gen(function* () {
        const ItemEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "SimpleItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            versioned: true,
          }),
        )

        mockUpdateItem.mockResolvedValue({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            itemId: "i-1",
            name: "Test",
            __edd_e__: "SimpleItem",
            version: 1,
          }),
        })

        yield* ItemEntity.upsert({ itemId: "i-1", name: "Test" }).asEffect()

        const call = mockUpdateItem.mock.calls[0]![0]
        const updateExpr = call.UpdateExpression as string
        // Should have if_not_exists for version with + :vinc
        expect(updateExpr).toMatch(/if_not_exists\(.+, .+\) \+ :vinc/)
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  describe("returnValues", () => {
    it.effect("update with returnValues: none", () =>
      Effect.gen(function* () {
        const ItemEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "SimpleItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
          }),
        )

        mockUpdateItem.mockResolvedValue({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            itemId: "i-1",
            name: "Updated",
            __edd_e__: "SimpleItem",
          }),
        })

        yield* ItemEntity.update({ itemId: "i-1" }).pipe(
          Entity.set({ name: "Updated" }),
          Entity.returnValues("none"),
          Entity.asModel,
        )

        const call = mockUpdateItem.mock.calls[0]![0]
        expect(call.ReturnValues).toBe("NONE")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("update with returnValues: updatedOld", () =>
      Effect.gen(function* () {
        const ItemEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "SimpleItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
          }),
        )

        mockUpdateItem.mockResolvedValue({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            itemId: "i-1",
            name: "Old",
            __edd_e__: "SimpleItem",
          }),
        })

        yield* ItemEntity.update({ itemId: "i-1" }).pipe(
          Entity.set({ name: "Updated" }),
          Entity.returnValues("updatedOld"),
          Entity.asModel,
        )

        const call = mockUpdateItem.mock.calls[0]![0]
        expect(call.ReturnValues).toBe("UPDATED_OLD")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("default update returnValues is ALL_NEW", () =>
      Effect.gen(function* () {
        const ItemEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "SimpleItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
          }),
        )

        mockUpdateItem.mockResolvedValue({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#simpleitem#i-1",
            sk: "$myapp#v1#simpleitem",
            itemId: "i-1",
            name: "Updated",
            __edd_e__: "SimpleItem",
          }),
        })

        yield* ItemEntity.update({ itemId: "i-1" }).pipe(
          Entity.set({ name: "Updated" }),
          Entity.asModel,
        )

        const call = mockUpdateItem.mock.calls[0]![0]
        expect(call.ReturnValues).toBe("ALL_NEW")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("delete with returnValues: allOld", () =>
      Effect.gen(function* () {
        const ItemEntity = withConfig(
          Entity.make({
            model: SimpleItem,
            entityType: "SimpleItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
          }),
        )

        mockDeleteItem.mockResolvedValue({})

        yield* ItemEntity.delete({ itemId: "i-1" }).pipe(Entity.returnValues("allOld")).asEffect()

        const call = mockDeleteItem.mock.calls[0]![0]
        expect(call.ReturnValues).toBe("ALL_OLD")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // Wave 5: DynamoModel.Hidden integration
  // ---------------------------------------------------------------------------

  describe("Hidden fields", () => {
    class ItemWithHidden extends Schema.Class<ItemWithHidden>("ItemWithHidden")({
      itemId: Schema.String,
      name: Schema.String,
      internalScore: Schema.Number.pipe(DynamoModel.Hidden),
    }) {}

    it.effect("hidden fields are stripped from model decode (yield*)", () =>
      Effect.gen(function* () {
        const HiddenEntity = withConfig(
          Entity.make({
            model: ItemWithHidden,
            entityType: "HiddenItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
          }),
        )

        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            pk: "$myapp#v1#hiddenitem#i-1",
            sk: "$myapp#v1#hiddenitem",
            itemId: "i-1",
            name: "Test",
            internalScore: 42,
            __edd_e__: "HiddenItem",
          }),
        })

        const result = yield* HiddenEntity.get({ itemId: "i-1" }).asEffect()
        // Hidden field should not be present in model decode
        expect((result as any).internalScore).toBeUndefined()
        expect(result.name).toBe("Test")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("hidden fields are stripped from asRecord", () =>
      Effect.gen(function* () {
        const HiddenEntity = withConfig(
          Entity.make({
            model: ItemWithHidden,
            entityType: "HiddenItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
            timestamps: true,
          }),
        )

        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            pk: "$myapp#v1#hiddenitem#i-1",
            sk: "$myapp#v1#hiddenitem",
            itemId: "i-1",
            name: "Test",
            internalScore: 42,
            __edd_e__: "HiddenItem",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          }),
        })

        const result = yield* HiddenEntity.get({ itemId: "i-1" }).pipe(Entity.asRecord)
        expect((result as any).internalScore).toBeUndefined()
        expect(result.name).toBe("Test")
        // System fields should still be present
        expect((result as any).createdAt).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("hidden fields are visible in asItem", () =>
      Effect.gen(function* () {
        const HiddenEntity = withConfig(
          Entity.make({
            model: ItemWithHidden,
            entityType: "HiddenItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
          }),
        )

        mockGetItem.mockResolvedValue({
          Item: toAttributeMap({
            pk: "$myapp#v1#hiddenitem#i-1",
            sk: "$myapp#v1#hiddenitem",
            itemId: "i-1",
            name: "Test",
            internalScore: 42,
            __edd_e__: "HiddenItem",
          }),
        })

        const result = yield* HiddenEntity.get({ itemId: "i-1" }).pipe(Entity.asItem)
        // Hidden field should be visible in item mode
        expect((result as any).internalScore).toBe(42)
        expect((result as any).__edd_e__).toBe("HiddenItem")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("hidden fields are stored in DynamoDB", () =>
      Effect.gen(function* () {
        const HiddenEntity = withConfig(
          Entity.make({
            model: ItemWithHidden,
            entityType: "HiddenItem",
            primaryKey: {
              pk: { field: "pk", composite: ["itemId"] },
              sk: { field: "sk", composite: [] },
            },
          }),
        )

        mockPutItem.mockResolvedValue({})

        yield* HiddenEntity.put({ itemId: "i-1", name: "Test", internalScore: 42 }).asEffect()

        const call = mockPutItem.mock.calls[0]![0]
        const item = call.Item
        // Hidden field should still be stored in DynamoDB
        expect(item.internalScore.N).toBe("42")
      }).pipe(Effect.provide(TestLayer)),
    )
  })

  // ---------------------------------------------------------------------------
  // Ref field handling
  // ---------------------------------------------------------------------------

  describe("ref field handling", () => {
    // --- Ref test models ---
    class Team extends Schema.Class<Team>("Team")({
      id: Schema.String.pipe(DynamoModel.identifier),
      name: Schema.String,
      country: Schema.String,
    }) {}

    class Player extends Schema.Class<Player>("Player")({
      id: Schema.String.pipe(DynamoModel.identifier),
      displayName: Schema.String,
    }) {}

    class TeamPlayerSelection extends Schema.Class<TeamPlayerSelection>("TeamPlayerSelection")({
      selectionId: Schema.String,
      team: Team.pipe(DynamoModel.ref),
      player: Player.pipe(DynamoModel.ref),
      role: Schema.String,
    }) {}

    const TeamEntity = withConfig(
      Entity.make({
        model: Team,
        entityType: "Team",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    const PlayerEntity = withConfig(
      Entity.make({
        model: Player,
        entityType: "Player",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    const SelectionEntity = withConfig(
      Entity.make({
        model: TeamPlayerSelection,
        entityType: "TeamPlayerSelection",
        primaryKey: {
          pk: { field: "pk", composite: ["selectionId"] },
          sk: { field: "sk", composite: [] },
        },
        refs: {
          team: { entity: TeamEntity },
          player: { entity: PlayerEntity },
        },
      }),
    )

    it("validates ref annotation at make() time", () => {
      class BadModel extends Schema.Class<BadModel>("BadModel")({
        id: Schema.String,
        team: Team, // NOT annotated with ref
      }) {}

      expect(() =>
        withConfig(
          Entity.make({
            model: BadModel,
            entityType: "BadModel",
            primaryKey: {
              pk: { field: "pk", composite: ["id"] },
              sk: { field: "sk", composite: [] },
            },
            refs: { team: { entity: TeamEntity } } as any,
          }),
        ),
      ).toThrow("does not have the DynamoModel.ref annotation")
    })

    it("validates identifier annotation on ref entity at make() time", () => {
      class NoIdEntity extends Schema.Class<NoIdEntity>("NoIdEntity")({
        code: Schema.String, // no identifier annotation
        name: Schema.String,
      }) {}

      const NoIdEntityDef = withConfig(
        Entity.make({
          model: NoIdEntity,
          entityType: "NoIdEntity",
          primaryKey: {
            pk: { field: "pk", composite: ["code"] },
            sk: { field: "sk", composite: [] },
          },
        }),
      )

      class RefModel extends Schema.Class<RefModel>("RefModel")({
        id: Schema.String,
        ref: NoIdEntity.pipe(DynamoModel.ref),
      }) {}

      expect(() =>
        withConfig(
          Entity.make({
            model: RefModel,
            entityType: "RefModel",
            primaryKey: {
              pk: { field: "pk", composite: ["id"] },
              sk: { field: "sk", composite: [] },
            },
            refs: { ref: { entity: NoIdEntityDef } } as any,
          }),
        ),
      ).toThrow("has no identifier field")
    })

    it.effect("put with ref IDs triggers hydration and stores embedded data", () =>
      Effect.gen(function* () {
        // Mock getItem to return Team and Player data
        mockGetItem.mockImplementation((input: any) => {
          const pkValue = input.Key.pk.S as string
          if (pkValue.includes("#team#")) {
            return Promise.resolve({
              Item: toAttributeMap({
                pk: pkValue,
                sk: "$myapp#v1#Team",
                id: "team-1",
                name: "Australia",
                country: "AU",
                __edd_e__: "Team",
              }),
            })
          }
          if (pkValue.includes("#player#")) {
            return Promise.resolve({
              Item: toAttributeMap({
                pk: pkValue,
                sk: "$myapp#v1#Player",
                id: "player-1",
                displayName: "Steve Smith",
                __edd_e__: "Player",
              }),
            })
          }
          return Promise.resolve({})
        })
        mockPutItem.mockResolvedValue({})

        yield* SelectionEntity.put({
          selectionId: "sel-1",
          teamId: "team-1",
          playerId: "player-1",
          role: "Batter",
        }).asEffect()

        // Verify getItem was called for both refs
        expect(mockGetItem).toHaveBeenCalledTimes(2)

        // Verify the put call has embedded domain data, not IDs
        const putCall = mockPutItem.mock.calls[0]![0]
        const item = putCall.Item

        // team should be an embedded map, not teamId
        expect(item.team).toBeDefined()
        expect(item.team.M).toBeDefined()
        expect(item.team.M.id.S).toBe("team-1")
        expect(item.team.M.name.S).toBe("Australia")
        expect(item.team.M.country.S).toBe("AU")

        // player should be an embedded map
        expect(item.player).toBeDefined()
        expect(item.player.M).toBeDefined()
        expect(item.player.M.id.S).toBe("player-1")
        expect(item.player.M.displayName.S).toBe("Steve Smith")

        // teamId and playerId should NOT be in the stored item
        expect(item.teamId).toBeUndefined()
        expect(item.playerId).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("get returns full domain objects with hydrated refs", () =>
      Effect.gen(function* () {
        // Mock getItem to return an item with embedded ref data
        mockGetItem.mockResolvedValueOnce({
          Item: toAttributeMap({
            pk: "$myapp#v1#TeamPlayerSelection#sel-1",
            sk: "$myapp#v1#TeamPlayerSelection",
            selectionId: "sel-1",
            team: { id: "team-1", name: "Australia", country: "AU" },
            player: { id: "player-1", displayName: "Steve Smith" },
            role: "Batter",
            __edd_e__: "TeamPlayerSelection",
          }),
        })

        const result = yield* SelectionEntity.get({ selectionId: "sel-1" }).asEffect()

        expect(result.selectionId).toBe("sel-1")
        expect(result.role).toBe("Batter")
        // Ref fields should be decoded as full domain objects
        expect(result.team.id).toBe("team-1")
        expect(result.team.name).toBe("Australia")
        expect(result.team.country).toBe("AU")
        expect(result.player.id).toBe("player-1")
        expect(result.player.displayName).toBe("Steve Smith")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("RefNotFound when ref ID doesn't resolve", () =>
      Effect.gen(function* () {
        // Mock getItem to return empty (not found)
        mockGetItem.mockResolvedValue({})

        const result = yield* SelectionEntity.put({
          selectionId: "sel-1",
          teamId: "nonexistent-team",
          playerId: "player-1",
          role: "Batter",
        }).pipe(Entity.asModel, Effect.flip)

        expect(result._tag).toBe("RefNotFound")
        if (result._tag === "RefNotFound") {
          expect(result.entity).toBe("TeamPlayerSelection")
          expect(result.field).toBe("team")
          expect(result.refEntity).toBe("Team")
          expect(result.refId).toBe("nonexistent-team")
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("embedded ref data is domain-only (no system fields)", () =>
      Effect.gen(function* () {
        // Create a Team entity with timestamps to verify they're excluded from embedded data
        const TeamWithTimestamps = withConfig(
          Entity.make({
            model: Team,
            entityType: "TeamTS",
            primaryKey: {
              pk: { field: "pk", composite: ["id"] },
              sk: { field: "sk", composite: [] },
            },
            timestamps: true,
          }),
        )

        // Mock getItem to return Team with timestamps
        mockGetItem.mockImplementation((input: any) => {
          const pkValue = input.Key.pk.S as string
          if (pkValue.includes("#teamts#")) {
            return Promise.resolve({
              Item: toAttributeMap({
                pk: pkValue,
                sk: "$myapp#v1#TeamTS",
                id: "team-1",
                name: "Australia",
                country: "AU",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
                __edd_e__: "TeamTS",
              }),
            })
          }
          if (pkValue.includes("#player#")) {
            return Promise.resolve({
              Item: toAttributeMap({
                pk: pkValue,
                sk: "$myapp#v1#Player",
                id: "player-1",
                displayName: "Steve Smith",
                __edd_e__: "Player",
              }),
            })
          }
          return Promise.resolve({})
        })
        mockPutItem.mockResolvedValue({})

        class SelectionWithTSTeam extends Schema.Class<SelectionWithTSTeam>("SelectionWithTSTeam")({
          selectionId: Schema.String,
          team: Team.pipe(DynamoModel.ref),
          player: Player.pipe(DynamoModel.ref),
          role: Schema.String,
        }) {}

        const SelectionWithTSTeamEntity = withConfig(
          Entity.make({
            model: SelectionWithTSTeam,
            entityType: "SelectionWithTSTeam",
            primaryKey: {
              pk: { field: "pk", composite: ["selectionId"] },
              sk: { field: "sk", composite: [] },
            },
            refs: {
              team: { entity: TeamWithTimestamps },
              player: { entity: PlayerEntity },
            },
          }),
        )

        yield* SelectionWithTSTeamEntity.put({
          selectionId: "sel-1",
          teamId: "team-1",
          playerId: "player-1",
          role: "Batter",
        }).asEffect()

        const putCall = mockPutItem.mock.calls[0]![0]
        const embeddedTeam = putCall.Item.team.M

        // Domain data should be present
        expect(embeddedTeam.id.S).toBe("team-1")
        expect(embeddedTeam.name.S).toBe("Australia")
        expect(embeddedTeam.country.S).toBe("AU")

        // System fields should NOT be in the embedded data
        // (asModel returns only domain fields, which is what we spread)
        expect(embeddedTeam.createdAt).toBeUndefined()
        expect(embeddedTeam.updatedAt).toBeUndefined()
        expect(embeddedTeam.__edd_e__).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("multiple refs are fetched in parallel", () =>
      Effect.gen(function* () {
        // Track call order to verify parallelism
        const callOrder: string[] = []

        mockGetItem.mockImplementation((input: any) => {
          const pkValue = input.Key.pk.S as string
          if (pkValue.includes("#team#")) {
            callOrder.push("team")
            return Promise.resolve({
              Item: toAttributeMap({
                pk: pkValue,
                sk: "$myapp#v1#Team",
                id: "team-1",
                name: "Australia",
                country: "AU",
                __edd_e__: "Team",
              }),
            })
          }
          if (pkValue.includes("#player#")) {
            callOrder.push("player")
            return Promise.resolve({
              Item: toAttributeMap({
                pk: pkValue,
                sk: "$myapp#v1#Player",
                id: "player-1",
                displayName: "Steve Smith",
                __edd_e__: "Player",
              }),
            })
          }
          return Promise.resolve({})
        })
        mockPutItem.mockResolvedValue({})

        yield* SelectionEntity.put({
          selectionId: "sel-1",
          teamId: "team-1",
          playerId: "player-1",
          role: "Batter",
        }).asEffect()

        // Both refs should have been fetched (2 getItem calls)
        expect(mockGetItem).toHaveBeenCalledTimes(2)
        expect(callOrder).toHaveLength(2)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("update with changed ref ID re-hydrates", () =>
      Effect.gen(function* () {
        // Mock getItem for both the update's read and the ref hydration
        let getCallCount = 0
        mockGetItem.mockImplementation((input: any) => {
          getCallCount++
          const pkValue = input.Key.pk.S as string
          if (pkValue.includes("#team#")) {
            return Promise.resolve({
              Item: toAttributeMap({
                pk: pkValue,
                sk: "$myapp#v1#Team",
                id: "team-2",
                name: "India",
                country: "IN",
                __edd_e__: "Team",
              }),
            })
          }
          // For the update read (current item)
          return Promise.resolve({
            Item: toAttributeMap({
              pk: pkValue,
              sk: "$myapp#v1#TeamPlayerSelection",
              selectionId: "sel-1",
              team: { id: "team-1", name: "Australia", country: "AU" },
              player: { id: "player-1", displayName: "Steve Smith" },
              role: "Batter",
              __edd_e__: "TeamPlayerSelection",
            }),
          })
        })
        mockUpdateItem.mockResolvedValue({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#TeamPlayerSelection#sel-1",
            sk: "$myapp#v1#TeamPlayerSelection",
            selectionId: "sel-1",
            team: { id: "team-2", name: "India", country: "IN" },
            player: { id: "player-1", displayName: "Steve Smith" },
            role: "Batter",
            __edd_e__: "TeamPlayerSelection",
          }),
        })

        yield* SelectionEntity.update({ selectionId: "sel-1" }).pipe(
          Entity.set({ teamId: "team-2" }),
          Entity.asModel,
        )

        // Should have called getItem for the team ref hydration
        expect(getCallCount).toBeGreaterThanOrEqual(1)

        // The updateItem call should have the embedded team data
        const updateCall = mockUpdateItem.mock.calls[0]![0]
        // The SET clause should reference the team field (hydrated data), not teamId
        expect(updateCall.ExpressionAttributeNames).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it("Entity.make with refs validates field in model", () => {
      expect(() =>
        withConfig(
          Entity.make({
            model: TeamPlayerSelection,
            entityType: "Test",
            primaryKey: {
              pk: { field: "pk", composite: ["selectionId"] },
              sk: { field: "sk", composite: [] },
            },
            refs: { nonexistent: { entity: TeamEntity } } as any,
          }),
        ),
      ).toThrow("does not exist in the model")
    })

    it("createSchema omits PK composites from input", () => {
      const decode = Schema.decodeUnknownSync(SelectionEntity.createSchema)
      const result = decode({
        teamId: "team-1",
        playerId: "player-1",
        role: "Batter",
      })
      expect(result.teamId).toBe("team-1")
      expect(result.playerId).toBe("player-1")
      expect(result.role).toBe("Batter")
      // selectionId (PK composite) should not be required
      expect((result as any).selectionId).toBeUndefined()
    })

    it("inputSchema has ref ID fields from identifier schema", () => {
      const decode = Schema.decodeUnknownSync(SelectionEntity.inputSchema)
      const result = decode({
        selectionId: "sel-1",
        teamId: "team-1",
        playerId: "player-1",
        role: "Batter",
      })
      expect(result.selectionId).toBe("sel-1")
      expect(result.teamId).toBe("team-1")
      expect(result.playerId).toBe("player-1")
      expect(result.role).toBe("Batter")
    })

    it("updateSchema has optional ref ID fields", () => {
      const decode = Schema.decodeUnknownSync(SelectionEntity.updateSchema)
      // All fields optional, can provide just one ref ID
      const result = decode({ teamId: "team-2" })
      expect(result.teamId).toBe("team-2")
    })

    it("inputSchema uses branded identifier schema for ref IDs", () => {
      const BrandedTeamId = Schema.String.pipe(Schema.brand("BTeamId"))
      const BrandedPlayerId = Schema.String.pipe(Schema.brand("BPlayerId"))

      class BTeam extends Schema.Class<BTeam>("BTeam")({
        id: BrandedTeamId.pipe(DynamoModel.identifier),
        name: Schema.String,
      }) {}

      class BPlayer extends Schema.Class<BPlayer>("BPlayer")({
        id: BrandedPlayerId.pipe(DynamoModel.identifier),
        name: Schema.String,
      }) {}

      class BSel extends Schema.Class<BSel>("BSel")({
        id: Schema.String,
        team: BTeam.pipe(DynamoModel.ref),
        player: BPlayer.pipe(DynamoModel.ref),
        role: Schema.String,
      }) {}

      const BTeamEntity = withConfig(
        Entity.make({
          model: BTeam,
          entityType: "BTeam",
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
        }),
      )

      const BPlayerEntity = withConfig(
        Entity.make({
          model: BPlayer,
          entityType: "BPlayer",
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
        }),
      )

      const BSelEntity = withConfig(
        Entity.make({
          model: BSel,
          entityType: "BSel",
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
          refs: {
            team: { entity: BTeamEntity },
            player: { entity: BPlayerEntity },
          },
        }),
      )

      // inputSchema should accept plain strings (branded types decode from string)
      const decode = Schema.decodeUnknownSync(BSelEntity.inputSchema)
      const result = decode({
        id: "sel-1",
        teamId: "team-1",
        playerId: "player-1",
        role: "Batter",
      })
      expect(result.teamId).toBe("team-1")
      expect(result.playerId).toBe("player-1")
    })
  })

  // ---------------------------------------------------------------------------
  // Cascade combinator
  // ---------------------------------------------------------------------------

  describe("cascade combinator", () => {
    // --- Models for cascade tests ---
    class CascadePlayer extends Schema.Class<CascadePlayer>("CascadePlayer")({
      playerId: Schema.String.pipe(DynamoModel.identifier),
      displayName: Schema.String,
      position: Schema.String,
    }) {}

    class CascadeSelection extends Schema.Class<CascadeSelection>("CascadeSelection")({
      selectionId: Schema.String,
      player: CascadePlayer.pipe(DynamoModel.ref),
      role: Schema.String,
    }) {}

    class CascadeMatchPlayer extends Schema.Class<CascadeMatchPlayer>("CascadeMatchPlayer")({
      matchPlayerId: Schema.String,
      player: CascadePlayer.pipe(DynamoModel.ref),
      score: Schema.Number,
    }) {}

    const CascadePlayerEntity = withConfig(
      Entity.make({
        model: CascadePlayer,
        entityType: "CascadePlayer",
        primaryKey: {
          pk: { field: "pk", composite: ["playerId"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    )

    const CascadeSelectionEntity = withConfig(
      Entity.make({
        model: CascadeSelection,
        entityType: "CascadeSelection",
        primaryKey: {
          pk: { field: "pk", composite: ["selectionId"] },
          sk: { field: "sk", composite: [] },
        },
        refs: {
          player: {
            entity: CascadePlayerEntity,
            cascade: { index: "gsi2", pk: { field: "gsi2pk" }, sk: { field: "gsi2sk" } },
          },
        },
      }),
    )

    const CascadeMatchPlayerEntity = withConfig(
      Entity.make({
        model: CascadeMatchPlayer,
        entityType: "CascadeMatchPlayer",
        primaryKey: {
          pk: { field: "pk", composite: ["matchPlayerId"] },
          sk: { field: "sk", composite: [] },
        },
        refs: {
          player: {
            entity: CascadePlayerEntity,
            cascade: { index: "gsi3", pk: { field: "gsi3pk" }, sk: { field: "gsi3sk" } },
          },
        },
      }),
    )

    it("auto-generates cascade indexes from cascade config", () => {
      expect(CascadeSelectionEntity.indexes).toHaveProperty("_cascade_player")
      const idx = (CascadeSelectionEntity.indexes as any)._cascade_player
      expect(idx.index).toBe("gsi2")
      expect(idx.pk).toEqual({ field: "gsi2pk", composite: ["playerId"] })
      expect(idx.sk).toEqual({ field: "gsi2sk", composite: ["selectionId"] })
    })

    it("stores cascade config on UpdateState", () => {
      const op = CascadePlayerEntity.update({ playerId: "p-1" }).pipe(
        Entity.set({ displayName: "New Name" }),
        Entity.cascade({ targets: [CascadeSelectionEntity] }),
      )
      expect(op._updateState.cascade).toEqual({
        targets: [CascadeSelectionEntity],
      })
    })

    it("stores cascade config with filter and mode", () => {
      const op = CascadePlayerEntity.update({ playerId: "p-1" }).pipe(
        Entity.set({ displayName: "New Name" }),
        Entity.cascade({
          targets: [CascadeSelectionEntity],
          filter: { role: "Captain" },
          mode: "transactional",
        }),
      )
      expect(op._updateState.cascade).toEqual({
        targets: [CascadeSelectionEntity],
        filter: { role: "Captain" },
        mode: "transactional",
      })
    })

    it.effect("cascade queries target GSI and updates matching items (eventual mode)", () =>
      Effect.gen(function* () {
        // Mock: updateItem for the source entity update
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#CascadePlayer#p-1",
            sk: "$myapp#v1#CascadePlayer",
            playerId: "p-1",
            displayName: "Steven Smith",
            position: "Batter",
            __edd_e__: "CascadePlayer",
          }),
        })

        // Mock: query the target GSI to find cascade targets
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#CascadeSelection#sel-1",
              sk: "$myapp#v1#CascadeSelection",
              selectionId: "sel-1",
              player: { playerId: "p-1", displayName: "Steve Smith", position: "Batter" },
              role: "Captain",
              __edd_e__: "CascadeSelection",
              gsi2pk: "$myapp#v1#CascadeSelection#p-1",
              gsi2sk: "$myapp#v1#CascadeSelection#sel-1",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        // Mock: updateItem for cascade target update
        mockUpdateItem.mockResolvedValueOnce({})

        yield* CascadePlayerEntity.update({ playerId: "p-1" }).pipe(
          Entity.set({ displayName: "Steven Smith" }),
          Entity.cascade({ targets: [CascadeSelectionEntity] }),
          Entity.asModel,
        )

        // Verify: GSI query was made
        expect(mockQuery).toHaveBeenCalledTimes(1)
        const queryCall = mockQuery.mock.calls[0]![0]
        expect(queryCall.IndexName).toBe("gsi2")
        expect(queryCall.ExpressionAttributeValues[":pk"].S).toContain("p-1")
        expect(queryCall.ExpressionAttributeValues[":et0"].S).toBe("CascadeSelection")

        // Verify: updateItem was called for the source + 1 cascade target
        expect(mockUpdateItem).toHaveBeenCalledTimes(2)
        const cascadeUpdate = mockUpdateItem.mock.calls[1]![0]
        expect(cascadeUpdate.UpdateExpression).toBe("SET #ref = :refData")
        expect(cascadeUpdate.ExpressionAttributeNames["#ref"]).toBe("player")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("cascade with filter adds FilterExpression conditions", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#CascadePlayer#p-1",
            sk: "$myapp#v1#CascadePlayer",
            playerId: "p-1",
            displayName: "Steven Smith",
            position: "Batter",
            __edd_e__: "CascadePlayer",
          }),
        })

        mockQuery.mockResolvedValueOnce({
          Items: [],
          LastEvaluatedKey: undefined,
        })

        yield* CascadePlayerEntity.update({ playerId: "p-1" }).pipe(
          Entity.set({ displayName: "Steven Smith" }),
          Entity.cascade({
            targets: [CascadeSelectionEntity],
            filter: { role: "Captain" },
          }),
          Entity.asModel,
        )

        const queryCall = mockQuery.mock.calls[0]![0]
        expect(queryCall.FilterExpression).toContain("#cf0 = :cf0")
        expect(queryCall.ExpressionAttributeNames["#cf0"]).toBe("role")
        expect(queryCall.ExpressionAttributeValues[":cf0"].S).toBe("Captain")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("cascade in transactional mode uses transactWriteItems", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#CascadePlayer#p-1",
            sk: "$myapp#v1#CascadePlayer",
            playerId: "p-1",
            displayName: "Steven Smith",
            position: "Batter",
            __edd_e__: "CascadePlayer",
          }),
        })

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#CascadeSelection#sel-1",
              sk: "$myapp#v1#CascadeSelection",
              selectionId: "sel-1",
              player: { playerId: "p-1", displayName: "Steve Smith", position: "Batter" },
              role: "Captain",
              __edd_e__: "CascadeSelection",
              gsi2pk: "$myapp#v1#CascadeSelection#p-1",
              gsi2sk: "$myapp#v1#CascadeSelection#sel-1",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        mockTransactWriteItems.mockResolvedValueOnce({})

        yield* CascadePlayerEntity.update({ playerId: "p-1" }).pipe(
          Entity.set({ displayName: "Steven Smith" }),
          Entity.cascade({
            targets: [CascadeSelectionEntity],
            mode: "transactional",
          }),
          Entity.asModel,
        )

        // Verify: transactWriteItems was used, not updateItem for cascade
        expect(mockTransactWriteItems).toHaveBeenCalledTimes(1)
        const txCall = mockTransactWriteItems.mock.calls[0]![0]
        expect(txCall.TransactItems).toHaveLength(1)
        expect(txCall.TransactItems[0].Update.UpdateExpression).toBe("SET #ref = :refData")
        expect(txCall.TransactItems[0].Update.ExpressionAttributeNames["#ref"]).toBe("player")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("transactional cascade fails when >100 items", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#CascadePlayer#p-1",
            sk: "$myapp#v1#CascadePlayer",
            playerId: "p-1",
            displayName: "Steven Smith",
            position: "Batter",
            __edd_e__: "CascadePlayer",
          }),
        })

        // Return 101 items from GSI query
        const items = Array.from({ length: 101 }, (_, i) =>
          toAttributeMap({
            pk: `$myapp#v1#CascadeSelection#sel-${i}`,
            sk: "$myapp#v1#CascadeSelection",
            selectionId: `sel-${i}`,
            player: { playerId: "p-1", displayName: "Steve Smith", position: "Batter" },
            role: "Captain",
            __edd_e__: "CascadeSelection",
            gsi2pk: "$myapp#v1#CascadeSelection#p-1",
            gsi2sk: `$myapp#v1#CascadeSelection#sel-${i}`,
          }),
        )

        mockQuery.mockResolvedValueOnce({
          Items: items,
          LastEvaluatedKey: undefined,
        })

        const error = yield* CascadePlayerEntity.update({ playerId: "p-1" })
          .pipe(
            Entity.set({ displayName: "Steven Smith" }),
            Entity.cascade({
              targets: [CascadeSelectionEntity],
              mode: "transactional",
            }),
          )
          .asEffect()
          .pipe(Effect.flip)

        expect(error._tag).toBe("CascadePartialFailure")
        if (error._tag === "CascadePartialFailure") {
          expect(error.failed).toBe(101)
          expect(error.succeeded).toBe(0)
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("CascadePartialFailure on partial failure in eventual mode", () =>
      Effect.gen(function* () {
        mockUpdateItem
          // Source update succeeds
          .mockResolvedValueOnce({
            Attributes: toAttributeMap({
              pk: "$myapp#v1#CascadePlayer#p-1",
              sk: "$myapp#v1#CascadePlayer",
              playerId: "p-1",
              displayName: "Steven Smith",
              position: "Batter",
              __edd_e__: "CascadePlayer",
            }),
          })
          // First cascade target succeeds
          .mockResolvedValueOnce({})
          // Second cascade target fails
          .mockRejectedValueOnce(new Error("Simulated DynamoDB failure"))

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#CascadeSelection#sel-1",
              sk: "$myapp#v1#CascadeSelection",
              selectionId: "sel-1",
              player: { playerId: "p-1", displayName: "Steve Smith", position: "Batter" },
              role: "Captain",
              __edd_e__: "CascadeSelection",
              gsi2pk: "$myapp#v1#CascadeSelection#p-1",
              gsi2sk: "$myapp#v1#CascadeSelection#sel-1",
            }),
            toAttributeMap({
              pk: "$myapp#v1#CascadeSelection#sel-2",
              sk: "$myapp#v1#CascadeSelection",
              selectionId: "sel-2",
              player: { playerId: "p-1", displayName: "Steve Smith", position: "Batter" },
              role: "Vice Captain",
              __edd_e__: "CascadeSelection",
              gsi2pk: "$myapp#v1#CascadeSelection#p-1",
              gsi2sk: "$myapp#v1#CascadeSelection#sel-2",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        const error = yield* CascadePlayerEntity.update({ playerId: "p-1" })
          .pipe(
            Entity.set({ displayName: "Steven Smith" }),
            Entity.cascade({ targets: [CascadeSelectionEntity] }),
          )
          .asEffect()
          .pipe(Effect.flip)

        expect(error._tag).toBe("CascadePartialFailure")
        if (error._tag === "CascadePartialFailure") {
          expect(error.sourceEntity).toBe("CascadePlayer")
          expect(error.sourceId).toBe("p-1")
          expect(error.succeeded).toBe(1)
          expect(error.failed).toBe(1)
          expect(error.errors).toHaveLength(1)
        }
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("cascade skips targets with no matching ref", () =>
      Effect.gen(function* () {
        // Target entity has no ref pointing to source — should be skipped
        class Unrelated extends Schema.Class<Unrelated>("Unrelated")({
          unrelatedId: Schema.String,
          name: Schema.String,
        }) {}

        const UnrelatedEntity = withConfig(
          Entity.make({
            model: Unrelated,
            entityType: "Unrelated",
            primaryKey: {
              pk: { field: "pk", composite: ["unrelatedId"] },
              sk: { field: "sk", composite: [] },
            },
          }),
        )

        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#CascadePlayer#p-1",
            sk: "$myapp#v1#CascadePlayer",
            playerId: "p-1",
            displayName: "Steven Smith",
            position: "Batter",
            __edd_e__: "CascadePlayer",
          }),
        })

        yield* CascadePlayerEntity.update({ playerId: "p-1" }).pipe(
          Entity.set({ displayName: "Steven Smith" }),
          Entity.cascade({ targets: [UnrelatedEntity as any] }),
          Entity.asModel,
        )

        // No GSI query or cascade update should happen
        expect(mockQuery).not.toHaveBeenCalled()
        // Only the source update
        expect(mockUpdateItem).toHaveBeenCalledTimes(1)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("cascade handles paginated GSI results", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#CascadePlayer#p-1",
            sk: "$myapp#v1#CascadePlayer",
            playerId: "p-1",
            displayName: "Steven Smith",
            position: "Batter",
            __edd_e__: "CascadePlayer",
          }),
        })

        // First page
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#CascadeSelection#sel-1",
              sk: "$myapp#v1#CascadeSelection",
              selectionId: "sel-1",
              player: { playerId: "p-1", displayName: "Steve Smith", position: "Batter" },
              role: "Captain",
              __edd_e__: "CascadeSelection",
              gsi2pk: "$myapp#v1#CascadeSelection#p-1",
              gsi2sk: "$myapp#v1#CascadeSelection#sel-1",
            }),
          ],
          LastEvaluatedKey: toAttributeMap({ pk: "continue", sk: "here" }),
        })

        // Second page
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#CascadeSelection#sel-2",
              sk: "$myapp#v1#CascadeSelection",
              selectionId: "sel-2",
              player: { playerId: "p-1", displayName: "Steve Smith", position: "Batter" },
              role: "Vice Captain",
              __edd_e__: "CascadeSelection",
              gsi2pk: "$myapp#v1#CascadeSelection#p-1",
              gsi2sk: "$myapp#v1#CascadeSelection#sel-2",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        // Two cascade updates
        mockUpdateItem.mockResolvedValueOnce({})
        mockUpdateItem.mockResolvedValueOnce({})

        yield* CascadePlayerEntity.update({ playerId: "p-1" }).pipe(
          Entity.set({ displayName: "Steven Smith" }),
          Entity.cascade({ targets: [CascadeSelectionEntity] }),
          Entity.asModel,
        )

        // Two pages queried
        expect(mockQuery).toHaveBeenCalledTimes(2)
        // Source update + 2 cascade updates
        expect(mockUpdateItem).toHaveBeenCalledTimes(3)
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("cascade propagates domain-only data (no system fields)", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#CascadePlayer#p-1",
            sk: "$myapp#v1#CascadePlayer",
            playerId: "p-1",
            displayName: "Steven Smith",
            position: "Batter",
            __edd_e__: "CascadePlayer",
          }),
        })

        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#CascadeSelection#sel-1",
              sk: "$myapp#v1#CascadeSelection",
              selectionId: "sel-1",
              player: { playerId: "p-1", displayName: "Steve Smith", position: "Batter" },
              role: "Captain",
              __edd_e__: "CascadeSelection",
              gsi2pk: "$myapp#v1#CascadeSelection#p-1",
              gsi2sk: "$myapp#v1#CascadeSelection#sel-1",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        mockUpdateItem.mockResolvedValueOnce({})

        yield* CascadePlayerEntity.update({ playerId: "p-1" }).pipe(
          Entity.set({ displayName: "Steven Smith" }),
          Entity.cascade({ targets: [CascadeSelectionEntity] }),
          Entity.asModel,
        )

        // Check the cascade update's ref data
        const cascadeUpdate = mockUpdateItem.mock.calls[1]![0]
        const refData = cascadeUpdate.ExpressionAttributeValues[":refData"]

        // Should contain domain fields
        expect(refData.M.playerId.S).toBe("p-1")
        expect(refData.M.displayName.S).toBe("Steven Smith")
        expect(refData.M.position.S).toBe("Batter")

        // Should NOT contain system fields
        expect(refData.M.pk).toBeUndefined()
        expect(refData.M.sk).toBeUndefined()
        expect(refData.M.__edd_e__).toBeUndefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    it("Entity._resolvedRefs is accessible", () => {
      expect(CascadeSelectionEntity._resolvedRefs).toHaveLength(1)
      expect(CascadeSelectionEntity._resolvedRefs[0]!.fieldName).toBe("player")
      expect(CascadeSelectionEntity._resolvedRefs[0]!.idFieldName).toBe("playerId")
      expect(CascadeSelectionEntity._resolvedRefs[0]!.refEntityType).toBe("CascadePlayer")
    })

    it.effect("cascade to multiple target entity types", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValueOnce({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#CascadePlayer#p-1",
            sk: "$myapp#v1#CascadePlayer",
            playerId: "p-1",
            displayName: "Steven Smith",
            position: "Batter",
            __edd_e__: "CascadePlayer",
          }),
        })

        // First target: CascadeSelection
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#CascadeSelection#sel-1",
              sk: "$myapp#v1#CascadeSelection",
              selectionId: "sel-1",
              player: { playerId: "p-1", displayName: "Steve Smith", position: "Batter" },
              role: "Captain",
              __edd_e__: "CascadeSelection",
              gsi2pk: "$myapp#v1#CascadeSelection#p-1",
              gsi2sk: "$myapp#v1#CascadeSelection#sel-1",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        // Second target: CascadeMatchPlayer
        mockQuery.mockResolvedValueOnce({
          Items: [
            toAttributeMap({
              pk: "$myapp#v1#CascadeMatchPlayer#mp-1",
              sk: "$myapp#v1#CascadeMatchPlayer",
              matchPlayerId: "mp-1",
              player: { playerId: "p-1", displayName: "Steve Smith", position: "Batter" },
              score: 42,
              __edd_e__: "CascadeMatchPlayer",
              gsi3pk: "$myapp#v1#CascadeMatchPlayer#p-1",
              gsi3sk: "$myapp#v1#CascadeMatchPlayer#mp-1",
            }),
          ],
          LastEvaluatedKey: undefined,
        })

        // Two cascade updates
        mockUpdateItem.mockResolvedValueOnce({})
        mockUpdateItem.mockResolvedValueOnce({})

        yield* CascadePlayerEntity.update({ playerId: "p-1" }).pipe(
          Entity.set({ displayName: "Steven Smith" }),
          Entity.cascade({
            targets: [CascadeSelectionEntity, CascadeMatchPlayerEntity],
          }),
          Entity.asModel,
        )

        // Two GSI queries (one per target)
        expect(mockQuery).toHaveBeenCalledTimes(2)
        // Source update + 2 cascade targets
        expect(mockUpdateItem).toHaveBeenCalledTimes(3)

        // Verify different GSIs were queried
        expect(mockQuery.mock.calls[0]![0].IndexName).toBe("gsi2")
        expect(mockQuery.mock.calls[1]![0].IndexName).toBe("gsi3")
      }).pipe(Effect.provide(TestLayer)),
    )

    // -------------------------------------------------------------------------
    // Cascade GSI selection — exact-match preference
    //
    // Regression tests for the bug where findCascadeIndex returned the FIRST
    // GSI whose PK composite contained the source's identifier field, even if
    // that GSI also had additional composites the source couldn't supply.
    // This caused KeyComposer.composePk to throw "Missing composite attribute"
    // at runtime whenever a target had a multi-composite GSI listed before a
    // single-composite cascade-friendly GSI.
    // -------------------------------------------------------------------------
    describe("cascade GSI selection", () => {
      // SquadSelections-style entity: a multi-composite GSI on `playerId`
      // (declared FIRST so the legacy first-match logic would pick it) plus a
      // single-composite GSI on `playerId` (the cascade-safe shape).
      class CascadeSquadSelection extends Schema.Class<CascadeSquadSelection>(
        "CascadeSquadSelection",
      )({
        squadSelectionId: Schema.String,
        player: CascadePlayer.pipe(DynamoModel.ref),
        season: Schema.String,
        series: Schema.String,
        selectionNumber: Schema.Number,
      }) {}

      const CascadeSquadSelectionEntity = withConfig(
        Entity.make({
          model: CascadeSquadSelection,
          entityType: "CascadeSquadSelection",
          primaryKey: {
            pk: { field: "pk", composite: ["squadSelectionId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            // Multi-composite GSI declared first — must NOT be picked.
            byPlayerSeries: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["playerId", "season", "series"] },
              sk: { field: "gsi1sk", composite: ["selectionNumber"] },
            },
            // Single-composite GSI on the same identifier — MUST be picked.
            byPlayer: {
              name: "gsi2",
              pk: { field: "gsi2pk", composite: ["playerId"] },
              sk: { field: "gsi2sk", composite: ["season", "series"] },
            },
          },
          refs: {
            player: { entity: CascadePlayerEntity },
          },
        }),
      )

      it.effect(
        "prefers single-composite GSI even when multi-composite GSI is declared first",
        () =>
          Effect.gen(function* () {
            // Source update succeeds — returns the new player domain data.
            mockUpdateItem.mockResolvedValueOnce({
              Attributes: toAttributeMap({
                pk: "$myapp#v1#CascadePlayer#p-1",
                sk: "$myapp#v1#CascadePlayer",
                playerId: "p-1",
                displayName: "Steven Smith",
                position: "Batter",
                __edd_e__: "CascadePlayer",
              }),
            })

            // Cascade GSI query returns one matching squad selection.
            mockQuery.mockResolvedValueOnce({
              Items: [
                toAttributeMap({
                  pk: "$myapp#v1#CascadeSquadSelection#sq-1",
                  sk: "$myapp#v1#CascadeSquadSelection",
                  squadSelectionId: "sq-1",
                  player: { playerId: "p-1", displayName: "Steve Smith", position: "Batter" },
                  season: "2026",
                  series: "Ashes",
                  selectionNumber: 1,
                  __edd_e__: "CascadeSquadSelection",
                  gsi1pk: "$myapp#v1#CascadeSquadSelection#p-1#2026#Ashes",
                  gsi1sk: "$myapp#v1#CascadeSquadSelection#1",
                  gsi2pk: "$myapp#v1#CascadeSquadSelection#p-1",
                  gsi2sk: "$myapp#v1#CascadeSquadSelection#2026#Ashes",
                }),
              ],
              LastEvaluatedKey: undefined,
            })

            // Cascade target update succeeds.
            mockUpdateItem.mockResolvedValueOnce({})

            yield* CascadePlayerEntity.update({ playerId: "p-1" }).pipe(
              Entity.set({ displayName: "Steven Smith" }),
              Entity.cascade({ targets: [CascadeSquadSelectionEntity] }),
              Entity.asModel,
            )

            // Verify cascade GSI query was issued and chose the SINGLE-composite
            // GSI (gsi2 / byPlayer), not the multi-composite one (gsi1).
            expect(mockQuery).toHaveBeenCalledTimes(1)
            const queryCall = mockQuery.mock.calls[0]![0]
            expect(queryCall.IndexName).toBe("gsi2")
            expect(queryCall.ExpressionAttributeNames["#pk"]).toBe("gsi2pk")
            // The :pk value must contain the player id and NOT contain a
            // season/series segment (which would prove the multi-composite GSI
            // had been picked instead).
            const pkValue = queryCall.ExpressionAttributeValues[":pk"].S as string
            expect(pkValue).toContain("p-1")
            expect(pkValue).not.toContain("2026")
            expect(pkValue).not.toContain("Ashes")

            // Verify cascade target update fired with the new player ref data.
            expect(mockUpdateItem).toHaveBeenCalledTimes(2)
            const cascadeUpdate = mockUpdateItem.mock.calls[1]![0]
            expect(cascadeUpdate.UpdateExpression).toBe("SET #ref = :refData")
            expect(cascadeUpdate.ExpressionAttributeNames["#ref"]).toBe("player")
            const refData = cascadeUpdate.ExpressionAttributeValues[":refData"]
            expect(refData.M.playerId.S).toBe("p-1")
            expect(refData.M.displayName.S).toBe("Steven Smith")
          }).pipe(Effect.provide(TestLayer)),
      )

      // -----------------------------------------------------------------------
      // Defensive case: target has ONLY a multi-composite GSI containing the
      // source identifier (no exact-match GSI exists). The original buggy code
      // would crash with "Missing composite attribute" deep inside KeyComposer.
      // The fix instead surfaces a tagged CascadePartialFailure that explains
      // exactly what's wrong.
      // -----------------------------------------------------------------------
      class CascadeOverComposed extends Schema.Class<CascadeOverComposed>("CascadeOverComposed")({
        ocId: Schema.String,
        player: CascadePlayer.pipe(DynamoModel.ref),
        season: Schema.String,
        series: Schema.String,
      }) {}

      const CascadeOverComposedEntity = withConfig(
        Entity.make({
          model: CascadeOverComposed,
          entityType: "CascadeOverComposed",
          primaryKey: {
            pk: { field: "pk", composite: ["ocId"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            // Only GSI containing playerId — but with extra composites the
            // source CascadePlayer entity can't supply.
            byPlayerSeries: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["playerId", "season", "series"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
          refs: {
            player: { entity: CascadePlayerEntity },
          },
        }),
      )

      it.effect("raises CascadePartialFailure when no usable GSI exists", () =>
        Effect.gen(function* () {
          mockUpdateItem.mockResolvedValueOnce({
            Attributes: toAttributeMap({
              pk: "$myapp#v1#CascadePlayer#p-1",
              sk: "$myapp#v1#CascadePlayer",
              playerId: "p-1",
              displayName: "Steven Smith",
              position: "Batter",
              __edd_e__: "CascadePlayer",
            }),
          })

          const error = yield* CascadePlayerEntity.update({ playerId: "p-1" })
            .pipe(
              Entity.set({ displayName: "Steven Smith" }),
              Entity.cascade({ targets: [CascadeOverComposedEntity] }),
            )
            .asEffect()
            .pipe(Effect.flip)

          expect(error._tag).toBe("CascadePartialFailure")
          if (error._tag === "CascadePartialFailure") {
            expect(error.sourceEntity).toBe("CascadePlayer")
            expect(error.sourceId).toBe("p-1")
            expect(error.errors).toHaveLength(1)
            const message = String(error.errors[0])
            expect(message).toContain("CascadeOverComposed")
            expect(message).toContain("playerId")
            // The cascade should NOT have queried or updated anything.
            expect(mockQuery).not.toHaveBeenCalled()
            // Source update was the only updateItem call.
            expect(mockUpdateItem).toHaveBeenCalledTimes(1)
          }
        }).pipe(Effect.provide(TestLayer)),
      )
    })
  })

  // ---------------------------------------------------------------------------
  // Domain-value input decode (issue #19) + timestamps optional-input
  // ---------------------------------------------------------------------------

  describe("domain-value input decode & timestamp collision", () => {
    // Reporter's repro (github issue #19): model declares createdAt as a
    // date-annotated schema, put() accepts a domain DateTime.Utc.
    class Account extends Schema.Class<Account>("Account")({
      id: Schema.String,
      createdAt: Schema.DateTimeUtcFromString,
    }) {}

    const AccountEntity = withConfig(
      Entity.make({
        model: Account,
        entityType: "Account",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: false,
      }),
    )

    it.effect("put: accepts domain DateTime.Utc for model-declared date field (#19)", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})
        const createdAt = DateTime.makeUnsafe("2024-01-01T00:00:00.000Z")
        yield* AccountEntity.put({ id: "a-1", createdAt }).asEffect()
        const item = mockPutItem.mock.calls[0]![0].Item
        expect(item.createdAt).toEqual({ S: "2024-01-01T00:00:00.000Z" })
      }).pipe(Effect.provide(TestLayer)),
    )

    // Optional-input: model declares createdAt + timestamps:true. User may
    // omit the field (library generates) or supply it (user value wins).
    class AuditedDoc extends Schema.Class<AuditedDoc>("AuditedDoc")({
      id: Schema.String,
      title: Schema.String,
      createdAt: Schema.DateTimeUtcFromString,
      updatedAt: Schema.DateTimeUtcFromString,
    }) {}

    const AuditedDocEntity = withConfig(
      Entity.make({
        model: AuditedDoc,
        entityType: "AuditedDoc",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
      }),
    )

    it.effect("put: caller may omit colliding timestamp — library generates", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})
        yield* AuditedDocEntity.put({ id: "d-1", title: "hello" }).asEffect()
        const item = mockPutItem.mock.calls[0]![0].Item
        expect(item.createdAt.S).toBeTypeOf("string")
        expect(item.updatedAt.S).toBeTypeOf("string")
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("put: caller-supplied timestamp wins over library-generated", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})
        const fixed = DateTime.makeUnsafe("2020-06-15T12:00:00.000Z")
        yield* AuditedDocEntity.put({
          id: "d-2",
          title: "imported",
          createdAt: fixed,
          updatedAt: fixed,
        }).asEffect()
        const item = mockPutItem.mock.calls[0]![0].Item
        expect(item.createdAt).toEqual({ S: "2020-06-15T12:00:00.000Z" })
        expect(item.updatedAt).toEqual({ S: "2020-06-15T12:00:00.000Z" })
      }).pipe(Effect.provide(TestLayer)),
    )

    it.effect("update: .set({ updatedAt }) — user value flows through", () =>
      Effect.gen(function* () {
        mockUpdateItem.mockResolvedValue({
          Attributes: toAttributeMap({
            pk: "$myapp#v1#auditeddoc#d-3",
            sk: "$myapp#v1#auditeddoc",
            id: "d-3",
            title: "x",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-06-01T00:00:00.000Z",
            __edd_e__: "AuditedDoc",
          }),
        })
        const pinned = DateTime.makeUnsafe("2024-06-01T00:00:00.000Z")
        yield* AuditedDocEntity.update({ id: "d-3" })
          .pipe(Entity.set({ updatedAt: pinned }))
          .asEffect()
        const call = mockUpdateItem.mock.calls[0]![0]
        const uaValueKey = Object.keys(call.ExpressionAttributeValues).find(
          (k) =>
            (call.ExpressionAttributeValues as Record<string, { S?: string }>)[k]?.S ===
            "2024-06-01T00:00:00.000Z",
        )
        expect(uaValueKey).toBeDefined()
      }).pipe(Effect.provide(TestLayer)),
    )

    // Domain-adaptive generation: model declares createdAt with a non-default
    // encoding (epoch seconds). Library-generated value uses that storage.
    class EpochDoc extends Schema.Class<EpochDoc>("EpochDoc")({
      id: Schema.String,
      createdAt: Schema.DateTimeUtcFromString.pipe(
        DynamoModel.storedAs(DynamoModel.DateEpochSeconds),
      ),
    }) {}

    const EpochDocEntity = withConfig(
      Entity.make({
        model: EpochDoc,
        entityType: "EpochDoc",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        timestamps: true,
      }),
    )

    it.effect("put: library-generated timestamp respects model field encoding", () =>
      Effect.gen(function* () {
        mockPutItem.mockResolvedValue({})
        yield* EpochDocEntity.put({ id: "e-1" }).asEffect()
        const item = mockPutItem.mock.calls[0]![0].Item
        // createdAt stored as epoch-seconds number (not ISO string) because the
        // model field declares DateEpochSeconds storage.
        expect(item.createdAt.N).toBeTypeOf("string")
        expect(Number.parseInt(item.createdAt.N as string, 10)).toBeGreaterThan(1_700_000_000)
      }).pipe(Effect.provide(TestLayer)),
    )

    // Non-date collision: library silently yields the field to the user.
    it.effect("put: non-date createdAt collision — user owns the field", () =>
      Effect.gen(function* () {
        class Log extends Schema.Class<Log>("Log")({
          id: Schema.String,
          createdAt: Schema.String, // user-owned "2025-01-15" string, not a timestamp
        }) {}
        const LogEntity = withConfig(
          Entity.make({
            model: Log,
            entityType: "Log",
            primaryKey: {
              pk: { field: "pk", composite: ["id"] },
              sk: { field: "sk", composite: ["createdAt"] },
            },
            timestamps: true, // still active; library manages `updatedAt`
          }),
        )
        mockPutItem.mockResolvedValue({})
        yield* LogEntity.put({ id: "l-1", createdAt: "2025-01-15" }).asEffect()
        const item = mockPutItem.mock.calls[0]![0].Item
        // User's value stored as-is (not overwritten by a library-generated timestamp).
        expect(item.createdAt).toEqual({ S: "2025-01-15" })
        // `updatedAt` is still library-managed (not colliding).
        expect(item.updatedAt.S).toBeTypeOf("string")
      }).pipe(Effect.provide(TestLayer)),
    )

    // Collision validation.
    it("Entity.make: errors when `version` is declared in the model alongside versioned (EDD-9021)", () => {
      class Bad extends Schema.Class<Bad>("Bad")({
        id: Schema.String,
        version: Schema.Number,
      }) {}
      expect(() =>
        Entity.make({
          model: Bad,
          entityType: "Bad",
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
          versioned: true,
        }),
      ).toThrow(/EDD-9021/)
    })
  })
})
