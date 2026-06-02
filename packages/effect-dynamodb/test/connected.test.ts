/**
 * Connected integration tests — runs against DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   pnpm test:connected
 *
 * These tests exercise real DynamoDB behavior that mocks cannot validate:
 * pagination cursors, expression evaluation, conditional check failures,
 * batch unprocessed-item retry, transaction atomicity, and GSI propagation.
 */

import { it } from "@effect/vitest"
import { Config, DateTime, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// ---------------------------------------------------------------------------
// Skip if DynamoDB Local is not available
// ---------------------------------------------------------------------------

const ENDPOINT = Effect.runSync(
  Config.string("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}

const describeConnected = dynamoAvailable ? describe : describe.skip

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  role: Schema.Literals(["admin", "member"]),
  bio: Schema.optional(Schema.String),
  createdBy: Schema.String,
}) {}

const UserModel = DynamoModel.configure(User, {
  createdBy: { immutable: true },
})

class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  userId: Schema.String,
  title: Schema.NonEmptyString,
  status: Schema.Literals(["todo", "in-progress", "done"]),
  priority: Schema.Number,
  tags: Schema.optional(Schema.Array(Schema.String)),
}) {}

// ---------------------------------------------------------------------------
// Schema, Table, Entities
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "connected-test", version: 1 })
const tableName = `connected-test-${Date.now()}`

const Users = Entity.make({
  model: UserModel,
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["userId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byRole: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["role"] },
      sk: { field: "gsi1sk", composite: ["userId"] },
    },
    byEmail: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["email"] },
      sk: { field: "gsi2sk", composite: [] },
    },
  },
  unique: { email: ["email"] },
  timestamps: true,
  versioned: { retain: true },
})

const Tasks = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["taskId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byUser: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["userId"] },
      sk: { field: "gsi1sk", composite: ["status", "taskId"] },
    },
  },
  timestamps: true,
  versioned: true,
  softDelete: true,
})

// Shared-PK join-table fixture — exercises the `.primary()` accessor where
// many items live under one partition key and are distinguished by SK.
class Membership extends Schema.Class<Membership>("Membership")({
  orgId: Schema.String,
  userId: Schema.String,
  role: Schema.Literals(["owner", "admin", "member"]),
  joinedAt: Schema.String,
}) {}

const Memberships = Entity.make({
  model: Membership,
  entityType: "Membership",
  primaryKey: {
    pk: { field: "pk", composite: ["orgId"] },
    sk: { field: "sk", composite: ["userId"] },
  },
})

// Sparse-unique fixture — issue #25. Two unique constraints reference optional
// model fields; omitting them must not synthesize a "_unique.<name>#undefined"
// sentinel that collides across records.
class Vehicle extends Schema.Class<Vehicle>("Vehicle")({
  vehicleId: Schema.String,
  accountId: Schema.String,
  name: Schema.NonEmptyString,
  deviceBinding: Schema.optional(Schema.String),
  transponderId: Schema.optional(Schema.String),
}) {}

const Vehicles = Entity.make({
  model: Vehicle,
  entityType: "Vehicle",
  primaryKey: {
    pk: { field: "pk", composite: ["vehicleId"] },
    sk: { field: "sk", composite: [] },
  },
  unique: {
    nameInAccount: ["accountId", "name"],
    deviceBinding: ["deviceBinding"],
    transponderId: ["transponderId"],
  },
  timestamps: true,
})

// Unique-constraint TTL fixture (#58) — the sentinel item expires after the
// configured offset, releasing the reservation automatically.
class Reservation extends Schema.Class<Reservation>("Reservation")({
  reservationId: Schema.String,
  slot: Schema.String,
}) {}

const Reservations = Entity.make({
  model: Reservation,
  entityType: "Reservation",
  primaryKey: {
    pk: { field: "pk", composite: ["reservationId"] },
    sk: { field: "sk", composite: [] },
  },
  unique: { slot: { fields: ["slot"], ttl: Duration.days(30) } },
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Users, Tasks, Memberships, Vehicles, Reservations },
})

// ---------------------------------------------------------------------------
// Aggregate + Ref models
// ---------------------------------------------------------------------------

class Author extends Schema.Class<Author>("Author")({
  id: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}

class Comment extends Schema.Class<Comment>("Comment")({
  id: Schema.String,
  text: Schema.String,
  commenter: Schema.String,
}) {}

class PostMeta extends Schema.Class<PostMeta>("PostMeta")({
  summary: Schema.String,
  wordCount: Schema.Number,
}) {}

class BlogPost extends Schema.Class<BlogPost>("BlogPost")({
  id: Schema.String,
  title: Schema.String,
  author: Author.pipe(DynamoModel.ref),
  meta: PostMeta,
  comments: Schema.Array(Comment),
}) {}

// Entity with refs — article embeds a denormalized author
class Article extends Schema.Class<Article>("Article")({
  articleId: Schema.String,
  title: Schema.String,
  author: Author.pipe(DynamoModel.ref),
  status: Schema.Literals(["draft", "published"]),
}) {}

// Sub-aggregate models for discriminator testing
class ReviewerNote extends Schema.Class<ReviewerNote>("ReviewerNote")({
  reviewer: Author.pipe(DynamoModel.ref),
  rating: Schema.Number,
  text: Schema.String,
}) {}

const AggSchema = DynamoSchema.make({ name: "agg-test", version: 1 })

const aggTableName = `agg-test-${Date.now()}`

const Authors = Entity.make({
  model: Author,
  entityType: "Author",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})

const Articles = Entity.make({
  model: Article,
  entityType: "Article",
  primaryKey: {
    pk: { field: "pk", composite: ["articleId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byAuthor: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["authorId"] },
      sk: { field: "gsi1sk", composite: ["articleId"] },
    },
  },
  refs: {
    author: { entity: Authors },
  },
})

const AggTable = Table.make({ schema: AggSchema, entities: { Authors, Articles } })

// Sub-aggregate: reviewer note (bound with discriminator for editorial vs peer)
const ReviewerNoteAggregate = Aggregate.make(ReviewerNote, {
  root: { entityType: "ReviewerNote" },
  edges: {
    reviewer: Aggregate.ref(Authors),
  },
})

const BlogPostAggregate = Aggregate.make(BlogPost, {
  table: AggTable,
  schema: AggSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: {
    index: "gsi2",
    name: "blogpost",
    sk: { field: "gsi2sk", composite: ["title"] },
  },
  root: { entityType: "BlogPostRoot" },
  edges: {
    author: Aggregate.ref(Authors),
    meta: Aggregate.one("meta", { entityType: "BlogPostMeta" }),
    comments: Aggregate.many("comments", { entityType: "BlogPostComment" }),
  },
})

// ---------------------------------------------------------------------------
// Shared Layer
// ---------------------------------------------------------------------------

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

const TestLayer = Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))
const AggTestLayer = Layer.mergeAll(ClientLayer, AggTable.layer({ name: aggTableName }))

const provide = Effect.provide(TestLayer)
const provideAgg = Effect.provide(AggTestLayer)

// ---------------------------------------------------------------------------
// Table setup / teardown
// ---------------------------------------------------------------------------

describeConnected("Connected integration tests", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
      }).pipe(provide, Effect.scoped),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.scoped,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  // -------------------------------------------------------------------------
  // CRUD — put, get, create, update, delete
  // -------------------------------------------------------------------------

  describe("CRUD", () => {
    it.effect("put + get round-trip returns model fields", () =>
      Effect.gen(function* () {
        const created = yield* Users.put({
          userId: "u-crud-1",
          email: "crud1@test.com",
          displayName: "Crud One",
          role: "admin",
          createdBy: "test",
        }).asEffect()
        expect(created.userId).toBe("u-crud-1")
        expect(created.email).toBe("crud1@test.com")
        expect(created.role).toBe("admin")

        const fetched = yield* Users.get({ userId: "u-crud-1" }).asEffect()
        expect(fetched.userId).toBe("u-crud-1")
        expect(fetched.displayName).toBe("Crud One")
      }).pipe(provide),
    )

    it.effect("asRecord includes system fields", () =>
      Effect.gen(function* () {
        const record = yield* Users.get({ userId: "u-crud-1" }).pipe(Entity.asRecord)
        expect(record.version).toBeGreaterThanOrEqual(1)
        expect(record.createdAt).toBeDefined()
        expect(record.updatedAt).toBeDefined()
      }).pipe(provide),
    )

    it.effect("get non-existent item fails with ItemNotFound", () =>
      Effect.gen(function* () {
        const err = yield* Users.get({ userId: "u-nonexistent" }).asEffect().pipe(Effect.flip)
        expect(err._tag).toBe("ItemNotFound")
      }).pipe(provide),
    )

    it.effect("create fails on duplicate primary key", () =>
      Effect.gen(function* () {
        // Use Tasks (no unique constraints) to test create without the transact path
        yield* Tasks.create({
          taskId: "t-dup",
          userId: "u-dup",
          title: "Original",
          status: "todo",
          priority: 1,
        }).asEffect()
        const err = yield* Tasks.create({
          taskId: "t-dup",
          userId: "u-dup",
          title: "Duplicate",
          status: "todo",
          priority: 2,
        })
          .asEffect()
          .pipe(Effect.flip)
        expect(err._tag).toBe("ConditionalCheckFailed")
      }).pipe(provide),
    )

    it.effect("update modifies fields and increments version", () =>
      Effect.gen(function* () {
        yield* Users.put({
          userId: "u-upd",
          email: "upd@test.com",
          displayName: "Before",
          role: "member",
          createdBy: "test",
        }).asEffect()
        const before = yield* Users.get({ userId: "u-upd" }).pipe(Entity.asRecord)

        const after = yield* Users.update({ userId: "u-upd" }).pipe(
          Users.set({ displayName: "After" }),
          Entity.asRecord,
        )
        expect(after.displayName).toBe("After")
        expect(after.version).toBe(before.version + 1)
      }).pipe(provide),
    )

    it.effect("immutable field is preserved across updates", () =>
      Effect.gen(function* () {
        yield* Users.put({
          userId: "u-imm",
          email: "imm@test.com",
          displayName: "Immutable",
          role: "member",
          createdBy: "original-creator",
        }).asEffect()
        yield* Users.update({ userId: "u-imm" }).pipe(
          Users.set({ displayName: "Changed" }),
          Entity.asModel,
        )
        const fetched = yield* Users.get({ userId: "u-imm" }).asEffect()
        expect(fetched.createdBy).toBe("original-creator")
      }).pipe(provide),
    )

    it.effect("delete removes item", () =>
      Effect.gen(function* () {
        yield* Users.put({
          userId: "u-del",
          email: "del@test.com",
          displayName: "Delete Me",
          role: "member",
          createdBy: "test",
        }).asEffect()
        yield* Users.delete({ userId: "u-del" }).asEffect()
        const err = yield* Users.get({ userId: "u-del" }).asEffect().pipe(Effect.flip)
        expect(err._tag).toBe("ItemNotFound")
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Decode modes — asModel, asRecord, asItem, asNative
  // -------------------------------------------------------------------------

  describe("Decode modes", () => {
    it.effect("asItem includes key fields and __edd_e__", () =>
      Effect.gen(function* () {
        yield* Users.put({
          userId: "u-modes",
          email: "modes@test.com",
          displayName: "Modes",
          role: "admin",
          createdBy: "test",
        }).asEffect()
        const item = yield* Users.get({ userId: "u-modes" }).pipe(Entity.asItem)
        expect(item.__edd_e__).toBe("User")
        expect(item.pk).toBeDefined()
        expect(item.sk).toBeDefined()
      }).pipe(provide),
    )

    it.effect("asNative returns AttributeValue format", () =>
      Effect.gen(function* () {
        const native = yield* Users.get({ userId: "u-modes" }).pipe(Entity.asNative)
        expect(native.pk).toHaveProperty("S")
        expect(native.__edd_e__).toHaveProperty("S")
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Rich update operations
  // -------------------------------------------------------------------------

  describe("Rich updates", () => {
    it.effect("add increments numeric fields", () =>
      Effect.gen(function* () {
        yield* Tasks.put({
          taskId: "t-add",
          userId: "u-1",
          title: "Add Test",
          status: "todo",
          priority: 1,
        }).asEffect()
        yield* Tasks.update({ taskId: "t-add" }).pipe(Entity.add({ priority: 5 }), Entity.asModel)
        const task = yield* Tasks.get({ taskId: "t-add" }).asEffect()
        expect(task.priority).toBe(6)
      }).pipe(provide),
    )

    it.effect("subtract decrements numeric fields", () =>
      Effect.gen(function* () {
        yield* Tasks.put({
          taskId: "t-sub",
          userId: "u-1",
          title: "Sub Test",
          status: "todo",
          priority: 10,
        }).asEffect()
        yield* Tasks.update({ taskId: "t-sub" }).pipe(
          Entity.subtract({ priority: 3 }),
          Entity.asModel,
        )
        const task = yield* Tasks.get({ taskId: "t-sub" }).asEffect()
        expect(task.priority).toBe(7)
      }).pipe(provide),
    )

    it.effect("append adds to list fields", () =>
      Effect.gen(function* () {
        yield* Tasks.put({
          taskId: "t-list",
          userId: "u-1",
          title: "List Test",
          status: "todo",
          priority: 1,
          tags: ["initial"],
        }).asEffect()
        yield* Tasks.update({ taskId: "t-list" }).pipe(
          Entity.append({ tags: ["added"] }),
          Entity.asModel,
        )
        const task = yield* Tasks.get({ taskId: "t-list" }).asEffect()
        expect(task.tags).toEqual(["initial", "added"])
      }).pipe(provide),
    )

    it.effect("remove deletes attribute", () =>
      Effect.gen(function* () {
        yield* Users.put({
          userId: "u-rem",
          email: "rem@test.com",
          displayName: "Remove",
          role: "member",
          bio: "will be removed",
          createdBy: "test",
        }).asEffect()
        yield* Users.update({ userId: "u-rem" }).pipe(Entity.remove(["bio"]), Entity.asModel)
        const item = yield* Users.get({ userId: "u-rem" }).pipe(Entity.asItem)
        expect(item.bio).toBeUndefined()
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Optimistic locking
  // -------------------------------------------------------------------------

  describe("Optimistic locking", () => {
    it.effect("expectedVersion succeeds with correct version", () =>
      Effect.gen(function* () {
        yield* Users.put({
          userId: "u-lock",
          email: "lock@test.com",
          displayName: "Lock",
          role: "member",
          createdBy: "test",
        }).asEffect()
        const record = yield* Users.get({ userId: "u-lock" }).pipe(Entity.asRecord)
        const updated = yield* Users.update({ userId: "u-lock" }).pipe(
          Users.set({ displayName: "Locked Update" }),
          Users.expectedVersion(record.version),
          Entity.asRecord,
        )
        expect(updated.displayName).toBe("Locked Update")
        expect(updated.version).toBe(record.version + 1)
      }).pipe(provide),
    )

    it.effect("expectedVersion fails with wrong version", () =>
      Effect.gen(function* () {
        const err = yield* Users.update({ userId: "u-lock" }).pipe(
          Users.set({ displayName: "Stale" }),
          Users.expectedVersion(1),
          (op) => op.asEffect(),
          Effect.flip,
        )
        expect(err._tag).toBe("OptimisticLockError")
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Unique constraints
  // -------------------------------------------------------------------------

  describe("Unique constraints", () => {
    it.effect("rejects duplicate email on create", () =>
      Effect.gen(function* () {
        yield* Users.put({
          userId: "u-uniq1",
          email: "unique@test.com",
          displayName: "Unique1",
          role: "member",
          createdBy: "test",
        }).asEffect()
        const err = yield* Users.put({
          userId: "u-uniq2",
          email: "unique@test.com",
          displayName: "Unique2",
          role: "member",
          createdBy: "test",
        })
          .asEffect()
          .pipe(Effect.flip)
        expect(err._tag).toBe("UniqueConstraintViolation")
      }).pipe(provide),
    )

    it.effect("update rotates sentinel when unique field changes", () =>
      Effect.gen(function* () {
        yield* Users.put({
          userId: "u-uniq-upd",
          email: "old-email@test.com",
          displayName: "Update Unique",
          role: "member",
          createdBy: "test",
        }).asEffect()

        // Update email — should rotate the sentinel atomically
        yield* Users.update({ userId: "u-uniq-upd" }).pipe(
          Users.set({ email: "new-email@test.com" }),
          Entity.asModel,
        )

        const updated = yield* Users.get({ userId: "u-uniq-upd" }).asEffect()
        expect(updated.email).toBe("new-email@test.com")
      }).pipe(provide),
    )

    it.effect("old email is released after update", () =>
      Effect.gen(function* () {
        // Another user can now claim the old email
        yield* Users.put({
          userId: "u-uniq-claim",
          email: "old-email@test.com",
          displayName: "Claimed Old",
          role: "member",
          createdBy: "test",
        }).asEffect()

        const claimed = yield* Users.get({ userId: "u-uniq-claim" }).asEffect()
        expect(claimed.email).toBe("old-email@test.com")
      }).pipe(provide),
    )

    it.effect("update to taken email fails with UniqueConstraintViolation", () =>
      Effect.gen(function* () {
        // u-uniq-upd has "new-email@test.com", try to update u-uniq-claim to the same
        const err = yield* Users.update({ userId: "u-uniq-claim" }).pipe(
          Users.set({ email: "new-email@test.com" }),
          (op) => op.asEffect(),
          Effect.flip,
        )
        expect(err._tag).toBe("UniqueConstraintViolation")

        // Original value unchanged
        const unchanged = yield* Users.get({ userId: "u-uniq-claim" }).asEffect()
        expect(unchanged.email).toBe("old-email@test.com")
      }).pipe(provide),
    )

    it.effect("unique constraint ttl persists on the sentinel item (#58)", () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Reservations },
          tables: { MainTable },
        })
        // Pin the Clock: sentinel _ttl = now + 30 days (relative TTL via #56).
        yield* TestClock.setTime(1767225600000) // 2026-01-01T00:00:00.000Z
        yield* db.entities.Reservations.put({ reservationId: "r-ttl-1", slot: "slot-ttl-a" })

        // Locate the sentinel by its discriminator and assert the persisted TTL.
        const raw = yield* (yield* DynamoClient).scan({
          TableName: tableName,
          FilterExpression: "#e = :e",
          ExpressionAttributeNames: { "#e": "__edd_e__" },
          ExpressionAttributeValues: { ":e": { S: "Reservation._unique.slot" } },
        })
        const sentinel = raw.Items?.find((i) => i.__edd_e__?.S === "Reservation._unique.slot")
        expect(sentinel).toBeDefined()
        expect(Number(sentinel!._ttl!.N)).toBe(1767225600 + 30 * 86400)
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Sparse unique constraints — issue #25
  //
  // End-to-end coverage of the four transition states for an entity with two
  // unique constraints on optional fields (deviceBinding, transponderId) and
  // one on a required compound (nameInAccount). Verifies against real DynamoDB
  // that no false collisions occur for unset fields and that sentinels rotate
  // correctly across undefined↔defined transitions.
  // -------------------------------------------------------------------------

  describe("Sparse unique constraints (issue #25)", () => {
    it.effect("two records with omitted optional unique fields both succeed", () =>
      Effect.gen(function* () {
        // Under the v1.3.1 bug, the second create here failed with a false
        // UniqueConstraintViolation on `deviceBinding` (and on `transponderId`).
        yield* Vehicles.create({
          vehicleId: "veh-sparse-1",
          accountId: "acct-sparse",
          name: "v1",
        }).asEffect()
        yield* Vehicles.create({
          vehicleId: "veh-sparse-2",
          accountId: "acct-sparse",
          name: "v2",
        }).asEffect()

        const v1 = yield* Vehicles.get({ vehicleId: "veh-sparse-1" }).asEffect()
        const v2 = yield* Vehicles.get({ vehicleId: "veh-sparse-2" }).asEffect()
        expect(v1.deviceBinding).toBeUndefined()
        expect(v2.deviceBinding).toBeUndefined()
      }).pipe(provide),
    )

    it.effect("required compound constraint still enforced when optional ones are sparse", () =>
      Effect.gen(function* () {
        const err = yield* Vehicles.create({
          vehicleId: "veh-sparse-3",
          accountId: "acct-sparse",
          name: "v1", // collides with veh-sparse-1
        })
          .asEffect()
          .pipe(Effect.flip)
        expect(err._tag).toBe("UniqueConstraintViolation")
        if (err._tag === "UniqueConstraintViolation") {
          expect(err.constraint).toBe("nameInAccount")
        }
      }).pipe(provide),
    )

    it.effect("update undefined → defined claims the sentinel (and blocks collisions)", () =>
      Effect.gen(function* () {
        yield* Vehicles.update({ vehicleId: "veh-sparse-1" }).pipe(
          Vehicles.set({ deviceBinding: "device-xyz" }),
          (op) => op.asEffect(),
        )

        const err = yield* Vehicles.update({ vehicleId: "veh-sparse-2" }).pipe(
          Vehicles.set({ deviceBinding: "device-xyz" }),
          (op) => op.asEffect(),
          Effect.flip,
        )
        expect(err._tag).toBe("UniqueConstraintViolation")
        if (err._tag === "UniqueConstraintViolation") {
          expect(err.constraint).toBe("deviceBinding")
          expect(err.fields).toEqual({ deviceBinding: "device-xyz" })
        }
      }).pipe(provide),
    )

    it.effect("update defined → undefined releases the sentinel for re-use", () =>
      Effect.gen(function* () {
        yield* Vehicles.update({ vehicleId: "veh-sparse-1" }).pipe(
          Entity.remove(["deviceBinding"]),
          (op) => op.asEffect(),
        )

        yield* Vehicles.update({ vehicleId: "veh-sparse-2" }).pipe(
          Vehicles.set({ deviceBinding: "device-xyz" }),
          (op) => op.asEffect(),
        )
        const v2 = yield* Vehicles.get({ vehicleId: "veh-sparse-2" }).asEffect()
        expect(v2.deviceBinding).toBe("device-xyz")
      }).pipe(provide),
    )

    it.effect("delete with undefined unique fields succeeds", () =>
      Effect.gen(function* () {
        yield* Vehicles.delete({ vehicleId: "veh-sparse-1" }).asEffect()
        const err = yield* Vehicles.get({ vehicleId: "veh-sparse-1" }).asEffect().pipe(Effect.flip)
        expect(err._tag).toBe("ItemNotFound")
      }).pipe(provide),
    )

    it.effect("name freed by delete is reusable", () =>
      Effect.gen(function* () {
        yield* Vehicles.create({
          vehicleId: "veh-sparse-4",
          accountId: "acct-sparse",
          name: "v1",
        }).asEffect()
        const v4 = yield* Vehicles.get({ vehicleId: "veh-sparse-4" }).asEffect()
        expect(v4.name).toBe("v1")
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Conditional writes
  // -------------------------------------------------------------------------

  describe("Conditional writes", () => {
    it.effect("condition passes when expression is true", () =>
      Effect.gen(function* () {
        yield* Tasks.put({
          taskId: "t-cond",
          userId: "u-1",
          title: "Conditional",
          status: "todo",
          priority: 1,
        }).asEffect()
        // Use priority (non-GSI composite) to avoid GSI key recomposition issues
        const updated = yield* Tasks.update({ taskId: "t-cond" }).pipe(
          Tasks.set({ priority: 99 }),
          Tasks.condition({ status: "todo" }),
          Entity.asModel,
        )
        expect(updated.priority).toBe(99)
      }).pipe(provide),
    )

    it.effect("condition fails when expression is false", () =>
      Effect.gen(function* () {
        const err = yield* Tasks.update({ taskId: "t-cond" }).pipe(
          Tasks.set({ priority: 50 }),
          Tasks.condition({ status: "done" }),
          (op) => op.asEffect(),
          Effect.flip,
        )
        expect(err._tag).toBe("ConditionalCheckFailed")
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // GSI queries
  // -------------------------------------------------------------------------

  describe("GSI queries", () => {
    it.effect("query returns items matching partition key", () =>
      Effect.gen(function* () {
        yield* Tasks.put({
          taskId: "t-q1",
          userId: "u-query",
          title: "Query 1",
          status: "todo",
          priority: 1,
        }).asEffect()
        yield* Tasks.put({
          taskId: "t-q2",
          userId: "u-query",
          title: "Query 2",
          status: "done",
          priority: 2,
        }).asEffect()
        yield* Tasks.put({
          taskId: "t-q3",
          userId: "u-other",
          title: "Other User",
          status: "todo",
          priority: 1,
        }).asEffect()

        const results = yield* Tasks.query.byUser({ userId: "u-query" }).pipe(Query.collect)
        expect(results).toHaveLength(2)
        expect(results.every((t) => t.userId === "u-query")).toBe(true)
      }).pipe(provide),
    )

    it.effect("query with sort key beginsWith filters correctly", () =>
      Effect.gen(function* () {
        // KeyComposer prefixes each composite value with its attribute name
        // (`status_<value>`), so the full SK prefix for Tasks with status=todo
        // under byUser (gsi1sk composite: ["status", "taskId"]) is
        // `$<schema>#v1#<entity>#status_<value>`.
        const todos = yield* Tasks.query.byUser({ userId: "u-query" }).pipe(
          Query.where({
            beginsWith: `$connected-test#v1#task#status_todo`,
          }),
          Query.collect,
        )
        expect(todos).toHaveLength(1)
        expect(todos[0]!.status).toBe("todo")
      }).pipe(provide),
    )

    it.effect("query reverse returns descending order", () =>
      Effect.gen(function* () {
        const results = yield* Tasks.query
          .byUser({ userId: "u-query" })
          .pipe(Query.reverse, Query.collect)
        expect(results).toHaveLength(2)
        // Reversed: 'todo' sorts after 'done', so reversed puts todo first
        expect(results[0]!.status).toBe("todo")
      }).pipe(provide),
    )

    it.effect("query with limit restricts per-page result count", () =>
      Effect.gen(function* () {
        // Query.limit sets DynamoDB Limit (per-page), Query.execute returns a single page
        const page = yield* Tasks.query
          .byUser({ userId: "u-query" })
          .pipe(Query.limit(1), Query.execute)
        expect(page.items).toHaveLength(1)
      }).pipe(provide),
    )

    it.effect("query count returns total items", () =>
      Effect.gen(function* () {
        const count = yield* Tasks.query.byUser({ userId: "u-query" }).pipe(Query.count)
        expect(count).toBe(2)
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Primary index query accessor (.primary) — GH #2.
  //
  // Symmetric to GSI accessors: required PK composites, optional SK composites
  // (prefix-ordered). Exercises the shared-PK join-table pattern where many
  // items live under one partition key and are distinguished by SK.
  // -------------------------------------------------------------------------

  describe(".primary() accessor (bound client)", () => {
    // Use unique orgIds per describe block so we don't collide with other
    // describe blocks that happen to reuse `Memberships`. Each primary test
    // seeds its own partition explicitly; no cross-test dependencies.
    const seedAcmeMemberships = Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Memberships },
        tables: { MainTable },
      })
      yield* db.entities.Memberships.put({
        orgId: "org-acme",
        userId: "u-alice",
        role: "owner",
        joinedAt: "2025-01-01",
      })
      yield* db.entities.Memberships.put({
        orgId: "org-acme",
        userId: "u-bob",
        role: "admin",
        joinedAt: "2025-02-01",
      })
      yield* db.entities.Memberships.put({
        orgId: "org-acme",
        userId: "u-carol",
        role: "member",
        joinedAt: "2025-03-01",
      })
      yield* db.entities.Memberships.put({
        orgId: "org-other",
        userId: "u-alice",
        role: "admin",
        joinedAt: "2025-01-15",
      })
    })

    it.effect("lists all items under a shared primary partition key", () =>
      Effect.gen(function* () {
        yield* seedAcmeMemberships

        const db = yield* DynamoClient.make({
          entities: { Memberships },
          tables: { MainTable },
        })

        const acmeMembers = yield* db.entities.Memberships.primary({
          orgId: "org-acme",
        }).collect()

        expect(acmeMembers).toHaveLength(3)
        expect(acmeMembers.every((m) => m.orgId === "org-acme")).toBe(true)
        expect(acmeMembers.map((m) => m.userId).sort()).toEqual(["u-alice", "u-bob", "u-carol"])

        // Cross-partition isolation — org-other should not leak into org-acme.
        const otherMembers = yield* db.entities.Memberships.primary({
          orgId: "org-other",
        }).collect()
        expect(otherMembers).toHaveLength(1)
        expect(otherMembers[0]!.userId).toBe("u-alice")
      }).pipe(provide),
    )

    it.effect("PK + full SK composite narrows to a single item", () =>
      Effect.gen(function* () {
        yield* seedAcmeMemberships

        const db = yield* DynamoClient.make({
          entities: { Memberships },
          tables: { MainTable },
        })

        const bobs = yield* db.entities.Memberships.primary({
          orgId: "org-acme",
          userId: "u-bob",
        }).collect()

        expect(bobs).toHaveLength(1)
        expect(bobs[0]!.role).toBe("admin")
      }).pipe(provide),
    )

    it.effect("chains .filter() to post-filter results by a non-key attribute", () =>
      Effect.gen(function* () {
        yield* seedAcmeMemberships

        const db = yield* DynamoClient.make({
          entities: { Memberships },
          tables: { MainTable },
        })

        const admins = yield* db.entities.Memberships.primary({ orgId: "org-acme" })
          .filter({ role: "admin" })
          .collect()

        expect(admins).toHaveLength(1)
        expect(admins[0]!.userId).toBe("u-bob")
      }).pipe(provide),
    )

    it.effect("chains .limit() + .reverse() + .fetch() for paged descending reads", () =>
      Effect.gen(function* () {
        yield* seedAcmeMemberships

        const db = yield* DynamoClient.make({
          entities: { Memberships },
          tables: { MainTable },
        })

        const page = yield* db.entities.Memberships.primary({ orgId: "org-acme" })
          .reverse()
          .limit(1)
          .fetch()

        expect(page.items).toHaveLength(1)
        // Reversed SK sort: u-carol sorts last ascending, so it comes first reversed.
        expect(page.items[0]!.userId).toBe("u-carol")
        expect(page.cursor).not.toBeNull()
      }).pipe(provide),
    )

    it.effect(".count() returns the number of items in the partition", () =>
      Effect.gen(function* () {
        yield* seedAcmeMemberships

        const db = yield* DynamoClient.make({
          entities: { Memberships },
          tables: { MainTable },
        })

        const count = yield* db.entities.Memberships.primary({ orgId: "org-acme" }).count()
        expect(count).toBe(3)
      }).pipe(provide),
    )

    it.effect("works for entities with no SK composites (single-item partitions)", () =>
      // Use Tasks — its primary key has `sk: { composite: [] }` (empty SK
      // composites) and `versioned: true` WITHOUT retain, so there are no
      // snapshot items polluting the partition.
      Effect.gen(function* () {
        yield* Tasks.put({
          taskId: "t-primary-single-1",
          userId: "u-primary-single",
          title: "Primary-only task",
          status: "todo",
          priority: 1,
        }).asEffect()

        const db = yield* DynamoClient.make({
          entities: { Tasks },
          tables: { MainTable },
        })

        const result = yield* db.entities.Tasks.primary({
          taskId: "t-primary-single-1",
        }).collect()
        expect(result).toHaveLength(1)
        expect(result[0]!.taskId).toBe("t-primary-single-1")
        expect(result[0]!.title).toBe("Primary-only task")
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  describe("Pagination", () => {
    it.effect("paginate yields all items across pages", () =>
      Effect.gen(function* () {
        for (let i = 0; i < 5; i++) {
          yield* Tasks.put({
            taskId: `t-page-${i}`,
            userId: "u-paginate",
            title: `Page Task ${i}`,
            status: "todo",
            priority: i,
          }).asEffect()
        }

        // paginate with limit 2 per page returns a Stream of pages
        const stream = yield* Tasks.query
          .byUser({ userId: "u-paginate" })
          .pipe(Query.limit(2), Query.paginate)

        const pages = yield* Stream.runCollect(stream)
        const allItems = Array.from(pages).flat()
        expect(allItems).toHaveLength(5)
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Scan
  // -------------------------------------------------------------------------

  describe("Scan", () => {
    it.effect("scan returns items of the entity type", () =>
      Effect.gen(function* () {
        const results = yield* Tasks.scan().pipe(Query.collect)
        expect(results.length).toBeGreaterThan(0)
        for (const t of results) {
          expect(t.taskId).toBeDefined()
          expect(t.title).toBeDefined()
        }
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Consistent reads
  // -------------------------------------------------------------------------

  describe("Consistent reads", () => {
    it.effect("consistentRead on get returns item", () =>
      Effect.gen(function* () {
        yield* Users.put({
          userId: "u-consist",
          email: "consist@test.com",
          displayName: "Consistent",
          role: "member",
          createdBy: "test",
        }).asEffect()
        const user = yield* Users.get({ userId: "u-consist" }).pipe(
          Entity.consistentRead(),
          Entity.asModel,
        )
        expect(user.userId).toBe("u-consist")
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Projection
  // -------------------------------------------------------------------------

  describe("Projection", () => {
    it.effect("project returns only selected attributes", () =>
      Effect.gen(function* () {
        const result = yield* Users.get({ userId: "u-crud-1" }).pipe(
          Entity.project(["userId", "email"]),
        )
        expect(result.userId).toBe("u-crud-1")
        expect(result.email).toBe("crud1@test.com")
        expect(result.displayName).toBeUndefined()
      }).pipe(provide),
    )

    it.effect("Entity.select returns only selected attributes", () =>
      Effect.gen(function* () {
        const results = yield* Tasks.query
          .byUser({ userId: "u-query" })
          .pipe(Tasks.select(["taskId", "title"]), Query.collect)
        expect(results.length).toBeGreaterThan(0)
        for (const r of results) {
          expect(r.taskId).toBeDefined()
          expect(r.title).toBeDefined()
          expect(r.priority).toBeUndefined()
        }
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Batch operations
  // -------------------------------------------------------------------------

  describe("Batch", () => {
    it.effect("Batch.get fetches multiple items in one call", () =>
      Effect.gen(function* () {
        yield* Users.put({
          userId: "u-batch1",
          email: "batch1@test.com",
          displayName: "Batch1",
          role: "member",
          createdBy: "test",
        }).asEffect()
        yield* Users.put({
          userId: "u-batch2",
          email: "batch2@test.com",
          displayName: "Batch2",
          role: "admin",
          createdBy: "test",
        }).asEffect()

        const [u1, u2, u3] = yield* Batch.get([
          Users.get({ userId: "u-batch1" }),
          Users.get({ userId: "u-batch2" }),
          Users.get({ userId: "u-nonexistent-batch" }),
        ])
        expect(u1?.userId).toBe("u-batch1")
        expect(u2?.userId).toBe("u-batch2")
        expect(u3).toBeUndefined()
      }).pipe(provide),
    )

    it.effect("Batch.write puts and deletes in one call", () =>
      Effect.gen(function* () {
        yield* Batch.write([
          Tasks.put({
            taskId: "t-bw1",
            userId: "u-bw",
            title: "Batch Write 1",
            status: "todo",
            priority: 1,
          }),
          Tasks.put({
            taskId: "t-bw2",
            userId: "u-bw",
            title: "Batch Write 2",
            status: "done",
            priority: 2,
          }),
        ])
        const t1 = yield* Tasks.get({ taskId: "t-bw1" }).asEffect()
        const t2 = yield* Tasks.get({ taskId: "t-bw2" }).asEffect()
        expect(t1.title).toBe("Batch Write 1")
        expect(t2.title).toBe("Batch Write 2")
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  describe("Transactions", () => {
    it.effect("transactWrite creates multiple items atomically", () =>
      Effect.gen(function* () {
        yield* Transaction.transactWrite([
          Users.put({
            userId: "u-tx",
            email: "tx@test.com",
            displayName: "TxUser",
            role: "admin",
            createdBy: "test",
          }),
          Tasks.put({
            taskId: "t-tx",
            userId: "u-tx",
            title: "Tx Task",
            status: "todo",
            priority: 1,
          }),
        ])

        const user = yield* Users.get({ userId: "u-tx" }).asEffect()
        const task = yield* Tasks.get({ taskId: "t-tx" }).asEffect()
        expect(user.displayName).toBe("TxUser")
        expect(task.title).toBe("Tx Task")
      }).pipe(provide),
    )

    it.effect("transactGet fetches multiple items atomically", () =>
      Effect.gen(function* () {
        const [user, task] = yield* Transaction.transactGet([
          Users.get({ userId: "u-tx" }),
          Tasks.get({ taskId: "t-tx" }),
        ])
        expect(user?.displayName).toBe("TxUser")
        expect(task?.title).toBe("Tx Task")
      }).pipe(provide),
    )

    it.effect("transactWrite with condition check rolls back on failure", () =>
      Effect.gen(function* () {
        const err = yield* Transaction.transactWrite([
          Users.put({
            userId: "u-tx-fail",
            email: "txfail@test.com",
            displayName: "Should Not Exist",
            role: "member",
            createdBy: "test",
          }),
          // Condition check: u-tx has role "admin", checking for "member" should fail
          Transaction.check(
            Users.get({ userId: "u-tx" }),
            Expression.condition({ eq: { role: "member" } }),
          ),
        ]).pipe(Effect.asVoid, Effect.flip)
        expect(err._tag).toBe("TransactionCancelled")

        // Verify the put was rolled back
        const result = yield* Users.get({ userId: "u-tx-fail" })
          .asEffect()
          .pipe(
            Effect.map(() => "exists"),
            Effect.catchTag("ItemNotFound", () => Effect.succeed("not found")),
          )
        expect(result).toBe("not found")
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Version history (versioned: { retain: true })
  // -------------------------------------------------------------------------

  describe("Version history", () => {
    it.effect("getVersion retrieves specific version snapshot", () =>
      Effect.gen(function* () {
        yield* Users.put({
          userId: "u-ver",
          email: "ver@test.com",
          displayName: "V1",
          role: "member",
          createdBy: "test",
        }).asEffect()
        yield* Users.update({ userId: "u-ver" }).pipe(
          Users.set({ displayName: "V2" }),
          Entity.asModel,
        )
        yield* Users.update({ userId: "u-ver" }).pipe(
          Users.set({ displayName: "V3" }),
          Entity.asModel,
        )

        const v1 = yield* Users.getVersion({ userId: "u-ver" }, 1).asEffect()
        const v2 = yield* Users.getVersion({ userId: "u-ver" }, 2).asEffect()
        const current = yield* Users.get({ userId: "u-ver" }).asEffect()

        expect(v1.displayName).toBe("V1")
        expect(v2.displayName).toBe("V2")
        expect(current.displayName).toBe("V3")
      }).pipe(provide),
    )

    it.effect("versions returns all snapshots", () =>
      Effect.gen(function* () {
        // put creates v1 snapshot; update #1 overwrites v1 snapshot; update #2 creates v2 snapshot
        const versions = yield* Users.versions({ userId: "u-ver" }).pipe(Query.collect)
        expect(versions.length).toBeGreaterThanOrEqual(2)
      }).pipe(provide),
    )

    it.effect("getVersion for non-existent version fails with ItemNotFound", () =>
      Effect.gen(function* () {
        const err = yield* Users.getVersion({ userId: "u-ver" }, 99).asEffect().pipe(Effect.flip)
        expect(err._tag).toBe("ItemNotFound")
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Soft delete + restore
  // -------------------------------------------------------------------------

  describe("Soft delete + restore", () => {
    it.effect("soft-deleted item vanishes from queries but is retrievable", () =>
      Effect.gen(function* () {
        yield* Tasks.put({
          taskId: "t-soft",
          userId: "u-soft",
          title: "Soft Delete Me",
          status: "todo",
          priority: 1,
        }).asEffect()

        const before = yield* Tasks.query.byUser({ userId: "u-soft" }).pipe(Query.collect)
        expect(before).toHaveLength(1)

        yield* Tasks.delete({ taskId: "t-soft" }).asEffect()

        const after = yield* Tasks.query.byUser({ userId: "u-soft" }).pipe(Query.collect)
        expect(after).toHaveLength(0)

        const deleted = yield* Tasks.deleted.get({ taskId: "t-soft" }).pipe(Entity.asRecord)
        expect(deleted.title).toBe("Soft Delete Me")
        expect((deleted as any).deletedAt).toBeDefined()
      }).pipe(provide),
    )

    it.effect("restore brings soft-deleted item back", () =>
      Effect.gen(function* () {
        yield* Tasks.restore({ taskId: "t-soft" }).asEffect()

        const restored = yield* Tasks.get({ taskId: "t-soft" }).asEffect()
        expect(restored.title).toBe("Soft Delete Me")

        const results = yield* Tasks.query.byUser({ userId: "u-soft" }).pipe(Query.collect)
        expect(results).toHaveLength(1)
      }).pipe(provide),
    )
  })

  // -------------------------------------------------------------------------
  // Purge
  // -------------------------------------------------------------------------

  describe("Purge", () => {
    it.effect("purge removes item, versions, and soft-deleted copies", () =>
      Effect.gen(function* () {
        yield* Users.put({
          userId: "u-purge",
          email: "purge@test.com",
          displayName: "Purge Me",
          role: "member",
          createdBy: "test",
        }).asEffect()
        yield* Users.update({ userId: "u-purge" }).pipe(
          Users.set({ displayName: "V2" }),
          Entity.asModel,
        )

        yield* Users.purge({ userId: "u-purge" }).asEffect()

        const err = yield* Users.get({ userId: "u-purge" }).asEffect().pipe(Effect.flip)
        expect(err._tag).toBe("ItemNotFound")

        const versions = yield* Users.versions({ userId: "u-purge" }).pipe(Query.collect)
        expect(versions).toHaveLength(0)
      }).pipe(provide),
    )
  })
})

// ===========================================================================
// Time-series Connected Tests (separate table; one current + N event items)
// ===========================================================================

class Telemetry extends Schema.Class<Telemetry>("Telemetry")({
  channel: Schema.String,
  deviceId: Schema.String,
  accountId: Schema.optional(Schema.String),
  timestamp: Schema.DateTimeUtc,
  location: Schema.optional(Schema.String),
  alert: Schema.optional(Schema.Boolean),
  gpio: Schema.optional(Schema.Number),
}) {}

const TelemetryAppendInput = Schema.Struct({
  channel: Schema.String,
  deviceId: Schema.String,
  timestamp: Schema.DateTimeUtc,
  location: Schema.optional(Schema.String),
  alert: Schema.optional(Schema.Boolean),
  gpio: Schema.optional(Schema.Number),
})

const tsSchema = DynamoSchema.make({ name: "ts-test", version: 1 })
const tsTableName = `ts-test-${Date.now()}`

const Telemetries = Entity.make({
  model: Telemetry,
  entityType: "Telemetry",
  primaryKey: {
    pk: { field: "pk", composite: ["channel", "deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byAccount: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["accountId"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
    },
  },
  timestamps: true,
  timeSeries: {
    orderBy: "timestamp",
    ttl: Duration.days(7),
    appendInput: TelemetryAppendInput,
  },
})

const TsTable = Table.make({ schema: tsSchema, entities: { Telemetries } })
const TsTestLayer = Layer.mergeAll(ClientLayer, TsTable.layer({ name: tsTableName }))
const provideTs = Effect.provide(TsTestLayer)

describeConnected("timeSeries integration tests", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tsTableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(TsTable),
        })
      }).pipe(provideTs, Effect.scoped),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tsTableName })
      }).pipe(
        provideTs,
        Effect.scoped,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  it.effect("append round-trip: current reflects latest orderBy", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Telemetries },
        tables: { TsTable },
      })

      const t1 = DateTime.makeUnsafe("2026-04-22T10:00:00.000Z")
      const r = yield* db.entities.Telemetries.append({
        channel: "c-round",
        deviceId: "d-1",
        timestamp: t1,
        location: "rack-1",
      })
      expect(r.current.channel).toBe("c-round")

      const fetched = yield* db.entities.Telemetries.get({
        channel: "c-round",
        deviceId: "d-1",
      })
      expect(fetched.location).toBe("rack-1")
    }).pipe(provideTs),
  )

  it.effect("sequential monotone appends reflected in history", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Telemetries },
        tables: { TsTable },
      })

      const t1 = DateTime.makeUnsafe("2026-04-22T10:00:00.000Z")
      const t2 = DateTime.makeUnsafe("2026-04-22T10:05:00.000Z")
      const t3 = DateTime.makeUnsafe("2026-04-22T10:10:00.000Z")

      for (const ts of [t1, t2, t3]) {
        const r = yield* db.entities.Telemetries.append({
          channel: "c-seq",
          deviceId: "d-1",
          timestamp: ts,
        })
        expect(r.current.channel).toBe("c-seq")
      }

      const history = yield* db.entities.Telemetries.history({
        channel: "c-seq",
        deviceId: "d-1",
      }).collect()
      expect(history).toHaveLength(3)
    }).pipe(provideTs),
  )

  it.effect("stale append: older orderBy fails with StaleAppend on the error channel", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Telemetries },
        tables: { TsTable },
      })

      const newer = DateTime.makeUnsafe("2026-04-22T12:00:00.000Z")
      const older = DateTime.makeUnsafe("2026-04-22T11:00:00.000Z")

      yield* db.entities.Telemetries.append({
        channel: "c-stale",
        deviceId: "d-1",
        timestamp: newer,
      })

      const result = yield* db.entities.Telemetries.append({
        channel: "c-stale",
        deviceId: "d-1",
        timestamp: older,
      })
        .asEffect()
        .pipe(Effect.flip)

      expect(result._tag).toBe("StaleAppend")
      if (result._tag === "StaleAppend") {
        expect(Option.isSome(result.current)).toBe(true)
      }

      const history = yield* db.entities.Telemetries.history({
        channel: "c-stale",
        deviceId: "d-1",
      }).collect()
      expect(history).toHaveLength(1) // the winning event only
    }).pipe(provideTs),
  )

  it.effect("duplicate orderBy is strictly < (second fails with StaleAppend, no dup event)", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Telemetries },
        tables: { TsTable },
      })

      const same = DateTime.makeUnsafe("2026-04-22T13:00:00.000Z")

      yield* db.entities.Telemetries.append({
        channel: "c-dup",
        deviceId: "d-1",
        timestamp: same,
      })

      const result = yield* db.entities.Telemetries.append({
        channel: "c-dup",
        deviceId: "d-1",
        timestamp: same,
      })
        .asEffect()
        .pipe(Effect.flip)
      expect(result._tag).toBe("StaleAppend")

      const history = yield* db.entities.Telemetries.history({
        channel: "c-dup",
        deviceId: "d-1",
      }).collect()
      expect(history).toHaveLength(1)
    }).pipe(provideTs),
  )

  it.effect(
    "user-condition violation (CAS held) fails with ConditionalCheckFailed carrying current",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Telemetries },
          tables: { TsTable },
        })

        // Seed an item with a known location.
        yield* db.entities.Telemetries.append({
          channel: "c-cond",
          deviceId: "d-1",
          timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
          location: "rack-A",
        })

        // Attempt an append with a NEWER orderBy (CAS would hold) but a
        // condition that does not match the current.
        const result = yield* (db.entities.Telemetries.append as any)({
          channel: "c-cond",
          deviceId: "d-1",
          timestamp: DateTime.makeUnsafe("2026-04-22T10:01:00.000Z"),
          location: "rack-B",
        })
          .condition({ eq: { location: "rack-Z" } })
          .asEffect()
          .pipe(Effect.flip)

        expect(result._tag).toBe("ConditionalCheckFailed")
        if (result._tag === "ConditionalCheckFailed") {
          expect(Option.isSome(result.current)).toBe(true)
        }
      }).pipe(provideTs),
  )

  it.effect("skipFollowUp on success: returns void", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Telemetries },
        tables: { TsTable },
      })

      const result = yield* db.entities.Telemetries.append({
        channel: "c-skip",
        deviceId: "d-1",
        timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
      }).skipFollowUp()
      expect(result).toBeUndefined()

      // Round-trip — the row was written even though we didn't read it back.
      const fetched = yield* db.entities.Telemetries.get({
        channel: "c-skip",
        deviceId: "d-1",
      })
      expect(fetched.deviceId).toBe("d-1")
    }).pipe(provideTs),
  )

  it.effect("skipFollowUp on stale: fails with StaleAppend(current=Option.none)", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Telemetries },
        tables: { TsTable },
      })

      yield* db.entities.Telemetries.append({
        channel: "c-skip-stale",
        deviceId: "d-1",
        timestamp: DateTime.makeUnsafe("2026-04-22T12:00:00.000Z"),
      })

      const result = yield* db.entities.Telemetries.append({
        channel: "c-skip-stale",
        deviceId: "d-1",
        timestamp: DateTime.makeUnsafe("2026-04-22T11:00:00.000Z"),
      })
        .skipFollowUp()
        .asEffect()
        .pipe(Effect.flip)

      expect(result._tag).toBe("StaleAppend")
      if (result._tag === "StaleAppend") {
        expect(Option.isNone(result.current)).toBe(true)
      }
    }).pipe(provideTs),
  )

  it.effect("enrichment preservation: put sets accountId, append leaves it intact", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Telemetries },
        tables: { TsTable },
      })

      const t0 = DateTime.makeUnsafe("2026-04-22T14:00:00.000Z")
      // Seed the current row using append — accountId is NOT in appendInput.
      // Attach accountId enrichment via .update().
      yield* db.entities.Telemetries.append({
        channel: "c-enrich",
        deviceId: "d-1",
        timestamp: t0,
        location: "rack-A",
      })
      yield* db.entities.Telemetries.update({ channel: "c-enrich", deviceId: "d-1" }).set({
        accountId: "acct-1",
      })

      // Append without accountId in input — must not overwrite enrichment.
      const t1 = DateTime.makeUnsafe("2026-04-22T14:05:00.000Z")
      yield* db.entities.Telemetries.append({
        channel: "c-enrich",
        deviceId: "d-1",
        timestamp: t1,
        location: "rack-B",
      })

      const fetched = yield* db.entities.Telemetries.get({
        channel: "c-enrich",
        deviceId: "d-1",
      })
      expect(fetched.accountId).toBe("acct-1")
      expect(fetched.location).toBe("rack-B")
    }).pipe(provideTs),
  )

  it.effect("GSI on current: byAccount query returns current item, not events", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Telemetries },
        tables: { TsTable },
      })

      // Use .put() to set a complete row with accountId populated.
      yield* db.entities.Telemetries.put({
        channel: "c-gsi",
        deviceId: "d-1",
        timestamp: DateTime.makeUnsafe("2026-04-22T15:00:00.000Z"),
        accountId: "acct-gsi",
      })

      const later = DateTime.makeUnsafe("2026-04-22T15:05:00.000Z")
      yield* db.entities.Telemetries.append({
        channel: "c-gsi",
        deviceId: "d-1",
        timestamp: later,
      })

      const rows = yield* db.entities.Telemetries.byAccount({ accountId: "acct-gsi" }).collect()
      // One row — the current; events don't carry GSI keys.
      expect(rows).toHaveLength(1)
      expect(rows[0]!.deviceId).toBe("d-1")
    }).pipe(provideTs),
  )

  it.effect("history range via .where(between)", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Telemetries },
        tables: { TsTable },
      })

      // Seed 5 events over a ~1-hour window.
      const base = new Date("2026-04-22T16:00:00.000Z").getTime()
      for (let i = 0; i < 5; i++) {
        yield* db.entities.Telemetries.append({
          channel: "c-range",
          deviceId: "d-1",
          timestamp: DateTime.makeUnsafe(new Date(base + i * 15 * 60_000).toISOString()),
        })
      }

      // Window covers events 1..3 (indices 1,2,3 — three events).
      const from = new Date(base + 10 * 60_000).toISOString()
      const to = new Date(base + 50 * 60_000).toISOString()

      const window = yield* db.entities.Telemetries.history({ channel: "c-range", deviceId: "d-1" })
        .where((t, { between }) => between(t.timestamp, from, to))
        .collect()
      expect(window).toHaveLength(3)
    }).pipe(provideTs),
  )

  it.effect("_ttl attribute present on event items with sensible epoch value", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Telemetries },
        tables: { TsTable },
      })

      // Pin the ambient Clock so the TTL (now + Duration.days(7)) is exact.
      // The library reads the Clock via DateTime.now (#56); under it.effect the
      // ambient clock is the TestClock, so set it to a known instant.
      yield* TestClock.setTime(1767225600000) // 2026-01-01T00:00:00.000Z
      yield* db.entities.Telemetries.append({
        channel: "c-ttl",
        deviceId: "d-1",
        timestamp: DateTime.makeUnsafe("2026-04-22T17:00:00.000Z"),
      })

      const raw = yield* (yield* DynamoClient).query({
        TableName: tsTableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": { S: "$ts-test#v1#telemetry#channel_c-ttl#deviceid_d-1" },
          ":skPrefix": { S: "$ts-test#v1#telemetry#e#" },
        },
      })
      expect(raw.Items).toBeDefined()
      expect(raw.Items!.length).toBeGreaterThanOrEqual(1)
      const event = raw.Items![0]!
      const ttl = event._ttl?.N ? Number(event._ttl.N) : undefined
      expect(ttl).toBeDefined()
      // Exactly 7 days (Duration.days(7)) past the pinned instant.
      expect(ttl!).toBe(1767225600 + 7 * 86400)
    }).pipe(provideTs),
  )

  it.effect("concurrent appenders: final current = max(orderBy)", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { Telemetries },
        tables: { TsTable },
      })

      const ts = (iso: string) => DateTime.makeUnsafe(iso)
      const times = [
        "2026-04-22T18:00:00.000Z",
        "2026-04-22T18:00:05.000Z",
        "2026-04-22T18:00:10.000Z",
      ]
      yield* Effect.all(
        times.map((iso) =>
          db.entities.Telemetries.append({
            channel: "c-concur",
            deviceId: "d-1",
            timestamp: ts(iso),
          })
            .asEffect()
            // Some concurrent attempts will lose the CAS; surface that as a
            // value so Effect.all doesn't short-circuit on StaleAppend.
            .pipe(Effect.catchTag("StaleAppend", () => Effect.void)),
        ),
        { concurrency: "unbounded" },
      )

      const current = yield* db.entities.Telemetries.get({
        channel: "c-concur",
        deviceId: "d-1",
      })
      // The latest timestamp is `18:00:10`.
      const iso = DateTime.formatIso(current.timestamp)
      expect(iso).toBe("2026-04-22T18:00:10.000Z")
    }).pipe(provideTs),
  )
})

// ===========================================================================
// timeSeries .append().remove() — atomic SET + REMOVE + CAS — closes #49
// ===========================================================================
//
// `.append(input).remove(attrs)` clears `appendInput` attributes in the same
// UpdateItem as the scoped SET and CAS predicate, closing the race window
// that the two-write workaround (.append() then .update().remove()) suffered
// from. Any GSI half whose composite list intersects the removed attribute
// cascades through `composeGsiKeysForUpdatePolicyAware` via `removedSet`.
//
// Fixture entity: sparse-PK GSI keyed on `alertState`, mirroring the issue
// #49 motivating IoT case. End-to-end: write with alertState, observe via
// byCurrentAlert; remove alertState, observe item drop from the GSI; item
// remains addressable via primary key.
// ===========================================================================

class TsAlertDevice extends Schema.Class<TsAlertDevice>("TsAlertDevice")({
  channel: Schema.String,
  deviceId: Schema.String,
  timestamp: Schema.DateTimeUtc,
  alertState: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String), // enrichment — not in appendInput
}) {}

const TsAlertDeviceAppendInput = Schema.Struct({
  channel: Schema.String,
  deviceId: Schema.String,
  timestamp: Schema.DateTimeUtc,
  alertState: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
})

const tsAlertSchema = DynamoSchema.make({ name: "ts-alert-test", version: 1 })
const tsAlertTableName = `ts-alert-test-${Date.now()}`

const TsAlertDevices = Entity.make({
  model: TsAlertDevice,
  entityType: "TsAlertDevice",
  primaryKey: {
    pk: { field: "pk", composite: ["channel", "deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    // Sparse-PK GSI on alertState — the issue #49 motivating shape.
    byCurrentAlert: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["alertState"] },
      sk: { field: "gsi1sk", composite: ["timestamp"] },
      indexPolicy: { pk: "sparse", sk: "preserve" },
    },
    // PK-composites-only GSI — must remain populated under .remove() of an
    // unrelated attribute (preserves the #43 fix under the new code path).
    byChannel: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["channel"] },
      sk: { field: "gsi2sk", composite: ["deviceId"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
  timeSeries: {
    orderBy: "timestamp",
    appendInput: TsAlertDeviceAppendInput,
  },
})

const TsAlertTable = Table.make({ schema: tsAlertSchema, entities: { TsAlertDevices } })
const TsAlertLayer = Layer.mergeAll(ClientLayer, TsAlertTable.layer({ name: tsAlertTableName }))
const provideTsAlert = Effect.provide(TsAlertLayer)

describeConnected("timeSeries .append().remove() integration tests (closes #49)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tsAlertTableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(TsAlertTable),
        })
      }).pipe(provideTsAlert, Effect.scoped),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tsAlertTableName })
      }).pipe(
        provideTsAlert,
        Effect.scoped,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  it.effect(
    "round-trip: .remove() clears the attribute on the current item, item remains addressable",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { TsAlertDevices },
          tables: { TsAlertTable },
        })

        // 1. Initial append with alertState set.
        yield* db.entities.TsAlertDevices.append({
          channel: "ch-rt",
          deviceId: "d-rt-1",
          timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
          alertState: "ACTIVE",
          location: "rack-1",
        })

        const beforeRemove = yield* db.entities.TsAlertDevices.get({
          channel: "ch-rt",
          deviceId: "d-rt-1",
        })
        expect(beforeRemove.alertState).toBe("ACTIVE")
        expect(beforeRemove.location).toBe("rack-1")

        // 2. Append with .remove(['alertState']) clears it atomically.
        yield* db.entities.TsAlertDevices.append({
          channel: "ch-rt",
          deviceId: "d-rt-1",
          timestamp: DateTime.makeUnsafe("2026-04-22T10:05:00.000Z"),
          location: "rack-2",
        }).remove(["alertState"])

        const afterRemove = yield* db.entities.TsAlertDevices.get({
          channel: "ch-rt",
          deviceId: "d-rt-1",
        })
        // alertState absent (Schema.optional decodes to undefined).
        expect(afterRemove.alertState).toBeUndefined()
        // Other appendInput field unaffected.
        expect(afterRemove.location).toBe("rack-2")
        // orderBy updated.
        expect(DateTime.formatIso(afterRemove.timestamp)).toBe("2026-04-22T10:05:00.000Z")
      }).pipe(provideTsAlert),
  )

  it.effect(
    "sparse-PK GSI cascade: item drops from byCurrentAlert after .remove(['alertState'])",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { TsAlertDevices },
          tables: { TsAlertTable },
        })

        // 1. Initial append → item visible under alertState=ACTIVE.
        yield* db.entities.TsAlertDevices.append({
          channel: "ch-drop",
          deviceId: "d-drop-1",
          timestamp: DateTime.makeUnsafe("2026-04-22T11:00:00.000Z"),
          alertState: "ACTIVE",
        })

        const beforeRows = yield* db.entities.TsAlertDevices.byCurrentAlert({
          alertState: "ACTIVE",
        }).collect()
        expect(beforeRows).toHaveLength(1)
        expect(beforeRows[0]!.deviceId).toBe("d-drop-1")

        // 2. .remove(['alertState']) cascades a drop on the byCurrentAlert PK
        //    half via `removedSet` → `'sparse'` → can't-compose → REMOVE.
        yield* db.entities.TsAlertDevices.append({
          channel: "ch-drop",
          deviceId: "d-drop-1",
          timestamp: DateTime.makeUnsafe("2026-04-22T11:05:00.000Z"),
        }).remove(["alertState"])

        // 3. Item must no longer be visible to byCurrentAlert(alertState=ACTIVE).
        const afterRows = yield* db.entities.TsAlertDevices.byCurrentAlert({
          alertState: "ACTIVE",
        }).collect()
        expect(afterRows).toHaveLength(0)
      }).pipe(provideTsAlert),
  )

  it.effect(
    "PK-composites-only GSI preserved: byChannel still returns item after unrelated .remove()",
    () =>
      Effect.gen(function* () {
        // Removing `location` (not part of any GSI composite) must NOT
        // disturb the byChannel GSI — the #43 fix must hold under this path.
        const db = yield* DynamoClient.make({
          entities: { TsAlertDevices },
          tables: { TsAlertTable },
        })

        yield* db.entities.TsAlertDevices.append({
          channel: "ch-preserve",
          deviceId: "d-preserve-1",
          timestamp: DateTime.makeUnsafe("2026-04-22T12:00:00.000Z"),
          location: "rack-X",
        })

        yield* db.entities.TsAlertDevices.append({
          channel: "ch-preserve",
          deviceId: "d-preserve-1",
          timestamp: DateTime.makeUnsafe("2026-04-22T12:05:00.000Z"),
        }).remove(["location"])

        const rows = yield* db.entities.TsAlertDevices.byChannel({
          channel: "ch-preserve",
        }).collect()
        expect(rows).toHaveLength(1)
        expect(rows[0]!.deviceId).toBe("d-preserve-1")
        // location is gone from the item.
        expect(rows[0]!.location).toBeUndefined()
      }).pipe(provideTsAlert),
  )

  it.effect(
    "enrichment preservation: .remove(['alertState']) leaves out-of-appendInput accountId intact",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { TsAlertDevices },
          tables: { TsAlertTable },
        })

        // Seed via append with alert state.
        yield* db.entities.TsAlertDevices.append({
          channel: "ch-enrich",
          deviceId: "d-enrich-1",
          timestamp: DateTime.makeUnsafe("2026-04-22T13:00:00.000Z"),
          alertState: "ACTIVE",
        })

        // Out-of-band enrichment via .update() — accountId is NOT in appendInput.
        yield* db.entities.TsAlertDevices.update({
          channel: "ch-enrich",
          deviceId: "d-enrich-1",
        }).set({ accountId: "acct-7" })

        // Append + remove alertState. accountId must survive — it is outside
        // appendInput, so .append() never touches it (enrichment-preservation
        // contract). .remove(['alertState']) operates on alertState only.
        yield* db.entities.TsAlertDevices.append({
          channel: "ch-enrich",
          deviceId: "d-enrich-1",
          timestamp: DateTime.makeUnsafe("2026-04-22T13:05:00.000Z"),
        }).remove(["alertState"])

        const cur = yield* db.entities.TsAlertDevices.get({
          channel: "ch-enrich",
          deviceId: "d-enrich-1",
        })
        expect(cur.accountId).toBe("acct-7")
        expect(cur.alertState).toBeUndefined()
      }).pipe(provideTsAlert),
  )

  it.effect("stale .remove(): older orderBy → StaleAppend, REMOVE not applied", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { TsAlertDevices },
        tables: { TsAlertTable },
      })

      // Seed at t=14:00 with alertState=ACTIVE.
      yield* db.entities.TsAlertDevices.append({
        channel: "ch-stale",
        deviceId: "d-stale-1",
        timestamp: DateTime.makeUnsafe("2026-04-22T14:00:00.000Z"),
        alertState: "ACTIVE",
      })

      // Stale append with older orderBy + .remove() — CAS fires, transaction
      // rejected, alertState is NOT cleared.
      const result = yield* db.entities.TsAlertDevices.append({
        channel: "ch-stale",
        deviceId: "d-stale-1",
        timestamp: DateTime.makeUnsafe("2026-04-22T13:00:00.000Z"),
      })
        .remove(["alertState"])
        .asEffect()
        .pipe(Effect.flip)

      expect(result._tag).toBe("StaleAppend")

      const cur = yield* db.entities.TsAlertDevices.get({
        channel: "ch-stale",
        deviceId: "d-stale-1",
      })
      // alertState preserved — the failed remove did not land.
      expect(cur.alertState).toBe("ACTIVE")
    }).pipe(provideTsAlert),
  )

  it.effect(
    "validation: .remove() of an attribute outside appendInput fails fast with ValidationError",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { TsAlertDevices },
          tables: { TsAlertTable },
        })

        const err = yield* db.entities.TsAlertDevices.append({
          channel: "ch-val",
          deviceId: "d-val-1",
          timestamp: DateTime.makeUnsafe("2026-04-22T15:00:00.000Z"),
        })
          .remove(["accountId"]) // accountId is NOT in appendInput
          .asEffect()
          .pipe(Effect.flip)

        expect(err._tag).toBe("ValidationError")
      }).pipe(provideTsAlert),
  )
})

// ===========================================================================
// PK-composites-only GSI shape — closes #43
// ===========================================================================
//
// The bug: GSIs whose composites are entirely entity-PK composites (e.g.
// `byChannel: { pk: [channel], sk: [deviceId] }` on an entity with
// `primaryKey: [channel, deviceId]`) had their `gsi*pk` / `gsi*sk` keys
// silently skipped under v1.7.0 / v1.7.1. Items written through `.append()`
// (and updates that didn't restate the PK composites in payload) were
// invisible to channel-scoped GSI queries.
//
// These tests exercise the v1.7.2 fix end-to-end against DDB Local: the
// items must be visible to byChannel queries after both `.append()` and
// `.update()` writes, and the GSI keys must be preserved across multiple
// updates (idempotent re-SET).
// ===========================================================================

class ChannelDevice extends Schema.Class<ChannelDevice>("ChannelDevice")({
  channel: Schema.String,
  deviceId: Schema.String,
  accountId: Schema.optional(Schema.String),
  alertState: Schema.optional(Schema.String),
  timestamp: Schema.DateTimeUtc,
  reading: Schema.optional(Schema.Number),
  otherField: Schema.optional(Schema.String),
}) {}

const ChannelDeviceAppendInput = Schema.Struct({
  channel: Schema.String,
  deviceId: Schema.String,
  timestamp: Schema.DateTimeUtc,
  reading: Schema.optional(Schema.Number),
})

const cdSchema = DynamoSchema.make({ name: "cd-test", version: 1 })
const cdTableName = `cd-test-${Date.now()}`

// PK-composites-only GSI shape — the #43 bug repro entity. Time-series
// because that was the originally-reported failure surface.
const ChannelDevicesTs = Entity.make({
  model: ChannelDevice,
  entityType: "ChannelDeviceTs",
  primaryKey: {
    pk: { field: "pk", composite: ["channel", "deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byChannel: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["channel"] },
      sk: { field: "gsi1sk", composite: ["deviceId"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
  timestamps: true,
  timeSeries: {
    orderBy: "timestamp",
    ttl: Duration.days(7),
    appendInput: ChannelDeviceAppendInput,
  },
})

// Same shape but no time-series — exercises the standard `.update()` path.
const ChannelDevicesPlain = Entity.make({
  model: ChannelDevice,
  entityType: "ChannelDevicePlain",
  primaryKey: {
    pk: { field: "pk", composite: ["channel", "deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byChannel: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["channel"] },
      sk: { field: "gsi2sk", composite: ["deviceId"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
  timestamps: true,
})

// Multi-writer entity: TWO GSIs — one PK-composites-only (byChannel on gsi3),
// one multi-writer with non-PK composites (byCurrentAlert on gsi4). Used to
// verify both behaviors coexist — PK-only fires every write (idempotent SET),
// multi-writer GSI is untouched by stamps.
const ChannelDevicesMixed = Entity.make({
  model: ChannelDevice,
  entityType: "ChannelDeviceMixed",
  primaryKey: {
    pk: { field: "pk", composite: ["channel", "deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byChannel: {
      // PK-composites-only — must fire on every write (#43).
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["channel"] },
      sk: { field: "gsi3sk", composite: ["deviceId"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
    byCurrentAlert: {
      // Multi-writer — neither composite is in the PK; stamp updates must
      // leave both halves untouched (v1.7.1 multi-writer fix preserved).
      name: "gsi4",
      pk: { field: "gsi4pk", composite: ["accountId"] },
      sk: { field: "gsi4sk", composite: ["alertState"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
  timestamps: true,
})

const CdTable = Table.make({
  schema: cdSchema,
  entities: { ChannelDevicesTs, ChannelDevicesPlain, ChannelDevicesMixed },
})
const CdLayer = Layer.mergeAll(ClientLayer, CdTable.layer({ name: cdTableName }))
const provideCd = Effect.provide(CdLayer)

describeConnected("PK-composites-only GSI shape (closes #43)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: cdTableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(CdTable),
        })
      }).pipe(provideCd, Effect.scoped),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: cdTableName })
      }).pipe(
        provideCd,
        Effect.scoped,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  it.effect(
    "Entity.append() writes gsi1pk + gsi1sk on PK-composites-only GSI; byChannel query returns the item",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { ChannelDevicesTs },
          tables: { CdTable },
        })

        yield* db.entities.ChannelDevicesTs.append({
          channel: "ch-append",
          deviceId: "d-append-1",
          timestamp: DateTime.makeUnsafe("2026-04-30T10:00:00.000Z"),
          reading: 42,
        })

        // Pre-v1.7.2 this query returned 0 items because gsi1pk / gsi1sk
        // were never written by .append().
        const rows = yield* db.entities.ChannelDevicesTs.byChannel({
          channel: "ch-append",
        }).collect()
        expect(rows).toHaveLength(1)
        expect(rows[0]!.deviceId).toBe("d-append-1")
      }).pipe(provideCd),
  )

  it.effect(
    "Entity.update().set() preserves gsi keys on PK-composites-only GSI; byChannel still returns the item",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { ChannelDevicesTs },
          tables: { CdTable },
        })

        // Seed via append.
        yield* db.entities.ChannelDevicesTs.append({
          channel: "ch-update",
          deviceId: "d-update-1",
          timestamp: DateTime.makeUnsafe("2026-04-30T10:00:00.000Z"),
        })

        // Issue an update that doesn't mention channel or deviceId in the
        // payload. Pre-v1.7.2 the per-half gate skipped both halves and
        // the gsi keys persisted unchanged (correct here only because
        // append already wrote them — but pre-v1.7.2 append didn't, so the
        // item was invisible from the start). Post-v1.7.2 the SK halves
        // SET via the broadened gate using keyRecord membership.
        yield* db.entities.ChannelDevicesTs.update({
          channel: "ch-update",
          deviceId: "d-update-1",
        }).set({ otherField: "X" })

        const rows = yield* db.entities.ChannelDevicesTs.byChannel({
          channel: "ch-update",
        }).collect()
        expect(rows).toHaveLength(1)
        expect(rows[0]!.deviceId).toBe("d-update-1")
        expect(rows[0]!.otherField).toBe("X")
      }).pipe(provideCd),
  )

  it.effect("Multiple sequential updates idempotently re-SET the same gsi key values", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { ChannelDevicesPlain },
        tables: { CdTable },
      })

      yield* db.entities.ChannelDevicesPlain.put({
        channel: "ch-idem",
        deviceId: "d-idem-1",
        timestamp: DateTime.makeUnsafe("2026-04-30T10:00:00.000Z"),
      }).asEffect()

      // Multiple updates — each one SETs gsi2pk and gsi2sk to the same
      // composed value (PK composites are immutable). DDB SET to the
      // same value is a noop on the byte representation but a billable
      // write — that's expected and acknowledged in DESIGN.md §7.
      for (const i of [1, 2, 3]) {
        yield* db.entities.ChannelDevicesPlain.update({
          channel: "ch-idem",
          deviceId: "d-idem-1",
        }).set({ otherField: `update-${i}` })
      }

      const rows = yield* db.entities.ChannelDevicesPlain.byChannel({
        channel: "ch-idem",
      }).collect()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.deviceId).toBe("d-idem-1")
      expect(rows[0]!.otherField).toBe("update-3")

      // Sanity-check the actual GSI keys via a direct query — they must
      // hold the composed values across the three SETs.
      const raw = yield* (yield* DynamoClient).getItem({
        TableName: cdTableName,
        Key: {
          pk: {
            S: "$cd-test#v1#channeldeviceplain#channel_ch-idem#deviceid_d-idem-1",
          },
          sk: { S: "$cd-test#v1#channeldeviceplain" },
        },
      })
      expect(raw.Item).toBeDefined()
      expect(raw.Item!.gsi2pk?.S).toBe("$cd-test#v1#channeldeviceplain#channel_ch-idem")
      expect(raw.Item!.gsi2sk?.S).toBe("$cd-test#v1#channeldeviceplain#deviceid_d-idem-1")
    }).pipe(provideCd),
  )

  it.effect(
    "Multi-writer GSI (NOT PK-composites-only) — stamp update leaves byCurrentAlert untouched",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { ChannelDevicesMixed },
          tables: { CdTable },
        })

        // Seed: enrichment sets accountId, telemetry sets alertState.
        yield* db.entities.ChannelDevicesMixed.put({
          channel: "ch-mixed-mw",
          deviceId: "d-mw-1",
          accountId: "acct-1",
          alertState: "active",
          timestamp: DateTime.makeUnsafe("2026-04-30T10:00:00.000Z"),
        }).asEffect()

        // Capture the byCurrentAlert key composition baseline.
        const baseline = yield* (yield* DynamoClient).getItem({
          TableName: cdTableName,
          Key: {
            pk: {
              S: "$cd-test#v1#channeldevicemixed#channel_ch-mixed-mw#deviceid_d-mw-1",
            },
            sk: { S: "$cd-test#v1#channeldevicemixed" },
          },
        })
        const baselineGsi4pk = baseline.Item?.gsi4pk?.S
        const baselineGsi4sk = baseline.Item?.gsi4sk?.S
        expect(baselineGsi4pk).toBeDefined()
        expect(baselineGsi4sk).toBeDefined()

        // Stamp writer — touches a non-composite. byCurrentAlert (gsi4)
        // composites (accountId, alertState) are NOT in the payload AND
        // NOT in keyRecord (only channel/deviceId are). Per-half gate must
        // skip both halves of byCurrentAlert. v1.7.1 multi-writer fix.
        yield* db.entities.ChannelDevicesMixed.update({
          channel: "ch-mixed-mw",
          deviceId: "d-mw-1",
        }).set({ otherField: "stamp-value" })

        const after = yield* (yield* DynamoClient).getItem({
          TableName: cdTableName,
          Key: {
            pk: {
              S: "$cd-test#v1#channeldevicemixed#channel_ch-mixed-mw#deviceid_d-mw-1",
            },
            sk: { S: "$cd-test#v1#channeldevicemixed" },
          },
        })
        // byCurrentAlert keys unchanged — multi-writer fix preserved.
        expect(after.Item?.gsi4pk?.S).toBe(baselineGsi4pk)
        expect(after.Item?.gsi4sk?.S).toBe(baselineGsi4sk)
        // byChannel keys (gsi3, PK-composites-only) SET on every write
        // (idempotent) — values unchanged but the SET clause was emitted.
        expect(after.Item?.gsi3pk?.S).toBe("$cd-test#v1#channeldevicemixed#channel_ch-mixed-mw")
        expect(after.Item?.gsi3sk?.S).toBe("$cd-test#v1#channeldevicemixed#deviceid_d-mw-1")
      }).pipe(provideCd),
  )

  it.effect(
    "Mixed entity (PK-composites-only + multi-writer GSIs) — both behaviors coexist on the same write",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { ChannelDevicesMixed },
          tables: { CdTable },
        })

        yield* db.entities.ChannelDevicesMixed.put({
          channel: "ch-mixed",
          deviceId: "d-mixed-1",
          accountId: "acct-2",
          alertState: "warning",
          timestamp: DateTime.makeUnsafe("2026-04-30T11:00:00.000Z"),
        }).asEffect()

        // Stamp update: only otherField changes. byChannel (gsi3,
        // PK-composites-only) must SET (idempotent re-compose).
        // byCurrentAlert (gsi4, multi-writer) must noop.
        yield* db.entities.ChannelDevicesMixed.update({
          channel: "ch-mixed",
          deviceId: "d-mixed-1",
        }).set({ otherField: "stamped" })

        // byChannel query (gsi3) returns the item — proves PK-composites-only
        // SET happened.
        const byChannelRows = yield* db.entities.ChannelDevicesMixed.byChannel({
          channel: "ch-mixed",
        }).collect()
        expect(byChannelRows).toHaveLength(1)
        expect(byChannelRows[0]!.deviceId).toBe("d-mixed-1")
        expect(byChannelRows[0]!.otherField).toBe("stamped")

        // byCurrentAlert query (gsi4) also returns the item — proves the
        // multi-writer GSI keys were preserved across the stamp update.
        const byAlertRows = yield* db.entities.ChannelDevicesMixed.byCurrentAlert({
          accountId: "acct-2",
        }).collect()
        expect(byAlertRows).toHaveLength(1)
        expect(byAlertRows[0]!.alertState).toBe("warning")
      }).pipe(provideCd),
  )
})

// ===========================================================================
// Entity Refs + Aggregate Connected Tests (separate table with GSI for aggregates)
// ===========================================================================

describeConnected("Entity refs and Aggregate integration tests", () => {
  beforeAll(async () => {
    // Go through DynamoClient.make so the aggregate→table auto-merge wires
    // `BlogPostAggregate`'s gsi2 collection index into the CreateTable call.
    // `BlogPostAggregate` can't be registered on `Table.make` directly because
    // it references `AggTable` — the classic circular-reference case that the
    // `DynamoClient.make({ aggregates, tables })` merge was designed for.
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Authors, Articles },
          aggregates: { BlogPostAggregate },
          tables: { AggTable },
        })
        yield* db.tables.AggTable.create()
      }).pipe(provideAgg, Effect.scoped),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: aggTableName })
      }).pipe(
        provideAgg,
        Effect.scoped,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  // -------------------------------------------------------------------------
  // Seed reference data
  // -------------------------------------------------------------------------

  describe("Entity refs", () => {
    it.effect("seed authors for ref tests", () =>
      Effect.gen(function* () {
        yield* Authors.put({ id: "alice", name: "Alice Johnson" }).asEffect()
        yield* Authors.put({ id: "bob", name: "Bob Williams" }).asEffect()

        const alice = yield* Authors.get({ id: "alice" }).asEffect()
        expect(alice.name).toBe("Alice Johnson")
      }).pipe(provideAgg),
    )

    it.effect("put with ref ID hydrates on get", () =>
      Effect.gen(function* () {
        yield* Articles.put({
          articleId: "art-1",
          title: "Effect TS Guide",
          authorId: "alice",
          status: "published",
        }).asEffect()

        const article = yield* Articles.get({ articleId: "art-1" }).asEffect()
        expect(article.title).toBe("Effect TS Guide")
        expect(article.author.id).toBe("alice")
        expect(article.author.name).toBe("Alice Johnson")
      }).pipe(provideAgg),
    )

    it.effect("asRecord includes ref data", () =>
      Effect.gen(function* () {
        const record = yield* Articles.get({ articleId: "art-1" }).pipe(Entity.asRecord)
        expect(record.author.id).toBe("alice")
        expect(record.author.name).toBe("Alice Johnson")
      }).pipe(provideAgg),
    )

    it.effect("RefNotFound when ref entity does not exist", () =>
      Effect.gen(function* () {
        const err = yield* Articles.put({
          articleId: "art-bad",
          title: "Bad Ref",
          authorId: "nonexistent",
          status: "draft",
        })
          .asEffect()
          .pipe(Effect.flip)
        expect(err._tag).toBe("RefNotFound")
      }).pipe(provideAgg),
    )

    it.effect("cascade propagates source entity changes to embedded refs", () =>
      Effect.gen(function* () {
        // Create a second article by the same author
        yield* Articles.put({
          articleId: "art-2",
          title: "Second Article",
          authorId: "alice",
          status: "draft",
        }).asEffect()

        // Update the author with cascade to Articles
        yield* Authors.update({ id: "alice" }).pipe(
          Entity.set({ name: "Alice J. Johnson" }),
          Entity.cascade({ targets: [Articles] }),
          Entity.asModel,
        )

        // Verify cascade propagated — both articles should have the updated author
        const art1 = yield* Articles.get({ articleId: "art-1" }).asEffect()
        expect(art1.author.name).toBe("Alice J. Johnson")

        const art2 = yield* Articles.get({ articleId: "art-2" }).asEffect()
        expect(art2.author.name).toBe("Alice J. Johnson")
      }).pipe(provideAgg),
    )

    it.effect("cascade does not affect articles by other authors", () =>
      Effect.gen(function* () {
        // Create an article by Bob
        yield* Articles.put({
          articleId: "art-bob",
          title: "Bob's Article",
          authorId: "bob",
          status: "published",
        }).asEffect()

        // Update Alice — should not affect Bob's article
        yield* Authors.update({ id: "alice" }).pipe(
          Entity.set({ name: "Alice Johnson" }),
          Entity.cascade({ targets: [Articles] }),
          Entity.asModel,
        )

        const bobArt = yield* Articles.get({ articleId: "art-bob" }).asEffect()
        expect(bobArt.author.name).toBe("Bob Williams")
      }).pipe(provideAgg),
    )
  })

  // -------------------------------------------------------------------------
  // Aggregate CRUD
  // -------------------------------------------------------------------------

  describe("Aggregate create + get", () => {
    it.effect("create decomposes into items and hydrates refs", () =>
      Effect.gen(function* () {
        const post = yield* BlogPostAggregate.create({
          id: "post-1",
          title: "Hello World",
          authorId: "alice",
          meta: { summary: "First post", wordCount: 500 },
          comments: [
            { id: "c1", text: "Great post!", commenter: "Charlie" },
            { id: "c2", text: "Thanks for sharing", commenter: "Dana" },
          ],
        })

        expect(post.id).toBe("post-1")
        expect(post.title).toBe("Hello World")
        // RefEdge: author hydrated from Authors entity
        expect(post.author.id).toBe("alice")
        expect(post.author.name).toBe("Alice Johnson")
        // OneEdge: meta
        expect(post.meta.summary).toBe("First post")
        expect(post.meta.wordCount).toBe(500)
        // ManyEdge: comments
        expect(post.comments).toHaveLength(2)
        expect(post.comments[0]!.text).toBe("Great post!")
        expect(post.comments[1]!.commenter).toBe("Dana")
      }).pipe(provideAgg),
    )

    it.effect("get assembles items into full domain object", () =>
      Effect.gen(function* () {
        const fetched = yield* BlogPostAggregate.get({ id: "post-1" })

        expect(fetched.id).toBe("post-1")
        expect(fetched.title).toBe("Hello World")
        expect(fetched.author.id).toBe("alice")
        expect(fetched.author.name).toBe("Alice Johnson")
        expect(fetched.meta.summary).toBe("First post")
        expect(fetched.meta.wordCount).toBe(500)
        expect(fetched.comments).toHaveLength(2)
        expect(fetched.comments.map((c) => c.commenter).sort()).toEqual(["Charlie", "Dana"])
      }).pipe(provideAgg),
    )

    it.effect("get non-existent aggregate fails with AggregateAssemblyError", () =>
      Effect.gen(function* () {
        const err = yield* BlogPostAggregate.get({ id: "nonexistent" }).pipe(Effect.flip)
        expect(err._tag).toBe("AggregateAssemblyError")
      }).pipe(provideAgg),
    )
  })

  describe("Aggregate update", () => {
    it.effect("update root field via cursor", () =>
      Effect.gen(function* () {
        const updated = yield* BlogPostAggregate.update({ id: "post-1" }, ({ cursor }) =>
          cursor.key("title").replace("Hello World (Revised)"),
        )

        expect(updated.title).toBe("Hello World (Revised)")
        // Other fields unchanged
        expect(updated.author.name).toBe("Alice Johnson")
        expect(updated.meta.summary).toBe("First post")
        expect(updated.comments).toHaveLength(2)
      }).pipe(provideAgg),
    )

    it.effect("update OneEdge field via cursor", () =>
      Effect.gen(function* () {
        const updated = yield* BlogPostAggregate.update({ id: "post-1" }, ({ cursor }) =>
          cursor.key("meta").modify((m) => ({ ...m, wordCount: 750 })),
        )

        expect(updated.meta.wordCount).toBe(750)
        expect(updated.meta.summary).toBe("First post")
      }).pipe(provideAgg),
    )

    it.effect("update ManyEdge via cursor (add comment)", () =>
      Effect.gen(function* () {
        const updated = yield* BlogPostAggregate.update({ id: "post-1" }, ({ cursor }) =>
          cursor
            .key("comments")
            .modify((comments) => [
              ...comments,
              { id: "c3", text: "New comment", commenter: "Eve" },
            ]),
        )

        expect(updated.comments).toHaveLength(3)
        expect(updated.comments.map((c) => c.commenter)).toContain("Eve")
      }).pipe(provideAgg),
    )

    it.effect("updated aggregate persists — re-read verifies", () =>
      Effect.gen(function* () {
        const fetched = yield* BlogPostAggregate.get({ id: "post-1" })

        expect(fetched.title).toBe("Hello World (Revised)")
        expect(fetched.meta.wordCount).toBe(750)
        expect(fetched.comments).toHaveLength(3)
      }).pipe(provideAgg),
    )
  })

  describe("Aggregate delete", () => {
    it.effect("delete removes all items in the partition", () =>
      Effect.gen(function* () {
        // Create a second aggregate to delete
        yield* BlogPostAggregate.create({
          id: "post-del",
          title: "Delete Me",
          authorId: "bob",
          meta: { summary: "Temporary", wordCount: 100 },
          comments: [{ id: "c-del", text: "Ephemeral", commenter: "Frank" }],
        })

        // Verify it exists
        const before = yield* BlogPostAggregate.get({ id: "post-del" })
        expect(before.title).toBe("Delete Me")

        // Delete
        yield* BlogPostAggregate.delete({ id: "post-del" })

        // Verify it's gone
        const err = yield* BlogPostAggregate.get({ id: "post-del" }).pipe(Effect.flip)
        expect(err._tag).toBe("AggregateAssemblyError")
      }).pipe(provideAgg),
    )

    it.effect("first aggregate still intact after deleting second", () =>
      Effect.gen(function* () {
        const post1 = yield* BlogPostAggregate.get({ id: "post-1" })
        expect(post1.title).toBe("Hello World (Revised)")
        expect(post1.comments).toHaveLength(3)
      }).pipe(provideAgg),
    )
  })

  // -------------------------------------------------------------------------
  // Sub-aggregate with discriminator
  // -------------------------------------------------------------------------

  describe("Sub-aggregate with discriminator", () => {
    // We reuse ReviewerNoteAggregate bound with discriminators inside a parent
    // aggregate. This is the pattern from the cricket example (TeamSheet × 2).
    // We create a Review aggregate that has editorial and peer review notes.

    class ReviewedPost extends Schema.Class<ReviewedPost>("ReviewedPost")({
      id: Schema.String,
      title: Schema.String,
      editorial: ReviewerNote,
      peer: ReviewerNote,
    }) {}

    const ReviewedPostAggregate = Aggregate.make(ReviewedPost, {
      table: AggTable,
      schema: AggSchema,
      pk: { field: "pk", composite: ["id"] },
      collection: {
        index: "gsi2",
        name: "reviewedpost",
        sk: { field: "gsi2sk", composite: ["title"] },
      },
      root: { entityType: "ReviewedPostRoot" },
      edges: {
        editorial: ReviewerNoteAggregate.with({ discriminator: { reviewType: "editorial" } }),
        peer: ReviewerNoteAggregate.with({ discriminator: { reviewType: "peer" } }),
      },
    })

    it.effect("create with discriminated sub-aggregates", () =>
      Effect.gen(function* () {
        const post = yield* ReviewedPostAggregate.create({
          id: "rev-1",
          title: "Reviewed Article",
          editorial: { reviewerId: "alice", rating: 9, text: "Excellent work" },
          peer: { reviewerId: "bob", rating: 7, text: "Needs minor revisions" },
        })

        expect(post.editorial.reviewer.name).toBe("Alice Johnson")
        expect(post.editorial.rating).toBe(9)
        expect(post.peer.reviewer.name).toBe("Bob Williams")
        expect(post.peer.rating).toBe(7)
      }).pipe(provideAgg),
    )

    it.effect("get reassembles discriminated sub-aggregates", () =>
      Effect.gen(function* () {
        const fetched = yield* ReviewedPostAggregate.get({ id: "rev-1" })

        expect(fetched.title).toBe("Reviewed Article")
        expect(fetched.editorial.reviewer.id).toBe("alice")
        expect(fetched.editorial.text).toBe("Excellent work")
        expect(fetched.peer.reviewer.id).toBe("bob")
        expect(fetched.peer.text).toBe("Needs minor revisions")
      }).pipe(provideAgg),
    )

    it.effect("update one sub-aggregate without affecting the other", () =>
      Effect.gen(function* () {
        const updated = yield* ReviewedPostAggregate.update({ id: "rev-1" }, ({ cursor }) =>
          cursor.key("editorial").modify((ed) => ({ ...ed, rating: 10 })),
        )

        expect(updated.editorial.rating).toBe(10)
        // Peer unchanged
        expect(updated.peer.rating).toBe(7)
        expect(updated.peer.text).toBe("Needs minor revisions")
      }).pipe(provideAgg),
    )

    it.effect("delete discriminated aggregate removes all items", () =>
      Effect.gen(function* () {
        yield* ReviewedPostAggregate.delete({ id: "rev-1" })

        const err = yield* ReviewedPostAggregate.get({ id: "rev-1" }).pipe(Effect.flip)
        expect(err._tag).toBe("AggregateAssemblyError")
      }).pipe(provideAgg),
    )
  })
})

// ---------------------------------------------------------------------------
// indexPolicy v1.7.1 integration tests — comprehensive multi-writer
// round-trip + per-half cascade + truncation coverage against DynamoDB Local.
//
// Asserts the v1.7.1 model end-to-end (closes #41):
//   1. Per-half evaluation gate — untouched halves stay untouched.
//   2. Per-half outcome — sparse drops the half; preserve noops or cascades.
//   3. Per-half cascade — Entity.remove drops only the half(s) containing
//      the named composite.
//   4. Set/remove asymmetry — set+remove truncates; remove alone REMOVEs.
// ---------------------------------------------------------------------------

// Hybrid telemetry-style fixture mirroring the consolidated comment in
// issue #41: byCurrentAlert has accountId on pk (preserve, enrichment-owned)
// and [alertState, timestamp] on sk (sparse, telemetry-owned). Both halves
// are touched independently by their respective writers.
class HybridDevice extends Schema.Class<HybridDevice>("HybridDevice")({
  channel: Schema.String,
  deviceId: Schema.String,
  // Enrichment-owned (preserve on pk).
  accountId: Schema.optional(Schema.String),
  // Telemetry-owned (sparse on sk).
  alertState: Schema.optional(Schema.Literals(["active", "cleared"])),
  timestamp: Schema.optional(Schema.String),
  // Stamp-style attribute — not in any GSI; touched by neither writer above.
  published: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
}) {}

const ipSchema = DynamoSchema.make({ name: "ip-test", version: 1 })
const ipTableName = `ip-test-${Date.now()}`

const HybridDevices = Entity.make({
  model: HybridDevice,
  entityType: "HybridDevice",
  primaryKey: {
    pk: { field: "pk", composite: ["channel", "deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    // The motivating multi-writer GSI from issue #41: pk preserve
    // (enrichment-owned), sk sparse (telemetry-owned).
    byCurrentAlert: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["accountId"] },
      sk: { field: "gsi1sk", composite: ["alertState", "timestamp"] },
      indexPolicy: { pk: "preserve", sk: "sparse" },
    },
    // Both-preserve GSI for testing per-half cascade override.
    byBothPreserve: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["accountId"] },
      sk: { field: "gsi2sk", composite: ["timestamp"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
  timestamps: true,
})

const IpTable = Table.make({ schema: ipSchema, entities: { HybridDevices } })
const IpTestLayer = Layer.mergeAll(ClientLayer, IpTable.layer({ name: ipTableName }))
const provideIp = Effect.provide(IpTestLayer)

// Hierarchical asset fixture for set/remove asymmetry + truncation tests.
class HierAsset extends Schema.Class<HierAsset>("HierAsset")({
  assetId: Schema.String,
  region: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  site: Schema.optional(Schema.String),
}) {}

const hierTableName = `ip-hier-${Date.now()}`

const HierAssets = Entity.make({
  model: HierAsset,
  entityType: "HierAsset",
  primaryKey: {
    pk: { field: "pk", composite: ["assetId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byLocation: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["region"] },
      sk: { field: "gsi1sk", composite: ["country", "city", "site"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
  timestamps: true,
})
const HierTable = Table.make({ schema: ipSchema, entities: { HierAssets } })
const HierTestLayer = Layer.mergeAll(ClientLayer, HierTable.layer({ name: hierTableName }))
const provideHier = Effect.provide(HierTestLayer)

describeConnected("indexPolicy v1.7.1 integration tests (closes #41)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: ipTableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(IpTable),
        })
      }).pipe(provideIp, Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: hierTableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(HierTable),
        })
      }).pipe(provideHier, Effect.scoped),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: ipTableName })
      }).pipe(
        provideIp,
        Effect.scoped,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: hierTableName })
      }).pipe(
        provideHier,
        Effect.scoped,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  // ----- Scenario 1: Stamp doesn't disturb GSI -----
  it.effect("scenario 1 — stamp writer doesn't disturb either GSI half", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { HybridDevices },
        tables: { IpTable },
      })

      // Pre-seed item with all composites; both GSIs visible.
      yield* db.entities.HybridDevices.put({
        channel: "c-s1",
        deviceId: "d-s1",
        accountId: "acme",
        alertState: "active",
        timestamp: "2026-04-30T10:00:00Z",
      })
      const beforeAlert = yield* db.entities.HybridDevices.byCurrentAlert({
        accountId: "acme",
      }).collect()
      expect(beforeAlert.some((d) => d.deviceId === "d-s1")).toBe(true)

      // Stamp writer touches only `published` — no GSI composite touched.
      yield* db.entities.HybridDevices.update({ channel: "c-s1", deviceId: "d-s1" }).set({
        published: "2026-04-30",
      })

      // v1.7.1 critical: BOTH GSIs unchanged. (v1.7.0 would have REMOVE'd
      // gsi1sk because sparse fired on the untouched sk half.)
      const afterAlert = yield* db.entities.HybridDevices.byCurrentAlert({
        accountId: "acme",
      }).collect()
      expect(afterAlert.some((d) => d.deviceId === "d-s1")).toBe(true)

      // Verify raw stored item — both GSI key attrs still present.
      const item = yield* HybridDevices.get({
        channel: "c-s1",
        deviceId: "d-s1",
      }).pipe(Entity.asItem)
      expect(item.gsi1pk).toBeDefined()
      expect(item.gsi1sk).toBeDefined()
    }).pipe(provideIp),
  )

  // ----- Scenario 2: Enrichment writer SETs pk, leaves sk alone -----
  it.effect("scenario 2 — enrichment writer SETs pk, sk untouched", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { HybridDevices },
        tables: { IpTable },
      })

      yield* db.entities.HybridDevices.put({
        channel: "c-s2",
        deviceId: "d-s2",
        accountId: "acme",
        alertState: "active",
        timestamp: "2026-04-30T10:00:00Z",
      })

      // Enrichment moves accountId. SK untouched.
      yield* db.entities.HybridDevices.update({ channel: "c-s2", deviceId: "d-s2" }).set({
        accountId: "newAcct",
      })

      // Visible under newAcct (pk SET).
      const newAcct = yield* db.entities.HybridDevices.byCurrentAlert({
        accountId: "newAcct",
      }).collect()
      expect(newAcct.some((d) => d.deviceId === "d-s2")).toBe(true)
      // No longer visible under acme.
      const acme = yield* db.entities.HybridDevices.byCurrentAlert({
        accountId: "acme",
      }).collect()
      expect(acme.some((d) => d.deviceId === "d-s2")).toBe(false)

      // SK unchanged — verify stored gsi1sk hasn't moved.
      const item = yield* HybridDevices.get({
        channel: "c-s2",
        deviceId: "d-s2",
      }).pipe(Entity.asItem)
      expect(item.gsi1sk).toBeDefined()
    }).pipe(provideIp),
  )

  // ----- Scenario 3: Telemetry writer SETs sk, leaves pk alone -----
  it.effect("scenario 3 — telemetry writer SETs sk, pk untouched", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { HybridDevices },
        tables: { IpTable },
      })

      yield* db.entities.HybridDevices.put({
        channel: "c-s3",
        deviceId: "d-s3",
        accountId: "acme",
        alertState: "active",
        timestamp: "2026-04-30T10:00:00Z",
      })

      // Telemetry tick: new alertState + timestamp. PK untouched.
      yield* db.entities.HybridDevices.update({ channel: "c-s3", deviceId: "d-s3" }).set({
        alertState: "cleared",
        timestamp: "2026-04-30T11:00:00Z",
      })

      // Still visible under acme (pk preserved).
      const acme = yield* db.entities.HybridDevices.byCurrentAlert({
        accountId: "acme",
      }).collect()
      expect(acme.some((d) => d.deviceId === "d-s3")).toBe(true)

      // Stored item reflects the new sk.
      const item = yield* HybridDevices.get({
        channel: "c-s3",
        deviceId: "d-s3",
      }).pipe(Entity.asItem)
      expect((item.gsi1sk as string).includes("cleared")).toBe(true)
    }).pipe(provideIp),
  )

  // ----- Scenario 4: Telemetry "no alert" event drops sk -----
  it.effect(
    "scenario 4 — telemetry 'no alert' (timestamp only, alertState undefined) → REMOVE sk only",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { HybridDevices },
          tables: { IpTable },
        })

        yield* db.entities.HybridDevices.put({
          channel: "c-s4",
          deviceId: "d-s4",
          accountId: "acme",
          alertState: "active",
          timestamp: "2026-04-30T10:00:00Z",
        })

        // Telemetry tick with alertState explicitly set to undefined →
        // sk touched (alertState in payload), can't compose (hole at sk[0]) →
        // sparse → REMOVE sk.
        yield* db.entities.HybridDevices.update({ channel: "c-s4", deviceId: "d-s4" }).set({
          alertState: undefined,
          timestamp: "2026-04-30T11:00:00Z",
        })

        // Item invisible in GSI (DDB projection rule needs both keys).
        const acme = yield* db.entities.HybridDevices.byCurrentAlert({
          accountId: "acme",
        }).collect()
        expect(acme.some((d) => d.deviceId === "d-s4")).toBe(false)

        // But pk preserved on the underlying item — verify raw stored attrs.
        const item = yield* HybridDevices.get({
          channel: "c-s4",
          deviceId: "d-s4",
        }).pipe(Entity.asItem)
        expect(item.gsi1pk).toBeDefined() // preserved
        expect(item.gsi1sk).toBeUndefined() // REMOVE'd
      }).pipe(provideIp),
  )

  // ----- Scenario 5: Rejoin without enrichment re-fire (closes v1.7.0 bug-1) -----
  it.effect(
    "scenario 5 — rejoin: telemetry SETs sk after a drop; pk preserved → re-visible without enrichment re-fire",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { HybridDevices },
          tables: { IpTable },
        })

        yield* db.entities.HybridDevices.put({
          channel: "c-s5",
          deviceId: "d-s5",
          accountId: "acme",
          alertState: "active",
          timestamp: "2026-04-30T10:00:00Z",
        })

        // Drop sk first.
        yield* db.entities.HybridDevices.update({ channel: "c-s5", deviceId: "d-s5" }).set({
          alertState: undefined,
          timestamp: "2026-04-30T11:00:00Z",
        })
        const dropped = yield* db.entities.HybridDevices.byCurrentAlert({
          accountId: "acme",
        }).collect()
        expect(dropped.some((d) => d.deviceId === "d-s5")).toBe(false)

        // Telemetry rejoins — sets new alertState + timestamp.
        yield* db.entities.HybridDevices.update({ channel: "c-s5", deviceId: "d-s5" }).set({
          alertState: "active",
          timestamp: "2026-04-30T12:00:00Z",
        })

        // v1.7.1 critical assertion: item re-visible under PRESERVED pk
        // (acme), with NEW sk. No enrichment writer had to re-fire.
        // (v1.7.0 would have lost gsi1pk on the drop and the rejoin alone
        // wouldn't have re-indexed the item until enrichment re-fired.)
        const rejoined = yield* db.entities.HybridDevices.byCurrentAlert({
          accountId: "acme",
        }).collect()
        expect(rejoined.some((d) => d.deviceId === "d-s5")).toBe(true)
      }).pipe(provideIp),
  )

  // ----- Scenario 6: Explicit clear via undefined ----- (already exercised by 4)
  it.effect("scenario 6 — explicit clear via undefined produces same outcome as omission", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { HybridDevices },
        tables: { IpTable },
      })

      yield* db.entities.HybridDevices.put({
        channel: "c-s6",
        deviceId: "d-s6",
        accountId: "acme",
        alertState: "active",
        timestamp: "2026-04-30T10:00:00Z",
      })

      // Explicit `alertState: undefined` — sk touched (in operator true on
      // undefined), can't compose → sparse → REMOVE sk.
      yield* db.entities.HybridDevices.update({ channel: "c-s6", deviceId: "d-s6" }).set({
        alertState: undefined,
        timestamp: "2026-04-30T11:00:00Z",
      })
      const item = yield* HybridDevices.get({
        channel: "c-s6",
        deviceId: "d-s6",
      }).pipe(Entity.asItem)
      expect(item.gsi1sk).toBeUndefined()
      expect(item.gsi1pk).toBeDefined() // preserved
    }).pipe(provideIp),
  )

  // ----- Scenario 7: Entity.remove on sparse-half composite — per-half cascade -----
  it.effect(
    "scenario 7 — Entity.remove(['alertState']) drops sk only (per-half, NOT GSI-wide)",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { HybridDevices },
          tables: { IpTable },
        })

        yield* db.entities.HybridDevices.put({
          channel: "c-s7",
          deviceId: "d-s7",
          accountId: "acme",
          alertState: "active",
          timestamp: "2026-04-30T10:00:00Z",
        })

        // Per-half cascade: alertState in sk only → REMOVE gsi1sk only.
        yield* db.entities.HybridDevices.update({ channel: "c-s7", deviceId: "d-s7" }).remove([
          "alertState",
        ])

        const item = yield* HybridDevices.get({
          channel: "c-s7",
          deviceId: "d-s7",
        }).pipe(Entity.asItem)
        // v1.7.1 critical: gsi1pk preserved (per-half cascade — not GSI-wide).
        expect(item.gsi1pk).toBeDefined()
        // sk REMOVE'd via cascade override.
        expect(item.gsi1sk).toBeUndefined()
        // The byBothPreserve gsi2 has accountId on pk (untouched, no cascade
        // — alertState not in gsi2's composites) → both halves untouched.
        expect(item.gsi2pk).toBeDefined()
        expect(item.gsi2sk).toBeDefined()
      }).pipe(provideIp),
  )

  // ----- Scenario 8: Entity.remove on preserve-half composite — cascade override -----
  it.effect(
    "scenario 8 — Entity.remove(['accountId']) under preserve → REMOVE pk via cascade override (per-half)",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { HybridDevices },
          tables: { IpTable },
        })

        yield* db.entities.HybridDevices.put({
          channel: "c-s8",
          deviceId: "d-s8",
          accountId: "acme",
          alertState: "active",
          timestamp: "2026-04-30T10:00:00Z",
        })

        // accountId is the only pk composite for both byCurrentAlert and
        // byBothPreserve. Per-half cascade fires on PK halves only — sk
        // untouched (alertState/timestamp not in removedSet, not in payload).
        yield* db.entities.HybridDevices.update({ channel: "c-s8", deviceId: "d-s8" }).remove([
          "accountId",
        ])

        const item = yield* HybridDevices.get({
          channel: "c-s8",
          deviceId: "d-s8",
        }).pipe(Entity.asItem)
        // Both PK halves REMOVE'd (cascade override under preserve fires on
        // both — accountId is in both PKs).
        expect(item.gsi1pk).toBeUndefined()
        expect(item.gsi2pk).toBeUndefined()
        // v1.7.1 critical: SK halves preserved (they don't contain
        // accountId; per-half gate skips them entirely).
        expect(item.gsi1sk).toBeDefined()
        expect(item.gsi2sk).toBeDefined()
      }).pipe(provideIp),
  )

  // ----- Scenario 9: Hierarchical truncation via set+remove -----
  it.effect(
    "scenario 9 — hierarchical truncation: set surviving + remove leaf → SET sk truncated",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { HierAssets },
          tables: { HierTable },
        })

        yield* db.entities.HierAssets.put({
          assetId: "rack-9",
          region: "americas",
          country: "us",
          city: "sf",
          site: "datacenter-1",
        })

        // Demote — drop site, keep country+city via set; structural rule
        // composes the leading prefix [country, city]. SET sk truncated.
        // PK untouched (region not in payload, not in removedSet).
        yield* db.entities.HierAssets.update({ assetId: "rack-9" })
          .set({ country: "us", city: "sf" })
          .remove(["site"])

        const item = yield* HierAssets.get({ assetId: "rack-9" }).pipe(Entity.asItem)
        // PK preserved (region untouched).
        expect(item.gsi1pk).toBeDefined()
        // SK SET to truncated leading prefix.
        expect(item.gsi1sk as string).toBe("$ip-test#v1#hierasset#country_us#city_sf")

        // begins_with query at city level still finds the asset.
        const atRegion = yield* db.entities.HierAssets.byLocation({
          region: "americas",
        }).collect()
        expect(atRegion.some((a) => a.assetId === "rack-9")).toBe(true)
      }).pipe(provideHier),
  )

  // ----- Scenario 10: Hole pattern + sparse → REMOVE sk -----
  it.effect("scenario 10 — hole pattern under sparse → REMOVE sk only (NOT GSI-wide)", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { HybridDevices },
        tables: { IpTable },
      })

      yield* db.entities.HybridDevices.put({
        channel: "c-s10",
        deviceId: "d-s10",
        accountId: "acme",
        alertState: "active",
        timestamp: "2026-04-30T10:00:00Z",
      })

      // Hole on sk: pass timestamp only; alertState absent from payload.
      // Wait — under v1.7.1, omitted means untouched per the gate. To
      // exercise hole-under-sparse here we have to TOUCH sk by including
      // alertState as undefined (or include another sk composite). We use
      // `timestamp` as the touch signal; alertState is absent (stored value
      // exists, but a fresh ingest `set({ timestamp: T })` only mentions
      // timestamp). That makes sk touched (timestamp in payload), but
      // alertState... is in stored attrs as "active" — so the merged record
      // has alertState present.
      //
      // To exercise the actual hole-under-sparse semantic, the writer must
      // touch sk AND signal alertState as absent. Use `alertState: undefined`
      // explicitly to force the hole.
      yield* db.entities.HybridDevices.update({ channel: "c-s10", deviceId: "d-s10" }).set({
        alertState: undefined,
        timestamp: "2026-04-30T11:00:00Z",
      })

      const item = yield* HybridDevices.get({
        channel: "c-s10",
        deviceId: "d-s10",
      }).pipe(Entity.asItem)
      // sk REMOVE'd via sparse + can't-compose (hole at sk[0]).
      expect(item.gsi1sk).toBeUndefined()
      // pk preserved (untouched).
      expect(item.gsi1pk).toBeDefined()
    }).pipe(provideIp),
  )

  // ----- Scenario 11: Hole pattern + preserve, no removedSet → noop -----
  it.effect(
    "scenario 11 — hole pattern under preserve (no removedSet) → noop sk (stored value retained)",
    () =>
      Effect.gen(function* () {
        // Use HierAssets with byLocation sk = [country, city, site], both
        // preserve. Hole = country present, city absent, site present.
        const dbHier = yield* DynamoClient.make({
          entities: { HierAssets },
          tables: { HierTable },
        })

        yield* dbHier.entities.HierAssets.put({
          assetId: "rack-11",
          region: "americas",
          country: "us",
          city: "sf",
          site: "datacenter-1",
        })
        const beforeStored = yield* HierAssets.get({ assetId: "rack-11" }).pipe(Entity.asItem)
        const beforeSk = beforeStored.gsi1sk

        // Touch sk with a hole pattern under preserve, no removedSet.
        // city: undefined, site: 'datacenter-2' → hole at sk[1].
        yield* dbHier.entities.HierAssets.update({ assetId: "rack-11" }).set({
          country: "us",
          city: undefined,
          site: "datacenter-2",
        })

        const item = yield* HierAssets.get({ assetId: "rack-11" }).pipe(Entity.asItem)
        // v1.7.1: preserve + can't-compose + no cascade → noop. The stored
        // gsi1sk is left at its previous value (no SET, no REMOVE).
        expect(item.gsi1sk).toBe(beforeSk)
      }).pipe(provideHier),
  )

  // ----- Scenario 12: Hole pattern + preserve + removedSet → REMOVE via cascade override -----
  it.effect(
    "scenario 12 — hole pattern under preserve + removedSet → REMOVE sk via cascade override",
    () =>
      Effect.gen(function* () {
        const dbHier = yield* DynamoClient.make({
          entities: { HierAssets },
          tables: { HierTable },
        })

        yield* dbHier.entities.HierAssets.put({
          assetId: "rack-12",
          region: "americas",
          country: "us",
          city: "sf",
          site: "datacenter-1",
        })

        // Touch sk via removedSet on city, set site to a new value → hole
        // pattern (country present, city absent via removedSet, site
        // present). Preserve + cascade override → REMOVE sk.
        yield* dbHier.entities.HierAssets.update({ assetId: "rack-12" })
          .set({ site: "datacenter-2" })
          .remove(["city"])

        const item = yield* HierAssets.get({ assetId: "rack-12" }).pipe(Entity.asItem)
        expect(item.gsi1sk).toBeUndefined()
        // pk preserved.
        expect(item.gsi1pk).toBeDefined()
      }).pipe(provideHier),
  )

  // ----- Scenario 13: Multi-writer concurrent updates -----
  it.effect(
    "scenario 13 — multi-writer sequential updates produce expected combined GSI state",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { HybridDevices },
          tables: { IpTable },
        })

        // Initial state — full composites set on put.
        yield* db.entities.HybridDevices.put({
          channel: "c-s13",
          deviceId: "d-s13",
          accountId: "acme",
          alertState: "active",
          timestamp: "2026-04-30T10:00:00Z",
        })

        // Enrichment writer fires.
        yield* db.entities.HybridDevices.update({ channel: "c-s13", deviceId: "d-s13" }).set({
          accountId: "newAcct",
        })
        // Telemetry writer fires.
        yield* db.entities.HybridDevices.update({ channel: "c-s13", deviceId: "d-s13" }).set({
          alertState: "cleared",
          timestamp: "2026-04-30T11:00:00Z",
        })

        // Both writes preserved end-to-end. Final GSI state under newAcct +
        // cleared.
        const final = yield* db.entities.HybridDevices.byCurrentAlert({
          accountId: "newAcct",
        }).collect()
        expect(final.some((d) => d.deviceId === "d-s13")).toBe(true)
        // Stale account still empty.
        const stale = yield* db.entities.HybridDevices.byCurrentAlert({
          accountId: "acme",
        }).collect()
        expect(stale.some((d) => d.deviceId === "d-s13")).toBe(false)
      }).pipe(provideIp),
  )

  // ----- Scenario 14: DDB projection invariant (documented, not library behavior) -----
  it.effect(
    "scenario 14 — DDB projection invariant: item with only one GSI key attr is invisible",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { HybridDevices },
          tables: { IpTable },
        })

        // Put with full composites — visible.
        yield* db.entities.HybridDevices.put({
          channel: "c-s14",
          deviceId: "d-s14",
          accountId: "acme",
          alertState: "active",
          timestamp: "2026-04-30T10:00:00Z",
        })
        const visible = yield* db.entities.HybridDevices.byCurrentAlert({
          accountId: "acme",
        }).collect()
        expect(visible.some((d) => d.deviceId === "d-s14")).toBe(true)

        // Drop sk only — gsi1pk persists, gsi1sk REMOVE'd.
        yield* db.entities.HybridDevices.update({ channel: "c-s14", deviceId: "d-s14" }).set({
          alertState: undefined,
          timestamp: "2026-04-30T11:00:00Z",
        })

        // DDB projection rule: GSI query returns nothing for items missing
        // either of the GSI's key attrs. This is NOT library behavior — it's
        // the DDB invariant the per-half cascade relies on. We document it
        // here so readers see the round trip.
        const invisible = yield* db.entities.HybridDevices.byCurrentAlert({
          accountId: "acme",
        }).collect()
        expect(invisible.some((d) => d.deviceId === "d-s14")).toBe(false)

        // Raw item still has gsi1pk — confirming the per-half persistence.
        const item = yield* HybridDevices.get({
          channel: "c-s14",
          deviceId: "d-s14",
        }).pipe(Entity.asItem)
        expect(item.gsi1pk).toBeDefined()
        expect(item.gsi1sk).toBeUndefined()
      }).pipe(provideIp),
  )
})

// ===========================================================================
// Empty-composite-half GSI shape — closes #46 (v1.7.3 skip-predicate reframe)
// ===========================================================================
//
// The bug (#46): GSI halves declared with `composite: []` had every
// `.some(...)` clause in the touched-predicate trivially return false, so
// `Entity.update()` skipped composing the half entirely. Items written via
// .put() (which uses the separate composeAllKeys/composeIndexKeys path) had
// the half correctly populated, but any subsequent .update() that touched
// the OTHER half left the empty-composite half untouched — and worse, an
// .update() that bound a previously-sparse GSI for the first time wrote
// only the PK half, leaving the SK half missing → invisible to the GSI.
//
// v1.7.3 reframes the gate as a skip-predicate keyed on the gate's actual
// purpose (multi-writer protection). The leading `length > 0` guard
// short-circuits empty-composite halves to "always evaluated," and
// classifyHalf (which already handled empty composites correctly as
// { kind: 'set', length: 0 }) is finally reached.
//
// These tests exercise the v1.7.3 fix end-to-end against DDB Local. They
// reproduce the #46 scenario exactly: a Vehicle entity with a sparse
// byDeviceBinding GSI whose SK composite is empty.
// ===========================================================================

class VehicleConnected extends Schema.Class<VehicleConnected>("VehicleConnected")({
  vehicleId: Schema.String,
  deviceBinding: Schema.optional(Schema.String),
  // Companion non-PK composites for the mixed-shape test.
  tenantId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  // Plain payload field — used to drive .update() calls that don't touch
  // any GSI composite directly.
  label: Schema.optional(Schema.String),
}) {}

const vehicleSchema = DynamoSchema.make({ name: "vehicle-empty", version: 1 })
const vehicleTableName = `vehicle-empty-${Date.now()}`

// The exact #46 reproducer entity.
const VehiclesByDevice = Entity.make({
  model: VehicleConnected,
  entityType: "VehicleByDevice",
  primaryKey: {
    pk: { field: "pk", composite: ["vehicleId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byDeviceBinding: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["deviceBinding"] },
      sk: { field: "gsi3sk", composite: [] },
    },
  },
  timestamps: true,
})

// Mixed entity: ONE empty-SK GSI (byDeviceBinding) + ONE multi-writer GSI
// with non-PK composites (byTenant). Used to prove the empty-composite-
// half fix coexists with the v1.7.1 multi-writer protection (#41).
const VehiclesMixed = Entity.make({
  model: VehicleConnected,
  entityType: "VehicleMixed",
  primaryKey: {
    pk: { field: "pk", composite: ["vehicleId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byDeviceBinding: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["deviceBinding"] },
      sk: { field: "gsi3sk", composite: [] },
    },
    byTenant: {
      name: "gsi4",
      pk: { field: "gsi4pk", composite: ["tenantId"] },
      sk: { field: "gsi4sk", composite: ["status"] },
      indexPolicy: { pk: "preserve", sk: "preserve" },
    },
  },
  timestamps: true,
})

const VehicleTable = Table.make({
  schema: vehicleSchema,
  entities: { VehiclesByDevice, VehiclesMixed },
})
const VehicleTestLayer = Layer.mergeAll(ClientLayer, VehicleTable.layer({ name: vehicleTableName }))
const provideVehicle = Effect.provide(VehicleTestLayer)

describeConnected("Empty-composite-half GSI shape (closes #46)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: vehicleTableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(VehicleTable),
        })
      }).pipe(provideVehicle, Effect.scoped),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: vehicleTableName })
      }).pipe(
        provideVehicle,
        Effect.scoped,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  // ----- Scenario 1: #46 reproducer end-to-end -----
  it.effect(
    "scenario 1 — put without deviceBinding, update binds it, byDeviceBinding query returns the item",
    () =>
      Effect.gen(function* () {
        // The exact #46 reproducer. Pre-v1.7.3: vehicle invisible after the
        // update because gsi3sk was never written.
        const db = yield* DynamoClient.make({
          entities: { VehiclesByDevice },
          tables: { VehicleTable },
        })

        // Step 1: put without deviceBinding → sparse, no gsi3 keys composed.
        yield* db.entities.VehiclesByDevice.put({
          vehicleId: "veh-46-1",
          // deviceBinding intentionally omitted
        })

        // Step 2: bind the device via .update().
        yield* db.entities.VehiclesByDevice.update({ vehicleId: "veh-46-1" }).set({
          deviceBinding: "cloud#dev-46-1",
        })

        // v1.7.3 critical: byDeviceBinding query MUST return the vehicle.
        // Pre-v1.7.3 this returned 0 items because gsi3sk was never written.
        const rows = yield* db.entities.VehiclesByDevice.byDeviceBinding({
          deviceBinding: "cloud#dev-46-1",
        }).collect()
        expect(rows).toHaveLength(1)
        expect(rows[0]!.vehicleId).toBe("veh-46-1")

        // Verify the raw item — both halves of gsi3 must be present.
        const raw = yield* (yield* DynamoClient).getItem({
          TableName: vehicleTableName,
          Key: {
            pk: { S: "$vehicle-empty#v1#vehiclebydevice#vehicleid_veh-46-1" },
            sk: { S: "$vehicle-empty#v1#vehiclebydevice" },
          },
        })
        expect(raw.Item).toBeDefined()
        expect(raw.Item!.gsi3pk?.S).toBe(
          "$vehicle-empty#v1#vehiclebydevice#devicebinding_cloud#dev-46-1",
        )
        // The empty-composite half — gsi3sk MUST be the constant entity prefix.
        expect(raw.Item!.gsi3sk?.S).toBe("$vehicle-empty#v1#vehiclebydevice")
      }).pipe(provideVehicle),
  )

  // ----- Scenario 2: Idempotent re-update -----
  it.effect("scenario 2 — multiple sequential updates keep gsi3 keys consistent", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { VehiclesByDevice },
        tables: { VehicleTable },
      })

      yield* db.entities.VehiclesByDevice.put({
        vehicleId: "veh-46-2",
        deviceBinding: "cloud#dev-initial",
      })

      // Three updates: change deviceBinding, change a label, change
      // deviceBinding again. Each one must keep gsi3pk consistent with the
      // CURRENT deviceBinding and gsi3sk consistent with the constant
      // entity prefix.
      yield* db.entities.VehiclesByDevice.update({ vehicleId: "veh-46-2" }).set({
        deviceBinding: "cloud#dev-second",
      })
      yield* db.entities.VehiclesByDevice.update({ vehicleId: "veh-46-2" }).set({
        label: "stamped",
      })
      yield* db.entities.VehiclesByDevice.update({ vehicleId: "veh-46-2" }).set({
        deviceBinding: "cloud#dev-third",
      })

      // Final state — vehicle visible under cloud#dev-third only.
      const third = yield* db.entities.VehiclesByDevice.byDeviceBinding({
        deviceBinding: "cloud#dev-third",
      }).collect()
      expect(third).toHaveLength(1)
      expect(third[0]!.vehicleId).toBe("veh-46-2")
      expect(third[0]!.label).toBe("stamped")

      // Older bindings — no rows.
      const initial = yield* db.entities.VehiclesByDevice.byDeviceBinding({
        deviceBinding: "cloud#dev-initial",
      }).collect()
      expect(initial).toHaveLength(0)
      const second = yield* db.entities.VehiclesByDevice.byDeviceBinding({
        deviceBinding: "cloud#dev-second",
      }).collect()
      expect(second).toHaveLength(0)

      // gsi3sk must remain the constant entity prefix across all updates.
      const raw = yield* (yield* DynamoClient).getItem({
        TableName: vehicleTableName,
        Key: {
          pk: { S: "$vehicle-empty#v1#vehiclebydevice#vehicleid_veh-46-2" },
          sk: { S: "$vehicle-empty#v1#vehiclebydevice" },
        },
      })
      expect(raw.Item!.gsi3sk?.S).toBe("$vehicle-empty#v1#vehiclebydevice")
    }).pipe(provideVehicle),
  )

  // ----- Scenario 3: Mixed entity (#46 fix + #41 multi-writer fix coexist) -----
  it.effect(
    "scenario 3 — mixed entity: empty-SK GSI fixes; multi-writer GSI on same entity untouched by stamps",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { VehiclesMixed },
          tables: { VehicleTable },
        })

        // Seed: full vehicle with deviceBinding + tenantId + status.
        yield* db.entities.VehiclesMixed.put({
          vehicleId: "veh-46-3",
          deviceBinding: "cloud#dev-mixed",
          tenantId: "tenant-1",
          status: "active",
        })

        // Capture baseline byTenant key composition.
        const baseline = yield* (yield* DynamoClient).getItem({
          TableName: vehicleTableName,
          Key: {
            pk: { S: "$vehicle-empty#v1#vehiclemixed#vehicleid_veh-46-3" },
            sk: { S: "$vehicle-empty#v1#vehiclemixed" },
          },
        })
        const baselineGsi4pk = baseline.Item?.gsi4pk?.S
        const baselineGsi4sk = baseline.Item?.gsi4sk?.S
        expect(baselineGsi4pk).toBeDefined()
        expect(baselineGsi4sk).toBeDefined()

        // Stamp update: only label changes. Neither byDeviceBinding's
        // composites (deviceBinding) nor byTenant's composites (tenantId,
        // status) are in the payload.
        // - byDeviceBinding.pk: skipped (multi-writer protection — composite
        //   absent). gsi3pk preserved.
        // - byDeviceBinding.sk: empty composite → ALWAYS evaluated → constant
        //   prefix re-SET. gsi3sk preserved with the same value.
        // - byTenant.pk + sk: skipped (multi-writer protection). gsi4pk +
        //   gsi4sk preserved untouched. v1.7.1 #41 fix preserved.
        yield* db.entities.VehiclesMixed.update({ vehicleId: "veh-46-3" }).set({
          label: "stamped",
        })

        const after = yield* (yield* DynamoClient).getItem({
          TableName: vehicleTableName,
          Key: {
            pk: { S: "$vehicle-empty#v1#vehiclemixed#vehicleid_veh-46-3" },
            sk: { S: "$vehicle-empty#v1#vehiclemixed" },
          },
        })
        // byTenant unchanged — multi-writer fix preserved across stamp.
        expect(after.Item?.gsi4pk?.S).toBe(baselineGsi4pk)
        expect(after.Item?.gsi4sk?.S).toBe(baselineGsi4sk)
        // byDeviceBinding still visible under cloud#dev-mixed.
        const byDev = yield* db.entities.VehiclesMixed.byDeviceBinding({
          deviceBinding: "cloud#dev-mixed",
        }).collect()
        expect(byDev.some((v) => v.vehicleId === "veh-46-3")).toBe(true)
        // byTenant still visible.
        const byTen = yield* db.entities.VehiclesMixed.byTenant({
          tenantId: "tenant-1",
        }).collect()
        expect(byTen.some((v) => v.vehicleId === "veh-46-3")).toBe(true)

        // gsi3sk constant prefix preserved.
        expect(after.Item?.gsi3sk?.S).toBe("$vehicle-empty#v1#vehiclemixed")
      }).pipe(provideVehicle),
  )

  // ----- Scenario 4: Entity.remove on the empty-composite-half GSI's PK -----
  it.effect(
    "scenario 4 — Entity.remove(['deviceBinding']) on empty-SK GSI: PK REMOVE'd via cascade, SK still SET (constant prefix)",
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { VehiclesByDevice },
          tables: { VehicleTable },
        })

        // Seed: vehicle with deviceBinding.
        yield* db.entities.VehiclesByDevice.put({
          vehicleId: "veh-46-4",
          deviceBinding: "cloud#dev-to-remove",
        })

        // Item visible.
        const before = yield* db.entities.VehiclesByDevice.byDeviceBinding({
          deviceBinding: "cloud#dev-to-remove",
        }).collect()
        expect(before).toHaveLength(1)

        // Remove the deviceBinding attribute. PK half touched via
        // removedSet, can't compose without deviceBinding → preserve +
        // cascade override → REMOVE gsi3pk. SK half (empty composite) →
        // always evaluated → constant prefix re-SET.
        yield* db.entities.VehiclesByDevice.update({ vehicleId: "veh-46-4" }).remove([
          "deviceBinding",
        ])

        // Item invisible (DDB needs both keys for projection).
        const after = yield* db.entities.VehiclesByDevice.byDeviceBinding({
          deviceBinding: "cloud#dev-to-remove",
        }).collect()
        expect(after).toHaveLength(0)

        // Raw item: gsi3pk REMOVE'd, gsi3sk still present (constant prefix).
        const raw = yield* (yield* DynamoClient).getItem({
          TableName: vehicleTableName,
          Key: {
            pk: { S: "$vehicle-empty#v1#vehiclebydevice#vehicleid_veh-46-4" },
            sk: { S: "$vehicle-empty#v1#vehiclebydevice" },
          },
        })
        expect(raw.Item).toBeDefined()
        expect(raw.Item!.gsi3pk).toBeUndefined()
        expect(raw.Item!.gsi3sk?.S).toBe("$vehicle-empty#v1#vehiclebydevice")
      }).pipe(provideVehicle),
  )
})

// ---------------------------------------------------------------------------
// TTL attribute name override (closes #51)
//
// Consumers may have pre-existing tables whose `TimeToLiveSpecification.AttributeName`
// is not `_ttl` (the library default). This describeConnected block verifies the
// end-to-end behaviour with `TableConfig.ttlAttributeName: "ttl"` across all
// three lifecycle features that write TTL — `timeSeries: { ttl }`,
// `softDelete: { ttl }`, and `versioned: { retain, ttl }` — and the restore
// path that strips the configured name.
// ---------------------------------------------------------------------------

class TtlEvent extends Schema.Class<TtlEvent>("TtlEvent")({
  channel: Schema.String,
  deviceId: Schema.String,
  timestamp: Schema.DateTimeUtc,
  reading: Schema.optional(Schema.Number),
}) {}

const TtlEventAppendInput = Schema.Struct({
  channel: Schema.String,
  deviceId: Schema.String,
  timestamp: Schema.DateTimeUtc,
  reading: Schema.optional(Schema.Number),
})

class TtlSoftItem extends Schema.Class<TtlSoftItem>("TtlSoftItem")({
  itemId: Schema.String,
  label: Schema.String,
}) {}

class TtlRetainItem extends Schema.Class<TtlRetainItem>("TtlRetainItem")({
  itemId: Schema.String,
  payload: Schema.String,
}) {}

const ttlSchema = DynamoSchema.make({ name: "ttl-attr-test", version: 1 })
const ttlTableName = `ttl-attr-test-${Date.now()}`

const TtlEvents = Entity.make({
  model: TtlEvent,
  entityType: "TtlEvent",
  primaryKey: {
    pk: { field: "pk", composite: ["channel", "deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  timeSeries: {
    orderBy: "timestamp",
    ttl: Duration.days(7),
    appendInput: TtlEventAppendInput,
  },
})

const TtlSoftItems = Entity.make({
  model: TtlSoftItem,
  entityType: "TtlSoftItem",
  primaryKey: {
    pk: { field: "pk", composite: ["itemId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  versioned: true,
  softDelete: { ttl: Duration.days(30) },
})

const TtlRetainItems = Entity.make({
  model: TtlRetainItem,
  entityType: "TtlRetainItem",
  primaryKey: {
    pk: { field: "pk", composite: ["itemId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  versioned: { retain: true, ttl: Duration.days(90) },
})

const TtlTable = Table.make({
  schema: ttlSchema,
  entities: { TtlEvents, TtlSoftItems, TtlRetainItems },
})
const TtlTestLayer = Layer.mergeAll(
  ClientLayer,
  TtlTable.layer({ name: ttlTableName, ttlAttributeName: "ttl" }),
)
const provideTtl = Effect.provide(TtlTestLayer)

describeConnected("TableConfig.ttlAttributeName override (closes #51)", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: ttlTableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(TtlTable),
        })
      }).pipe(provideTtl, Effect.scoped),
    )
  }, 15000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: ttlTableName })
      }).pipe(
        provideTtl,
        Effect.scoped,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 15000)

  it.effect("timeSeries event writes TTL to the configured attribute name", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { TtlEvents },
        tables: { TtlTable },
      })

      // Pin the ambient Clock so TTL (now + offset, via DateTime.now — #56) is exact.
      yield* TestClock.setTime(1767225600000) // 2026-01-01T00:00:00.000Z
      yield* db.entities.TtlEvents.append({
        channel: "c-cfg-1",
        deviceId: "d-1",
        timestamp: DateTime.makeUnsafe("2026-04-22T10:00:00.000Z"),
      })

      const raw = yield* (yield* DynamoClient).query({
        TableName: ttlTableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": { S: "$ttl-attr-test#v1#ttlevent#channel_c-cfg-1#deviceid_d-1" },
          ":skPrefix": { S: "$ttl-attr-test#v1#ttlevent#e#" },
        },
      })
      expect(raw.Items).toBeDefined()
      expect(raw.Items!.length).toBe(1)
      const event = raw.Items![0]!
      // Configured attribute "ttl" carries the epoch-seconds expiry.
      expect(event.ttl?.N).toBeDefined()
      // Exactly 7 days (Duration.days(7)) past the pinned instant.
      expect(Number(event.ttl!.N)).toBe(1767225600 + 7 * 86400)
      // Library default "_ttl" must NOT be written when override is in effect.
      expect(event._ttl).toBeUndefined()
    }).pipe(provideTtl),
  )

  it.effect("soft-deleted item writes TTL to the configured attribute name", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { TtlSoftItems },
        tables: { TtlTable },
      })

      // Pin the ambient Clock so TTL (now + offset, via DateTime.now — #56) is exact.
      yield* TestClock.setTime(1767225600000) // 2026-01-01T00:00:00.000Z
      yield* db.entities.TtlSoftItems.put({ itemId: "sd-1", label: "to be deleted" })
      yield* db.entities.TtlSoftItems.delete({ itemId: "sd-1" })

      // Read the soft-deleted record raw to assert the attribute name.
      const raw = yield* (yield* DynamoClient).query({
        TableName: ttlTableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": { S: "$ttl-attr-test#v1#ttlsoftitem#itemid_sd-1" },
          ":skPrefix": { S: "$ttl-attr-test#v1#ttlsoftitem#deleted#" },
        },
      })
      expect(raw.Items).toBeDefined()
      expect(raw.Items!.length).toBe(1)
      const deleted = raw.Items![0]!
      expect(deleted.ttl?.N).toBeDefined()
      // Exactly 30 days (Duration.days(30)) past the pinned instant.
      expect(Number(deleted.ttl!.N)).toBe(1767225600 + 30 * 86400)
      expect(deleted._ttl).toBeUndefined()
    }).pipe(provideTtl),
  )

  it.effect("restore strips the configured TTL attribute from the resurrected item", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { TtlSoftItems },
        tables: { TtlTable },
      })

      yield* db.entities.TtlSoftItems.put({ itemId: "sd-2", label: "round-trip" })
      yield* db.entities.TtlSoftItems.delete({ itemId: "sd-2" })
      yield* db.entities.TtlSoftItems.restore({ itemId: "sd-2" })

      const raw = yield* (yield* DynamoClient).getItem({
        TableName: ttlTableName,
        Key: {
          pk: { S: "$ttl-attr-test#v1#ttlsoftitem#itemid_sd-2" },
          sk: { S: "$ttl-attr-test#v1#ttlsoftitem" },
        },
      })
      expect(raw.Item).toBeDefined()
      // Restored item should not carry the TTL — restore strips the configured name.
      expect(raw.Item!.ttl).toBeUndefined()
      expect(raw.Item!._ttl).toBeUndefined()
    }).pipe(provideTtl),
  )

  it.effect("versioned snapshot writes TTL to the configured attribute name", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { TtlRetainItems },
        tables: { TtlTable },
      })

      // Pin the ambient Clock so TTL (now + offset, via DateTime.now — #56) is exact.
      yield* TestClock.setTime(1767225600000) // 2026-01-01T00:00:00.000Z
      // First put produces a v1 snapshot under the retain config (which has ttl).
      yield* db.entities.TtlRetainItems.put({ itemId: "rt-1", payload: "initial" })

      const raw = yield* (yield* DynamoClient).query({
        TableName: ttlTableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": { S: "$ttl-attr-test#v1#ttlretainitem#itemid_rt-1" },
          ":skPrefix": { S: "$ttl-attr-test#v1#ttlretainitem#v#" },
        },
      })
      expect(raw.Items).toBeDefined()
      expect(raw.Items!.length).toBe(1)
      const snapshot = raw.Items![0]!
      expect(snapshot.ttl?.N).toBeDefined()
      // Exactly 90 days (Duration.days(90)) past the pinned instant.
      expect(Number(snapshot.ttl!.N)).toBe(1767225600 + 90 * 86400)
      expect(snapshot._ttl).toBeUndefined()
    }).pipe(provideTtl),
  )
})
