/**
 * Blog Example — Multi-Entity Single-Table Design
 *
 * Demonstrates effect-dynamodb v2 features using a blog application
 * with three entity types (User, Post, Comment) in a single DynamoDB table.
 *
 * Access patterns:
 * 1. Get user by userId               -> Primary key
 * 2. Get post by postId               -> Primary key
 * 3. Get all posts by a user          -> GSI1: byAuthor (collection)
 * 4. Get all comments on a post       -> GSI1: byPost (collection)
 * 5. Atomic reads/writes              -> Transactions
 * 6. Multi-entity collection queries  -> Collection on GSI1
 *
 * Key API patterns demonstrated:
 * - DynamoClient.make({ entities, collections }) typed gateway pattern
 * - db.entities.Entity methods return Effect directly
 * - db.entities.Entity.indexName(pk) for composing index queries
 * - db.entities.Entity.update(key, ...combinators) for type-safe updates
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
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// =============================================================================
// 1. Pure domain models — no DynamoDB concepts
// =============================================================================

// #region models
class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  bio: Schema.optional(Schema.String),
  postCount: Schema.Number,
}) {}

const PostStatus = { Draft: "draft", Published: "published", Archived: "archived" } as const
const PostStatusSchema = Schema.Literals(Object.values(PostStatus))

class Post extends Schema.Class<Post>("Post")({
  postId: Schema.String,
  authorId: Schema.String,
  title: Schema.NonEmptyString,
  content: Schema.String,
  status: PostStatusSchema,
  commentCount: Schema.Number,
}) {}

class Comment extends Schema.Class<Comment>("Comment")({
  commentId: Schema.String,
  postId: Schema.String,
  authorId: Schema.String,
  body: Schema.NonEmptyString,
}) {}
// #endregion

// =============================================================================
// 2. Schema
// =============================================================================

// #region schema
const BlogSchema = DynamoSchema.make({ name: "blog", version: 1 })
// #endregion

// =============================================================================
// 3. Entity definitions — primary key only, no GSIs
// =============================================================================

// #region user-entity
const Users = Entity.make({
  model: User,
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["userId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  versioned: true,
})
// #endregion

// #region post-entity
const Posts = Entity.make({
  model: Post,
  entityType: "Post",
  primaryKey: {
    pk: { field: "pk", composite: ["postId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byAuthor: {
      index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      composite: ["authorId"],
      sk: ["postId"],
    },
  },
  timestamps: true,
})
// #endregion

// #region comment-entity
const Comments = Entity.make({
  model: Comment,
  entityType: "Comment",
  primaryKey: {
    pk: { field: "pk", composite: ["commentId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byPost: {
      index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
      composite: ["postId"],
      sk: ["commentId"],
    },
  },
  timestamps: true,
})

const BlogTable = Table.make({
  schema: BlogSchema,
  entities: { Users, Posts, Comments },
})

// #endregion

// =============================================================================
// 5. Main program
// =============================================================================

const program = Effect.gen(function* () {
  // #region seed-data
  // Typed execution gateway
  const db = yield* DynamoClient.make({
    entities: { Users, Posts, Comments },
  })

  yield* db.tables["blog-table"]!.create()

  // yield* returns User — clean class name, no system fields
  const alice = yield* db.entities.Users.put({
    userId: "alice-1",
    email: "alice@blog.com",
    displayName: "Alice",
    postCount: 0,
  })

  // get returns model instance by default, with system fields available
  const aliceWithMeta = yield* db.entities.Users.get({ userId: "alice-1" })
  // #endregion

  // --- Setup ---
  yield* Console.log("=== Setup ===\n")
  yield* Console.log("Table created: blog-table\n")

  // --- Pattern 1: Put + Get — clean model types ---
  yield* Console.log("=== Pattern 1: Put + Get (Model Types) ===\n")
  // alice: User
  yield* Console.log(`Created user: ${alice.displayName} (${alice.email})`)
  yield* Console.log(`  retrieved: ${aliceWithMeta?.displayName}\n`)

  // --- Pattern 2: Multiple entity types in one table ---
  yield* Console.log("=== Pattern 2: Multi-Entity Single Table ===\n")

  const post1 = yield* db.entities.Posts.put({
    postId: "post-1",
    authorId: "alice-1",
    title: "Getting Started with Effect TS",
    content: "Effect is a powerful functional programming library...",
    status: "published",
    commentCount: 0,
  })
  yield* Console.log(`Created post: "${post1.title}" (${post1.status})`)

  yield* db.entities.Posts.put({
    postId: "post-2",
    authorId: "alice-1",
    title: "DynamoDB Single-Table Design",
    content: "Single-table design is a DynamoDB best practice...",
    status: "published",
    commentCount: 0,
  })

  yield* db.entities.Posts.put({
    postId: "post-3",
    authorId: "alice-1",
    title: "Draft Post",
    content: "Work in progress...",
    status: "draft",
    commentCount: 0,
  })
  yield* Console.log("Created posts: post-1, post-2, post-3")

  yield* db.entities.Comments.put({
    commentId: "comment-1",
    postId: "post-1",
    authorId: "bob-1",
    body: "Great article!",
  })

  yield* db.entities.Comments.put({
    commentId: "comment-2",
    postId: "post-1",
    authorId: "charlie-1",
    body: "Very helpful, thanks!",
  })
  yield* Console.log("Created comments: comment-1, comment-2\n")

  // --- Pattern 3: GSI Queries ---
  yield* Console.log("=== Pattern 3: GSI Queries ===\n")

  // #region gsi-queries
  // Posts by author
  const alicePosts = yield* db.entities.Posts.byAuthor({ authorId: "alice-1" }).collect()

  // Comments on a post
  const postComments = yield* db.entities.Comments.byPost({ postId: "post-1" }).collect()
  // #endregion
  yield* Console.log(`Alice's posts (${alicePosts.length}):`)
  for (const p of alicePosts) {
    yield* Console.log(`  ${p.postId}: "${p.title}" — ${p.status}`)
  }

  yield* Console.log(`\nComments on post-1 (${postComments.length}):`)
  for (const c of postComments) {
    yield* Console.log(`  ${c.commentId}: "${c.body}" (by ${c.authorId})`)
  }
  yield* Console.log("")

  // --- Pattern 4: Pipeable updates ---
  yield* Console.log("=== Pattern 4: Pipeable Updates ===\n")

  // #region update
  // db.entities.Users.update(key, ...combinators) — type-safe
  const updatedAlice = yield* db.entities.Users.update(
    { userId: "alice-1" },
    Entity.set({ displayName: "Alice B.", postCount: 3 }),
  )
  // #endregion
  // updatedAlice: User
  yield* Console.log(
    `Updated user: ${updatedAlice.displayName} (postCount: ${updatedAlice.postCount})`,
  )

  // Multiple combinators in update
  const aliceV2 = yield* db.entities.Users.update(
    { userId: "alice-1" },
    Entity.set({ bio: "Effect TS enthusiast" }),
  )
  yield* Console.log(`  updated bio: ${aliceV2.bio}`)

  // #region optimistic-locking
  // expectedVersion for optimistic locking
  const lockResult = yield* db.entities.Users.update(
    { userId: "alice-1" },
    Entity.set({ displayName: "Wrong Name" }),
    Entity.expectedVersion(1), // version is now 2 — this will fail
  ).pipe(
    Effect.map(() => "unexpected success"),
    Effect.catchTag("OptimisticLockError", (e) =>
      Effect.succeed(`Caught OptimisticLockError: expected v${e.expectedVersion}`),
    ),
  )
  // #endregion
  yield* Console.log(`  ${lockResult}\n`)

  // --- Pattern 5: Transactions — composable API ---
  yield* Console.log("=== Pattern 5: Transactions ===\n")

  // #region transactions
  // Atomic multi-entity read — typed tuple, no cast needed
  const [txUser, txPost] = yield* Transaction.transactGet([
    Users.get({ userId: "alice-1" }),
    Posts.get({ postId: "post-1" }),
  ])
  // txUser: User | undefined, txPost: Post | undefined

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
  // #endregion
  yield* Console.log(`transactGet: fetched 2 items atomically`)
  yield* Console.log(`  User: ${txUser?.displayName}`)
  yield* Console.log(`  Post: "${txPost?.title}"`)
  yield* Console.log("\ntransactWrite: created post-4 + deleted post-3 atomically\n")

  // --- Pattern 6: Collection queries ---
  yield* Console.log("=== Pattern 6: Collection Queries ===\n")

  // Query comments on a post via the collection.
  const commentsResult = yield* db.entities.Comments.byPost({ postId: "post-1" }).collect()
  yield* Console.log(`Collection query — comments on post-1: ${commentsResult.length}`)
  for (const c of commentsResult) {
    yield* Console.log(`  ${c.commentId}: "${c.body}"\n`)
  }

  // --- Pattern 7: Model instances returned by default ---
  yield* Console.log("=== Pattern 7: Model Instances ===\n")

  const post1Retrieved = yield* db.entities.Posts.get({ postId: "post-1" })
  yield* Console.log(`Retrieved post: "${post1Retrieved?.title}"`)
  yield* Console.log(`  Status: ${post1Retrieved?.status}\n`)

  // --- Cleanup ---
  yield* Console.log("=== Cleanup ===\n")

  yield* db.entities.Users.delete({ userId: "alice-1" })
  yield* db.entities.Posts.delete({ postId: "post-1" })
  yield* db.entities.Posts.delete({ postId: "post-2" })
  yield* db.entities.Posts.delete({ postId: "post-4" })
  yield* db.entities.Comments.delete({ commentId: "comment-1" })
  yield* db.entities.Comments.delete({ commentId: "comment-2" })
  yield* Console.log("Deleted all items")

  yield* db.tables["blog-table"]!.delete()
  yield* Console.log("Table deleted.")
})

// =============================================================================
// 6. Provide dependencies and run
// =============================================================================

// #region layer
const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  BlogTable.layer({ name: "blog-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)
// #endregion

export { program, BlogTable, Users, Posts, Comments, User, Post, Comment }
