/**
 * Blog Example — Multi-Entity Single-Table Design
 *
 * Demonstrates effect-dynamodb v2 features using a blog application
 * with three entity types (User, Post, Comment) in a single DynamoDB table.
 *
 * Access patterns:
 * 1. Get user by userId               → Primary key
 * 2. Get post by postId               → Primary key
 * 3. Get all posts by a user          → GSI1: byAuthor
 * 4. Get all comments on a post       → GSI1: byPost
 * 5. Atomic reads/writes              → Transactions
 * 6. Multi-entity collection queries  → Collection on GSI1
 *
 * Key API patterns demonstrated:
 * - yield* returns clean model types (User, Post, Comment)
 * - Entity.asRecord for system fields (timestamps, version)
 * - Entity-scoped set() + expectedVersion() for type-safe pipeable updates
 * - Entity.asNative for raw DynamoDB format
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/blog.ts
 */

import { Console, Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// =============================================================================
// 1. Pure domain models — no DynamoDB concepts
// =============================================================================

class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  bio: Schema.optional(Schema.String),
  postCount: Schema.Number,
}) {}

class Post extends Schema.Class<Post>("Post")({
  postId: Schema.String,
  authorId: Schema.String,
  title: Schema.NonEmptyString,
  content: Schema.String,
  status: Schema.Literals(["draft", "published", "archived"]),
  commentCount: Schema.Number,
}) {}

class Comment extends Schema.Class<Comment>("Comment")({
  commentId: Schema.String,
  postId: Schema.String,
  authorId: Schema.String,
  body: Schema.NonEmptyString,
}) {}

// =============================================================================
// 2. Schema + Table
// =============================================================================

const BlogSchema = DynamoSchema.make({ name: "blog", version: 1 })
const BlogTable = Table.make({ schema: BlogSchema })

// =============================================================================
// 3. Entity definitions — bind models to table with composite indexes
// =============================================================================

const Users = Entity.make({
  model: User,
  table: BlogTable,
  entityType: "User",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: [] },
    },
  },
  timestamps: true,
  versioned: true,
})

const Posts = Entity.make({
  model: Post,
  table: BlogTable,
  entityType: "Post",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["postId"] },
      sk: { field: "sk", composite: [] },
    },
    byAuthor: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["authorId"] },
      sk: { field: "gsi1sk", composite: ["postId"] },
    },
  },
  timestamps: true,
})

const Comments = Entity.make({
  model: Comment,
  table: BlogTable,
  entityType: "Comment",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["commentId"] },
      sk: { field: "sk", composite: [] },
    },
    byPost: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["postId"] },
      sk: { field: "gsi1sk", composite: ["commentId"] },
    },
  },
  timestamps: true,
})

// =============================================================================
// 4. Main program
// =============================================================================

const program = Effect.gen(function* () {
  const client = yield* DynamoClient

  // --- Setup ---
  yield* Console.log("=== Setup ===\n")

  yield* client.createTable({
    TableName: "blog-table",
    BillingMode: "PAY_PER_REQUEST",
    ...Table.definition(BlogTable, [Users, Posts, Comments]),
  })
  yield* Console.log("Table created: blog-table\n")

  // --- Pattern 1: Put + Get — clean model types ---
  yield* Console.log("=== Pattern 1: Put + Get (Model Types) ===\n")

  // yield* returns User — clean class name, no system fields
  const alice = yield* Users.put({
    userId: "alice-1",
    email: "alice@blog.com",
    displayName: "Alice",
    postCount: 0,
  })
  // alice: User
  yield* Console.log(`Created user: ${alice.displayName} (${alice.email})`)

  // asRecord to see system fields
  const aliceRecord = yield* Users.get({ userId: "alice-1" }).pipe(Entity.asRecord)
  yield* Console.log(`  version: ${aliceRecord.version}, createdAt: ${aliceRecord.createdAt}\n`)

  // --- Pattern 2: Multiple entity types in one table ---
  yield* Console.log("=== Pattern 2: Multi-Entity Single Table ===\n")

  const post1 = yield* Posts.put({
    postId: "post-1",
    authorId: "alice-1",
    title: "Getting Started with Effect TS",
    content: "Effect is a powerful functional programming library...",
    status: "published",
    commentCount: 0,
  })
  yield* Console.log(`Created post: "${post1.title}" (${post1.status})`)

  yield* Posts.put({
    postId: "post-2",
    authorId: "alice-1",
    title: "DynamoDB Single-Table Design",
    content: "Single-table design is a DynamoDB best practice...",
    status: "published",
    commentCount: 0,
  })

  yield* Posts.put({
    postId: "post-3",
    authorId: "alice-1",
    title: "Draft Post",
    content: "Work in progress...",
    status: "draft",
    commentCount: 0,
  })
  yield* Console.log("Created posts: post-1, post-2, post-3")

  yield* Comments.put({
    commentId: "comment-1",
    postId: "post-1",
    authorId: "bob-1",
    body: "Great article!",
  })

  yield* Comments.put({
    commentId: "comment-2",
    postId: "post-1",
    authorId: "charlie-1",
    body: "Very helpful, thanks!",
  })
  yield* Console.log("Created comments: comment-1, comment-2\n")

  // --- Pattern 3: GSI Queries ---
  yield* Console.log("=== Pattern 3: GSI Queries ===\n")

  // Posts by author
  const alicePosts = yield* Query.collect(Posts.query.byAuthor({ authorId: "alice-1" }))
  yield* Console.log(`Alice's posts (${alicePosts.length}):`)
  for (const p of alicePosts) {
    yield* Console.log(`  ${p.postId}: "${p.title}" — ${p.status}`)
  }

  // Comments on a post
  const postComments = yield* Query.collect(Comments.query.byPost({ postId: "post-1" }))
  yield* Console.log(`\nComments on post-1 (${postComments.length}):`)
  for (const c of postComments) {
    yield* Console.log(`  ${c.commentId}: "${c.body}" (by ${c.authorId})`)
  }
  yield* Console.log("")

  // --- Pattern 4: Pipeable updates ---
  yield* Console.log("=== Pattern 4: Pipeable Updates ===\n")

  // Users.update(key) + Users.set(fields) — type-safe in both paths
  const updatedAlice = yield* Users.update({ userId: "alice-1" }).pipe(
    Users.set({ displayName: "Alice B.", postCount: 3 }),
  )
  // updatedAlice: User
  yield* Console.log(
    `Updated user: ${updatedAlice.displayName} (postCount: ${updatedAlice.postCount})`,
  )

  // Combine set + asRecord to see version increment
  const aliceV2 = yield* Users.update({ userId: "alice-1" }).pipe(
    Users.set({ bio: "Effect TS enthusiast" }),
    Entity.asRecord,
  )
  yield* Console.log(`  version: ${aliceV2.version}, bio: ${aliceV2.bio}`)

  // expectedVersion for optimistic locking
  const lockResult = yield* Users.update({ userId: "alice-1" }).pipe(
    Users.set({ displayName: "Wrong Name" }),
    Users.expectedVersion(1), // version is now 3 — this will fail
    (op) => op.asEffect(),
    Effect.map(() => "unexpected success"),
    Effect.catchTag("OptimisticLockError", (e) =>
      Effect.succeed(`Caught OptimisticLockError: expected v${e.expectedVersion}`),
    ),
  )
  yield* Console.log(`  ${lockResult}\n`)

  // --- Pattern 5: Transactions — composable API ---
  yield* Console.log("=== Pattern 5: Transactions ===\n")

  // Atomic multi-entity read — typed tuple, no cast needed
  const [txUser, txPost] = yield* Transaction.transactGet([
    Users.get({ userId: "alice-1" }),
    Posts.get({ postId: "post-1" }),
  ])
  // txUser: User | undefined, txPost: Post | undefined
  yield* Console.log(`transactGet: fetched 2 items atomically`)
  yield* Console.log(`  User: ${txUser?.displayName}`)
  yield* Console.log(`  Post: "${txPost?.title}"`)

  // Atomic multi-entity write — entity intermediates directly
  yield* Transaction.transactWrite([
    Posts.put({
      postId: "post-4",
      authorId: "alice-1",
      title: "Atomic Operations",
      content: "Transactions ensure consistency...",
      status: "published",
      commentCount: 0,
    }),
    Posts.delete({ postId: "post-3" }),
  ])
  yield* Console.log("\ntransactWrite: created post-4 + deleted post-3 atomically\n")

  // --- Pattern 6: Collection queries ---
  yield* Console.log("=== Pattern 6: Collection Queries ===\n")

  // Query comments on a post via the entity's own query method.
  // Comments.query.byPost hits the same GSI as a Collection query would.
  const comments = yield* Query.collect(Comments.query.byPost({ postId: "post-1" }))
  yield* Console.log(`Collection query — comments on post-1: ${comments.length}`)
  for (const c of comments) {
    yield* Console.log(`  ${c.commentId}: "${c.body}"\n`)
  }

  // --- Pattern 7: asNative for debugging ---
  yield* Console.log("=== Pattern 7: asNative (Raw DynamoDB) ===\n")

  const rawPost = yield* Posts.get({ postId: "post-1" }).pipe(Entity.asNative)
  yield* Console.log("Raw DynamoDB item (first 150 chars):")
  yield* Console.log(`  ${JSON.stringify(rawPost).slice(0, 150)}...\n`)

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")

  yield* Users.delete({ userId: "alice-1" })
  yield* Posts.delete({ postId: "post-1" })
  yield* Posts.delete({ postId: "post-2" })
  yield* Posts.delete({ postId: "post-4" })
  yield* Comments.delete({ commentId: "comment-1" })
  yield* Comments.delete({ commentId: "comment-2" })
  yield* Console.log("Deleted all items")

  yield* client.deleteTable({ TableName: "blog-table" })
  yield* Console.log("Table deleted.")
})

// =============================================================================
// 5. Provide dependencies and run
// =============================================================================

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  BlogTable.layer({ name: "blog-table" }),
)

const main = program.pipe(Effect.provide(AppLayer), Effect.scoped)

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)

export { program, BlogTable, Users, Posts, Comments, User, Post, Comment }
