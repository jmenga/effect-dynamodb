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
import { Effect, Layer, Schema, Stream } from "effect"
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

const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000"

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
      index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      composite: ["role"],
      sk: ["userId"],
    },
    byEmail: { index: { name: "gsi2", pk: "gsi2pk", sk: "gsi2sk" }, composite: ["email"], sk: [] },
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
      index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      composite: ["userId"],
      sk: ["status", "taskId"],
    },
  },
  timestamps: true,
  versioned: true,
  softDelete: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { Users, Tasks } })

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
      index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      composite: ["authorId"],
      sk: ["articleId"],
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
          ...Table.definition(MainTable, [Users, Tasks]),
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
        Effect.catchTag("DynamoError", () => Effect.void),
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
        const todos = yield* Tasks.query.byUser({ userId: "u-query" }).pipe(
          Query.where({
            beginsWith: `$connected-test#v1#task#todo`,
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
// Entity Refs + Aggregate Connected Tests (separate table with GSI for aggregates)
// ===========================================================================

describeConnected("Entity refs and Aggregate integration tests", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: aggTableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(AggTable, [Authors, Articles, BlogPostAggregate]),
        })
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
        Effect.catchTag("DynamoError", () => Effect.void),
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
